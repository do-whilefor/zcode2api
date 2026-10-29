# zcode2api

Go 编写的 ZCode 多账号额度管理与 HTTP 推理网关，提供 OpenAI Chat Completions、Responses 和 Anthropic Messages 兼容出口。

网关只使用 HTTP 直连，不启动 ZCode CLI、app-server 或 MCP 工具中转进程，也不要求安装 ZCode。工具由 Claude Code 等客户端执行，下一轮携带结构化工具结果继续请求。账号登录、余额与领卡沿用本人授权的 ZCode 账号。

## 启动

源码构建需要 Go 1.26 或更高版本；编译后的服务不需要 Node.js、npm 或 ZCode。控制台静态资源内嵌进可执行文件：

```bash
go build -trimpath -o bin/zcode2api .
./bin/zcode2api --root .
```

控制台与网关默认使用随机端口，写入 `data/ports.json`。首次管理密码写入 `data/admin-password.txt`。固定端口等配置见 `config.example.json`；不要覆盖自己已有的 `config.json`。

Windows 后台启动与停止（启动脚本自动构建 `bin/zcode2api.exe`）：

```powershell
.\scripts\start.ps1
.\scripts\stop.ps1
```

Docker：`docker compose up -d --build`。默认管理面为 `http://127.0.0.1:8765`，网关为 `http://127.0.0.1:8766/v1`。部署、反向代理、升级与持久化说明见 [部署文档](docs/deployment.md)。

## 推理与限流

请求链路：客户端 → 网关鉴权与账号调度 → ZCode HTTP Messages/SSE → 转换回客户端协议。

- **限流先换号**：429、限流业务码、3008/3009/3010 并发忙碌、过载响应先立即尝试其他账号，黏连不会阻挡换号。
- **全池限流才等待重试**：当本次可用账号都遇到限流后，开启全池共享的 **10 秒**窗口。窗口内轮流重试，不设次数上限，不受 `max_attempts` 限制。默认同账号间隔 1 秒，遵循上游 `Retry-After`；上游要求等待更久时，不提前请求它。
- **窗口结束**：仍未恢复则返回对应的限流/忙碌错误。非流式 429/503/529 携带 `Retry-After`，流式用所属协议的错误事件结束。
- **额度耗尽与凭证失效**：立即从本次请求排除并换号，不等待余额刷新；耗尽账号异步查询余额，失效账号标记为需要重新授权。
- **安全重试边界**：首个正文、思考或工具调用发出后禁止整轮重放。Anthropic 前导事件暂存到实际内容开始，首字前的 SSE 错误仍可安全换号。
- **本地排队独立**：账号正在处理其他请求时，`retry.busy_wait_sec` 控制等待空闲的时间，默认 60 秒；它不是上游限流的 10 秒重试窗口。
- **空闲通知**：账号释放或资料更新时唤醒排队请求；调度查询与余额解析在预留名额的锁外完成。
- **超时独立**：`http.first_token_timeout_ms` 默认 60 秒，`http.idle_timeout_ms` 默认 120 秒。`http.total_timeout_ms` 默认为 0，持续输出不会因重试预算而在 120 秒被截断。客户端断开会取消上游与重试等待。
- **普通失败**：网络/服务端错误保留退避与 `max_attempts`，`retry.total_budget_ms` 用于常规排队/重试，不限制已经开始正常生成的整轮时长。

旧配置中的 `inference_driver: "runtime"` 会迁移为 HTTP，废弃的运行时设置会被忽略或清理。CLI/MCP 桥接模块、旧工具路由和运行时探测脚本已删除。

## 接入

先在控制台创建网关密钥。网关密钥是本项目签发的密钥，不是账号 JWT。

| 客户端协议 | Base URL | 主要端点 |
| --- | --- | --- |
| OpenAI Chat | `http://127.0.0.1:<gateway_port>/v1` | `POST /v1/chat/completions` |
| Anthropic / Claude Code | `http://127.0.0.1:<gateway_port>` | `POST /v1/messages` |
| Responses | `http://127.0.0.1:<gateway_port>/v1` | `POST /v1/responses` |

