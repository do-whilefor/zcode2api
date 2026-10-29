# Go 后端迁移

迁移日期：2026-10-29。

## 实现范围

生产入口为 `main.go`，业务实现位于 `internal/server/`。HTTP 双端口服务、配置热更新、SQLite、凭据加解密、账号导入、OAuth 与重启恢复、余额轮询、自动领卡、分组调度、密钥限制、三种 API 及 SSE 转换均由 Go 实现。生产进程不调用 Node.js，不启动任何 CLI 子进程。

控制台继续使用原有 HTML/CSS/浏览器 JavaScript，通过 `go:embed` 打包进二进制。它不是 Node 后端；控制台页面和客户端地址不需要因为换语言而修改。

`internal/server/request.go` 保存原协议前缀，`upstream.go` 保存请求头与解码逻辑。User-Agent 中保留已核对协议画像的 `runtime/node.js/24` 字段，仅用于协议兼容，不表示程序依赖或运行 Node。

## 数据兼容

- 使用原 `data/zcode2api.db` 与原表结构，只补齐旧库缺列。
- 使用原 `data/secret.key` 和 `enc:v1:IV.tag.ciphertext` AES-256-GCM 封装，已有账号与网关密钥无需重新导入。
- 保留 `config.json`、环境变量、数据库设置覆盖、代理、端口及模型别名。旧 runtime 配置强制迁至 http。
- OAuth 轮询令牌仍加密存库，可恢复未过期的 pending 流程。令牌交换中断会要求重新授权。
- 管理登录会话和 Responses 历史仍为进程内数据，重启后需要重新登录管理台；原有网关 API Key 不变。

不要让 Node 和 Go 两个实例同时管理同一个数据目录。切换前先停旧服务，再用 SQLite 备份接口或完整复制已停服务的数据目录，数据库与主密钥须一起保存。

本次工作区原 Node 源码和测试已另存到本机忽略目录 `data/migrations/node-source-before-go.zip`，以保留迁移前尚未提交的实现；该压缩包不包含账号数据库或密钥，不是数据备份。

## 构建与验证

```sh
go build -trimpath -o bin/zcode2api .
go test ./...
go vet ./...
go test -race ./...
```

Windows 后台运行：`scripts/start.ps1`；停止：`scripts/stop.ps1`。Windows 停止脚本核对 Go 进程绝对路径；迁移完成后的清理已移除旧 Node 进程识别分支。

Go 回归使用本地模拟上游和临时数据目录，不使用真实账号额度。`testdata/node-compatibility.json` 是迁移前从当前 Node 实现离线生成的协议转换与加密兼容样本。测试覆盖三协议流式/非流式、工具参数与签名、历史隔离、开始输出后禁止重放、全池 10 秒限流窗口、Retry-After、取消、超时、并发调度、旧库、OAuth 恢复、领卡互斥及用量统计。

原 Node 后端的 61 项离线测试在迁移前全部通过。控制台的两份浏览器逻辑测试保留，可选执行 `node --test test/web-*.test.mjs`；不需要 npm 依赖。

迁移时的验证结果：Go 完整测试、`go test -race ./...` 和 `go vet ./...` 通过；当时后端语句覆盖率 72.5%；控制台 5 项测试通过；Windows 可执行文件已构建并启动，Linux amd64 交叉构建通过。后续优化见 [链路优化记录](chain-optimization.md)。

本机已从 Node 进程切换为 `zcode2api.exe`，继续使用控制台 6789 与网关 6780。两个健康端点和控制台首页正常，管理接口可读取 2 个账号及 1 个密钥；迁移前后账号加密凭据、网关密钥及用量、主密钥一致。切换前还通过 SQLite backup 接口保存了数据快照，路径记录于本机 `data/migrations/latest-data-backup.txt`；这份备份包含敏感数据，应和原数据目录同样保管。

真实上游生成速度与 Go/Node 性能差异未作对照测试，不能据此次迁移声明具体提速比例。Dockerfile 已改为 Go 多阶段构建；容器部署仍需在运行 Docker Engine 的机器上构建验证。
