# HTTP 网关部署

## Docker

```sh
docker compose up -d --build
docker compose logs -f
```

镜像包含 Go 可执行文件、CA 证书和时区数据，控制台资源已内嵌，不安装 ZCode 或 MCP 中转。管理面映射到本机 8765，网关映射到本机 8766；默认两个端口都只对宿主机回环地址公开。容器内部监听 0.0.0.0，以便端口映射访问。

`./data` 必须持久化，包含数据库、加密主密钥、授权进度和首次管理密码。复制迁移时需一起保存数据库及 `secret.key`；运行中请使用 SQLite 备份机制或先停服务再复制，避免漏掉 WAL 数据。宿主机 config.json 不会自动进入镜像，需要时显式挂载到 `/app/config.json:ro`；端口环境变量优先。

首次启动后在控制台完成 OAuth，不依赖容器内的本机凭据导入。管理密码见 `data/admin-password.txt`。默认镜像健康检查只请求本机 `/healthz`，不会调用上游或消耗额度。

升级：保存好数据卷，更新源码后执行 `docker compose up -d --build`。发布前可记录当前 Git 提交以便回到旧版重新构建。没有容器内在线覆盖更新。

Docker 标准输出日志按 10MB × 3 份轮转；应用自身的 `data/logs/app.log` 和数据库日志目前仍需管理员按保留需求维护，不能把 Docker 日志轮转当作全部存储上限。

## Windows

安装 Go 1.26+，运行 `scripts/start.ps1` 自动构建并启动。已构建的 `bin/zcode2api.exe` 可独立运行，无需 Go 工具链或 Node.js。脚本隐藏窗口运行，输出写入 `data/service.stdout.log` 和 `data/service.stderr.log`。`scripts/stop.ps1` 核对 PID、本项目 Go 可执行文件的绝对路径后停止；不匹配时拒绝停止其他进程。停止后未完成请求会中断。

前台方式为 `go run .` 或 `bin/zcode2api.exe --root .`，Ctrl+C 退出时会停止轮询并取消上游请求。后台停止脚本使用 Windows Stop-Process，未完成请求会中断。

## 端口与反向代理

原生部署默认随机端口；在 config.json 设置 `web_port` / `gateway_port` 固定。环境变量支持 `ZCODE2API_WEB_PORT`、`ZCODE2API_GATEWAY_PORT`、`ZCODE2API_HOST`、`ZCODE2API_DATA_DIR` 和 `ZCODE2API_ADMIN_PASSWORD`。设置页配置持久化在数据库，除端口等静态选项外，启动时可覆盖文件配置。

通过 Nginx 暴露网关时可参考：

```nginx
location / {
    proxy_pass http://127.0.0.1:8766;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 180s;
    client_max_body_size 32m;
}
```

TLS 在反向代理配置。网关每 15 秒发送 SSE 心跳。只有入口被可信反向代理隔离时才启用 `trust_proxy`；该选项影响 IP 白名单和审计来源。管理面建议保留回环地址，通过本机浏览器或受控隧道访问。

`GET /healthz` 表示服务进程存活；`GET /readyz` 根据本地是否存在 active 账号返回 200/503，并给出数量。这不是上游实时可用性承诺，也不会为了健康检查反复请求模型。

## HTTP 协议维护

设置页 `http` 配置独立控制首字、空闲和整轮超时；整轮默认 0，不会因为常规重试预算而截断长输出。`client_version` 调整请求头，不能替代协议核查。

上游升级时先核对 `internal/server/request.go` 和 `internal/server/upstream.go` 的版本、归属头与必要系统前缀，再运行 `go test ./...`，最后显式执行合成内容的 HTTP 活体验证。保留错误业务码与请求 ID；不要把账号 JWT 或完整业务提示写进诊断报告。

精确 token 计数、跨协议思考签名、静默刷新账号和重启后 Responses 历史，仍需相应上游接口或持久化方案验证，不能通过改请求头补齐。