支持 `Authorization: Bearer <密钥>` 或 `x-api-key`。模型使用 `GET /v1/models` 返回的 ID，默认别名 `glm-flash` 指向 `GLM-5.3-Flash`。模型白名单、按密钥额度、到期时间、IP 白名单、分组链和会话亲和继续生效。

```bash
curl http://127.0.0.1:<gateway_port>/v1/chat/completions \
  -H "Authorization: Bearer <网关密钥>" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-flash","messages":[{"role":"user","content":"你好"}],"reasoning_effort":"high"}'
```

Claude Code 可设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY`，并用 `claude --model glm-5.3-flash` 启动。Base URL 不添加 `/v1`。客户端显式思考档位优先于密钥与全局默认，不自动降档；`[1M]` / `[200K]` 模型后缀仅为客户端提示，不代表上游保证相应上下文容量。

思考输出：Chat 使用 `reasoning_content` 扩展，Anthropic 保留原生 thinking/signature 块，Responses 使用 reasoning summary 事件。工具 ID、结构化工具历史、参数增量和用量保留；参数透传不等于上游保证严格 schema 等功能。

## 账号与控制台

- 支持本机凭据导入、OAuth 授权、网页 Cookie 导入；网页账号仅用于平台接口，不能参与推理。
- 按模型展示余额、已用与到期时间，自动轮询额度并按实际可领取清单领卡。
- 支持按账号与全局设置出站代理；HTTP 请求即时读取配置。
- 默认仅监听 127.0.0.1；管理端口和网关端口独立。
- 凭据 AES-256-GCM 加密落盘，网关密钥仅保存哈希。
- 用量与性能记录区分排队、重试等待、首字、首个思考、首个正文和总耗时；管理接口为 `/api/performance` 与 `/api/usage/logs`。

## 已知边界

这是 ZCode 非公开 HTTP 协议适配，需要必要的系统前缀，不是零附加上下文的透明代理。协议画像与实测记录见 [HTTP 迁移核查](docs/http-migration-assessment.md)。

- `http.client_version` 只调整 HTTP 客户端版本头。系统前缀仍由 `internal/server/request.go` 与 `internal/server/upstream.go` 中的已核查画像定义；修改版本号不意味着自动适配新协议。
- 跨协议支持客户端 function 工具。托管 web_search、namespace/custom 等不支持的类型明确返回错误，不伪装为可用；因此不能保证所有版本的 Codex CLI 完整兼容。
- 跨协议思考签名、部分多模态块、对话中途的 system/developer 消息，以及多个不同的 system 缓存策略，存在转换边界。
- `POST /v1/messages/count_tokens` 仍为本地粗估，不能用于精确上下文预算。
- Responses 的 `previous_response_id` 按密钥隔离，历史最多 100 条 / 64MB，进程重启会失效；完整客户端历史可独立继续。`store:false` 不保存。
- OAuth 再授权需要用户完成授权页；没有已验证的 ZCode JWT 静默刷新接口。保活成功不能证明令牌已续期。

## 验证

`go test ./...` 运行离线回归，包括原 Node 协议快照对照、旧库/加密兼容、三协议流式与非流式、OAuth 流程恢复、额度和领卡、全池限流的 10 秒窗口、并发调度、取消与超时边界。`go vet ./...` 做静态检查。

控制台仍使用浏览器 JavaScript；可选执行 `node --test test/web-*.test.mjs` 验证输入法和视图逻辑，不需要安装 npm 依赖。

真实上游调用未包含在离线测试中。迁移说明、备份和验证范围见 [Go 迁移记录](docs/go-migration.md)。

本地链路的优化范围和可复现基准见 [链路优化记录](docs/chain-optimization.md)。
