# zcode2api

ZCode 多账号免费额度管理器与推理网关（Start Plan 赠卡）。参照 workbuddy-manager 形态，为 ZCode 免费链路提供：账号纳管、额度轮询、自动领卡、多账号推理调度与 OpenAI/Anthropic 兼容出口。

## 架构要点

- **推理层驱动官方运行时**：`zcode-plan/anthropic/v1/messages` 直连协议模拟已被服务端风控（3012）证伪，本项目通过官方 `zcode.cjs app-server`（stdio JSON-RPC）驱动推理，不绕过风控。
- **每账号独立运行时**：用官方环境变量 `ZCODE_DATA_BASE_DIR` / `ZCODE_STORAGE_DIR` / `ZCODE_CREDENTIAL_SECRET` / `ZCODE_TELEMETRY_DEVICE_MID` 做进程级隔离，凭据以官方 `enc:v1` AES-256-GCM 格式写入隔离目录。
- **宿主仿真（HostEmulator）**：实现官方宿主职责——`provider/updateAccountConfig` 注入账号（`basedOnZCodeBuiltinRevision` 必须精确等于 `zcode-builtin:<rev>:<sha256(内置配置路径)>` 指纹）、`interaction/requestProviderRuntimeHeaders` 回账号 JWT 鉴权头、`session/requestRuntimePreferences` 15s 内应答。
- **会话流行为画像**：走 `session/create + session/send + session/subscribe(desktop-continuous)` 主链路，与桌面端 `main_turn` 同构（`x-zcode-session-type: main`、`x-zcode-query-source: main_turn`），事件流按 `params.type`（turn.completed/failed、model.streaming）归一。
- **调度与重试**：分组链（默认单分组「默认池」，可自行增删）+ `expiring_first`（180min 临期窗口）策略；官方错误分类表（3008/3009/3010 并发上限→立即换号；401→needs_relogin；3103 额度耗尽→换号；429/5xx→退避）；每账号 inflight=1；流式首 token 前可整体重放。账号恢复（轮询/手动 verify/领卡成功）即清空调度器熔断，401 死账号 relogin 后立即可用。
- **黏连调度**：密钥可配 `sticky_minutes`，窗口内同密钥黏住同一账号，复用上游前缀缓存（KVCache）省钱提速。
- **反代支持**：`trust_proxy: true` 时 `req.ip` 取 X-Forwarded-For，IP 白名单与审计日志才是真实客户端；白名单支持 IPv4 CIDR（`10.0.0.0/8`）、前缀通配（`1.2.3.*`）与精确 IP。
- **忙碌排队**：账号本地占用或上游返回 3008/3009/3010 时，在排队窗口内持续尝试换号（默认 60 秒，`retry.busy_wait_sec` 可调，0/负数回退 10s 兜底）；有其他空闲账号时优先切换，全忙时排队等待而非快速失败，最终 529/503 响应带标准 `Retry-After` 头（下游如 Claude Code SDK 按此退避）。流式内容或工具调用已发送后不会重放。该窗口不限制正常推理耗时，也无法中断已经发出的上游请求。
- **客户端工具调用**：OpenAI Chat Completions、Anthropic Messages 和 Responses 的 function 工具通过会话级 MCP 桥接；调用结果默认须在 10 分钟内使用相同密钥、模型和调用 ID 提交（可通过 `tool_result_timeout_sec` 设置为 60–3600 秒）。会话仅保存在内存，服务重启会中断待处理调用。工具流式响应按完整片段发送，不是逐 token 流式。当前仅支持自动工具选择，强制工具选择、关闭工具、禁止并行、严格 schema 和旧版 functions 不支持。会话完成后记录用量；未完成的会话可能无法取得最终用量。
  - 非 function 类型工具（Codex 的 `namespace:multi_agent_v1`、`web_search` 托管工具、custom 自由工具）自动跳过并记 warn 日志，不再整单 400。
  - 客户端回执网关不认识的 tool_result（服务重启丢失会话 / 客户端自答回执等）时降级为普通文本回合继续对话，不再 400 打断会话。
  - 未声明 tools 的请求会在会话层禁用运行时内置工具（空 toolAllowlist）——否则模型会自行调用并执行内部工具，且向未声明工具的客户端泄漏 tool_use 块（真机实测）。
- **max_tokens**：网关层接收该参数（兼容客户端），但运行时 `session/create` 的严格 schema 已明确拒绝（Unrecognized key，实测），不再向上游透传——不保证遵守客户端输出上限。

