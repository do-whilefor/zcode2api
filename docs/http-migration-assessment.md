# 保留 ZCode 账号额度的 HTTP 迁移

> 本文保留 Node 版 HTTP 迁移时的探测记录，路径和测试数量属于当时实现。当前后端已迁至 Go，现行验证方式见 [Go 迁移记录](go-migration.md)。

核查日期：2026-10-29。继续使用现有 ZCode Start Plan 账号额度，没有引入另外购买的 API 凭据。

## 更新后的结论

已验证独立 HTTP 请求可以使用现有账号额度，并实现 `inference_driver: "http"`。这条链路不启动 `zcode.cjs app-server`，不创建运行时会话或 MCP 工具代理。网关现已固定使用 HTTP，旧桥与运行时诊断脚本已删除；下文探测过程仅为迁移时的历史记录。

早先普通 HTTP 请求的 3012 只能说明那些请求未被接受，不能据此认定额度只能通过运行时调用。本次通过成功请求与失败请求的对照，补齐了 HTTP 协议配置。

## 与参考项目的关系

核对了 [qoder2api-hub 的实现说明](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/internals.md)及其 [qoder_sign.py](https://github.com/shuishuipingan/qoder2api-hub/blob/main/qoder_sign.py)。该项目实现 Qoder 特定的请求模板、编码、COSY 签名和 SSE 信封解包，并非任意供应商都能直接使用的透明代理；其部分工具历史也会文本化。

ZCode 协议不同：当前观测到的 Start Plan 主会话 HTTP 请求携带账号 JWT、归属头和特定系统前缀，使用 Anthropic Messages/SSE；成功请求没有 Qoder COSY 签名。官方运行时中的通用 V4 签名分支明确排除了 Start Plan，不能将其他产品的签名代码直接移植过来。

## 实测证据

| 路径或请求变化 | 本次结果 |
| --- | --- |
| 普通 JWT + messages 的直接 HTTP 请求 | HTTP 405 / 3012 |
| 普通 HTTP 请求补设备、请求和会话归属字段 | 仍为 3012 |
| workspace/generateText | JSON-RPC -32603，unusual activity |
| 官方主会话 | 成功 |
| 成功主会话 HTTP 请求在诊断进程中重发 | SSE 成功，聚合增量后收到预期答案 |
| 关闭诊断运行时、使用新的会话和请求 ID 后重发 | 仍成功 |
| 移除 system、只保留身份首行或换成通用 system | 3012 |
| 保留两个必要系统块、精简正文及输出预算 | 成功 |
| 使用独立实现的 HTTP 配置，不先运行诊断运行时 | 成功 |
| 三种客户端协议的 function 工具、结果回传和流式答案 | 均成功，运行时槽位始终为 0 |
| Claude Code 实机读取、连续对话、编辑、执行测试 | 四轮通过 |
| 用户实际配置、CVE 工作目录、非 bare 的 Claude Code 只读测试 | 成功读取本项目 package.json 并返回 zcode2api |

74 项回归测试全部通过。本机已通过持久化设置切换为 HTTP；服务健康检查为 200，仪表盘运行时槽位为 0。用户原有 Claude URL、API Key、模型和思考配置没有修改。

运行时与独立 HTTP 的成功探测均请求 max。不同探测提示和前缀长度不同，这些是功能证据，不能用于宣布提速百分比。

## 当前实现

src/upstream/zcode-profile.js 保存此次核对的 0.17.0 HTTP 配置与两个必要系统块，包括原有安全说明。不依赖运行时进程、客户端抓包缓存或临时签名。

src/upstream/anthropic-request.js 在这些系统块之后附加客户端指令。客户端的多个普通 system 文本块合并为一个，按原顺序以空行连接，不删除文本；相同缓存策略合并为末尾一个断点，不同缓存策略明确拒绝。对照中，Claude 原始多个系统块布局被拒绝，文本相同但合并后的布局被接受。完整上游内部规则仍未知，不应将这些观测描述为永久规范。adaptive 思考、context_management.keep=all 等原有字段保留，无需删除来完成本次适配。

Anthropic 客户端的结构化消息、工具定义、工具结果、思考签名与响应事件保留。Chat/Responses 的 function 工具转换为 Anthropic 工具，历史使用结构化 tool_use/tool_result，不经过 MCP；工具参数增量也实时转换。客户端执行工具，下一条 HTTP 请求携带结果继续，无需服务端保留暂停中的工具进程。

账号调度、现有额度、鉴权、密钥限额、会话亲和和用量日志共用原有逻辑；新驱动不降低请求思考档位。输出上限经 max_tokens 传给上游。缓存读取/写入与普通输入分别记账，转换到 Chat/Responses 时输入总量包含缓存部分。

## 仍然存在的边界

- 这是 ZCode 特定的非公开 HTTP 协议适配，服务端更新后可能需要更新配置。
- 必需系统前缀增加输入，不能称为零附加上下文的透明代理。
- 跨协议转换无法创造上游没有的托管工具。web_search、namespace/custom 等非 function 工具明确报错，不静默跳过。
- 不同 system 缓存策略、对话中途的 system/developer 角色、部分多模态块不能无损转换，会明确拒绝。
- Responses 的 previous_response_id 按密钥隔离，最多保存 100 条、总计 64MB，进程重启会失效；完整客户端历史可独立继续。检索/删除接口保留原有本地缓存语义。
- count_tokens 仍是本地粗估，未验证上游精确计数接口。strict、托管功能和其他扩展字段是否执行，由上游能力决定；透传参数不等于实现全部功能。

## 配置与复测

网关只使用 HTTP，旧 runtime 配置启动时迁移为 http。设置页不再提供运行时选项；启动不检查 runtime_bin，也不执行预热或槽位回收。限流优先换号，全池限流才进入共享 10 秒重试窗口，次数不限。首字/空闲/整轮超时独立配置，正常长输出不受重试预算限制。

```powershell
node --test test/http-driver.test.mjs
node test/live-native-http.mjs
node test/live-claude-code.mjs
```

活体测试消耗现有账号额度，仅使用合成内容；Claude 测试仅修改并恢复 fixture 文件。迁移时使用的运行时抓包、重放及可行性脚本已完成用途并删除，当前复测使用上述 HTTP 与客户端脚本。
