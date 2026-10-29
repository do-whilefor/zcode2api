# zcode2api 实施计划

制定日期：2026-10-28
依据：本目录 4 份设计文档（《账号授权与免费付费链路汇总》《免费链路与赠卡接口协议核对》《多账号管理器设计》《网关API与重试设计》）+ 本机实测探查。

## 0. 探查结论（已在本机验证，作为实施前提）

| 事实 | 验证方式 |
| --- | --- |
| Node v24.18.0（内置 `node:sqlite`，免编译依赖） | 实测 |
| 官方运行时 `D:/Users/Acer/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs` v0.17.0，支持 `app-server`（stdio NDJSON JSON-RPC 风格） | 实测 |
| 本机 `~/.zcode/v2/credentials.json` 为扁平键值（`zcodejwttoken`/`oauth:*`/`account-provider:*` → `enc:v1:...`），AES-256-GCM，回退密钥 = sha256(`zcode-credential-fallback:{platform}:{homedir}:{os.userInfo().username}`)，10/10 解密成功 | 实测 |
| `ZCODE_DATA_BASE_DIR` / `ZCODE_STORAGE_DIR` / `ZCODE_CREDENTIAL_SECRET` / `ZCODE_TELEMETRY_DEVICE_MID` 均为运行时识别的环境变量 → **每账号隔离运行时的官方机制** | 实测（bundle 源码确认） |
| app-server 协议：请求 `{"id","method","params"}` → `{"id","result"|"error"}`；通知 `{"method","params"}`；zod 校验错误回传缺失字段 | 实测 |
| `session/create` params：`{workspace:{workspacePath,workspaceKey}, model?:{providerId,modelId,options?:{reasoningLevel}}, thoughtLevel?, mode?}`（strict） | 实测 |
| `session/send` params：`{sessionId, content, ...}` | 实测 |
| `provider/updateAccountConfig` params：`{revision, basedOnZCodeBuiltinRevision, providers: {<id>: {builtinModelIds, access:{type:'zhipu-account'}}}, states: {<id>: {availability:'available'|'pending'|'unavailable'|'unknown', entitled: bool, current?: bool}}}`（strict） | 实测 |
| `session/requestRuntimePreferences`（scope=runtime-materialization，15s 超时）宿主必须应答；应答 schema `{nativeSearchEnhancementsEnabled:bool, toolSearchMode?, memoryEnabled?, askUserQuestionAutoResolutionEnabled?, modelContextBudgetStrategy?...}` | 实测 |
| 内置配置走 CDN：`client/configs` → `builtin_provider_config_json` = URL → `zcode-builtin-23.json`（revision 23，providerRules 含 start-plan 条目，baseUrl=`https://zcode.z.ai/api/v1/zcode-plan/anthropic`） | 实测 |
| 免费推理直连协议模拟被 3012 风控拦截（文档实测）→ 推理层必须驱动官方运行时 | 文档实测 |

## 1. 目标产物

单进程 Node 服务「zcode2api」：

