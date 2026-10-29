# ZCode 多账号免费额度管理器 · 设计方案

整理日期：2026-10-28

目标：做一个 ZCode 版的 workbuddy-manager——**只面向免费权益**（Start Plan 赠卡）、覆盖**国内（BigModel）与国际（Z.ai）**两族、支持**多账号纳管**、**额度/总用量可视化**、**定时轮询**、**自动领卡**、**指定思考强度**的推理服务。

本文基于本项目前两份核对文档（《ZCode_账号授权与免费付费链路汇总.md》《ZCode_免费链路与赠卡接口协议核对.md》）的全部实测结论，以及 workbuddy-manager / workbuddy2api 的公开架构。

---

## 1. 参照系：workbuddy-manager 是怎么实现的

workbuddy-manager 是**双层架构**：

| 层 | 项目 | 技术栈 | 职责 |
| --- | --- | --- | --- |
| 上游内核 | `workbuddy2api` | Go | 账号池、账号调度/轮询、令牌刷新、限流熔断、OpenAI 兼容反代（`/v1/chat/completions`、`/v1/messages`、`/v1/models`） |
| 管理面板 | `workbuddy-manager` | Next.js 15 + FastAPI (Python 3.11) | 扫码纳管账号、定时签到/保活、积分与有效期监控、密钥分发（配额/IP/模型白名单）、全量调用审计、多上游、可视化设置 |

面板与上游的关系是"**上游负责能力，面板负责呈现**"：面板不改上游一行代码，通过上游的状态/配置接口与自己的数据库协作。管理端 API 面板（`/api/auth/start` + `/api/auth/poll` 扫码授权、`/api/accounts/{file}/checkin|test|refresh`、`/api/keys`、`/api/upstreams`、`/api/logs`、`/api/stats/*`）值得直接照抄形态。

**ZCode 与 CodeBuddy 的根本差异**（决定内核设计）：workbuddy2api 靠协议模拟直连上游推理接口；而 ZCode 的推理网关 `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` 有**服务端运行时风控**（实测 `code:3012 "request has been blocked due to unusual activity"`，复刻全部公开协议要素仍被拦），只有官方运行时能通过。因此 ZCode 版内核的推理层不能做协议模拟，必须**驱动官方运行时**（这同时是合规上正确的做法——不绕过风控）。

---

## 2. 总体架构

```
┌────────────────────────── Web 控制台（Next.js/Vite + React）──────────────────────────┐
│  账号管理 │ 额度看板 │ 领卡中心 │ 用量统计 │ 密钥管理 │ 设置（轮询/版本/映射）         │
└──────────────────────────────┬───────────────────────────────────────────────────────┘
                               │ HTTP (会话/管理令牌)
┌──────────────────────────────▼────────────── 核心服务（单进程，Node 推荐）────────────┐
│  ┌─────────────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────────────────────────┐  │
│  │ AccountMgr  │ │ QuotaPoller  │ │ ClaimService│ │ InferenceBridge              │  │
│  │ 账号CRUD/状态│ │ 轮询balance  │ │ 预览+领取    │ │ RuntimeBridge(官方运行时桥)   │  │
│  │ OAuth/导入   │ │ 用量增量聚合  │ │ 活动发现     │ │ 会话/档位/流式事件→SSE        │  │
│  └──────┬──────┘ └──────┬───────┘ └──────┬──────┘ └──────────┬───────────────────┘  │
│         └───────────────┴───────┬────────┴───────────────────┘                      │
│                          SQLite（accounts/tokens/快照/用量/领取/密钥/日志）             │
│                          凭证 AES-GCM 加密（机器派生密钥）                              │
└──────────────────────────────┬───────────────────────────────────────────────────────┘
                               │ ZCode Protocol (stdio NDJSON) × N
              ┌────────────────▼─────────────────┐
              │ 官方运行时 zcode.cjs app-server   │  ← 推理唯一可行通道（过风控）
              │ （每账号/每槽位一个进程实例）       │
              └──────────────────────────────────┘
```

技术栈建议：**Node 全栈**（Fastify/Hono + better-sqlite3 + React 控制台）。理由：官方运行时 `zcode.cjs` 本身是 Node，桥接层（子进程、NDJSON、事件流）在同一生态里最自然；workbuddy 的 Go+Python 双层是为了复用上游，我们没有这个包袱。部署形态优先 Windows 常驻（官方桌面运行时在 Windows 上验证过）+ 可选 Linux（自带 `resources/glm` 运行时目录）。

