# ZCode 自动续期核查

核查日期：2026-10-29（Asia/Shanghai）。范围：本机官方程序、zcode2api 实现、当前账号凭据元数据及余额接口。未触发重新登录或替换账号凭据。

## 结论

本机官方 ZCode 没有实现 BigModel/Z.ai **登录令牌的 refresh-token 交换**。桌面端启动时主要恢复已有凭据，并不需要每次重新登录。Z.ai 另有业务令牌兑换缓存，但它不续期 ZCode JWT，也不能使已过期的原 OAuth 令牌恢复有效。

本项目当前的“续期”是 OAuth 再授权；401 自动处理只负责生成链接与通知，尚未自动复用浏览器会话完成授权。不能承诺当前已支持长期无人值守续期。

## 官方程序证据

安装目录：`D:/Users/Acer/AppData/Local/Programs/ZCode/resources`。

- `app.asar/package.json`：版本 **3.16.3**，与项目默认配置中的 3.16.2 不同。
- 授权实现实际位于 `app.asar/out/host/index.js`，不能只搜索 `glm/zcode.cjs` 就认定核查了桌面登录实现。
- host 文件长度 2,074,639 字节，SHA-256：`9c86fb849e8878f6610a240ddfa28c1f166b229991b02c9f3c9449e2b661b3b3`。
- 以下偏移为该文件解码为 JavaScript 字符串后的零基字符位置，升级后需要重新核对。

| 位置/类 | 核查结果 |
| --- | --- |
| `BigModelProviderAdapter`，约 1,094,975 | 授权码经 `/api/v1/oauth/token` 兑换为 ZCode JWT 和 BigModel access token；可保存返回的 refresh token；类中没有 `refreshToken` 实现。 |
| `ZaiProviderAdapter`，约 1,101,724 | 授权码交换后用 Z.ai OAuth access token 兑换业务令牌；类中没有 `refreshToken` 实现。 |
| `OAuthService.refreshToken`，约 1,126,581 | 检查 `adapter.refreshToken`；缺失时直接抛出“OAuth 暂未提供 refresh token 交换接口，请重新登录”。这是客户端能力边界，不是服务端不存在任何刷新接口的证明。 |
| `OAuthService.restoreCachedSessionState`，约 1,114,000 | 从持久化存储恢复账号资料和凭据，检查 JWT 的 exp；发现已过期 JWT 时清除会话并要求再授权。没有 exp 时不能据此判定已过期。 |
| `OAuthService.restoreSession`，约 1,118,792 | 读取已保存 token 并查询资料验证；鉴权失败时登出，没有先用 refresh token 自动恢复。 |
| `ZaiBusinessTokenResolver`，约 1,098,146 | 业务令牌剩余时间超过 5 分钟时复用缓存，否则在下一次 resolve 时 POST `/api/auth/z/login`，请求体 `{token: 原 OAuth access token}`。不是周期刷新计时器。 |

运行时 `glm/zcode.cjs` 中另有 `ZaiBusinessTokenCache`：按业务令牌的 JWT exp 与 expires_in 取更早到期时间，提前量 2 分钟；它服务于业务/project-token 链路，不刷新 ZCode 登录令牌。文件里的 Vercel 和 MCP refresh-token 逻辑属于其他服务，不能混用为 ZCode 账号刷新接口。

## 当前账号实测

只输出凭据类型和有效期元数据，没有在报告中保存令牌本体。余额核验为本次直接请求结果；数据库 active 状态单独不足以证明在线有效。

| 账号 | 来源 | 当前余额核验 | 已保存凭据 | 有效期信息 |
| --- | --- | --- | --- | --- |
| `acc_b8867d74` / BigModel | 本机导入 | HTTP 200，业务成功 | ZCode JWT、业务令牌、平台标记 | 两种令牌均无 exp；ZCode JWT 与本机客户端当前保存值相同。 |
| `acc_dead8de9` / Z.ai | OAuth | HTTP 200，业务成功 | ZCode JWT、业务令牌、原 OAuth access token、平台标记 | ZCode JWT 无 exp；原 OAuth access token 的 exp 为 2026-10-29 11:05:08（北京时间）。它与 ZCode JWT 是不同凭据，原 OAuth 到期不能直接判定 ZCode JWT 到期。 |

两个账号都没有保存 `web_jwt`，也没有登记网页 Cookie 到期时间。不能据此判断外部浏览器是否仍登录；本次没有检查外部浏览器的 Cookie 或本地存储。

## 本项目当前行为

- `src/httpclient.js` 的 CookieJar 保存响应 Set-Cookie，主要用于平台请求的 Cookie 连续性；Cookie 轮换不等于签发新的登录 JWT。
- `src/accounts.js:294` 的 `refreshWebCookie` 需要用户提供新网页 JWT，验证后替换；没有请求自动刷新接口。
- `src/accounts.js:319` 的 `pingWebOnly` 查询 getCustomerInfo，只记录检查结果。
- `src/poller.js:68` 在 balance 401 后标记 needs_relogin 并调用 `ensureReauthFlow`。
- `src/admin/api.js:510` 的 `ensureReauthFlow` 生成授权链接和通知；没有自动打开浏览器或执行授权。
- `src/admin/api.js:457` 的 `completeOAuth` 完成后更新凭据、重启账号运行时并验证余额；Z.ai 业务令牌也只在这里兑换，没有定时续期。
- 本机导入只在调用时读取一次官方凭据，同身份重复导入会跳过；没有监控本机文件变化并自动同步令牌。

## 如何尽量免重登

合理的候选方案是：每个账号首次登录时保存独立浏览器会话 → 鉴权失败后先复用该会话打开 OAuth authorize_url → 由现有 CLI 轮询收取新凭据 → 校验账号身份与余额 → 更新原账号。复用网页会话可望免输密码，但属于再授权，并非延长旧 Cookie 或旧 JWT 的有效期。

实施前需要实际验证 BigModel 和 Z.ai 的授权页是否允许免交互完成、需要哪些会话数据，以及再授权是否影响仍在使用的旧令牌。现有 API token 响应不会自动带回浏览器 Cookie，单个网页 JWT 也未证明足够。登录会话失效、验证码或要求确认时仍可能需要用户操作。

**仍未验证**：服务端是否有客户端未使用的刷新接口；请求 balance/getCustomerInfo 是否延长服务端会话寿命；网页 Cookie 的自动轮换与固定寿命；持久浏览器会话的端到端静默授权。因此不以“保活成功”推断“续期成功”，也不主动周期重签当前有效凭据。
