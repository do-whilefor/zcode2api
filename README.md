<div align="center">

<img src="src/web/favicon.svg" alt="zcode2api" width="80" height="80">

# zcode2api

**ZCode(智谱、Zai）毒鸡蛋反代，让免费账号的重试、领卡和多账号管理交给网关。**

[![Go](https://img.shields.io/badge/Go-1.26%2B-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#安装与启动)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-555)](#环境要求)
[![License](https://img.shields.io/badge/License-Apache_2.0-orange?logo=apache&logoColor=white)](LICENSE)

[概述](#概述) · [使用方法](#使用方法) · [配置说明](#配置说明) · [安全范围](#安全范围) · [许可证与相关文件](#许可证与相关文件)

</div>

## 概述

zcode2api 是一个使用 Go 编写的 ZCode 多账号额度管理与 HTTP 推理网关。将自己授权的账号加入账号池后，即可通过统一的 API 地址和网关密钥接入支持 OpenAI Chat Completions、Responses 或 Anthropic Messages 协议的客户端。

项目重点解决免费账号使用中的几件事：

- **繁忙自动换号、受控重试**：遇到上游限流、并发忙碌或过载，优先尝试池中其他可用账号；全池受限后进入共享重试窗口，减少手动反复点击重试。
- **自动领卡**：定期检查账号实际可领取的额度卡并提交领取，支持手动领取、领取记录查询，以及已领取但尚未生效额度的单独展示。
- **多账号统一管理**：支持 BigModel 与 Z.ai 账号、本机凭据导入、OAuth 授权、分组调度、余额同步、到期查看和凭据更新。

### 免费账号的重试如何处理

| 情况 | 网关行为 |
| --- | --- |
| 限流、并发忙碌或过载 | 立即尝试其他可用账号，会话亲和不会阻挡换号；覆盖 429、3008/3009/3010、过载业务码及普通 HTTP 503/529 响应 |
| 本次可用账号全部受限 | 开启全池共享的 **10 秒重试窗口**，轮流重试，默认同一账号间隔 1 秒，并遵守上游 `Retry-After` |
| 额度耗尽或凭据失效 | 从本次请求中排除该账号并换号，同时更新余额或授权状态 |
| 已经输出正文、思考或工具调用 | 停止整轮重放，避免重复回答或重复执行工具 |
| 参数错误或风险拒绝 | 返回对应错误；3012 按异常活动拒绝处理，停止本次请求 |

10 秒窗口内的繁忙重试不受普通 `max_attempts` 次数限制；窗口结束仍未恢复时，网关返回错误。网络和普通服务端故障使用独立的退避与重试预算。上游权益、可用性和限额仍由平台决定。

## 使用方法

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows、Linux 或 macOS |
| 源码构建 | Go **1.26 或更高版本** |
| Windows 启停脚本 | PowerShell；源码启动还需 `go` 命令，Release 压缩包无需 Go |
| Docker 部署 | Docker Engine / Docker Desktop 与 Docker Compose |
| 账号 | 本人拥有或获得明确授权，且具备相应 ZCode 权益的账号 |

### 安装与启动

可使用预编译 Release 压缩包、源码或 Docker 启动。程序版本可通过 `zcode2api --version` 查看；设置里的 `app_version` 是上游 API 版本，二者独立。

**预编译 Release 压缩包（无需 Go）：**

从 [Releases](https://github.com/do-whilefor/zcode2api/releases) 下载对应操作系统和架构的压缩包，完整解压后进入该目录。

Windows 在 PowerShell 中运行 `./scripts/start.ps1`，会直接使用压缩包内的 `zcode2api.exe` 在后台启动；停止时运行 `./scripts/stop.ps1`。也可以运行 `./zcode2api.exe --root .` 在当前终端启动。

Linux / macOS 运行：

```bash
chmod +x ./zcode2api
./zcode2api --root .
```

首次管理密码保存在 `data/admin-password.txt`。Windows 启停脚本中的相对 `ZCODE2API_DATA_DIR` 以项目或解压目录为基准。

**从源码启动：**

下载源码后，进入项目根目录，选择下列方式。

**Windows PowerShell：**

```powershell
.\scripts\start.ps1
```

脚本会构建 `bin/zcode2api.exe` 并在后台启动。读取首次生成的管理密码：

```powershell
Get-Content .\data\admin-password.txt
```

**Linux / macOS / WSL：**

```bash
go build -trimpath -o bin/zcode2api .
./bin/zcode2api --root .
```

程序在当前终端运行。首次管理密码保存在 `data/admin-password.txt`。

**Docker Compose：**

```bash
docker compose up -d --build
```

仓库提供的 Compose 配置将数据持久化到宿主机 `./data`，并仅向宿主机回环地址映射端口。首次管理密码同样位于宿主机 `data/admin-password.txt`。

默认访问地址：

| 用途 | 地址 |
| --- | --- |
| Web 控制台 | <http://127.0.0.1:6789> |
| 推理网关 | <http://127.0.0.1:6780> |
| OpenAI 兼容 Base URL | <http://127.0.0.1:6780/v1> |

实际端口与进程信息写入 `data/ports.json`。如果设置了 `ZCODE2API_DATA_DIR`，密码、数据库与端口文件均位于指定的数据目录。

### 添加账号与领取额度卡

1. 登录控制台，进入「账号」，点击添加账号。
2. 选择本机导入或 OAuth 授权。本机导入读取**服务所在机器**的 `~/.zcode/v2/credentials.json`；Docker 容器不会自动读取宿主机凭据。没有本机凭据时，可使用 OAuth 授权。
3. 确认账号验证、模型能力和余额状态。多个账号可以放入不同分组，再为网关密钥指定分组链与调度策略。
4. 进入「领卡」查看可领取卡、待生效额度与领取记录，可手动领取单张卡或全部可领卡。
5. 自动领卡默认启用，检查周期为 **240 分钟**，服务需保持运行。开关和周期通过配置项 `claim_auto_enabled`、`claim_auto_min` 调整。

自动领卡合并查询活动投放接口和旧版额度卡接口，只领取上游明确提供领取动作或列入可领清单的卡片。同一卡片按 `plan_id` 去重；部分来源异常时保留已查询到的卡片并提示“部分同步”，全部失败时提示查询失败。需要先完成的奖励任务仍需用户在 ZCode 中完成；领取成功也可能有生效时间，待生效额度不会计入当前可用余额。

网页 Cookie 导入仅用于受支持的平台资料等接口，**不能用于推理或余额查询**。推理和领卡需要账号具备有效的 ZCode 凭据。

### 配置客户端并开始使用

先在控制台「密钥」中创建一个网关密钥，再填写客户端配置。**网关密钥由本项目签发，不是账号 JWT，也不是控制台管理密码。**

| 协议 | Base URL | 请求端点 |
| --- | --- | --- |
| OpenAI Chat Completions | `http://127.0.0.1:6780/v1` | `POST /v1/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:6780/v1` | `POST /v1/responses` |
| Anthropic Messages | `http://127.0.0.1:6780` | `POST /v1/messages` |

模型使用 `GET /v1/models` 实际返回的 ID。默认别名 `glm-flash` 指向 `GLM-5.3-Flash`，`glm-5.3` 指向 `GLM-5.3`；模型能否使用取决于账号权益与密钥权限。

### 排查上游 HTTP 405

若错误包含 `upstream_waf_blocked`、`Server=ESA` 和 `EagleId`，表示请求被上游安全网关拦截；仅凭 405 不能判断为请求方法错误、客户端版本过旧或账号失效。可使用同一账号和请求体，对比部署服务器直连与本人可用的出站代理，保留追踪 ID 供上游排查。

在控制台「设置 → 出站代理」配置全局代理，并分别控制「启用全局代理」与「启用代理轮询」。保存后对后续请求生效，重启后保留。关闭全局代理会恢复直连；「账号 → 编辑 → 出站代理」中的单独设置优先，且固定使用该账号代理。项目不会自动读取 Windows 系统代理。

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

订阅模式可直接填写 HTTPS 订阅地址，支持 URI 或 Base64 URI 列表中的 VLESS TCP/WS（含 Reality）、Hysteria2、HTTP/HTTPS。需要 Mihomo，可在「设置 → 出站代理 → 节点订阅」中自行点击「安装 Mihomo」，也可填写已安装程序的路径。在线安装仅在点击时触发，从官方 GitHub 下载固定版本 `v1.19.33`，按内置的官方资产 SHA-256 校验后解压至数据目录的 `tools/mihomo/`，支持 Windows、Linux、macOS 的 amd64/arm64；无需管理员权限，但数据目录须可写且允许执行。下载使用服务器直连，不依赖尚未就绪的订阅代理。安装完成会填入路径供保存，不会替用户开启代理；已启用的订阅代理使用默认命令 `mihomo` 时，可在后续操作中发现数据目录的托管版本。GitHub 无法连接或平台不受支持时，可[手动下载](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)。相对路径基于 `--root`，单独的命令名从 PATH 查找。Hysteria2 的 `pinSHA256` 会映射为内核的证书指纹。程序不会下载或执行订阅提供的脚本。

可使用节点名称正则筛选，例如 `香港(高速0[2-5]|专线0[12])`。最多保留 64 个节点，去重后按订阅顺序使用。程序在本机按节点创建固定 HTTP 入口，确保 SDK 与 Go 的独立连接仍使用相同节点。订阅按需定时刷新，刷新成功后新请求使用新入口，正在进行的请求使用旧入口直至结束；同一来源刷新暂时失败时保留仍在运行的旧配置。停止程序或切换配置后，会清理不再使用的子进程及运行文件。

「检测当前代理配置」测试草稿但不保存设置，也不发送账号令牌或消耗模型额度。未鉴权接口返回 401 表示出口可达，**不能证明真实业务一定通过风控**；能连通的节点仍可能在推理时返回 `3012`，应根据实际结果收紧节点筛选。代理地址及订阅链接不写入浏览器草稿。订阅访问参数和节点凭据仅存于管理员配置及私有运行目录，不写入应用日志。

### 上游安全验证（可选）

支持通过阿里云官方 SDK 自动重新申请一次性验证码票据。票据按请求生成，不延长旧票据的有效期，也不在并发请求或不同账号之间复用；上游明确返回票据失效时，在尚未输出内容前最多重新验证一次。`3012`、WAF HTML 拦截及 SDK 的 `F001` 拒绝会停止本次请求。

可在「设置 → 上游安全验证」选择模式、模拟开关、超时及运行路径。也可在 `config.json` 的 `http` 对象中加入以下 `captcha` 字段：

```json
{
  "captcha": {
    "mode": "auto",
    "node_path": "node",
    "jsdom_path": "",
    "simulate_canvas_webgl": true,
    "timeout_ms": 30000
  }
}
```

该配置是 `http` 对象中的 `captcha` 字段，请保留原有超时字段。`mode` 默认为 `off`；`auto` 遵循上游的 `enabled` 和 `skip_model_request` 配置；`always` 会在场景启用时申请票据，适合诊断，不会改变阿里云的验证结论。

安全验证只使用 Node.js 18+ 和 jsdom。在程序根目录安装锁定版本的可选依赖：

```sh
npm --prefix captcha_node ci --omit=dev --ignore-scripts
```

`jsdom_path` 留空时从 `--root` 指定目录下的 `captcha_node/node_modules/jsdom` 加载依赖；也可填写另一个包含 `node_modules/jsdom` 的目录，使用绝对路径或相对于 `--root` 的路径。只加载该目录中的依赖，缺失时直接报告错误。Go 程序内嵌运行脚本，运行时不会自动下载 npm 包。`simulate_canvas_webgl=true` 为 Canvas 2D、WebGL、OffscreenCanvas 以及缺失的 Worker、matchMedia 接口提供固定模拟结果；不代表服务器真实 GPU 或渲染输出。设为 `false` 可关闭这些模拟用于对照。

旧的浏览器验证实现、Chrome/Chromium 依赖和 `backend`、`browser_path` 配置已移除；旧文件中这两个字段读取时被忽略，控制台保存的旧字段在启动时清除。SDK 缺少无痕验证启动方法、要求人工交互或返回拒绝时，直接报告错误，不尝试其他验证实现。jsdom 模拟环境不保证通过 SDK 的风险判定，也不能保证解除所有 405。

SDK 使用本次推理所选的无认证 HTTP/HTTPS 代理，或在代理关闭时直连；手填的带用户名/密码代理暂不支持 SDK 验证，可改用订阅模式的本机 Mihomo 入口。验证码票据仅通过子进程管道传递，不写入日志或数据库。保留超时、取消、并发排队、防止票据复用，以及明确过期后最多重新验证一次的保护；WAF HTML、`3012` 和 SDK 拒绝会停止本次请求。

Docker 可选构建完整运行环境：`docker compose build --build-arg CAPTCHA_RUNTIME=1 --build-arg PROXY_RUNTIME=1`，随后运行 `docker compose up -d`。前者安装 Node 和锁定的 jsdom，后者从固定版本、固定镜像摘要的官方多架构镜像加入 Mihomo。两个参数默认均为 `0`；只使用普通 HTTP/HTTPS 代理时无需 Mihomo。

本地回归检查：`go test ./...`、`go vet ./...`、`node --test test/network-settings.test.cjs`（Node 测试前先安装 `captcha_node` 依赖）。可选实机测试通过 `ZCODE2API_TEST_MIHOMO`、`ZCODE2API_TEST_SUBSCRIPTION` 和 `ZCODE2API_TEST_NODE_FILTER` 指定可信内核、私有订阅与筛选条件；普通测试不访问外部服务。

接口行为依据[阿里云客户端接入文档](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/new-architecture-for-web-and-h5-client-access)和[服务端一次性票据约束](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/server-access)实现；参考项目见 [liu5269/zcode2api](https://github.com/liu5269/zcode2api)。

### 更新、停止与卸载

Windows 停止服务：

```powershell
.\scripts\stop.ps1
```

更新源码后，先停止服务，再运行 `start.ps1` 重新构建并启动。Linux / macOS 前台运行时按 `Ctrl+C` 停止，更新源码后重新构建。

使用 Release 压缩包时，先停止旧程序，再用新版本替换程序、启停脚本等发行文件，保留原来的 `data` 目录和自定义 `config.json`，然后重新启动。

Docker 更新源码后，重新构建并启动：

```bash
docker compose up -d --build
```

停止并移除容器：

```bash
docker compose down
```

卸载时先停止服务，再移除程序与源码；`docker compose down` 会保留宿主机绑定的数据目录。需要保留账号和配置时，请整体备份 `data`，包括数据库、`secret.key` 和 Cookie 文件。

## 配置说明

运行参数可在控制台「设置」中修改，保存后即时生效。已保存的设置持久化在数据库中，重启后会继续覆盖同名配置。主题设置在浏览器中立即生效。

直接运行源码构建的程序时，可将 [config.example.json](config.example.json) 复制为 `config.json` 后修改。Docker 默认只挂载数据目录；如需使用配置文件，须另行将它挂载到 `/app/config.json`。监听地址和端口修改后需要重启服务。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `web_port` / `gateway_port` | `6789` / `6780` | 控制台与推理网关端口 |
| `host` | `127.0.0.1` | 本机直接运行时的监听地址 |
| `poll_interval_sec` | `60` | 账号余额轮询基础间隔，秒 |
| `poll_jitter_sec` / `poll_concurrency` | `10` / `4` | 轮询抖动秒数与并发数 |
| `claim_auto_enabled` / `claim_auto_min` | `true` / `240` | 自动领卡开关与检查周期，分钟 |
| `conversation_affinity_minutes` | `10` | 客户端提供会话标识时的账号亲和时间，分钟 |
| `default_reasoning_level` | `low` | 默认思考档位 |
| `retry.rate_limit_retry_interval_ms` | `1000` | 上游未指定等待时间时，同一账号的繁忙重试间隔 |
| `retry.busy_wait_sec` | `60` | 本地账号槽位全部占用时，等待空闲账号的时长 |
| `retry.max_attempts` / `retry.total_budget_ms` | `10` / `120000` | 普通故障的尝试次数与常规排队、重试预算 |
| `http.first_token_timeout_ms` | `60000` | 上游首个有效内容超时，毫秒 |
| `http.idle_timeout_ms` | `120000` | 上游流空闲超时，毫秒 |
| `http.total_timeout_ms` | `0` | 整轮推理超时；`0` 表示不设整轮时限 |
| `app_version` | `3.16.2` | 额度、领卡等管理 API 的版本标识 |
| `http.client_version` | `0.17.0` | 推理 API 的版本标识 |

`busy_wait_sec` 控制本地排队，全池上游限流后的 10 秒窗口由网关单独处理。正常输出开始后，常规重试预算不会截断持续生成的回复。

支持的环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `ZCODE2API_DATA_DIR` | 指定数据目录 |
| `ZCODE2API_HOST` | 指定监听地址；Docker 镜像内默认为 `0.0.0.0` |
| `ZCODE2API_WEB_PORT` / `ZCODE2API_GATEWAY_PORT` | 指定控制台与网关端口 |
| `ZCODE2API_ADMIN_PASSWORD` | 指定管理密码；设置后使用该值登录 |
| `TZ` | 容器时区，Compose 默认 `Asia/Shanghai` |

## 测试与 CI/CD

常规测试不需要真实 API Key、代理服务或订阅凭据。上游 HTTP/SSE、验证码 SDK、订阅下载与 Mihomo 子进程由本地测试服务或模拟进程替代；Node 与真实 jsdom 仍会参与离线进程测试。

```bash
npm --prefix captcha_node ci --omit=dev --ignore-scripts
go test -shuffle=on -count=1 -covermode=atomic "-coverprofile=coverage.out" -timeout=5m . ./internal/...
node scripts/check-coverage.cjs coverage.out 75
node scripts/test-web.cjs
```

CI 在 Windows、Linux、macOS 上运行后端和前端回归、原生启动与内嵌页面检查，并覆盖 Node 18/20/22/24、Linux 竞态检测和短时模糊测试。后端语句覆盖率最低为 75%；主程序入口另外由真实可执行文件的冒烟测试验证。四种 `CAPTCHA_RUNTIME` / `PROXY_RUNTIME` 组合都会构建 Docker 镜像，运行时通过 `--network none` 禁止外部网络。安装依赖及构建镜像仍需要访问软件包仓库。

CI/CD 共用六个平台的发布包构建与检查：Windows、Linux、macOS 的 amd64/arm64，验证二进制架构、压缩包内容及必要依赖清单。Windows 另测含空格路径、无 Go 环境、重复启动与停止。

在 Actions 手动运行 **CD** 会完成全部测试、镜像构建与发布包验证，保留构建产物，不发布版本或镜像。推送 `v*` 标签时，只有这些检查全部通过后，才发布多架构 Docker 镜像和 GitHub Release。

需要真实订阅的可选集成测试已隔离到 `integration` 构建标签，不属于 CI；常规测试即使设置了相关环境变量也不会运行它。

## 安全范围

使用前请阅读 [安全说明与免责声明](SECURITY.md)。

- **账号授权**：接入本人拥有或已获得明确授权的账号，并在授权范围内管理凭据、查询额度和转发请求。
- **平台边界**：自动领卡与重试受账号权益和平台规则约束。软件的商业使用许可不代表取得第三方账号、免费额度或平台服务的转售授权。
- **凭据保护**：账号令牌加密入库，数据目录还包含主密钥、管理密码和可能的 Cookie 文件。请整体按敏感目录保管，不要提交到仓库或公开分享。
- **访问控制**：本机运行默认监听回环地址，仓库 Compose 默认仅向本机映射端口。需要远程访问时，请自行配置可信访问控制与 HTTPS。

本项目与 ZCode、智谱、Z.ai、BigModel 官方无隶属或背书关系。免费额度与活动规则、上游协议和账号状态均可能变化。

## 许可证与相关文件

本项目采用 [Apache License 2.0](LICENSE)，允许在遵守许可证条款的前提下使用、修改、分发及商业使用。第三方账号、模型服务和组件仍受各自的授权与使用条款约束。

**二次开发与再分发声明。** 再分发时，须向接收方提供许可证副本，在修改过的文件中显著说明修改，并按许可证第 4 条保留适用的版权、专利、商标和署名声明；若发行内容包含 `NOTICE`，还须按该条保留其中适用的署名信息。

| 文件 | 内容 |
| --- | --- |
| [LICENSE](LICENSE) | Apache License 2.0 许可全文 |
| [SECURITY.md](SECURITY.md) | 账号授权、使用边界与数据安全说明 |
| [config.example.json](config.example.json) | 本机运行配置示例 |
| [compose.yaml](compose.yaml) | Docker Compose 部署配置 |
| [scripts/start.ps1](scripts/start.ps1) / [scripts/stop.ps1](scripts/stop.ps1) | Windows 构建、启动与停止脚本 |