---

## 3. 账号模型与"加入账号"设计（重点）

### 3.1 账号记录

```
Account {
  id                  本地主键
  label               备注（"国内-1"、"国际-主号"）
  family              "bigmodel" | "zai"        ← 国内/国际两族，协议对称
  customer_id         平台客户号（85291792743088907 形态）
  tokens {
    zcode_jwt         CLI 级 ZCode JWT —— balance/claim/推理的唯一凭证（核心）
    web_jwt           网页会话 JWT（可选，业务接口/营销用，能力受限）
    business_token    平台业务令牌（可选，付费/组织接口用）
  }
  device_mid          每账号固定 UUID（X-Device-Mid；服务端可能做设备画像，必须稳定）
  app_version         模拟的客户端版本（随官方发版更新，如 3.16.2）
  status              active | needs_relogin | cooldown | expired
  created_at / last_ok_at
}
```

三类令牌**不可互用**（实测）：网页 JWT 在 `billing/balance` 与推理网关稳定 401；只有 OAuth 交换签发的 `zcode_jwt` 能过 balance。入库前必须**加验**：调一次 balance，通过才算纳管成功，并顺便取回初始额度快照。

### 3.2 加入路径 A：OAuth 轮询式引导（推荐，产出全能力账号）

完整复刻官方 CLI 的登录链路（全部端点已实测）：

```
1. POST https://zcode.z.ai/api/v1/oauth/cli/init
   Authorization: Bearer <服务端随机32字节hex pollToken>
   body: {"provider": "bigmodel" | "zai"}
   → { code:0, data:{ flow_id, authorize_url, expires_at, poll_interval_sec } }

2. 把 authorize_url 展示给用户（浏览器打开）：
   国内: https://bigmodel.cn/login?redirect=...&appId=zcode&state=...
   国际: https://chat.z.ai/api/oauth/authorize?redirect_uri=...&response_type=code
         &client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=...
   用户在浏览器完成登录授权。

3. 服务端按 poll_interval_sec 轮询：
   GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}
   Authorization: Bearer <pollToken>
   （4xx 除 408/429 为终态；成功拿到一次性 code）

4. 换取令牌：
   POST https://zcode.z.ai/api/v1/oauth/token
   body: {"provider": "...", "code": "...", "redirect_uri": "...", "state": "..."}
   → 国内: data.token(ZCode JWT) + data.bigmodel.access_token/refresh_token
   → 国际: data.token + data.zai.access_token，再 POST https://api.z.ai/api/auth/z/login
           {"token": <access_token>} → data.access_token（业务 JWT）

5. 生成 device_mid，入库加密，立即用 balance 加验 + 建档。
```

UI 形态照抄 workbuddy 的 `auth/start` + `auth/poll`：点"添加账号"→ 选国内/国际 → 弹出授权页 → 轮询自动完成 → 账号卡片出现。

### 3.3 加入路径 B：Cookie 导入（轻量、能力受限）

用户粘贴网页登录态（`bigmodel_token_production` Cookie 值）。**能力边界必须在 UI 标明**：可查资料/订阅/营销（bigmodel 业务接口裸 token、preview、marketing/touch），**不可** balance 与推理（401）。适合做"业务信息号"，不作为额度池主力。Z.ai 侧同理（chat.z.ai 会话）。

### 3.4 账号健康状态机

```
active ──balance 401──▶ needs_relogin（触发重新走路径A）
   │  ▲                      │ 重新授权成功
   │  └── 重新授权 ──────────┘
   └──429/网络──▶ cooldown（指数退避，自动恢复）
```

### 3.5 到期时间登记（token 到期 = 卡到期）

账号登记时和每次轮询都要维护一组到期字段，看板统一倒计时：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `card_expires_at` | balance `balances[].expires_at` / `plans[].ends_at`（秒级时间戳） | **卡到期 = 额度失效**（如 ZCODE GLOBAL BUILD 的 14 小时窗口），调度器在此之前熔断该账号，到期前（可配，默认提前 1h）推送"领新卡"提醒 |
| `card_started_at` / `effective_at` | balance plans | 判断"已领待生效"（pending） |
| `web_cookie_expires_at` | Cookie 导入时读 cookie JSON 的 `expirationDate`（实测约一年） | 网页会话寿命；过期前提醒重新导出 |
| `business_token_expires_at` | zai `/api/auth/z/login` 的 `expires_in` | 业务 JWT 寿命（客户端按 5min 提前量重铸） |
| `zcode_jwt_last_ok_at` | balance/marketing 最近一次 200 | **ZCode JWT 无 exp 字段**——寿命完全由服务端会话控制，只能用"最近验证时间 + 连续失败计数"表达健康度 |