- **Web 控制台**（管理面）：账号纳管、额度看板、领卡中心、用量统计、密钥管理、设置、日志。
- **出口网关**（/v1/*）：OpenAI 兼容 + Anthropic 兼容，推理走官方运行时桥。
- **两个独立 HTTP 端口**：`web_port` 与 `gateway_port`，默认**随机**（绑定 :0 取系统分配），启动时打印并持久化到 `data/ports.json`；后续用户可通过配置/环境变量指定。
- 数据落盘 `data/`：SQLite（node:sqlite）+ 主密钥文件 + 每账号运行时隔离目录。

## 2. 技术选型（与设计文档的差异说明）

| 设计文档建议 | 本实施 | 理由 |
| --- | --- | --- |
| Fastify/Hono + better-sqlite3 | **Fastify + node:sqlite** | Node 24 内置 sqlite，Windows 免 node-gyp 编译风险 |
| Next.js/Vite + React 控制台 | **原生 JS 单页控制台（无构建链）** | 零依赖零构建、可离线加载；功能面完全覆盖设计稿的 7 个页面 |
| 宿主仿真 + app-server 桥 | 同设计，但凭据隔离用官方 `ZCODE_DATA_BASE_DIR`/`ZCODE_CREDENTIAL_SECRET` 机制（比文档的 HOME 仿真更干净） | bundle 源码确认的官方支持路径 |

依赖仅：`fastify`、`@fastify/static`（其余全部用 Node 内置能力）。

## 3. 目录结构

```
zcode2api/
├── PROJECT_PLAN.md            本文件
├── package.json               type:module，bin: zcode2api
├── config.example.json        端口/管理密码/轮询参数示例
├── src/
│   ├── index.js               入口：装配、双端口监听、优雅退出
│   ├── config.js              配置加载（config.json > env > 默认；端口随机化）
│   ├── db.js                  node:sqlite 封装 + 全部建表/迁移
│   ├── log.js                 结构化日志（控制台 + data/logs/app.log）
│   ├── crypto.js              AES-256-GCM enc:v1 加解密（官方同格式）
│   ├── httpclient.js          统一出站 fetch：CookieJar、UA/版本头、X-Device-Mid、超时
│   ├── zcodeApi.js            平台接口封装：balance/preview/claim/configs/touch/oauth
│   ├── accounts.js            账号 CRUD + 三种纳管路径 + 健康状态机
│   ├── poller.js              QuotaPoller：轮询、快照、delta、到期改判、退避
│   ├── claims.js              ClaimService：发现（configs/touch/preview）+ claim + 定时
│   ├── scheduler.js           调度器：分组链、expiring_first/balanced/remaining_desc、
│   │                          MIN_REQUEST_WINDOW、每账号 inflight=1、busy 冷却/升级
│   ├── retry.js               重试子系统：官方错误分类表、换号、退避、流式边界
│   ├── bridge/
│   │   ├── runtime.js         RuntimeSlot：子进程生命周期、隔离目录、凭据注入、守护
│   │   ├── host.js            HostEmulator：updateAccountConfig 注入、
│   │   │                      requestRuntimePreferences 应答、最小应答集
│   │   ├── session.js         SessionDriver：create/send/event→归一化事件流、usage 抽取
│   │   └── pool.js            RuntimePool：账号↔槽位亲和、懒启动、健康检查
│   ├── gateway/
│   │   ├── openai.js          POST /v1/chat/completions、GET /v1/models、GET /v1/usage
│   │   ├── anthropic.js       POST /v1/messages、POST /v1/messages/count_tokens
│   │   ├── auth.js            网关密钥校验（sha256）、配额/白名单/IP
│   │   └── errors.js          错误映射（OpenAI/Anthropic 错误体）
│   ├── admin/
│   │   ├── api.js             管理面 REST（账号/看板/领卡/密钥/设置/日志/体检）
│   │   └── auth.js            管理员会话（密码登录 → token）
│   └── web/                   控制台静态资源（index.html + app.js + style.css）
├── data/                      运行时生成（gitignore）
└── test/                      冒烟与协议探测脚本
```

## 4. 数据模型（SQLite）

- `accounts`：id, label, family(bigmodel|zai), customer_id, group_id, status(active|needs_relogin|cooldown|web_only|expired|unverified),
  enc_tokens(JSON: zcode_jwt/web_jwt/business_token/refresh_token), device_mid, app_version,
  card_started_at, card_expires_at, web_cookie_expires_at, business_token_expires_at,
  zcode_jwt_last_ok_at, fail_streak, cooldown_until, capabilities(JSON), last_balance(JSON), created_at, last_ok_at
- `quota_snapshots`：id, account_id, ts, bucket_id, entitlement_id, meter, total_units, used_units, remaining_units, expires_at
- `usage_log`：设计文档 §5 全字段（id, ts, key_id, client_ip, account_id, family, model, reasoning_level, stream, attempt_count, rotated_accounts, status, error_code, error_message, ttft_ms, total_ms, tokens_in/out/reasoning, cache_read/write, prompt_hash）
- `schedule_log`：设计文档 §11.4 调度解释行
- `claim_log`：id, account_id, ts, plan_id, ok, code, message, user_plan_id, ends_at
- `keys`：id, name, key_hash, key_tail, quota_limit, used_units, expires_at, ip_whitelist, model_whitelist, group_order(JSON), sticky_minutes, enabled, created_at
- `groups`：id, name, role(primary|backup), family_filter, policy(expiring_first|balanced|remaining_desc), urgent_window_min, enabled
- `settings`：key, value(JSON)（轮询间隔、重试参数、别名表、通知 webhook、管理密码哈希等）
- `audit_log`：管理面操作审计

## 5. 关键流程

### 5.1 账号纳管（3 路径）
1. **本机导入**（本机部署首选）：读 `~/.zcode/v2/credentials.json` → 回退密钥解密 → 取 `zcodejwttoken`+`oauth:*`+device_mid(telemetry-state.json) → balance 加验 → 建档。
2. **OAuth 轮询**：`POST /api/accounts/oauth/start`（cli/init，pollToken 服务端随机 32B hex）→ 返回 authorize_url → 前端展示/打开 → 服务端按 poll_interval 轮询 cli/poll → 拿 code → oauth/token（双族分支，zai 再过 /api/auth/z/login 铸业务 JWT）→ 加验建档。
3. **Cookie 导入**：粘贴网页 JWT（bigmodel_token_production）→ 标记 `web_only`（能力受限，UI 明示）→ 仅资料/营销/preview。

入库前一律 balance 加验（web_only 除外），失败即拒绝并给出原因。

### 5.2 轮询（QuotaPoller）
- 每账号间隔（默认 60s）+ 抖动；全局并发上限；401→needs_relogin；429/5xx→指数退避；成功→last_ok_at+快照+delta 聚合。
- `X-Device-Mid` 必传；Date 头/server_time 配对防旧数据；`ends_at` 已过的 active 改判 expired；`billing/current` 不调用。

### 5.3 领卡（ClaimService）
发现三路（configs 投放模板 / marketing touch / billing preview）→ 手动或定时 claim（body 只有 plan_id；成功判定 code===0 且 data.plan 存在）→ 领取后强制刷新 balance → claim_log。失败按业务码展示，不绕过风控，重试有上限。

### 5.4 推理桥（RuntimeBridge）
- 每账号一个 RuntimeSlot：`node zcode.cjs app-server --surface terminal`，env 注入
  `ZCODE_DATA_BASE_DIR=<data>/runtimes/<id>`、`ZCODE_STORAGE_DIR=<...>/.zcode`、`ZCODE_CREDENTIAL_SECRET=<主密钥>`、`ZCODE_TELEMETRY_DEVICE_MID=<账号 device_mid>`、`ZCODE_APP_VERSION`；
  隔离目录内预写 `.zcode/v2/credentials.json`（用主密钥加密的账号 token）+ `telemetry-state.json`（deviceMid）。
- HostEmulator：启动后发 `provider/updateAccountConfig`（revision=CDN 配置 revision，providers=start-plan 条目，states=available/entitled/current）；应答 `session/requestRuntimePreferences`（15s 内）；其余宿主请求最小应答；空闲心跳/崩溃自动重启（退避）。
- SessionDriver：`session/create`（mode=yolo, model={providerId,modelId,options.reasoningLevel}）→ `session/send` → 消费 `session/event`（text/reasoning/tool 增量、usage、finish）→ 归一化事件流；usage 落 usage_log；下游断连 → `session/close`。
- 懒启动 + 空闲回收（默认 10min）；builtin 配置 1h 缓存从 CDN 刷新。

### 5.5 网关与重试
- `POST /v1/chat/completions`（流式/非流式、reasoning_effort/thinking_level→档位、max_tokens 钳制、tools 透传、usage chunk）
- `POST /v1/messages` + `/v1/messages/count_tokens`（Anthropic 事件流、thinking.budget→档位、stop_reason 映射）
- `GET /v1/models`（池内 capabilities 并集 ∪ 静态目录；别名表）
- `GET /v1/usage`（密钥自查）
- 密钥中间件：sha256 哈希、配额、有效期、IP 白名单、模型白名单、分组链。
- 重试：官方分类表（§1.2）；3008/3009/3010 → 立即换号（busy 冷却 1s±500ms，零 inflight 连续 3008 → 1s/5s/15s 升级+桥健康检查）；429/5xx → 同账号退避 2s×2 封顶 60s+jitter，连续 3 次换号；401 → needs_relogin+换号；3103/额度耗尽 → 换号；流式首 token 前可整体重放，首 token 后流内错误收尾。
- 调度：分组链顺序 → 候选过滤（active/未到期>60s/无冷却/模型白名单/余量>0/inflight<1）→ 策略排序（expiring_first 临期窗口 180min 优先，否则 LRU）→ 调度解释日志。

### 5.6 Web 控制台
登录（管理员密码，默认首次启动生成并打印）→ 7 页：账号（纳管三路径+体检+分组）、看板（池总量/账号卡片/倒计时/废卡率）、领卡（三路情报+一键/定时领取+领取历史）、用量（按天/时/密钥/模型/账号）、密钥（CRUD+配额+白名单+接入配置生成器）、设置（轮询/重试/别名/通知/端口）、日志（usage_log/调度/领卡/审计 + 事故时间线）。

## 6. 端口策略

- `config.json` 缺省/`"web_port": 0`/"gateway_port": 0 → 随机端口（listen(0)），实际端口打印到控制台 + 写 `data/ports.json`；管理 API `GET /api/runtime-info` 可查。后续用户在 config 指定固定端口即可。

## 7. 实施顺序

1. 骨架：config/db/log/双端口 → 启动自检。
2. crypto/httpclient/zcodeApi（用本机真实凭据先验证 balance 链路）。
3. accounts + 本机导入 + OAuth 轮询 + Cookie 导入；admin API 骨架。
4. poller + 快照/聚合。
5. claims（发现+领取+定时）。
6. bridge（spike 先打通单账号 create→send→event，再扩展池化）。
7. gateway openai + 重试/调度 + 密钥。
8. gateway anthropic + count_tokens。
9. web 控制台全部页面。
10. **检查一**：功能完整性逐项核对（对照设计文档功能清单），问题定位→复现→修复→回归。
11. **检查二**：细节打磨（错误文案、边界、并发、超时、日志、UI 交互），问题定位→复现→修复→回归。
12. **检查三**：真实链路（本机 Cookie/凭据：balance 轮询真实数据 + 真实推理一次 + 端到端 /v1 调用），问题定位→复现→修复→回归，并核查修复未引入回归。

## 8. 验收标准

- 启动即用：`node src/index.js` 拉起双端口（随机），控制台可登录可操作。
- 本机账号一键导入成功，balance 轮询出真实额度（GLM-5.3-Flash 3 亿桶）。
- 领卡中心能列出 preview；claim 有完整审计。
- `POST /v1/chat/completions`（网关密钥）走运行时桥返回真实模型输出（消耗 Start Plan 额度），流式与非流式都可用。
- 3008 时自动换号/退避有日志可解释；/v1/messages 事件流符合 Anthropic 协议。
- 三轮检查均有记录且发现问题闭环（定位→复现→修复→回归→旁证）。

## 9. 边界与合规

只管理本人自愿授权的账号；不做协议模拟绕过风控（推理层走官方运行时正是红线的工程表达）；claim 失败不绕过；凭证加密落盘、密钥只存哈希、默认只绑 127.0.0.1。
