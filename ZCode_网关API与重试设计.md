# ZCode 网关 API 与重试子系统设计

整理日期：2026-10-28

本文是《ZCode_多账号管理器设计.md》的深化：覆盖对外双协议（OpenAI / Anthropic-Claude Code）、模型列表、请求日志、重试子系统。错误分类直接取自官方客户端源码（v3.16.2 快照 `failure-provider-business-codes.ts` / `failure-classifier.ts` / `retry-policy.ts` / `stream-retry-boundary.ts`），是官方在真实线路上验证过的语义，不是猜测。

---

## 1. 重试子系统（核心：官方语义 + 账号池轮换）

### 1.1 你遇到的"服务器繁忙"是什么

免费 Start Plan 的"当前系统繁忙，请切换模型、升级账户，或稍后再试"= 业务码 **3008/3009/3010**（免费网关**并发上限**，源码 i18n `chat.quota.startPlan.concurrentLimit` 与 `zcode.error.providerBusiness.3008/3009` 同文案）。官方客户端把它们标记为**不自动重试**（单账号视角：让你切模型/升级）。但你的手工重试能成功，说明这是**短时并发槽位竞争**——多账号池的正确解法是**立即换号重试**，这是管理器相对官方客户端的独有优势。槽位随请求结束即释放（秒级），busy 冷却压到 **1s 量级**即可回池，无需 8~15s 的保守窗口。

### 1.2 官方错误分类表（直接搬进内核）

默认重试参数（`retry-policy.ts`）：**maxAttempts=11（10 次重试）、base=2s、×2 退避、上限 60s、jitter 开**（`ZCODE_MODEL_RETRY_*` 环境变量可调）。

| 业务码/条件 | 语义 | 可重试 |
| --- | --- | --- |
| `500` / `2007` / `1120` / `1230` | 服务器错误 | ✅ |
| `1234` / "internal network error" | 网络故障包装 | ✅ |
| `1302` / `1303` / `1305` / `3002` | 限流（恢复类） | ✅ |
| `1312` / `engine_overloaded_error` / `overloaded_error` | 上游过载 | ✅ |
| HTTP 429 | 限流，**尊重 Retry-After 头** | ✅ |
| HTTP 5xx / 网络断连 / 超时 | — | ✅ |
| **`3008` / `3009` / `3010`** | **并发上限（免费网关"系统繁忙"）** | 官方❌ / **池子✅（优先换号）** |
| `3001` / `3006` / `3007` | 请求无效 / 模型不存在 / 鉴权 | ❌（换账号可能有效，见 1.4） |
| `1005` / `1006` | 配额 / 未配置 | ❌ |
| `1261` | 上下文超限 | ❌（映射 400 类错误返回） |
| `1113` / `1309` / `1311` / `1304` / `1308` / `1310` / `1313` | 各类终止 | ❌ |
| `insufficient_quota`、`2056`、`20097`、`1316~1321` | 额度耗尽（终态） | ❌ → 换账号 |
| `1008` / `1314` / `1315` | 终态业务错误 | ❌ |
| `3103` | 免费额度耗尽（off-peak 同款） | ❌ → 换账号 |
| `3012` "unusual activity" | 风控拦截（走运行时桥不应出现） | ❌ → 重启桥进程并告警 |
| HTTP 401/403 | 令牌失效 | 单次：刷新/换号后重试一次 |

### 1.3 重试决策流

```
请求失败
  ├─ 分类（业务码 → 1.2 表；无业务码按 HTTP 状态；再无按网络/超时）
  ├─ 可重试？
  │    ├─ 是 → 检查重试预算（次数≤10、总延迟预算≤120s、Retry-After）
  │    │        ├─ 3008/3009/3010 → 【换号重试】选另一个 active 账号立即试（间隔≈0，
  │    │        │                   并发槽是每账号的）；busy 账号冷却 1s±500ms 即回池
  │    │        │                   （槽位随请求结束释放）；inflight=0 却连续 3008（外部
  │    │        │                   占用/泄漏会话）→ 冷却递增 1s→5s→15s，连续 2~3 次
  │    │        │                   触发桥健康检查
  │    │        ├─ 429/5xx/网络 → 同账号退避重试（2s×2 封顶 60s + jitter），
  │    │        │                   连续 3 次同账号失败 → 换号
  │    │        └─ 401 → 该账号标 needs_relogin + 换号重试
  │    └─ 否 → 3103/额度耗尽 → 换号重试（若还有别的账号）；全部账号耗尽 → 终态错误
  └─ 已有用户可见输出？（流式）→ 见 1.4，不得无脑重放
```