### 3.6 会话保活与免重登续期（Cookie 刷新机制）

核查边界（2026-10-29）：本机 ZCode 3.16.3 的 BigModel/Z.ai 登录 adapter 未实现 `refreshToken()`；服务层调用会报"暂未提供 refresh token 交换接口，请重新登录"。这不证明服务端不存在刷新端点。当前两个账号的 ZCode JWT 都没有 exp，但无 exp 也不代表永不过期。以下四层包含设计设想，不能全部视为已实现或已验证；最新证据见 `ZCode_自动续期核查.md`。

**① CookieJar 持久化（字面意义的 cookie 刷新）**

每账号一个持久化 cookie jar：每次请求捕获响应 `Set-Cookie` 并落盘（实测阿里 WAF 的 `acw_tc` 每个响应都在轮换、`ssxmod_itna` 承载风控指纹）。请求时回放整 jar——WAF 会把"没有 cookie 历史"的请求当成可疑流量。这是所有层的基础设施。

**② 低频鉴权保活 ping**

- 池内账号：额度轮询（balance，默认 60s）可验证当前 JWT 有效；没有证据表明每次 200 都延长服务端会话寿命。
- 受限账号（仅网页 cookie）：当前实现低频 ping `getCustomerInfo`（默认 30min），用于检查网页会话有效性；是否延长会话寿命尚未验证。

**③ zai 业务令牌重铸（官方同款机制）**

官方桌面端 `ZaiBusinessTokenResolver` 在业务令牌不足 5 分钟时，下一次 resolve 用原 OAuth access_token POST `/api/auth/z/login` 换业务令牌；它不是 ZCode JWT 的续期器。运行时另有 `ZaiBusinessTokenCache`，提前量为 2 分钟。管理器目前仅在 OAuth 完成时兑换业务令牌，未实现周期重铸；原 OAuth access_token 也可能过期，不能据此承诺长期免登录。

**④ zcode_jwt 掉线后的半自动续期（不重新登录的关键）**

JWT 失效（401）后的再授权不必让用户手动走完整登录——分两条 verified/待验证路径：

- **路径甲（候选方案，未实现，端到端待验证）**：为每个账号持久化独立浏览器会话，加载 `authorize_url`，尝试复用有效网页登录态完成 OAuth 授权，再由现有轮询流程取得新令牌。OAuth token 响应不包含浏览器 Cookie；需要单独保存实际浏览器会话。免交互跳转、Cookie 寿命、所需 localStorage/会话数据均需实测，不能保证只导入一个网页 JWT 就能完成。
- **路径乙（兜底）**：无头浏览器失败（风控加验证码等）→ 推送通知让用户点一下重新授权（deep link/页面按钮），凭证不丢、只是补一次授权。

**风险提示（写入文档）**：同一账号在别处重新登录可能轮换服务端会话（`user_key`）使旧 JWT 失效——管理器纳管的账号应尽量独占（不在多个客户端同时登录），或在文档中明示该行为。

---

## 4. 额度轮询与总用量（QuotaPoller）

