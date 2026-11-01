# 代理与上游安全验证

[返回 README](../README.md) · [配置与重试说明](configuration.md)

## 排查上游 HTTP 405

若错误包含 `upstream_waf_blocked`、`Server=ESA` 和 `EagleId`，表示请求被上游安全网关拦截；仅凭 405 不能判断为请求方法错误、客户端版本过旧或账号失效。可使用同一账号和请求体，对比部署服务器直连与本人可用的出站代理，保留追踪 ID 供上游排查。

## 出站代理

在控制台「设置 → 出站代理」配置全局代理，并分别控制「启用全局代理」与「启用代理轮询」。保存后对后续请求生效，重启后保留。关闭全局代理会恢复直连；「账号 → 编辑 → 出站代理」中的单独设置优先，且固定使用该账号代理。项目不会自动读取 Windows 系统代理。

### 手填与轮换

手填模式每行填写一个 HTTP/HTTPS 代理地址，支持带用户名和密码的代理。关闭轮询时固定选第一个地址；开启后由「轮换间隔（秒）」控制：默认 `0`，每个新的上游操作或推理尝试按顺序轮换；设为 `1` 到 `86400` 时，间隔内的新操作共用当前节点，到期后的下一个新操作切换至下一节点，没有请求时不会空转。此间隔与订阅刷新间隔独立。每次验证码配置获取、SDK 请求、携带票据的推理及过期票据重验均固定在同一个代理入口，不会在中途轮换。普通网络错误（包括场景配置获取时的连接断开）按现有策略重试；轮询时暂时跳过连接失败的出口，30 秒后重新探测，定时模式也可因此提前换节点。若所有出口均在冷却，会按顺序尝试恢复，而不回退直连。WAF、`3012` 和 SDK 风险拒绝会结束当前请求。若手填的外部代理本身会轮换公网 IP，需在提供商端使用固定或粘性会话；本服务无法固定外部代理内部的路由。

配置文件示例（合并进 `config.json`，保留其他字段）：

```json
{
  "outbound_proxy": {
    "enabled": true,
    "rotation_enabled": true,
    "rotation_interval_sec": 60,
    "source": "manual",
    "urls": ["http://127.0.0.1:7890", "http://127.0.0.1:7891"],
    "subscription_url": "",
    "subscription_filter": "",
    "mihomo_path": "mihomo",
    "refresh_interval_sec": 3600
  }
}
```

旧 `proxy_url` 配置会在没有显式 `outbound_proxy` 时迁移到启用的单地址列表；后续以新设置为准。

### 节点订阅与 Mihomo

订阅模式可直接填写 HTTPS 订阅地址，支持 URI 或 Base64 URI 列表中的 VLESS TCP/WS（含 Reality）、Hysteria2、HTTP/HTTPS。需要 Mihomo，可在「设置 → 出站代理 → 节点订阅」中自行点击「安装 Mihomo」，也可填写已安装程序的路径。在线安装仅在点击时触发，从官方 GitHub 下载固定版本 `v1.19.33`，按内置的官方资产 SHA-256 校验后解压至数据目录的 `tools/mihomo/`，支持 Windows、Linux、macOS 的 amd64/arm64；无需管理员权限，但数据目录须可写且允许执行。下载使用服务器直连，不依赖尚未就绪的订阅代理。安装完成会填入路径供保存，不会替用户开启代理；已启用的订阅代理使用默认命令 `mihomo` 时，可在后续操作中发现数据目录的托管版本。GitHub 无法连接或平台不受支持时，可[手动下载](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)。相对路径基于 `--root`，单独的命令名从 PATH 查找。Hysteria2 的 `pinSHA256` 会映射为内核的证书指纹。程序不会下载或执行订阅提供的脚本。

可使用节点名称正则筛选，例如 `香港(高速0[2-5]|专线0[12])`。最多保留 64 个节点，去重后按订阅顺序使用。程序在本机按节点创建固定 HTTP 入口，确保 SDK 与 Go 的独立连接仍使用相同节点。订阅按需定时刷新，刷新成功后新请求使用新入口，正在进行的请求使用旧入口直至结束；同一来源刷新暂时失败时保留仍在运行的旧配置。停止程序或切换配置后，会清理不再使用的子进程及运行文件。