- **明确不做（冗余裁剪）**：废卡率仪表 / 废卡作废登记 / 7 天领卡成功-尝试统计；`marketing/touch/action` 点击回执；`billing/current`（已废弃）、付费与企业链路（`/api/pay/*`、订阅管理、org/project、keyType=2）、legacy 凭证迁移、登录归因（attribution）解析、主动解 captcha。保活每族只 ping 一个最轻端点。
- **按账号出站代理**：账号可配 `proxy_url`（http(s)://host:port）——推理运行时经官方 `ZCODE_HTTP_PROXY` 环境变量走代理，balance/claim 等平台流量经 undici dispatcher 走代理；留空跟随全局 `proxy_url`（无则直连）。代理变更保存时自动重启该账号运行时。
- **绑定分离**：`bind_public:true` 只公开**网关**；管理面默认始终绑 `host`（127.0.0.1），需同时 `admin_bind_public:true` 才公开（收紧性变更：早期版本 bind_public 会连带公开管理面）。管理面不带 CORS 头（同源使用）。
- **槽位上限**：`max_slots`（默认 8，0=不限）约束并发运行的运行时子进程数（每槽位≈一个 Node 进程 80-150MB）；超限时回收最旧空闲槽位，全部忙碌则软超限放行并告警。
- **runtime_bin 自动探测**：默认按平台探测 ZCode 桌面安装位（Windows `%LOCALAPPDATA%/Programs/ZCode`、macOS 应用包、Linux `~/.local/share/ZCode`）；可用 `ZCODE2API_RUNTIME_BIN` 环境变量或 config.json `runtime_bin` 覆盖。启动时文件缺失会给出明确指引后退出。

## 启动

```bash
npm install
node src/index.js
```

- Web 控制台与出口网关默认绑定**随机端口**（打印在控制台并写入 `data/ports.json`）。
- 管理密码首次启动自动生成（`data/admin-password.txt`）。
- 固定端口：项目根目录 `config.json`（参考 `config.example.json`）配 `{"web_port":N,"gateway_port":N}`，`0`=随机。

## 接入示例

```bash
# OpenAI 兼容
curl http://127.0.0.1:<gateway_port>/v1/chat/completions \
  -H "Authorization: Bearer <网关密钥>" -H "content-type: application/json" \
  -d '{"model":"glm-flash","messages":[{"role":"user","content":"你好"}],"reasoning_effort":"high"}'

# Anthropic 兼容（基本文本和工具回环；复杂客户端兼容性尚未完全验证）
POST /v1/messages   （thinking.budget_tokens → low/high/max 档位）
# OpenAI Responses API 兼容（基本文本和工具回环；Codex CLI 兼容性尚未完全验证）
POST /v1/responses        （input 支持 string 与 message 数组；instructions→system；reasoning.effort）
GET  /v1/responses/:id    （内存 LRU 最近 100 条，进程重启即失）
GET  /v1/models     （池内 capabilities 动态并集）
GET  /v1/usage      （密钥自查）
POST /v1/messages/count_tokens
```

思考强度：`reasoning_effort`/`thinking_level`/`thinking.budget_tokens` → `low|high|max`（默认 high；卡模型强制要求显式档位）。

## 账号纳管（三路径）

1. **本机导入**（推荐）：读取 `~/.zcode/v2/credentials.json`（官方回退密钥解密）+ `telemetry-state.json` 的 device_mid，balance 加验后建档。
2. **OAuth 轮询**：`cli/init` → 浏览器授权 `authorize_url` → `cli/poll` 返回令牌（兼容授权码交换；zai 族再过 `/api/auth/z/login` 铸业务 JWT）→ 加验建档。控制台引导三步：打开授权页登录 → 回到控制台等待 → 登录成功自动提示并加入账号库（成功面板展示验证结果，可一键跳转账号页高亮新行）。授权回执由服务端持久化（`oauth_flows.noticed_at`），弹窗关闭、切换页面甚至换浏览器标签后完成登录，控制台每 5s 全局收割仍会 toast 提醒并刷新账号列表。
已有账号可在账号表点击「续期」重新授权，身份一致时更新原账号并重启运行时；也可粘贴重新获取的网页 JWT，验证身份和有效性后更新。网页会话检查不保证延长有效期，本项目尚未实现自动静默续期。

**401 再授权通知**：账号凭证失效（轮询或推理 401）时，服务端自动为该账号生成 OAuth 再授权链接（绑定原账号身份）并推送到通知 webhook；用户完成授权后自动换凭据、重启运行时并解除调度熔断。同账号 30 分钟节流（流程过期后自然轮换新链接），手动发起可用账号表「续期」或 `POST /api/accounts/:id/reauth`（force 绕过节流）。本机 ZCode 3.16.3 的 BigModel/Z.ai 登录适配器未实现 `refreshToken`；这只能证明客户端未提供该能力，不能证明服务端不存在刷新接口。复用有效的浏览器登录态完成再授权是免输密码恢复的候选方案，本项目尚未实现或验证。详见 [自动续期核查](ZCode_自动续期核查.md)。

