# Uina 当前运行时

本文是 Uina 唯一的“当前事实”架构说明。它只描述当前 checkout 中存在、且能追溯到代码、测试或本地 smoke 的行为；设想和未实现设计见 `proposals/`，外部资料见 `references/`，历史审查见 `history/`。

## 当前纵向切片

```text
输入
  -> Subject active run / steer / followUp mailbox
  -> context projection + Model stream
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
| `ui/` | 展示、输入、焦点、组件组合；作为宿主的一个消费者 | 模型能力事实、Agent 状态转移、主体生命期 |
| `host/` | 主体生命期、provider/工具/Job/Subagent/扩展/会话的唯一装配、消费者事件流 | 任何 UI 类型（由边界检查强制） |
| `cli/app.ts` | 组合根：创建宿主、接入一个消费者、进程级信号与退出码 | 主体装配与 Agent 业务规则 |

## 宿主与消费者

`host/` 拥有主体的生命期，对外只暴露两件事：**一个输入入口**（`send` / `submitText` / `pushInput`）与**一条有序事件流**（`subscribe`）。消费者（TUI、stdio、远程观察者或未来的 TTS）可以随时接入或断开，主体是否继续工作与它们无关；消费者渲染所需的全部事实由 `snapshot()` 一次取齐，不再伸手进 Subject。

已由行为验证（`tests/host-separation.test.ts`）：不创建任何 UI 也能跑通 文本 → 工具调用 → 结果回注；**零消费者**状态下主体照常处理输入并写入会话；之后接入的新观察者只收到它接入之后的事件。`check-boundaries` 有一条规则禁止 `host/` import 任何 `ui/` 模块，因此这条边界不是口头约定。

投递模式规则（忙时 direct 升级为 steer、空闲时一律 direct）归属于宿主，不再由 UI 决定。

## Agent lifecycle

`Subject` 对外以 `activeRun` 表示完整运行。`waitForIdle()` 会等待 turn 结束、extension handler、队列续跑和 observed output flush 全部结算。

手动 compact 使用同一活动归属与取消信号，失败或取消不替换历史；AgentHandle 的 busy/status 从实际主体活动派生，dispose 等待活动与存储关闭。

每个已启动的 `content` 或 `thinking` 输出 channel 恰好以一个 `output_end` 或 `output_interrupted` 终止。网络错误、取消和协议失败不伪造成正常结束。

## 会话与恢复

`data/session.jsonl` 追加 header、message、input、custom message/entry、compaction 和 lifecycle event。恢复后保留单一有序 `SessionEntry[]`：模型历史与 TUI timeline 从同一序列投影，避免 custom message 在重启后改变位置。

工具已开始但没有最终结果时，恢复为 `unknown`，不推断外部副作用成功。

扩展阻止执行时记录 `not_started` 及原因，不生成 `tool_started`；该日志可正常重开。compaction 的 retained tail 按 `AgentMessage` 校验，接受 `custom` 和 `compactionSummary`，保留其内容、顺序与元数据；`custom_entry` 不进入模型上下文。

队列移交通过一条携带输入 ID、内容和来源的 `input` 记录提交：提交前归队列，提交后归会话，不再先写 `queue_consumed` 再另写 user message。用户输入投影为 user message，runtime 来源投影为隐藏 custom 消息，标明运行时来源，重开后仍可进入上下文，不伪装成人类发言。提交失败报告错误并保留待处理队列，失败轮次不自动续跑。这里保证输入归属，不保证外部副作用恰好执行一次或跨重启 producer 对账。

header 仍为 v2，新 reader 保留原有合法 v2 记录及 `queue_consumed`/`queue_restored` 的读取。旧 reader 不认识新增 `input` 子类型或缺字段的 usage，不能直接回读包含这些记录的新日志；回退使用升级前日志备份或隔离会话目录。不会自动猜测修复旧实现留下的非法生命周期记录，也无法补回旧日志中已丢失的输入。

## 工具结果

`Tool.run` 的唯一返回合同为 `{ result: string, status: ToolResultStatus }`。内置 shell、时间、Job/Subagent 工具与项目工具共用此合同；旧项目工具需将字符串返回值迁移为该对象。`tool_result` hook 的 `isError` 改为 `status`，正文变换默认保留完整结论。Broker 的 `run()` 仍是仅取正文的便捷方法，执行事实由 `execute()` 返回。

结果可附带 `continuation: "stop"`，在结果记录后结束当前决策，不丢弃其他排队输入。文件扩展用它表达明确的安静决定；UI 不需要过滤生成文本。

shell 非零退出码为 `failed`；后台任务成功创建表示此次工具调用 `succeeded`，正文中的 Job `running` 属于后台任务自身。Broker 接受 producer 已明确返回的结论；启动后遇到取消且工具抛错、无法确认结果时为 `unknown`。JSONL、实时 transcript 和恢复 transcript 保留五种结果状态；旧消息未记录状态时显示未知。UI 收到中断请求不会擅自将运行中工具定为失败，随后确认的结果可以更新已结束轮次中的对应工具卡。

## 能力注册

所有能力经 ActivationScope 注册：

- `builtin:runtime-tools` 注册 `get_time`、`exec_command`、Job 与 Subagent 工具，并拥有其关闭清理。
- `builtin:commands` 注册内置命令。
- 项目扩展从 `.uina/extensions/*.ts|js` 加载，在 `activate(pi)` 中调用 `pi.registerTool()`、`pi.registerCommand()`、`pi.registerProvider()`、renderer 或 hook 注册 API。

没有 `tools/` 目录扫描、loader 或动态 tool-path 旁路。ActivationScope 失效时，其注册会逆序释放；handler 报错带 extension source。

`Subject` 和 Provider adapter 只依赖必填 `RuntimeHooks` / `ProviderHooks`，不认识 `ExtensionHost`。CLI 将现有 Host 适配为 root view；无扩展 Agent 使用同一个 no-op view。所有 runtime hook 输入是冻结快照，变换必须显式返回新值；`ExtensionRunner.runtimeHooks(scopeIds?)` 只过滤同一 Host 的 handler 可见性，不创建第二个 Host、错误通道或 activation 状态。

## 模型事实

`modelContextWindow` 必须来自显式配置或可信 Provider/catalog 数据；未知上限保持未知并禁用自动 compaction。thinking 档位只来自显式配置或 Provider 目录：已移除按模型名索引的档位表，声明既不会被静默收窄也不会被静默抹掉，未声明即未知。Anthropic 的 `maxOutputTokens`、Gemini 的 `geminiThinkingFormat` 与 `thinkingBudgets` 都是必须显式声明的 wire 事实，缺失时在 Provider 创建阶段报错并指名字段，绝不由代码补造。UI 不补造 off，不通过 setter 或 slider 扩充可选档位。Provider usage 缺失字段保留缺失，缺少可靠总量时显示估算，不复用上一次请求的 usage；基于字符的 token/TPS 标 `~`。OpenAI-compatible finish 后继续读取 usage-only 尾，非法后续内容报错。

Provider adapter 只向 Agent 发出规范化的 `stop`、`tool_calls` 或 `length`。Anthropic 的 `message_start`/content block/`message_delta`/`message_stop` 和 Gemini 的 candidate `finishReason` 都必须形成完整终止；未知、拒绝、安全拦截、非法工具参数和不支持的终止原因会作为可见错误抛出，不会伪装为正常结束。`length` 即使带有工具调用也只保留 assistant 事实，不执行副作用；只有 `tool_calls` 才进入 ToolBroker。usage 在单次 Provider 请求内按字段合并，跨请求不复用。Gemini tool result 的函数名从历史 assistant tool call 推导；`geminiToolCallIds` 只有显式配置为 `true` 才写入 wire。

模型目录刷新会逐个 Provider 收集错误并向 CLI 报告；刷新失败时不会把失败伪装成空目录，也不会保留未标记的旧动态模型。

Anthropic/Gemini 的 `providerReplay` 保存 adapter 自有的有序块与签名；Core 仅持久化和传递元数据。Gemini thoughtSignature 位于 Part，Anthropic 多个 thinking/signature 与 redacted-thinking 块保留归属。

## 活动与文件事件扩展

JobRegistry 默认没有活动 Job 数量额度；显式 maxActivePerOwner 仍可配置。取消控制失败保留 stopping 和可定位 detail，producer.done 的真实结论仍被观察；close 等待实际终态。`job_output` 的 `wait` 超过 setTimeout 上限时显式报错，不再静默截断；已结算 Job 的原始输出在总量超过预算后按最旧优先释放，读取方仍会看到 `outputLost`，首次读取也不例外。宿主 UI 按 owner 无关视图读取全部 Job（扩展启动的后台工作同样可见）。

SubagentRegistry 从 AgentHandle 派生运行/空闲状态，只维护关系、输出与释放原因。子 Agent 的 provider 在创建时解析，因此切换模型对之后新建的子 Agent 生效；每个子 Agent 的输出保留在 256 KiB 预算内，超出后最旧的块被释放并通过 `outputLost` 报告。子 Agent 默认继承父级全部工具，由组装层用显式 include/exclude 策略收紧，CLI 不再硬编码禁止递归创建。继承的是工具实现，调用上下文的 `ownerId` 属于实际子代理；内置 Job 与 Subagent 工具据此确定归属，Job 完成通知回到发起它的 Subject。

普通扩展通过 submitInput 进入同一 Subject 输入入口，通过 reportError 报告带扩展来源的外部失败；builtin Job 完成通知也通过这个入口递交。[文件事件示例](../examples/README.md) 验证文件观察、异步命令、即时结果快照、安静决定与卸载。停止观察后不再启动其新命令，producer 通过自身取消信号结算。

## 进程生命周期与信号

进程级信号由 `cli/app.ts` 安装并在 shutdown 时卸载；`ui/core/terminal.ts` 只提供终端恢复，导入它不会注册任何进程监听器。SIGINT 保持普通中断语义（Node 会把信号名作为监听器首参，因此必须包一层零参闭包，否则信号名会被当成 force 标志）；SIGTERM（以及非 Windows 的 SIGHUP）先执行完整关闭（等待活动轮次、扩展 teardown、Job 关闭、session flush、杀掉已追踪的分离子进程），再以 143/129 退出。stdout/stderr 的 EPIPE 被忽略，其余写错误继续抛出。

shell 工具在 `exit` 之后按 stdio 空闲收敛（每个数据块重新计时 100ms），因此持有继承管道的分离子进程不会让工具永久挂起；子进程 PID 被登记，关闭时统一杀进程树。`exec_command` 的 `timeout`（秒）可省略；非法值直接报错，不做静默截断。

## 已验证与未验证

当前已通过 `pnpm typecheck`、`pnpm test`、`pnpm build`；测试覆盖本地 OpenAI-compatible、Anthropic、Gemini SSE，三种 Provider 的真实 CLI one-shot 工具回注、SessionEntry 恢复、ActivationScope teardown 和 runtime tool activation。

以下仍未验证或未实现：其余真实 Provider 服务端、真实 TTY IME、ARM native 实际加载、跨平台 shell、实际断电、长期负载、跨重启 Job/Subagent 对账、长期记忆、语音、视觉、感知和分布式运行时。

2026-09-09 硬化与重构后，`pnpm typecheck`（含边界检查）、`pnpm test`（18 文件、281 项）、`pnpm build` 通过。临时 JSONL 验证恢复，UI 验证组件及事件，均不等于实际断电或真实 TTY 操作。

编译 CLI 在隔离配置与工作目录通过 localhost 工具回注（2 次请求，退出 0）；协议失败错误可见、退出 1，Windows x64 native 资源实际加载成功。

真实 DeepSeek v4 Flash 已验证 off/high/max、usage、流式取消及普通文件扩展完整场景。后台运行期间用户答复在 715 ms 到达，安静决定没有回复文本，实际命令失败回注，后台取消在 523 ms 后确认，卸载后不再投递。完整范围、延迟与复现入口见 [交付证据](history/reviews/2026-09-05-plan-delivery.md)。

Job/Subagent 当前是进程内 builtin capability；ActivationScope 只保证其注册与关闭归属，不承诺崩溃后恢复。