### 检测与保存

「检测当前代理配置」测试草稿但不保存设置，也不发送账号令牌或消耗模型额度。未鉴权接口返回 401 表示出口可达，**不能证明真实业务一定通过风控**；能连通的节点仍可能在推理时返回 `3012`，应根据实际结果收紧节点筛选。代理地址及订阅链接不写入浏览器草稿。订阅访问参数和节点凭据仅存于管理员配置及私有运行目录，不写入应用日志。

## 上游安全验证（可选）

支持通过阿里云官方 SDK 自动重新申请一次性验证码票据。票据按请求生成，不延长旧票据的有效期，也不在并发请求或不同账号之间复用；上游明确返回票据失效时，在尚未输出内容前最多重新验证一次。`3012`、WAF HTML 拦截及 SDK 的 `F001` 拒绝会停止本次请求。

### 配置与依赖

可在「设置 → 上游安全验证」选择模式、模拟开关、超时及运行路径。也可将下列字段合并进 `config.json`，保留原有 `http` 超时等字段：

```json
{
  "http": {
    "captcha": {
      "mode": "auto",
      "node_path": "node",
      "jsdom_path": "",
      "simulate_canvas_webgl": true,
      "timeout_ms": 30000
    }
  }
}
```

`mode` 默认为 `off`；`auto` 遵循上游的 `enabled` 和 `skip_model_request` 配置；`always` 会在场景启用时申请票据，适合诊断，不会改变阿里云的验证结论。

安全验证只使用 Node.js 18+ 和 jsdom。在程序根目录安装锁定版本的可选依赖：

```sh
npm --prefix captcha_node ci --omit=dev --ignore-scripts
```

`captcha_node/package.json` 和 `captcha_node/package-lock.json` 需要随源码和发行包保留：前者声明依赖，后者锁定 jsdom 及传递依赖，供 `npm ci`、Docker 和 CI 使用。安装生成的 `captcha_node/node_modules/` 已由 `.gitignore` 排除，无需提交。

`jsdom_path` 留空时从 `--root` 指定目录下的 `captcha_node/node_modules/jsdom` 加载依赖；也可填写另一个包含 `node_modules/jsdom` 的目录，使用绝对路径或相对于 `--root` 的路径。只加载该目录中的依赖，缺失时直接报告错误。Go 程序内嵌运行脚本，运行时不会自动下载 npm 包。`simulate_canvas_webgl=true` 为 Canvas 2D、WebGL、OffscreenCanvas 以及缺失的 Worker、matchMedia 接口提供固定模拟结果；不代表服务器真实 GPU 或渲染输出。设为 `false` 可关闭这些模拟用于对照。

无需 Chrome/Chromium，不支持 `backend`、`browser_path` 配置；旧文件中这两个字段读取时被忽略，控制台保存的旧字段在启动时清除。SDK 缺少无痕验证启动方法、要求人工交互或返回拒绝时，直接报告错误，不尝试其他验证实现。jsdom 模拟环境不保证通过 SDK 的风险判定，也不能保证解除所有 405。

SDK 使用本次推理所选的无认证 HTTP/HTTPS 代理，或在全局代理关闭且未设置账号代理时直连；手填的带用户名/密码代理暂不支持 SDK 验证，可改用订阅模式的本机 Mihomo 入口。验证码票据仅通过子进程管道传递，不写入日志或数据库。保留超时、取消、并发排队、防止票据复用，以及明确过期后最多重新验证一次的保护；WAF HTML、`3012` 和 SDK 拒绝会停止本次请求。

### Docker 可选运行环境

Docker 可选构建完整运行环境：`docker compose build --build-arg CAPTCHA_RUNTIME=1 --build-arg PROXY_RUNTIME=1`，随后运行 `docker compose up -d`。前者安装 Node 和锁定的 jsdom，后者从固定版本、固定镜像摘要的官方多架构镜像加入 Mihomo。两个参数默认均为 `0`；只使用普通 HTTP/HTTPS 代理时无需 Mihomo。

接口行为依据[阿里云客户端接入文档](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/new-architecture-for-web-and-h5-client-access)和[服务端一次性票据约束](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access)实现；参考项目见 [liu5269/zcode2api](https://github.com/liu5269/zcode2api)。
