# Uina 当前运行时

本文是 Uina 唯一的“当前事实”架构说明。它只描述当前 checkout 中存在、且能追溯到代码、测试或本地 smoke 的行为；设想和未实现设计见 `proposals/`，外部资料见 `references/`，历史审查见 `history/`。

## 当前纵向切片

```text
输入
  -> Subject active run / steer / followUp mailbox
  -> context projection + ModelProvider stream
  -> text 或 tool call
  -> ToolBroker validate / execute
  -> tool result 回注
  -> 下一次模型请求或 settled
  -> ordered SessionEntry journal + UI/stdio projection
```

模型只生成文本和结构化工具意图；确定性代码拥有队列、schema 校验、外部工具执行、取消、持久化和生命周期状态。

## 稳定边界

| 区域 | 拥有 | 不拥有 |
| --- | --- | --- |
| `agent/` | active run、队列、上下文、工具回注、取消、输出生命周期 | Provider wire、文件格式、UI |
| `ai/` | 配置、Provider adapter、SSE/wire、模型事实 | Agent 历史和 UI 状态 |
| `session/` | 有序 SessionEntry、JSONL append/recovery、未完成工具 unknown | Provider 决策和 UI 规则 |
| `tools/broker.ts` | 工具 schema、校验和执行 | 工具发现或扩展加载 |
| `runtime/` | 只读 RuntimeHooks 合同与 no-op 实现 | handler、scope、扩展状态或 UI |
| `extensions/runner.ts` | ActivationScope、项目/builtin 注册、来源诊断、异步 teardown | Agent 决策和工具业务实现 |
| `extensions/runtime-tools/` | 内置 shell、时间、Job/Subagent 工具实现 | 项目扩展发现 |
| `ui/` | 展示、输入、焦点、组件组合 | 模型能力事实、Agent 状态转移 |
| `cli/app.ts` | 依赖组装、stdio/TTY 输入适配、退出 | Agent 业务规则 |

## Agent lifecycle

`Subject` 对外以 `activeRun` 表示完整运行。`waitForIdle()` 会等待 turn 结束、extension handler、队列续跑和 observed output flush 全部结算。

每个已启动的 `content` 或 `thinking` 输出 channel 恰好以一个 `output_end` 或 `output_interrupted` 终止。网络错误、取消和协议失败不伪造成正常结束。

## 会话与恢复

`data/session.jsonl` 追加 header、message、custom message/entry、compaction 和 lifecycle event。恢复后保留单一有序 `SessionEntry[]`：模型历史与 TUI timeline 从同一序列投影，避免 custom message 在重启后改变位置。

工具已开始但没有最终结果时，恢复为 `unknown`，不推断外部副作用成功。

## 能力注册

所有能力经 ActivationScope 注册：

- `builtin:runtime-tools` 注册 `get_time`、`exec_command`、Job 与 Subagent 工具，并拥有其关闭清理。
- `builtin:commands` 注册内置命令。
- 项目扩展从 `.uina/extensions/*.ts|js` 加载，在 `activate(pi)` 中调用 `pi.registerTool()`、`pi.registerCommand()`、`pi.registerProvider()`、renderer 或 hook 注册 API。

没有 `tools/` 目录扫描、loader 或动态 tool-path 旁路。ActivationScope 失效时，其注册会逆序释放；handler 报错带 extension source。

`Subject` 和 Provider adapter 只依赖必填 `RuntimeHooks` / `ProviderHooks`，不认识 `ExtensionHost`。CLI 将现有 Host 适配为 root view；无扩展 Agent 使用同一个 no-op view。所有 runtime hook 输入是冻结快照，变换必须显式返回新值；`ExtensionRunner.runtimeHooks(scopeIds?)` 只过滤同一 Host 的 handler 可见性，不创建第二个 Host、错误通道或 activation 状态。

## 模型事实

`modelContextWindow` 必须来自显式配置或可信 Provider/catalog 数据；未知上限保持未知并禁用自动 compaction。thinking 档位也必须显式声明，Uina 不根据模型名称猜测。Provider usage 缺失时 UI 显示估算，不复用上一次请求的 usage。

Provider adapter 只向 Agent 发出规范化的 `stop`、`tool_calls` 或 `length`。Anthropic 的 `message_start`/content block/`message_delta`/`message_stop` 和 Gemini 的 candidate `finishReason` 都必须形成完整终止；未知、拒绝、安全拦截、非法工具参数和不支持的终止原因会作为可见错误抛出，不会伪装为正常结束。`length` 即使带有工具调用也只保留 assistant 事实，不执行副作用；只有 `tool_calls` 才进入 ToolBroker。usage 在单次 Provider 请求内按字段合并，跨请求不复用。Gemini tool result 的函数名从历史 assistant tool call 推导；`geminiToolCallIds` 只有显式配置为 `true` 才写入 wire。

模型目录刷新会逐个 Provider 收集错误并向 CLI 报告；刷新失败时不会把失败伪装成空目录，也不会保留未标记的旧动态模型。

## 已验证与未验证

当前已通过 `pnpm typecheck`、`pnpm test`、`pnpm build`；测试覆盖本地 OpenAI-compatible、Anthropic、Gemini SSE，三种 Provider 的真实 CLI one-shot 工具回注、SessionEntry 恢复、ActivationScope teardown 和 runtime tool activation。

以下仍未验证或未实现：真实 DeepSeek/Ollama/Anthropic/Gemini 服务端（当前仅 localhost 协议与 CLI fixture）、真实 TTY IME、跨平台 shell、跨重启 Job/Subagent 对账、长期记忆、语音、视觉、感知和分布式运行时。

Job/Subagent 当前是进程内 builtin capability；ActivationScope 只保证其注册与关闭归属，不承诺崩溃后恢复。
