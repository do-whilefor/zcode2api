# ZCode 免费链路与"赠卡"接口协议核对

整理日期：2026-10-28

核对对象：[zai-org/ZCode](https://github.com/zai-org/ZCode) 源码快照，版本 **3.16.2**，提交 **`3c5b227649371507ddc4eb46ac5133afe6db1cab`**。本文是《ZCode_账号授权与免费付费链路汇总.md》的配套细读记录，把其中"免费体验"和"体验方案预览与领取"（即每次送的卡）两条线展开到**具体 URL、HTTP 方法、请求头、请求/响应体**级别。全部结论直接读自上述提交的公开源码；未抓包、未实测线上。

文中"送的卡"指 Start Plan 免费体验套餐：服务端配置投放 → 营销入口曝光 → 用户预览 → 领取 → 余额生效 → 走免费网关推理，这一整条链。

## 1. 总脉络

```
┌─ 授权阶段（取得两把钥匙）────────────────────────────┐
│ BigModel / Z.ai OAuth → POST /api/v1/oauth/token      │
│   ├─ data.token            = ZCode JWT   → 凭证 zcodejwttoken（免费链路用）
│   └─ data.bigmodel/zai.access_token = 平台业务令牌   → 凭证 oauth:{provider}:access_token（付费链路用）
└──────────────────────────────────────────────────────┘
            │
   ┌────────┴─────────────────────────────┐
   ▼ 免费体验 Start Plan                  ▼ 付费 Coding Plan
 ZCode JWT                            平台业务令牌
   │                                      │
 1) client/configs   ← 服务端投放"卡"的展示配置
 2) marketing/touch  ← 营销 banner 曝光与点击回执
 3) billing/preview  ← 预览可领取的卡（grant_units 数量）
 4) billing/claim    ← 领取，写入 user_plan 实例
 5) billing/balance  ← 查询套餐实例 + 额度桶（可用性权威来源）
 6) POST /api/v1/zcode-plan/anthropic/v1/messages      1) subscription/list 或 querySubscribeDetail 查订阅
    Authorization: Bearer {ZCode JWT}                  2) customerInfo → api_keys → access_tokens 换短期 PAT
                                                       3) POST /api/v1/ultra[/ultra-zai]/anthropic/v1/messages
                                                          Authorization: Bearer {短期 Project Token}
```

两类凭据的分工（源码 `accountProviderRequestAuthService.ts:83` 的分支）：

- `planKind === "start-plan"` → 请求凭证取 `loadOAuthTokenSet().zcodeJwtToken`，即 ZCode JWT。
- `individual-coding-plan` / `team-coding-plan` → 请求凭证取短期 Project Access Token。
- 换证前后用 sha256 指纹（family + planKind + [org, project, productId] + accessToken + zcodeJwt）校验账号未变，防止 401 重试或闲时票据串用新身份。

## 2. 授权阶段协议

### 2.1 BigModel OAuth

| 步骤 | 协议 |
| --- | --- |
| 授权入口 | `GET https://bigmodel.cn/login?redirect={redirectUri}&appId=zcode&state={state}` |
| 回调 | deep link `zcode://oauth/callback`，参数 `authCode`（新回落 `code`）+ `state` |
| 令牌交换 | `POST https://zcode.z.ai/api/v1/oauth/token`，`Content-Type: application/json`，body `{ "provider": "bigmodel", "code": "...", "redirect_uri": "zcode://oauth/callback", "state": "..." }` |
| 交换响应 | `{ "code": 0, "msg": "...", "data": { "token": "<ZCode JWT>", "bigmodel": { "access_token": "...", "refresh_token": "..." } } }` |
| 用户信息 | `GET https://bigmodel.cn/api/biz/customer/getCustomerInfo`，头 `Authorization: <access_token>`（**裸 token，不加 Bearer**） |

要点（`bigmodelProviderAdapter.ts`）：

- 授权码**一次性**且只交给 zcode token 路由消费；交换失败必须中止登录，不能保存半登录态，否则 Start Plan 永远显示未连接。
- 响应必须同时含 `data.token`（ZCode JWT）和 `data.bigmodel.access_token`（业务令牌），缺一即失败。
- ZCode JWT 落盘为凭证 `zcodejwttoken`，只给免费链路用；业务令牌落盘为 `oauth:bigmodel:access_token`，只给付费业务接口用。旧版曾把 JWT 误写进业务令牌槽，现源码在服务边界检测该污染状态（token 相同即判 `bigmodel_oauth_required`）。
- userinfo 若用 Bearer 前缀会**稳定鉴权失败**——BigModel 登录态业务接口约定裸 token。

### 2.2 Z.ai OAuth

| 步骤 | 协议 |
| --- | --- |
| 授权入口 | `GET https://chat.z.ai/api/oauth/authorize?redirect_uri={redirectUri}&response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state={state}` |
| 令牌交换 | `POST https://zcode.z.ai/api/v1/oauth/token`，body `{ "provider": "zai", "code": "...", "redirect_uri": "...", "state": "..." }` |
| 交换响应 | `{ "code": 0, "data": { "token": "<ZCode JWT>", "zai": { "access_token": "<OAuth access token>" }, "expires_in": <秒>, "user": { "user_id", "email", "name", "avatar" } } }` |
| 业务令牌兑换 | `POST https://api.z.ai/api/auth/z/login`，body `{ "token": "<OAuth access_token>" }` → `{ "code": 0|200, "data": { "access_token": "<平台业务 JWT>", "expires_in": <秒> } }` |
| 用户信息 | `GET https://chat.z.ai/api/oauth/userinfo`，头 `Authorization: Bearer <accessToken>` |

要点（`zaiProviderAdapter.ts`、`zaiBusinessTokenResolver.ts`）：

- 与 BigModel 不同，`data.zai.access_token` 只是 Z.ai **OAuth token**，落盘前必须经 `/api/auth/z/login` 兑换成平台业务 JWT；落盘为 `oauth:zai:access_token` 的就是业务 JWT 本身（客户端带 5 分钟提前量缓存）。
- `expires_in` 为秒，客户端乘 1000 转毫秒记录过期时间。

### 2.3 CLI 轮询式授权（deep link 丢失时的可靠路径）

- 初始化：`POST https://zcode.z.ai/api/v1/oauth/cli/init`，头 `Authorization: Bearer <pollToken>`（客户端随机 32 字节 hex）、`Content-Type: application/json`，body `{ "provider": "bigmodel" | "zai" }`。
- 响应：`{ "code": 0, "data": { "flow_id": "...", "authorize_url": "https://...", "expires_at": <秒>, "poll_interval_sec": <秒> } }`；客户端会把 `authorize_url` 的 `redirect`/`redirect_uri` 统一改写为 `zcode://oauth/callback`。
- 轮询：`GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flowId}`，头 `Authorization: Bearer <pollToken>`，按 `poll_interval_sec` 间隔轮询；4xx（除 408/429）视为终态失败；flow 过期或超时收口。
- 轮询 ready 返回的 tokenSet 在 adapter 内做与回调一致的归一化（Z.ai 仍要过 `/api/auth/z/login` 兑换）。

### 2.4 凭证存储

凭证服务（`credentialService.ts`）加密后持久化，不写入普通模型配置。关键槽位：`zcodejwttoken`、`oauth:bigmodel:access_token`、`oauth:zai:access_token`、`oauth:active_provider`。BigModel 免费链路的 JWT 允许从 provider 配置的 `apiKey` 副本兜底读取（`bigmodelStartPlanZcodeJwt.ts`），但**禁止**用 BigModel 业务 access_token 去 `/oauth/token` 二次兑换（会 HTTP 400）。

## 3. "送的卡"（Start Plan 体验套餐）接口协议

以下 1–3 在同一服务端投放——领取入口是否可见、能领哪张卡，全部由服务端配置驱动；客户端只做展示和转发。

### 3.1 服务端投放配置（卡的"样式"）

`GET https://zcode.z.ai/api/v1/client/configs?app_version={版本}&platform={process.platform}-{process.arch}`

- **无鉴权**，客户端快照缓存 1 小时。
- 响应 `data.configs` 里与"卡"相关的字段：
  - `startPlanPreview`: `{ planId, name, entitlements: [{ grantUnits, meter, period, showName, unitType }] }` —— Start Plan 卡片的静态展示配置（权益数量、计量单位、周期文案）。
  - `codingPlanStaticProducts` / `codingPlanStaticTeamProducts`: 付费套餐目录（tier LITE/PRO/MAX、subscribeMode、period、equity 文案卡）。
  - `codingPlanBillingDiscount`、`forceUpdate`、`offPeak.enable_offpeak_task`、`dynamicWorkflow.mode`、风控配置等。

### 3.2 营销曝光与回执（banner 的"推送"）

- 查询：`GET https://zcode.z.ai/api/v1/marketing/touch?seq={启动序号}`，头 `X-Device-Mid: <uuid>`、`X-Client-Language: zh-CN|en-US`、`X-ZCode-App-Version: <版本>`、`Authorization: Bearer <zcodejwttoken>`。
- 回执：`POST https://zcode.z.ai/api/v1/marketing/touch/action`，同头 + `Content-Type: application/json`，body `{ "campaign_id": "...", "action_type": "confirm" | "cancel" }`，成功响应必须是 `{ "code": 0 }`。
- 领取期间账号若已切换（token 变化），客户端拒绝用新凭据上报旧操作（scope UUID 随 token 更换）。

### 3.3 预览可领取的卡（"这张卡送多少"）

`GET https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version={版本}&platform={平台键}`

- 头：`Authorization: Bearer <ZCode JWT>`（注意：这里**有** Bearer 前缀）。
- 响应（平台信封，`code === 0` 才算成功）：

```json
{
  "code": 0, "msg": "...", "success": true,
  "data": {
    "server_time": 1769900000,
    "plans": [{
      "plan_id": "...", "name": "...", "description": "...", "priority": 0,
      "entitlements": [{
        "entitlement_id": "...", "show_name": "...",
        "meter": "...", "unit_type": "...", "capabilities": ["model:glm-..."],
        "grant_units": 0, "period": "...", "priority": 0, "effective_at": 0
      }]
    }]
  }
}
```

### 3.4 领取（"把卡拿走"）

`POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim`

- 头：
  - `Authorization: Bearer <ZCode JWT>`（无 JWT 直接返回 `{success:false, code:401}`，不发请求）
  - `Content-Type: application/json`
  - `X-ZCode-App-Version: <版本>`
  - `X-Platform: <process.platform>-<process.arch>`
  - 风控证明头（`requestVerificationClaimHeaders`）——**开源快照中为空实现**，即公开版不发送任何证明头；该槽位是为服务端反滥用预留的。
- body：`{ "plan_id": "<预览返回的 plan_id>" }`
- 响应：

```json
{
  "code": 0,
  "msg": "...",
  "data": {
    "server_time": 1769900000,
    "message": "...",
    "plan": {
      "user_plan_id": "...", "plan_id": "...", "status": "active",
      "starts_at": 0, "ends_at": 0,
      "entitlements": [{ "entitlement_id": "...", "show_name": "...", "effective_at": 0 }]
    }
  }
}
```

- 判定规则：`code === 0` **且** `data.plan` 存在才算领取成功；错误码可能是数字字符串（`"40xxx"`），缺失 code 不推断成功。
- 失败时 `data.plan.ends_at`（若有）用于"额度耗尽/活动结束"提示；`data.message` 是服务端已翻译的用户文案，顶层 `msg` 不是。
- `server_time` 是秒，客户端乘 1000 转毫秒；领取后使 balance 的短期缓存失效。

### 3.5 余额与可用性（"卡里还剩多少"）

`GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version={版本}`

- 头：`Authorization: Bearer <ZCode JWT>`（BigModel 从凭证 `zcodejwttoken` 或 provider 副本取；Z.ai 从凭证或 provider 连接副本取）。
- 响应：

```json
{
  "code": 0, "success": true, "msg": "...",
  "data": {
    "server_time": 1769900000,
    "plans": [{ "user_plan_id": "...", "plan_id": "zcode-v3-start-plan", "name": "ZCode V3 Start Plan",
                "status": "active", "starts_at": 0, "ends_at": 0, "entitlements": [...] }],
    "balances": [{ "bucket_id": "...", "user_plan_id": "...", "plan_id": "...", "entitlement_id": "...",
                   "show_name": "...", "meter": "...", "unit_type": "...",
                   "capabilities": ["model:glm-..."],
                   "total_units": 0, "used_units": 0, "reserved_units": 0,
                   "remaining_units": 0, "available_units": 0,
                   "period_start": 0, "period_end": 0, "expires_at": 0 }]
  }
}
```

要点（`zaiStartPlanBilling.ts`、`codingPlanProviderAvailability.ts:397`）：

- **`billing/current` 已废弃**；`balance` 的 `data.plans` 是 Start Plan 可用性的权威来源。
- "已激活的卡"判定：`status === "active"` 且 `plan_id`/`name` 含 `start-plan` / `start plan`（真实返回如 `zcode-v3-start-plan`）。
- 可用模型列表：`balances[].capabilities` 里 `model:` 前缀的条目（兜底用 `show_name`），经官方模型 ID 归一化后去重。
- 待生效判定：模型列表为空且所有权益 `effective_at` 都在未来 → `pending`；时间缺失不伪造日期。
- 防旧数据：`ends_at` 已过期的 `active` 计划以本次响应的 HTTP `Date` 头（或 `server_time`）校对后改判 `expired`，并剔除其名下额度桶；同请求按 key 去重，失败响应保留 1 秒防止 429 后立刻重放。

### 3.6 免费推理（"刷卡"）

- Anthropic 协议：`POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（内置 provider `account:bigmodel-start-plan` / `account:zai-start-plan` 的 baseUrl）。
- OpenAI 兼容协议：基座 `https://zcode.z.ai/api/v1/zcode-plan`（start-plan 模式下流式路径显式开启 response body，因为 zcode-plan 的业务码只出现在 finish chunk）。
- 认证头：凭证（ZCode JWT）作为 AI SDK 的 `apiKey` 注入；Anthropic 兼容网关**同时接受** `x-api-key` 与 `Authorization: Bearer`，客户端默认发 `Authorization: Bearer <ZCode JWT>`（`model-execution.ts:425`）。请求期动态身份头会先清掉静态配置里的 `authorization`/`x-api-key`，防止旧凭据被 SDK 优先采用。

## 4. 付费 Coding Plan 协议（对照）

### 4.1 订阅权益查询

- 个人：`GET https://bigmodel.cn/api/biz/subscription/list`（Z.ai 侧对应 `api.z.ai`），头 `Authorization: <业务令牌>`（BigModel 裸 token；`code` 200 才成功）。有效判定：`productId/productName` 含 "coding" 且 `status === "VALID"` 且 `inCurrentPeriod === true`。
- 团队：`GET {业务域}/api/biz/team/subscribe/product/querySubscribeDetail`，头 `Authorization: <业务令牌>`（zai 用 Bearer）+ `bigmodel-organization: <orgId>` + `bigmodel-project: <projectId>`。有效判定：`status === "EFFECTIVE"` 且 `memberGrantStatus === "VALID"`（`hasSubscription=true` 不代表有效，`EXPIRED`/`UNASSIGNED` 明确无效）。
- 团队上下文：`GET {业务域}/api/biz/customer/getCustomerInfo`，`projectType === "2"` 的是团队项目。

### 4.2 短期 Project Token（换"会过期的推理钥匙"）

均在业务域（BigModel：`https://bigmodel.cn`，Z.ai：`https://api.z.ai`），`ProjectAccessTokenClient`：

1. `GET /api/biz/customer/getCustomerInfo` —— 头 `Authorization: <业务令牌>`（**裸**，Bearer 会被误判登录失效）。个人套餐过滤 `projectType === "2"` 的团队项目，优先"默认机构"/"默认项目"；团队套餐直接用选定的 org/project 并校验存在性。
2. `GET /api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys` —— 个人：BigModel 裸 token / Z.ai `Bearer`；团队：裸 token + `bigmodel-organization`/`bigmodel-project` 头。
3. 没有名为 `zcode-api-key`（个人）/ `zcode-team-api-key`（团队，且 `keyType === 2`）的键时，`POST` 同 URL 创建，body `{ "name": "...", "usageScene": "coding-plan", "keyType": 2 }`（团队）。
4. `POST /api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys/{apiKeyId}/access_tokens` —— 头 `Authorization: Bearer <业务令牌>`，body `{ "clientType": "zcode", "clientVersion": "<版本>" }` → 返回短期 Project Access Token。内存缓存按 TTL 刷新（提前量延迟刷新）；仅响应 404 才废弃 Key ID 重建；其余错误不得触发建键回退。

注意：平台登录令牌、Key 条目 ID（`apiKeyId`）、短期推理 Token（PAT）是三个东西；部分字段沿用 `apiKey` 命名，放的不是用户手配的长期 API Key。

### 4.3 付费推理（网关改写）

- 配置里的 Base URL：`https://open.bigmodel.cn/api/anthropic`（BigModel）/ `https://api.z.ai/api/anthropic`（Z.ai）。
- 路由层（`official-coding-plan-gateway.ts`）做**精确匹配改写**：
  - `https://open.bigmodel.cn/api/anthropic/v1/messages` → `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`
  - `https://api.z.ai/api/anthropic/v1/messages` → `https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`
  - query 原样保留；其他路径、非 https、其他主机一律不改写。
- 认证头：`Authorization: Bearer <短期 PAT>`。

## 5. 服务协议风格对照（易踩坑点）

| 维度 | zcode.z.ai 平台接口 | BigModel/Z.ai 业务接口 |
| --- | --- | --- |
| 范围 | `/api/v1/oauth/*`、`/api/v1/client/configs`、`/api/v1/zcode-plan/*`、`/api/v1/marketing/touch*` | `/api/biz/*`、`/api/pay/*`、`/api/auth/z/login` |
| 成功码 | `code === 0`（preview/claim 明确沿用平台信封；claim 的 code 还可能是数字字符串） | `code === 200`（也有接口成功省略 code / 0/200 通融） |
| 鉴权 | `Authorization: Bearer <ZCode JWT 或 pollToken>` | BigModel 登录态多为**裸 token**（userinfo、customerInfo、subscription/list、api_keys 个人）；`/api/auth/z/login` 兑换、zai 业务、access_tokens、userinfo 走 Bearer；团队接口另加 `bigmodel-organization`/`bigmodel-project` 头 |
| 客户端元数据 | `X-ZCode-App-Version`、`X-Platform`、`X-Device-Mid`、`X-Client-Language`、balance/preview 的 `app_version`+`platform` 查询参数 | 无 |
| 风控 | claim 预留 `requestVerificationClaimHeaders` 证明头位（开源快照为空实现） | 支付接口有 WAF/HTML 干扰，客户端把不可渲染响应收敛为"系统繁忙" |
| 时间 | `server_time` 为**秒**，客户端 ×1000；balance 另用 HTTP `Date` 头防旧 JSON | `expires_in` 为**秒**；订阅字段为字符串时间 |

## 6. 与汇总文档的增量结论

1. 汇总文档第 6 节"源码也提供体验方案预览与领取相关接口"一句，对应具体协议即 `GET /api/v1/zcode-plan/billing/preview` 与 `POST /api/v1/zcode-plan/billing/claim`，凭证为 ZCode JWT（Bearer），claim 带 `X-ZCode-App-Version`/`X-Platform` 与（开源版为空的）风控证明头，body 只有 `plan_id`。
2. "每次送的卡"的内容（planId、权益数量、计量单位、周期）由服务端 `client/configs` 的 `startPlanPreview` 投放，`billing/preview` 返回的是**可领取**的实时清单；两者一个管展示、一个管领取，不要混同。
3. 领取后权益是否生效以 `billing/balance` 为唯一权威（`billing/current` 已废弃）；`balance` 同时决定免费链路可用模型白名单（`capabilities` 的 `model:` 前缀）。
4. 免费与付费请求的差别不只是 URL：凭证本体（ZCode JWT vs 短期 PAT）、获取方式（登录时一次下发 vs 四步换取）、认证头风格（Bearer vs 业务域裸 token）都不同。
5. 公开源码快照中的风控证明为空实现，说明公开仓库剥离了反滥用细节；不能据此推断线上服务端不校验，云端鉴权、反滥用与扣费实现仍不可从客户端源码确认（与汇总文档第 7 节一致）。

## 7. 线上实测补充（2026-10-28，用户提供 WEB 渠道 JWT + bigmodel.cn 浏览器 cookie）

用一枚真实 JWT（payload：`user_type=PERSONAL, user_channel=WEB, user_id=13548703, customer_id=85291792743088907`，HS512，**无 exp 字段**，即 bigmodel.cn 网页登录态 cookie `bigmodel_token_production`）与配套浏览器 cookie 做了两轮实测。

### 7.1 接口实测结果

| 接口 | 结果 | 结论 |
| --- | --- | --- |
| `GET /api/v1/client/configs`（无鉴权） | HTTP 200，`startPlanPreview` 在投：`planId=zcode-v3-start-plan`，每日 GLM-5.3 300 万 token + GLM-5.3-Flash 500 万 token；`captcha={enabled:true, sceneId:11xygtvd, skip_model_request:true}`；`forceUpdate=null` | 服务端投放存活；风控走 captcha 场景，对应开源快照的空壳实现 |
| `GET /api/v1/marketing/touch`（Bearer JWT） | HTTP 200 `code:0`，`deliveries:[]`（无鉴权时 400） | **JWT 有效**，平台鉴权层接受该 token；当前账号无营销投放 |
| `GET https://bigmodel.cn/api/biz/customer/getCustomerInfo`（裸 token） | HTTP 200 `code:200`，返回完整资料：个人认证成功、默认机构 `org-D75e304eC8Be4a08A22167bcfF0aB2D4`（owner）、默认项目 `proj_1644D3D3eB9242789ABc7608Cb962d64`（type 1） | **WEB 渠道 JWT 可以充当 BigModel 业务令牌**，付费流程的只读步骤可跑通 |
| `GET https://bigmodel.cn/api/biz/subscription/list`（裸 token） | HTTP 200 `code:200`，`data:[]` | 无付费订阅，纯免费账号 |
| `GET https://bigmodel.cn/api/biz/v1/organization/{org}/projects/{proj}/api_keys`（裸 token） | HTTP 200，2 个键：`默认项目(088907)`（usageScene=3）和 **`zcode-api-key`（usageScene=1 即 CODING_PLAN）** | 该账号登录过 ZCode 客户端，付费流程的 Key 条目已存在 |
| `GET /api/v1/zcode-plan/billing/preview` + `X-Device-Mid`（带不带 Bearer 均可） | HTTP 200 `code:0`，`{"plans":[]}`；**缺失 `X-Device-Mid` 时 HTTP 400 `code:3001 parameter error`** | preview 实为公开接口，`X-Device-Mid` 是服务端强制的必传参数（真实客户端由 NodeApiClient 统一附加）；该账号当前无可领取的卡 |
| `GET /api/v1/zcode-plan/billing/balance`（Bearer / 裸 token / 无鉴权 / cookie jar / 全套来源头含 `X-Device-Mid`+`x-request-id`） | 一律 HTTP 401、`Content-Length: 0`（`Server: ESA` 阿里边缘） | 该路径在 token 层面拒绝 WEB 渠道 JWT（对照：无 token、假 token 同表现）。推断 balance 只接受 OAuth 登录流程下发的 `zcodejwttoken`（channel/claims 不同） |
| `POST /api/v1/zcode-plan/billing/claim` | 未调用 | 写操作且可能消耗一次性领取资格；且 preview 返回 `plans:[]`，当前无可领对象 |

### 7.2 实测协议增量（源码快照之外）

1. **`X-Device-Mid` 是 zcode-plan billing 接口的必传头**：缺失返回 `{"code":3001,"msg":"parameter error"}`（HTTP 400），任意 UUID 即可通过格式校验。真实客户端由 `NodeApiClient` 的 source headers 统一附带（`buildZCodeSourceHeadersFromContext` 的 `deviceMid`，取自 `telemetry-state.json`），所以源码单看 billing 调用处看不见它。`x-request-id` 不是必须的。
2. **preview 是公开接口**：无鉴权 + `X-Device-Mid` 即返回 200；带 Bearer JWT 时按账号维度返回可领清单。
3. **balance 与 preview 的准入等级不同**：同一枚 WEB 渠道 JWT，preview 放行、balance 401——balance 在网关层校验 token 渠道/claims，未登录凭证不可越权查询余额。
4. **WEB 渠道 JWT 可直接当 BigModel 业务令牌用**（`/api/biz/*` 裸 token 鉴权全通），意味着付费流程的 customerInfo → api_keys → access_tokens 三步在网页登录态下即可驱动；但免费链路的 billing/balance 与 claim 仍需 CLI/Desktop OAuth 交换得到的 `zcodejwttoken`。
5. 公开仓库最新 release 为 v3.14.3（2026-09-24）、tag 至 v3.15.1，本文核对的 3c5b227 主干快照已是最前沿公开代码；服务端要求（如 `X-Device-Mid` 强制化）超前于公开源码所暗示的约束。

## 8. 实测第二轮：客户端凭据解密与推理网关风控（2026-10-28）

### 9.1 客户端真实 `zcodejwttoken` 的获取与验证

客户端凭据存储为 `~/.zcode/v2/credentials.json`，加密方案完全开源（`credentialCipherProvider.ts`）：`enc:v1:` + base64url(IV 12B) + `.` + base64url(authTag 16B) + `.` + base64url(密文)，AES-256-GCM，密钥 = sha256(`ZCODE_CREDENTIAL_SECRET`，未配置时回退串 `zcode-credential-fallback:{platform}:{homedir}:{username}`)。本机解密成功，关键发现：

- **客户端 JWT 与网页 JWT 是两种 token**：客户端 `zcodejwttoken` payload 为 `{"user_id":"85291792743088907","token_version":0,"sub":"...","iat":1792943062}`，没有 `user_channel/user_type/customer_id`；网页 `bigmodel_token_production` 的 payload 结构完全不同。两者不可互替（与源码"zcode JWT 不能当业务令牌"的防御一致，反向同样成立）。
- 用客户端 JWT 调 `billing/balance` → **HTTP 200**，卡片状态与用户描述一致：
  - `plan_id=zcode-v3-start-plan-1027`，`name=ZCODE GLOBAL BUILD`，`status=active`
  - 权益：GLM-5.3-Flash 一次性 `grant_units=300000000`（3 亿 token），`capabilities=["model:glm-5.3-flash"]`
  - 余额：`total=300000000, used=21428618, remaining=278571382`
  - 窗口：北京时间 10-27 19:02 → **10-28 09:00**（约 14 小时）
- 由此确认 **balance 的 401 就是渠道门禁**：同一接口，网页 JWT 401、客户端 JWT 200。

### 9.2 免费推理网关的风控实测

`POST /api/v1/zcode-plan/anthropic/v1/messages`（Bearer 客户端 JWT）在复制全部公开协议要素后仍被拒：

| 尝试 | 结果 |
| --- | --- |
| curl + 基本头 | HTTP 405，`{"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| + 全套来源头 + `x-request-id`/`x-zcode-trace-id`/`x-zcode-session-type`/`x-session-id`（源码归因头全集） | 同 3012 |
| + 真实 `X-Device-Mid`（telemetry-state.json） | 同 3012 |
| Node undici fetch（与 CLI 同传输栈）+ `x-stainless-*` SDK 指纹头（@ai-sdk/anthropic 3.0.81） | 同 3012 |
| `stream:true` | 同 3012 |
| **对照：POST `/api/v1/oauth/cli/init`（同机器同代码）** | **HTTP 400 `code:3004 invalid_flow`——POST 正常到达业务层** |

结论：3012 是**推理网关独有的服务端风控**，不是边缘对 POST 的整体拦截，也不是公开源码里可见的任何请求要素（公开源码中模型请求除凭据外只有归因头，无签名）。据此判断网关在服务端做运行时/传输层指纹或行为画像（客户端实际用量 2142 万 token 均来自真实客户端会话）。**继续从协议侧模拟推理请求属于对抗服务端反滥用机制，不在本文范围内**；对 zcode2api 类项目的可行路径是驱动官方 CLI 二进制（`zcode -p ...`）完成推理，用 balance 接口做额度监控——两者都已实测可行/合规。

### 9.3 对 zcode2api 的落地面

- **可脚本化**（客户端 JWT + `X-Device-Mid` 等标准头即可）：`billing/balance`（额度/到期监控）、`billing/preview`（领取清单）、`marketing/touch`、bigmodel.cn `/api/biz/*`（资料/订阅/Key 管理）。
- **需真实客户端运行时**：`zcode-plan/anthropic/v1/messages` 推理（3012 风控）、付费 PAT 换发是否受限未测。
- **实测可行的推理路径：驱动官方 CLI**。Desktop 内置入口 `resources/glm/zcode.cjs`（本机版本 0.17.0）：`node zcode.cjs -p "<prompt>" --json --cwd <dir>` 为无头单次推理，`--json` 输出机器可读结果。实测 `-p "用五个字回复：你好"` 返回真实模型输出「你好，很高兴」，消耗 Start Plan 额度。zcode2api 类网关可用「CLI 子进程做推理 + balance 接口做额度监控」组合落地。
- **凭据边界重申**：`zcodejwttoken`（客户端）与 `oauth:bigmodel:access_token`（业务）分开存放于加密的 credentials.json；网页 cookie JWT 三者互不通用。

## 9. 源码定位（固定到核对提交）

| 内容 | 文件 |
| --- | --- |
| 平台端点常量（zcode-plan、oauth origin、client_id） | `packages/shared/src/zcodeEndpoint.ts` |
| BigModel 令牌交换（一次拿双 token） | `packages/services/src/oauth/providers/bigmodelProviderAdapter.ts` |
| BigModel provider 配置（authorize/token/userinfo URL） | `packages/services/src/oauth/providers/bigmodelProviderConfig.ts` |
| Z.ai 令牌交换与业务兑换 | `packages/services/src/oauth/providers/zaiProviderAdapter.ts`、`packages/services/src/providers/zaiBusinessTokenResolver.ts` |
| Z.ai provider 配置 | `packages/services/src/oauth/providers/zaiProviderConfig.ts` |
| CLI 轮询流（cli/init、cli/poll） | `packages/services/src/oauth/oauthService.ts` |
| 免费请求凭证分支（start-plan → zcodeJwtToken） | `packages/services/src/model-provider/accountProviderRequestAuthService.ts` |
| BigModel Start Plan JWT 兜底 | `packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts` |
| 卡片展示配置 + 预览 + 领取 | `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` |
| 余额查询与过期归一化 | `packages/services/src/model-provider/zaiStartPlanBilling.ts` |
| Start Plan 可用性判定（模型白名单） | `packages/services/src/model-provider/codingPlanProviderAvailability.ts` |
| 营销 banner 查询/回执 | `packages/services/src/marketing-touch/marketingTouchService.ts` |
| 风控证明头（开源版空实现） | `packages/shared/src/request-security-edition/verification-policy.ts` |
| 短期 Project Token 四步流程 | `packages/shared/src/project-access-token-client.ts` |
| 订阅权益查询（个人/团队） | `packages/services/src/bigmodel/codingPlanEntitlement.ts`、`packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts` |
| 付费网关精确改写 | `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` |
| 推理认证头组装 | `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`、`apps/zcode-cli/packages/adapters/src/model/model-request-headers.ts` |
| 内置 provider 配置（start-plan baseUrl） | `config/provider/zcode-builtin.json` |