账号选择器与重试器共享账号状态机：busy 计数、冷却窗口（3008 后该账号冷却 1s±500ms；inflight=0 却连续 3008 属外部占用/泄漏会话，冷却递增 1s→5s→15s）、`expires_at` 熔断。

### 1.4 流式重试边界（官方 `stream-retry-boundary.ts` 语义）

- **重试安全前奏**：`start / text_start / text_end / reasoning_start / reasoning_end / tool_input_start/delta/end` 可以缓冲后重放。
- **第一个非空 `text_delta` / `reasoning_delta` = 用户可见首 token**：此后不得整体重放（会重复输出）。空 delta 随前奏缓冲。
- 落地：桥在首 token 前保持"可整体重试"状态（失败→换账号/重试无感）；首 token 后失败 → 流内发错误事件收尾（OpenAI: `data: {"error":...}` 或 finish；Anthropic: `error` 事件），并在日志标记 `post_first_token_failure`。
- 官方还有 streaming-recovery（会话内续流恢复），桥的一期不做，二期可选。

### 1.5 参数（管理器配置面）

`retry.max_attempts`（默认 10）、`retry.base_delay_ms`（2000）、`retry.backoff_factor`（2）、`retry.max_delay_ms`（60000）、`retry.jitter`（true）、`retry.busy_rotate_account`（true）、`retry.busy_cooldown_ms`（1000±500ms）、`retry.busy_escalation_ms`（1000/5000/15000，外部占用/泄漏场景递增）、`retry.busy_leak_threshold`（连续 2~3 次零 inflight 3008 → 桥健康检查）、`retry.total_budget_ms`（120000）、`retry.max_delay_before_first_token_only`（true）。

---

## 2. OpenAI 兼容层

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | 流式（SSE）/非流式；`stream_options.include_usage` 支持 |
| `GET /v1/models` | 见 §4 |
| `GET /v1/usage` | 密钥自查（已用/剩余/有效期，只读面板记录） |

映射细节：

- `model`：别名表 → 真实 GLM id；未带别名时按账号 capabilities 白名单取默认。
- **思考强度**：`reasoning_effort: "low"|"high"|"max"`（OpenAI 风格）→ 直接映射档位；`max` 对不支持分档的模型降级为 `enabled` 并在响应 `system` 注明。也接受自定义字段 `thinking_level`。
- `max_tokens` / `max_completion_tokens` → 上游 maxTokens（卡片模型上限 64000/128000，超出自动钳制）。
- 流式 chunk：`id/chatcmpl-*`、`choices[].delta`（`content`、`reasoning_content`——思考 delta 放这里，兼容主流中文生态）、`finish_reason`（`stop`/`length`/`tool_calls`）、最后的 usage chunk。
- 错误体：`{"error": {"message", "type", "code"}}`；`type` 映射：busy→`server_error`+`Retry-After`、quota→`insufficient_quota`、context→`context_length_exceeded`、auth→`authentication_error`。
- 工具调用：`tools`/`tool_choice` 透传给运行时（AI SDK 原生支持），tool_calls 增量按 OpenAI index 协议合成。

## 3. Anthropic 兼容层（Claude Code 直连）

| 端点 | 说明 |
| --- | --- |
| `POST /v1/messages` | 流式/非流式 |
| `POST /v1/messages/count_tokens` | 按字符数粗估（workbuddy 同款做法） |

- 事件流：`message_start` → `content_block_start` → `content_block_delta`（**`text_delta` + `thinking_delta`** 两类块）→ `content_block_stop` → `message_delta`（`stop_reason` + `usage`）→ `message_stop`，心跳 `ping`。
- `system`（string 或数组）、`tools`（`input_schema`）、`tool_use`/`tool_result` 块、`metadata.user_id` 透传；`anthropic-version`/`anthropic-beta` 头容忍不校验。
- `stop_reason` 映射：`end_turn`/`max_tokens`/`tool_use`；`thinking` 参数（`{"type":"enabled","budget_tokens":N}`）→ N 映射到最近档位（low/high/max）。
- 错误体：Anthropic 错误格式 `{"type":"error","error":{"type","message"}}`（`overloaded_error`/`rate_limit_error`/`invalid_request_error`/`authentication_error`）。
- Claude Code 实测要点：它把 `system` 发成数组且带工具定义——桥需要做 tools 的透传与 tool_use 增量合成，这是兼容层工作量最大的一块。

## 4. 模型列表（`/v1/models` + 模型中心）

