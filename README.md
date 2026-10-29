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

请求进入网关后，先从账号池选择符合模型、授权、额度和分组条件的账号。上游繁忙时，重试在返回内容之前完成：

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
| Windows 启停脚本 | PowerShell，且 `go` 命令可用 |
| Docker 部署 | Docker Engine / Docker Desktop 与 Docker Compose |
| 账号 | 本人拥有或获得明确授权，且具备相应 ZCode 权益的账号 |

### 安装与启动

下载源码后，进入项目根目录，选择一种方式启动。

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

### 添加账号与开启自动领卡

1. 登录控制台，进入「账号」，点击添加账号。
2. 选择本机导入或 OAuth 授权。本机导入读取**服务所在机器**的 `~/.zcode/v2/credentials.json`；Docker 容器不会自动读取宿主机凭据。没有本机凭据时，可使用 OAuth 授权。
3. 确认账号验证、模型能力和余额状态。多个账号可以放入不同分组，再为网关密钥指定分组链与调度策略。
4. 进入「领卡」查看可领取卡、待生效额度与领取记录，可手动领取单张卡或全部可领卡。
5. 在「设置 → 自动领卡」中确认开关和检查周期。默认启用，检查周期为 **240 分钟**，服务需保持运行。

自动领卡只领取上游实际提供、账号符合条件的额度卡。需要先完成的奖励任务仍需用户在 ZCode 中完成；领取成功也可能有生效时间，待生效额度不会计入当前可用余额。

网页 Cookie 导入仅用于受支持的平台资料等接口，**不能用于推理或余额查询**。推理和领卡需要账号具备有效的 ZCode 凭据。

### 配置客户端并开始使用

先在控制台「密钥」中创建一个网关密钥，再填写客户端配置。**网关密钥由本项目签发，不是账号 JWT，也不是控制台管理密码。**

| 协议 | Base URL | 请求端点 |
| --- | --- | --- |
| OpenAI Chat Completions | `http://127.0.0.1:6780/v1` | `POST /v1/chat/completions` |
| OpenAI Responses | `http://127.0.0.1:6780/v1` | `POST /v1/responses` |
| Anthropic Messages | `http://127.0.0.1:6780` | `POST /v1/messages` |

模型使用 `GET /v1/models` 实际返回的 ID。默认别名 `glm-flash` 指向 `GLM-5.3-Flash`，`glm-5.3` 指向 `GLM-5.3`；模型能否使用取决于账号权益与密钥权限。

### 更新、停止与卸载

Windows 停止服务：

```powershell
.\scripts\stop.ps1
```

更新源码后，先停止服务，再运行 `start.ps1` 重新构建并启动。Linux / macOS 前台运行时按 `Ctrl+C` 停止，更新源码后重新构建。

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

## 安全范围

使用前请阅读 [安全说明与免责声明](SECURITY.md)。

- **账号授权**：接入本人拥有或已获得明确授权的账号，并在授权范围内管理凭据、查询额度和转发请求。
- **平台边界**：自动领卡与重试受账号权益和平台规则约束。软件的商业使用许可不代表取得第三方账号、免费额度或平台服务的转售授权。
- **凭据保护**：账号令牌加密入库，数据目录还包含主密钥、管理密码和可能的 Cookie 文件。请整体按敏感目录保管，不要提交到仓库或公开分享。
- **访问控制**：本机运行默认监听回环地址，仓库 Compose 默认仅向本机映射端口。需要远程访问时，请自行配置可信访问控制与 HTTPS。

本项目与 ZCode、智谱、Z.ai、BigModel 官方无隶属或背书关系。免费额度与活动规则、上游协议和账号状态均可能变化。

## 许可证与相关文件

本项目采用 [Apache License 2.0](LICENSE)，允许在遵守许可证条款的前提下使用、修改、分发及商业使用。第三方账号、模型服务和组件仍受各自的授权与使用条款约束。

**二次开发与再分发请保留原作者的适用署名声明。** 再分发时，须向接收方提供许可证副本，在修改过的文件中显著说明修改，并按许可证第 4 条保留适用的版权、专利、商标和署名声明；若发行内容包含 `NOTICE`，还须按该条保留其中适用的署名信息。

建议在公开发布的衍生项目 README 中注明“基于 zcode2api 二次开发”。这是项目出处说明建议，不构成 Apache License 2.0 之外的附加许可条件。[SECURITY.md](SECURITY.md) 提供安全说明与部署建议，不限制许可证已授予的权利。

| 文件 | 内容 |
| --- | --- |
| [LICENSE](LICENSE) | Apache License 2.0 许可全文 |
| [SECURITY.md](SECURITY.md) | 账号授权、使用边界与数据安全说明 |
| [config.example.json](config.example.json) | 本机运行配置示例 |
| [compose.yaml](compose.yaml) | Docker Compose 部署配置 |
| [scripts/start.ps1](scripts/start.ps1) / [scripts/stop.ps1](scripts/stop.ps1) | Windows 构建、启动与停止脚本 |
