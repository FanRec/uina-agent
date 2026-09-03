# Uina v0 设计

本文只记录当前实现和可验证的边界。未实现能力另列为非目标，不作为当前状态描述。

## 当前垂直切片

```text
终端输入
  -> cli/app
  -> agent/loop
  -> context + provider
  -> 文本输出或结构化 tool call
  -> ToolBroker
  -> tool result 回注
  -> 下一次模型请求
  -> JSONL session
```

当前主体只有一个前台运行循环。模型负责生成文本和结构化意图；确定性代码负责队列、参数校验、工具执行、取消、历史和持久化。

## 模块边界

| 模块 | 责任 | 不负责 |
| --- | --- | --- |
| `agent/loop.ts` | turn 生命周期、模型请求、工具回注、中断 | wire 协议、文件格式、终端控制 |
| `agent/queue.ts` | steer/followUp 队列和输入顺序 | 模型决策 |
| `agent/context.ts` | system prompt、上下文和 token 估算 | 持久化 |
| `agent/compaction.ts` | 阈值判断、摘要请求、保留尾部 | session 文件写入 |
| `ai/gateway.ts` | HTTP 请求、OpenAI wire 消息、provider finish reason | 业务历史 |
| `ai/sse.ts` | 标准 SSE framing | OpenAI 业务字段解释 |
| `tools/broker.ts` | 注册、Ajv schema 编译、参数验证、执行 | 终端渲染 |
| `extensions/runner.ts` | activation scope、项目/内置能力注册、异步释放和来源诊断 | 工具业务逻辑、Agent 决策 |
| `extensions/runtime-tools/` | 内置 shell、时间、Job/Subagent 工具实现 | 项目扩展发现 |
| `session/jsonl-store.ts` | 追加、同步 flush、原子创建、尾行修复 | 模型上下文决策 |
| `session/recovery.ts` | JSONL record 验证、历史重放、未知工具结果恢复 | 文件写入 |
| `ui/` | 文本、工具状态、队列显示 | 状态转移 |
| `cli/app.ts` | 依赖组装、输入映射、graceful shutdown | Agent 决策 |

## 队列和中断

Pi 风格的两条队列由 `Subject` 管理：

- `steer` 在当前 assistant/tool 回合结束后、下一次模型请求前送达。
- `followUp` 在当前运行没有更多 tool call 或 steer 后送达。
- 空闲输入直接开新轮；流式期间输入不会和当前 assistant 消息混写。
- 中断只终止当前模型/工具请求，不自动消费队列。
- UI 将剩余队列恢复到输入区；用户重新提交后才继续。

同轮工具默认并行，结果按模型声明顺序回注。工具可以使用 `executionMode: "sequential"` 要求该批次顺序执行。

## 模型协议

网关只承诺 OpenAI Chat Completions streaming 形状。SSE 必须有合法 JSON、`finish_reason` 和 `[DONE]`。非法 JSON、异常断流、未知 finish reason、content filter 和不完整工具参数均失败，不补造成功结果。

`length` 是可识别的截断状态；工具参数不完整时不会执行。AbortSignal 是取消的唯一传播信号。

## 持久化

`data/session.jsonl` 使用 header 加追加 record：

```json
{"kind":"header","version":1,"id":"...","cwd":"...","createdAt":"..."}
{"kind":"message","id":"...","seq":1,"timestamp":"...","message":{}}
{"kind":"event","id":"...","seq":2,"timestamp":"...","event":"tool_started","data":{}}
{"kind":"compaction","id":"...","seq":3,"timestamp":"...","summary":"...","retainedTail":[],"tokensBefore":123}
```

每个 record 串行追加并同步 flush。最后一行的语法型 torn tail 可原子修复；中间损坏、schema 错误、seq 回退和工具结果错配会拒绝加载。工具开始事件存在但没有结束结果时，重启恢复为 `unknown`，不推断外部副作用是否成功。

## Shell 边界

shell 工具使用当前账户权限，不提供审批、沙箱、超时或白名单。stdout 和 stderr 独立收集，超过 50 KB 或 2000 行后保留尾部，完整流持续写入临时文件。进程正常完成以 `close` 为准，取消时使用 Windows `taskkill /t /f` 或 Unix 进程组终止。

## 验证状态

已通过：

- `pnpm typecheck`
- `pnpm build`
- gateway、loader、loop、JSONL、shell 单元/组合测试
- 本地 OpenAI 兼容 SSE 服务下的实际 CLI one-shot smoke

未宣称已通过：真实 DeepSeek/Ollama、真实 TTY IME、跨平台 shell、崩溃时外部命令副作用协调。

## 非目标

v0 不包含长期记忆、语音、视觉、感知事件、后台 Job、RPC、多会话、分支/fork、动态能力筛选、审批模式和分布式运行时。这些能力只有在出现可复现的用户场景后单独设计和验证。