- **动态并集**：所有 `active` 账号 `balance.balances[].capabilities` 的 `model:` 前缀项 ∪ 静态目录。轮询刷新，账号过期即摘除。
- 静态目录来自公开接口 `GET /api/v1/client/configs` 的 `builtin_provider_config_json`（含 contextWindow、maxOutputTokens、reasoningLevel.values、输入模态）——**官方配置远程可变**，按 1h 缓存对齐官方客户端行为。
- 扩展字段（管理器自有端点 `/api/models/detail`）：context_window、max_output、reasoning_levels、哪些账号可用。
- 别名映射：`glm-flash → GLM-5.3-Flash`；`/v1/models` 同时返回别名与真名，设置页可编辑。

## 5. 请求日志

每请求一行（`usage_log` 表）：

```
id, ts, key_id, client_ip, account_id, family, model, reasoning_level,
stream(bool), attempt_count, rotated_accounts[], status(success|busy|failed|...),
error_code, error_message, ttft_ms, total_ms,
tokens_in, tokens_out, tokens_reasoning, cache_read, cache_write
```

- **默认不落 prompt/响应正文**（只记长度与哈希）；调试开关开启后全量留存并设保留天数。
- 聚合页：按天/小时、按密钥/模型/账号的成功率、繁忙率（3008 占比——这个指标直接反映免费网关拥挤度）、P50/P95 首字延迟。
- 日志驱动运营：某账号 busy 率持续过高 → 自动降权；额度快耗尽 → 置顶提醒领卡。

## 6. 查缺补遗：本轮检查发现的缺失清单

| # | 缺失点 | 处理 |
| --- | --- | --- |
| 1 | **每账号并发=1**：3008 就是并发上限，桥必须做每账号请求队列（同一账号同时只发 1 个请求） | 账号级 semaphore；池子总并发=账号数 |
| 2 | **客户端断连**：下游取消 → 必须取消运行时会话（session/close），否则白烧额度 | 请求上下文 abort 透传 |
| 3 | **超时三件套**：连接超时、首字超时（60s，超时无输出→换号重试）、总时长上限 | 与重试预算联动 |
| 4 | **zcode JWT 无 exp**：失效只能靠 401 检测。官方无刷新端点（`refresh_token` 存而不用，adapter 未实现） | 一期：401→标 needs_relogin + 换号重试；续期走"网页 cookie + 无头浏览器静默重授权"（见管理器设计 §3.6④） |
| 5 | **账号 expires_at 熔断**：卡到期（如 14h 窗口）前主动停止调度该账号 | 调度器检查 + 看板倒计时 |
| 6 | **app_version 漂移**：balance/preview 按 app_version 判定能力，官方发版后旧版本可能被策略降级 | 设置项 + 定期探测 client/configs 的 forceUpdate |
| 7 | **运行时进程守护**：app-server 崩溃/僵死 → 自动重启该槽位并清空其队列 | 健康检查（心跳/空闲回收） |
| 8 | **首字前重试与 SSE 起始**：OpenAI 流式要先发 `data: {"id":...}` 才算"已开始"；桥要在首 token 前缓冲整个起始块 | 与 §1.4 边界一致 |
| 9 | **busy 期间客户体验**：换号重试对下游透明，但总延迟会叠加；`Retry-After`/`x-retry-attempts` 响应头暴露实况 | 透传元数据 |
| 10 | **多密钥隔离**：每密钥独立配额/模型范围/IP 白名单（workbuddy 核心运营功能） | keys 表 + 中间件 |
| 11 | **管理面鉴权**：管理员会话 + 网关密钥哈希（只显示一次） | 沿用 workbuddy 形态 |
| 12 | **international 族验证**：zai 族的 balance/claim 与 bigmodel 同构性是源码推断，领卡中心上线前要先对 zai 账号实测一轮 | P1 验收项 |
| 13 | **context 超限映射**：1261 → OpenAI `context_length_exceeded` / Anthropic `invalid_request_error`，让下游 SDK 能识别 | 错误映射表 |
| 14 | **配置热更新**：轮询间隔/重试参数/别名表改了即生效（不重启桥） | 设置中心化 + watch |

---

## 7. 更新后的分期验收口径

- **P0**：OAuth 纳管（双族）+ balance 轮询 + 账号看板 + 总用量。
- **P1**：领卡中心 + 定时任务 + 通知。
- **P2**：RuntimeBridge（宿主仿真）+ `/v1/chat/completions` + `/v1/models` + **重试子系统（含换号）** + 请求日志。
- **P3**：`/v1/messages`（Claude Code）+ count_tokens + 多密钥/白名单 + 别名 + 用量看板完善。

P2 的验收标准建议直接用真实场景：**同一请求在 3008 高发时段自动换号成功、日志里能看到 attempt_count>1 且下游无感**。