### 4.1 轮询协议（全部实测通过）

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version={版本}
Authorization: Bearer <zcode_jwt>
X-Device-Mid: <账号 device_mid>        ← 必传，缺失会 401/异常
X-ZCode-App-Version / X-Platform / User-Agent: ZCode/<版本>
```

响应关键字段：`data.plans[]`（套餐实例，`status=active` + `plan_id` 含 `start-plan` 即生效卡）、`data.balances[]`（额度桶：`capabilities` 的 `model:` 前缀 = 可用模型白名单；`total/used/remaining_units`；`expires_at`）。

### 4.2 轮询策略

- 每账号独立间隔（默认 60s）+ 随机抖动；全局并发上限。
- 失败处理：401 → `needs_relogin`；429/5xx → 指数退避；成功 → 更新 `last_ok_at`。
- **防旧数据**：用响应 `Date` 头与 `server_time` 配对校验（官方客户端同款逻辑），`ends_at` 已过的 active 计划改判 expired。
- `billing/current` 已废弃，不调用。

### 4.3 总 token 用量

两级口径合并：

1. **服务端累计值**：`balances[].used_units` 是累计值，轮询时按 bucket 记 delta（本次-上次），得到"今日/本周增量"，**重启不丢**（服务端是权威）。
2. **本地请求级**：推理桥每次调用的 usage（input/output/reasoning tokens）落 `usage_log`，支撑按密钥/按模型/按小时的明细与审计（workbuddy 的 logs/stats 形态）。

看板：账号卡片（剩余进度条 + 到期倒计时 + 模型白名单徽标）+ 池子总量 + 按天/小时用量图。

---

## 5. 领卡中心（ClaimService）

"每次送的卡"的三级发现 + 一键领取：

```
发现层：
1. GET /api/v1/client/configs（公开）         → startPlanPreview（卡的内容模板：planId/权益）
2. GET /api/v1/marketing/touch（Bearer JWT）  → 投放到该账号的活动 banner（deliveries）
3. GET /api/v1/zcode-plan/billing/preview     → 该账号当前可领清单（plans[]，grant_units）
   （X-Device-Mid 必传；无鉴权也可调）

领取层：
POST /api/v1/zcode-plan/billing/claim
  Authorization: Bearer <zcode_jwt>
  X-ZCode-App-Version / X-Platform / X-Device-Mid
  body: {"plan_id": "<preview 返回>"}
  → code===0 且 data.plan 存在 = 成功（user_plan_id/starts_at/ends_at）
  → code≠0：数字字符串错误码；data.plan.ends_at = "已领过/活动结束"提示依据
  → 领取后立刻强制刷新 balance（使缓存失效）

调度层：
"每日自动领卡"任务：对每个 active 账号执行 3(预览)→领取→balance 刷新→通知
（企业微信/飞书/TG 推送领取结果与额度变化）
```

风险边界：claim 可能被服务端验证码/风控拦截（client/configs 有 `captcha` 场景配置）。失败按业务错误码展示，**不做绕过**；成功率为准，重试有上限。

---

## 6. 推理内核（InferenceBridge）——与 workbuddy2api 的本质区别

### 6.1 为什么不能直连

`POST /api/v1/zcode-plan/anthropic/v1/messages` 有服务端运行时风控：真 token + 全套归因头 + 真实 device_mid + undici 传输栈 + stainless 指纹头全部复刻仍 3012；而同机器 POST 其他接口（如 `oauth/cli/init`）正常到达业务层。结论：**风控在识别"是不是官方运行时发出的请求"**。绕过它=对抗平台反滥用，不做；正确做法是驱动官方运行时（其一切行为与官方客户端一致）。

### 6.2 RuntimeBridge：官方运行时 + 宿主仿真

```
InferenceBridge
  ├─ RuntimePool：N 个 zcode.cjs app-server 子进程（账号亲和：一个实例绑定一个账号，
  │    避免跨账号身份污染；复刻官方 scope 指纹思想）
  ├─ HostEmulator（宿主仿真器）：对每个子进程实现宿主侧职责——
  │    ① 应答 session/requestRuntimePreferences（固定偏好集，15s 超时）
  │    ② provider/updateAccountConfig 注入账号：
  │       { revision, basedOnZCodeBuiltinRevision,
  │         providers: { "account:bigmodel-start-plan": <内置 start-plan 配置> },
  │         states:   { "account:bigmodel-start-plan":
  │                      { availability:"available", entitled:true, current:true } } }
  │       （这就是桌面宿主给运行时喂账号的正式通道，协议 schema 已核对）
  │    ③ 其余宿主请求按最小应答处理
  ├─ SessionDriver：
  │    session/create { workspace, mode:"yolo",
  │      model: { providerId, modelId, options:{ reasoningLevel } },  ← 思考强度
  │      thoughtLevel }                    ← 或会话中 session/setThoughtLevel 动态切
  │    session/send { sessionId, content } → 订阅 session/event → 转成 SSE
  │    usage 事件抽取消耗，写 usage_log
  └─ Adapter 接口：Bridge 隐藏在统一接口后面，未来若官方开放直连协议可无缝替换