3. **Cookie 导入**（受限 `web_only`）：网页会话 JWT 仅可资料/getCustomerInfo 保活/preview，不可 balance 与推理（渠道门禁，实测 401）。

## 安全与边界

- 只管理本人自愿授权的账号；不做批量注册、账号交易、风控绕过。
- 凭证 AES-256-GCM 加密落盘（机器主密钥 `data/secret.key`）；网关密钥只存 sha256 哈希。
- 默认只绑 127.0.0.1；公网部署请走反代 + HTTPS。
- claim 失败按业务码展示，不做验证码绕过。

## 目录

```
src/
├── index.js            入口装配（双端口、随机端口、优雅退出）
├── config.js / db.js / log.js / crypto.js / httpclient.js
├── zcodeApi.js         平台接口（balance/preview/claim/configs/touch/oauth）
├── accounts.js         账号三路径纳管 + 状态机 + 体检
├── poller.js           QuotaPoller（快照/聚合/退避/到期改判）
├── claims.js           领卡中心（三路发现 + 领取 + 定时 + 通知）
├── scheduler.js        调度器（分组链/策略/inflight/调度解释日志）
├── retry.js            官方错误分类表 + 退避 + 流式边界
├── bridge/             RuntimeSlot(隔离子进程) + HostEmulator + SessionDriver + Pool
├── gateway/            OpenAI/Anthropic 兼容层 + 密钥 + 推理编排
├── admin/              管理面 REST + 会话
└── web/                控制台（原生 JS，无构建链）
test/                   协议探测脚本（开发用）
```

授权流程加密保存到本地数据库，服务重启后可在添加账号窗口继续未过期授权；如果重启恰好发生在一次性授权结果处理期间，需要重新授权。已知网页 Cookie 到期时间时，账号页显示剩余时间，并在 7 天、24 小时和到期时记录通知；配置 webhook 后也会推送。到期时间未知时不能准确提醒。

## Claude Code 本机试用

重启 zcode2api，在管理面创建网关密钥。PowerShell 从项目目录启动 Claude Code（替换密钥占位符）：

```powershell
$ports = Get-Content -Raw data/ports.json | ConvertFrom-Json
$env:CLAUDE_CONFIG_DIR = Join-Path $env:TEMP 'zcode2api-claude'
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($ports.gateway_port)"
$env:ANTHROPIC_API_KEY = '<网关密钥>'
$env:ANTHROPIC_AUTH_TOKEN = $env:ANTHROPIC_API_KEY
claude --model glm-5.3-flash
```

这里使用独立的 Claude Code 配置目录，避免已有配置中的 `ANTHROPIC_BASE_URL` 覆盖测试地址；它不会使用原有目录中的个人配置。`ANTHROPIC_BASE_URL` 不要添加 `/v1`，Claude Code 会自行追加。已用 Claude Code 2.1.308 真机验证读取、连续对话、编辑和执行测试（注意 Windows 上 shell 工具名为 **PowerShell**，`Bash` 工具名仅 macOS/Linux 有效）；回归夹具 `node test/live-claude-code.mjs`。运行时当前不接受 `maxOutputTokens`，因此不能保证严格遵守客户端的输出上限。

## Codex CLI 本机试用

`codex exec` 走 `/v1/responses`（`wire_api = "responses"`），shell 工具回环已用 codex-cli 0.162.1 真机验证；回归夹具 `node test/live-codex.mjs`。`CODEX_HOME/config.toml` 配置（密钥经环境变量 `Z2A_API_KEY` 传入）：

```toml
model = "glm-5.3-flash"
model_provider = "z2a"

[model_providers.z2a]
name = "zcode2api"
base_url = "http://127.0.0.1:<gateway_port>/v1"
wire_api = "responses"
env_key = "Z2A_API_KEY"
```

注意：Codex 固定携带不支持的 `namespace:multi_agent_v1` / `web_search` 工具类型，网关自动跳过；其 Windows 沙箱（workspace-write）默认拦截 shell 执行，验证工具回环需 `--sandbox danger-full-access` 或在审批模式下放行——这是客户端本地沙箱行为，与网关无关。流式失败会以规范 `response.failed` 事件收尾，Codex 能读到具体错误而非「流提前断开」。