```

### 6.3 对外 API（照抄 workbuddy 形态）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容（流式/非流式） |
| POST | `/v1/messages` | Anthropic 兼容（Claude Code 等下游直连） |
| GET | `/v1/models` | 模型列表（GLM-5.3-Flash 等，随各账号 capabilities 动态并集） |
| GET | `/v1/usage` | 密钥自查额度 |
| POST | `/v1/messages/count_tokens` | 粗估 |

- **思考强度映射**：请求体 `reasoning_effort` / `thinking.budget`（或自定义字段 `thinking_level`）→ `low/high/max`；模型不支持分档的（disabled/enabled 型）做降级映射并在响应元数据里注明。
- **模型别名**：`glm-flash` → `GLM-5.3-Flash` 等映射表（workbuddy 同款功能）。
- **密钥分发**：多密钥 + 每密钥配额/有效期/IP 白名单/模型范围；密钥只存哈希。
- **调度**：按账号剩余额度与冷却状态选账号（剩余多者优先/轮询可配），请求级排队。

### 6.4 已知边界（写入文档，避免踩坑）

- standalone `app-server` 冷启动**不会**自动注册账号 provider（实测"Provider Registry 中不存在 Model"）——必须由 HostEmulator 注入（6.2②），这是本项目自研的核心点。
- 免费卡只有单模型（如 `glm-5.3-flash`），`/v1/models` 按池子实际能力并集返回。
- 每账号的卡有有效期（如 14 小时窗口），调度器要在 `expires_at` 前熔断该账号。

---

## 7. 存储与安全

- SQLite 单文件：`accounts / token_blobs(加密) / quota_snapshots / usage_log / claim_log / keys / audit_log / settings`。
- 令牌加密：AES-256-GCM，密钥 = sha256(机器派生串)（与官方 credentialService 同方案），密钥文件权限收紧。
- 管理面：管理员密码 + 会话；网关密钥哈希存储；审计日志记 IP/密钥/模型/状态码/首字延迟/扣费。
- 部署：默认只绑 127.0.0.1，公网走反代 + HTTPS（workbuddy 的安全建议原样适用）。

---

## 8. 分期路线

| 阶段 | 内容 | 依赖协议（均已实测） |
| --- | --- | --- |
| P0 | OAuth 纳管（双族）+ balance 轮询 + 账号看板 + 总用量聚合 + **到期时间登记/倒计时 + CookieJar 保活 + zai 业务令牌重铸** | cli/init、cli/poll、oauth/token、balance |
| P1 | 领卡中心（发现+领取+定时+通知）+ Cookie 导入受限账号 + **受限账号保活 ping** | client/configs、marketing/touch、preview、claim |
| P2 | RuntimeBridge（宿主仿真 + 会话驱动 + 档位）+ `/v1/*` 网关 + 密钥 | provider/updateAccountConfig、session/*、session/setThoughtLevel |
| P3 | 用量分析、多密钥体系、IP/模型白名单、模型别名、国际族对齐验证 | — |

P0/P1 一周内可跑通（纯 HTTP，全部协议已验证）；P2 是核心自研量所在（宿主仿真），建议先在单账号上打通 session/create → send → SSE，再扩池子。

---

## 9. 使用边界

本项目只用于管理**本人自愿授权**的免费账号；不批量注册、不交易账号、不绕过平台风控（推理层走官方运行时正是这条红线的工程表达）、不用于商业转售。与 workbuddy-manager 的免责声明同立场。

---

## 10. 功能取舍清单（开发视角评审）

### 10.1 必要功能（不做会出运营事故）

| 功能 | 理由 |
| --- | --- |
| 密钥级限速与配额 | 防下游失控循环一夜烧光全池免费额度；免费额度的稀缺性让限速从"可选"变"必要" |
| 全池耗尽的显式失败 | 所有账号 busy/到期时返回明确错误（含最近原因与预计恢复时间），绝不挂死下游 |
| 配置与数据自动备份 | SQLite 每日快照到本地目录 + 手动导出；账号凭证丢了要逐个重新 OAuth |
| `/healthz` + 桥进程守护 | 部署探测、app-server 崩溃自动重启（前面清单已列，归入"必要"档） |
| 出站代理配置（按账号可选） | 多账号同 IP 是免费网关风控的天然特征；5 个号以内可裸跑，10+ 建议每账号独立出口。留配置项即可，不做代理池管理 |
| 凭证加密与密钥哈希 | 已设计；泄露一次就是全池沦陷 |

### 10.2 实用功能（做了省心）

| 功能 | 理由 |
| --- | --- |
| 一键账号体检 | 对单账号跑 balance/preview/桥冒烟三连，输出诊断报告（workbuddy 的 /test 形态） |
| 额度与到期通知 | 剩余 <20%、卡到期前 1h、账号 401 —— 推送到 TG/飞书/企业微信 webhook |
| 每日领卡报告 | 昨日领取/消耗/作废汇总推送 |
| 账号分组与标签 | 国内池/国际池/备用池分开调度与统计 |
| 配置导入导出（加密） | 换机迁移不用逐号重登 |
| 接入配置生成器 | 为 Claude Code / OpenAI SDK / Cherry Studio 等下游一键生成接入配置片段，复制即用 |
| 别名与模型映射表编辑 | 下游老代码零改动迁移 |

### 10.3 眼前一亮的功能（差异化）

| 功能 | 为什么亮 |
| --- | --- |
| **废卡率仪表** | "领到 3 亿 → 用了 1.2 亿 → 过期作废 1.5 亿"。把免费卡窗口期内没用完的部分量化出来，直接刺激用户调整用量或加号——没有任何同类工具做这个 |
| **快过期优先调度** | 调度器把"距过期时间"作为权重：临期卡优先派单（use-it-or-lose-it），最大化免费额度利用率。工程量小（一个排序权重），收益直接 |
| **领卡雷达** | 聚合 client/configs + marketing/touch + billing/preview 三路情报，发现新投放即时推送；附带"该账号近 7 天收卡历史" |
| **请求事故时间线** | 一次失败请求的完整重试历史可视化：换号序列、退避间隔、每跳错误码。排障神器，也是给用户展示"系统在替我干活"的窗口 |
| **本地/服务端用量对账** | 本地 usage_log 累计 vs balance.used_units 定期核对，偏差超阈值告警——发现漏计与异常消耗 |
| **接力流** | 长流式输出中账号故障/到期，无感切换下一账号续流（协议无状态，天然可行；实现上要处理已输出边界的截断标记） |

### 10.4 冗余功能（明确不做）

| 功能 | 为什么不做 |
| --- | --- |
| 多用户注册/租户体系 | 单管理员足够；做多用户=给账号交易铺路，违反使用边界且复杂度爆炸 |
| 付费/计费模块 | 免费工具做计费是自找麻烦 |
| 直连推理的协议模拟 | 已被 3012 风控证伪，别再投入 |
| 付费套餐/团队套餐管理 | /api/pay 与企业订阅那一整套端点与免费定位无关 |
| 多语言 i18n（>2） | 自用中文+英文够了；五语种是公网运营的需求 |
| PostgreSQL 异地备份 | SQLite + 每日快照足够 |
| 住宅代理池管理 | 留 per-account 出站代理配置项即可，代理供应商集成是过度工程 |
| Windows 安装器/自更新器 | workbuddy 最重的工程；docker compose / pm2 / node 直跑即可 |
| OpenAI Responses API（`/v1/responses`） | workbuddy 为兼容生态而做；本项目的下游用 `/v1/chat/completions` + `/v1/messages` 已覆盖，等真实需求出现再加 |
| `marketing/touch/action` 回执 | 官方 banner 的点击上报，管理器只查询投放、不上报 |
| `billing/current` | 已废弃端点，balance 是唯一权威 |
| legacy 凭证兼容（loadLegacyTokenSet/旧 key 迁移） | 全新管理器没有历史包袱 |
| 登录归因（attribution）解析 | 官方增长埋点，与账号池无关 |
| 双轨保活 ping | 每族只保留 `marketing/touch` 一个 ping 端点 |
| 官方周边功能管理（闲时任务、工作流等） | 范围失控，聚焦账号池与网关 |

---

## 11. 账号分组与快过期优先调度（子系统设计）

### 11.1 数据模型

```sql
-- 分组：自由定义，带语义角色
CREATE TABLE groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,            -- "国内池" / "国际池" / "备用池" / 自定义
  role          TEXT NOT NULL DEFAULT 'primary',   -- primary | backup（备用池=兜底语义）
  family_filter TEXT,                     -- 'bigmodel' | 'zai' | NULL(混合)
  policy        TEXT NOT NULL DEFAULT 'balanced',  -- expiring_first | balanced | remaining_desc
  urgent_window_min  INTEGER NOT NULL DEFAULT 180, -- 距过期多少分钟内算"临期"
  enabled       INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE accounts ADD COLUMN group_id TEXT REFERENCES groups(id);
-- 密钥绑定分组链（有序）：请求按链顺序找号，前组全不可用才落到后组
ALTER TABLE keys ADD COLUMN group_order TEXT;  -- JSON: ["g_domestic","g_backup"]
```

要点：

- **备用池不是账号属性，是分组链里的兜底节点**——主池账号 busy/到期/冷却时按链落到备用池；账号可以在分组间随时移动（一条 UPDATE）。
- `family_filter` 是护栏：国内池里放 Z.ai 账号时 UI 警告（能力同构但活动/风控独立，混跑会污染统计）。
- 每把网关密钥绑定一条**有序分组链**（workbuddy 的"密钥绑定上游=账号池分组"同款），默认链 = [默认主组, 备用池]。

### 11.2 调度算法

```python
def select_account(chain, model, effort, ctx) -> Account | SkipReasons:
    for group in chain:                          # 按密钥的分组链顺序
        cands = [a for a in group.accounts
                 if a.status == 'active'
                 and a.expires_at > now + MIN_REQUEST_WINDOW   # 60s 内到期的卡不再派单
                 and a.not_in_cooldown()
                 and model in a.capabilities                    # 卡的模型白名单
                 and a.quota_remaining > 0
                 and a.inflight < 1]                            # 每账号并发=1
        if not cands: continue

        if group.policy == 'expiring_first':
            urgent = sorted([a for a in cands
                             if a.expires_at - now < group.urgent_window],
                            key=lambda a: a.expires_at)          # 临期者优先，最急的在前
            rest   = sorted([a for a in cands if a not in urgent],
                            key=lambda a: (-a.last_used_at))     # 其余 LRU 均衡
            pool = urgent + rest
        elif group.policy == 'remaining_desc':
            pool = sorted(cands, key=lambda a: -a.remaining)
        else:   # balanced
            pool = sorted(cands, key=lambda a: a.last_used_at)   # LRU 轮询

        for a in pool:
            if a.inflight == 0: return a
        # 全忙：选队列最短且预计等待最短的账号排队
        return min(cands, key=lambda a: a.queue_eta)

    return None  # 全链耗尽 → 503 + 各组跳过原因
```

三条铁律：

1. **临期优先只在 urgent_window 内生效**（默认 180 分钟）。没有这个窗口限制，expiring_first 会把全部流量压到同一张卡上，3008 概率暴涨；有窗口时"集中用掉临期卡"恰是想要的：用到 busy 为止，调度自然滑向下一张。
2. **MIN_REQUEST_WINDOW（60s）防止"派单即过期"**：请求要 2 分钟，卡 30 秒后到期，派过去就是浪费一次 3008/失败。
3. **busy 冷却与调度共享状态机**：3008 → 换号零间隔，busy 账号冷却 1s±抖动即回池（槽位随请求结束秒级释放；3008 拒绝发生在推理前、不烧额度，快试成本低）；inflight=0 却连续 3008 属外部占用/泄漏会话，冷却递增 1s→5s→15s 并触发桥健康检查；换号重试（§重试子系统）与这里的是同一个选择器，重试只是在候选列表里取下一个。

### 11.3 与缓存亲和的取舍（可选开关）

上游对同账号有 prompt cache（实测 usage 里有 cache_read）。频繁换号丢缓存、多花 token；黏住单号又放大 busy 概率。折中：每密钥可选 `sticky_minutes`（默认 0=关）——同 key+model 在窗口内尽量黏住上次账号，**临期规则优先级高于 sticky**（临期该用掉就用掉，cache 损失是次要的）。

### 11.4 可观测性：调度器必须"解释自己"

每次请求落一行调度日志（进 usage_log 或独立 `schedule_log`）：

```
request_id, chain: [国内池, 备用池],
candidates: [
  {account: 国内-A, skip: null, picked: true},
  {account: 国内-B, skip: "cooldown_until+7s (3008)"},
  {account: 国内-C, skip: "expires_in 42s < min_window"},
  {account: 备用-1, skip: "model 不在 capabilities"}
],
policy: expiring_first, urgent_window: 180min
```

这就是"事故时间线"功能的数据来源；调度理由透明化之后，"为什么总用这张卡""为什么刚才失败"在界面上直接可答。

### 11.5 看板

- 分组卡片：组内账号数 / 总剩余额度 / 24h 内到期额度 / 今日 busy 率 / 今日请求量。
- 账号卡片带分组徽标 + 临期徽标（urg ent_window 内高亮"即将过期，优先使用中"）。
- 废卡率仪表按分组分别出（备用池的废卡率通常最高——它只在主池忙时被用）。

### 11.6 默认配置建议

- 新账号默认进"待分组"，强制人工归类（防止国际号混进国内池）。
- 默认链：`[国内池, 备用池]` / `[国际池, 备用池]`。
- 备用池 policy 建议 `expiring_first`（备用卡通常是零散临期卡，用掉即赚）；主池建议 `balanced` + 临期窗口，两全。

---

## 12. 能力清单：截至 2026-10-28 已确认的平台能力

标记说明：【实测】= 本机真实请求验证过；【源码】= 官方客户端源码确认存在但未实测；【证伪】= 实测不可行。

### 12.1 账号与授权

| 能力 | 等级 | 备注 |
| --- | --- | --- |
| CLI 轮询式 OAuth（cli/init + cli/poll） | 【实测】init/poll 通道可达（3004 invalid_flow 证明业务层通）；完整登录需真实浏览器授权 | 多账号纳管的主路径 |
| OAuth 令牌交换（oauth/token，双族） | 【源码】 | 一次拿 ZCode JWT + 业务令牌；zai 需 /api/auth/z/login 重铸 |
| 网页 Cookie 导入（web JWT） | 【实测】 | 业务接口可用；balance/推理 401（渠道门禁） |
| credentials.json 解密/加密方案 | 【实测】 | AES-256-GCM，回退密钥串已知 |
| refresh_token 刷新 | 【证伪】 | 官方存而不用，adapter 未实现；只能靠保活+重授权 |
| ZCode JWT 无 exp | 【实测】 | 失效只能 401 探测 |
| 网页会话静默重授权 | 【证伪/半】 | BigModel 登录页是纯 SPA 壳，需真浏览器；Z.ai 标准 OAuth 待验证 |

### 12.2 额度与卡

| 能力 | 等级 | 备注 |
| --- | --- | --- |
| balance 额度遥测（plans+balances 全量） | 【实测】 | 卡身份/发放量/累计用量/剩余/到期时间/模型白名单，一次 GET 全拿到 |
| 卡到期时间（expires_at/ends_at） | 【实测】 | 14h 窗口实卡验证 |
| preview 可领清单（免鉴权+X-Device-Mid） | 【实测】 | 缺 X-Device-Mid → 3001 |
| claim 领取 | 【源码】 | 协议完整（plan_id body + 三件套头）；未实测（避免消耗资格） |
| client/configs 投放配置（startPlanPreview 等） | 【实测】 | 含 builtin_provider_config_json 全模型目录 |
| marketing/touch 营销投放查询 | 【实测】 | 双族可用；deliveries 当前为空 |
| billing/current | 【证伪】 | 已废弃 |
| 额度耗尽码 3103 / 并发繁忙 3008/3009 | 【源码】 | 官方 i18n 文案对齐 |

### 12.3 推理

| 能力 | 等级 | 备注 |
| --- | --- | --- |
| 桌面运行时子代理推理（含 $low/$high/$max 档位） | 【实测】 | 真实 Start Plan 扣量，双档位对照成功 |
| ListModels（宿主模型视图+档位） | 【实测】 | GLM-5.3-Flash: low/high/max，默认 max |
| 直连 zcode-plan/anthropic 推理 | 【证伪】 | 3012 风控，curl/undici/全套头/真 device_mid 均拦 |
| 无头 -p 推理 | 【实测】 | 可用但走 providerOrder 默认（本机落到 new-provider） |
| app-server 独立会话 | 【实测/受限】 | 协议流跑通；账号 provider 必须由宿主注入（provider/updateAccountConfig） |
| 官方重试语义与错误分类表（30+ 码） | 【源码】 | 10 次重试/2s×2/60s/jitter；3008 官方不重试 |
| 流式重试边界（首 token 前） | 【源码】 | 非空 delta 后禁整体重放 |

### 12.4 周边与观测

| 能力 | 等级 | 备注 |
| --- | --- | --- |
| model-io rollout 落盘日志 | 【实测】 | 每次模型请求的 provider/model/body 可查（排障利器） |
| 大模型业务接口（getCustomerInfo/subscription/api_keys） | 【实测】 | 网页 JWT 裸 token 可用 |
| WAF cookie 轮换（acw_tc 每响应） | 【实测】 | CookieJar 持久化的依据 |
| marketing/touch/action 回执 | 【源码】 | 管理器无需实现 |
| forceUpdate/captcha 远程配置 | 【实测】 | 用作 app_version 新鲜度探测 |
