# Uina 深度架构与质量审查

> 状态：进行中。本文是审查证据账本，不是设计授权；只记录当前 checkout 可追溯的事实、测试行为、静态实现、假设与未验证项。

## 基线与方法

- 审查基线：`6b24c80`（2026-09-05）。
- 工作区：审查开始时干净；本文件是本次唯一预期的工作区改动。
- 参照：Pi（扩展生命周期与 UI 接缝）；DeepSeek Harness（进程内 Job/Subagent 生命周期）。参照代码不自动构成 Uina 的需求。
- 风险等级：高。涉及 Agent 核心、持久化、外部副作用、后台任务和扩展运行时；采用端到端、静态边界和失败恢复三层证据。

## 证据等级

| 标记 | 含义 |
| --- | --- |
| 事实 | 当前环境中由命令、运行记录或代码直接观察到 |
| 测试行为 | 自动化测试证明；注明真实边界或 fake 边界 |
| 实现 | 代码存在，尚未在相应真实边界验证 |
| 假设 | 需要进一步验证的设计判断 |
| 未验证 | 缺少所需环境、凭据、设备或场景 |

## 审查日志

### 0. 基线与可复现性

- **事实**：`git status --short` 在审查开始时为空。
- **事实**：包脚本提供 `pnpm typecheck`、`pnpm test`、`pnpm build`；主入口为 `src/main.ts`。
- **测试行为**：此前在同一 checkout 执行过 `pnpm typecheck`、`pnpm test`（11 文件、224 测试）及 `pnpm build`；这些仅覆盖本地测试边界，不证明真实 Provider、TTY、外部进程或跨重启 Job 行为。
- **未验证**：真实 Provider、真实终端 IME、跨平台 shell、跨进程/跨重启后台工作。

### 1. 初始待审查清单

1. 前台 Agent 回路、队列、上下文、取消与 compaction。
2. Provider 协议、模型事实、usage 与真实配置边界。
3. JSONL 会话、恢复、外部副作用的 unknown 语义。
4. 扩展 API、激活/重载/卸载、Provider/工具/命令/UI renderer/hook 接缝；与 Pi 对照。
5. Job 与 Subagent 生命周期、取消、关闭和失败可见性；与 DeepSeek Harness 对照。
6. UI 的状态所有权、命令/快捷键/工具 renderer 接缝与模块尺寸。
7. 目录依赖、死代码、硬编码、伪数据、限制和测试可信度。

### 2. Job 与 Subagent（DeepSeek Harness 对照）

#### 已观察事实

- **事实**：Uina 的 `JobRegistry` 是 `extensions/jobs/registry.ts` 内的进程内 `Map`；`JobSpec.start()` 同步返回 `JobHandle` 后才注册，`done` 决定终态。这与 DeepSeek Harness 的“生产方拥有资源、注册表拥有身份与状态；启动后必须有可取消 handle”的核心顺序一致。
- **事实**：取消会先转为 `stopping`、中止 `AbortSignal`、调用 producer cancel；`done` 拒绝会转为 `failed`，cancel 同步抛错会转为 `unknown`。关闭时会取消并等待所有 live Job 结算。
- **测试行为**：`tests/background-jobs.test.ts` 覆盖启动、输出读取、取消、关闭和 owner 隔离；为进程内 fake producer，不证明真实子进程、网络 producer 或宿主崩溃恢复。
- **事实**：DeepSeek Harness 的 LocalJobRegistry 也有按 owner 的并发准入，默认 10；但它是可配置服务实现，并伴随 controller/owner scope、生产方输出约定和更细的 completed/reported 生命周期。
- **事实**：Uina 将 `maxActivePerOwner` 默认写死为 10，CLI 以 `new JobRegistry()` 构造，当前没有配置或扩展接缝能改变它。
- **事实**：Uina Job 增量输出只保留最近 50 KiB 或 2000 行；被移除的增量只通过 `outputLost` 表示，注册表本身没有 spill/replay port。
- **事实**：Subagent 是可继续的进程内 Agent，而非一次性 Job：正常一轮结束后进入 `waiting`，可用 `subagent_send` 再次驱动；失败/中断时才释放 handle 并通知父 Agent。这与 DeepSeek Harness 的“continuable subagent 与 one-shot provider 分开”方向一致。
- **测试行为**：`tests/subagents.test.ts` 覆盖启动、继续发送、取消与失败；使用进程内 scripted Provider，不证明真实模型并发、关闭竞争或长期输出压力。
- **事实**：Subagent 将 token、thinking、工具开始/完成字符串全部累积在 `record.outputs`，没有容量、持久化或 spill 策略；其记录也不会在正常 `waiting` 后自动释放。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | Job 并发上限在 Uina 中是不可配置的硬限制 | `JobRegistry` 默认 10，CLI 未传 options；第 11 个 Job 会被拒绝。DeepSeek Harness 的 10 是有明确服务级准入语义与配置面的实现选择，不能自动成为 Uina 的固定产品限制。 | 删除默认拒绝，或把准入策略作为 Jobs 扩展显式配置；不要留在通用运行时的隐式常量。 |
| P1 | 已确认 | 可继续 Subagent 的输出无限累积 | 每个 token/思考/工具事件都进入数组，正常 `waiting` 的记录长期保留；长会话会持续增长内存与 UI 读取成本。 | 不要临时加一个任意数组上限；先定义 session-backed transcript 或 producer-owned output store，再以 cursor/replay 端口读取。 |
| P2 | 已确认 | Job 输出截断存在不可恢复的数据丢失路径 | Registry 超过 50 KiB/2000 行即丢弃旧 observation，只标记 `outputLost`；并非每个 producer 都提供 `fullOutputPath`。 | 将截断/完整输出归 producer output contract，或提供可选 spill store；保持 UI 预览限制，但不能将完整事实悄然丢弃。 |
| P2 | 未验证 | 关闭可无限等待不合作的 producer | `close()` 等待每个 `done`；符合“不凭空加 timeout”，但缺少可见的 operator reconcile/force-close 接缝。 | 先用真实长进程和 cancel-ignore fixture 验证；若需要，增加显式 unknown/reconcile，不添加隐式超时。 |

### 3. 扩展运行时与 Pi 对照

#### 已观察事实

- **事实**：`ExtensionRunner` 为 project 与 builtin capability 共用 `ActivationScope`；工具、命令、message/entry renderer、Provider、UI widget 和 event handler 的清理由 scope 逆序拥有。异步 teardown 已被等待。
- **测试行为**：`tests/extension-runner.test.ts` 覆盖 project reload、旧 context 失效、激活失败可见、异步 teardown 与 scope-filtered runtime hooks；使用临时 JS 扩展，不证明用户项目中的真实依赖解析或生产 Provider 动态注册。
- **事实**：Pi 也提供 command、tool、message/entry renderer、Provider 和 stale context 语义；此外其 UI API 暴露 app keybinding manager、editor component、tool renderer context，并有 Provider unregister 路径。
- **事实**：Uina `registerProvider()` 依赖可选的 `ExtensionRunnerOptions.onProvider` 回调；回调未提供时调用返回成功、没有注册记录，也没有错误。
- **事实**：Uina 扩展扫描仅枚举 `.uina/extensions/` 的第一层 `*.ts|*.js` 文件。扩展加载失败后会报错，但 `list()` 只保留成功激活项，不保存 declared/loadable/failed/health 状态。
- **事实**：Uina UI extension API 有 `setWidget`、overlay、header/footer 与原始终端输入，但没有受管理的快捷键注册、编辑器替换或 tool renderer 接缝；工具展示由内置 `tool-view.ts` 决定。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | Provider 注册可能静默无效 | `onProvider` 是 optional，`registerProvider` 在缺少回调时不抛错、不登记、不返回失败；扩展会以为能力已接入。 | 将 Provider registry 设为 Runner 的必需 port，或在 capability 不可用时抛出可定位错误。 |
| P2 | 已确认 | 扩展状态不可运营 | 只有 `active` 列表；失败或不健康扩展没有可查询状态、版本、错误或重试入口。 | 增加最小 capability 状态投影：declared/loadable/active/failed，保留最后错误与 reload 动作；不要复制第二套业务状态。 |
| P2 | 已确认 | UI 开放接缝低于 Pi，内置工具展示和产品快捷键仍为硬编码 | 无 tool renderer / keybinding / editor seam；新工具表现和交互常需要改 UI 内置分支。 | 先从 `Tool` 的可选 renderer 和 action/keybinding registry 开始；builtin 与项目扩展共用同一注册与释放路径。 |
| P3 | 假设 | 平铺扩展发现不足以支撑成长中的项目能力域 | 当前只加载顶层文件；尚无真实嵌套项目扩展需求作为证明。 | 在出现真实包化/多文件扩展后，复用 Node 模块解析或 manifest，不预建插件市场与复杂分类。 |

### 4. Provider 事实、usage 与会话恢复

#### 已观察事实

- **事实**：Provider 适配器要求显式 `modelContextWindow`；未知模型目录条目没有上下文上限时不会成为可选模型。Gemini discovery 读取 Provider 返回的 `inputTokenLimit`。
- **测试行为**：Provider 测试覆盖 OpenAI-compatible、Anthropic、Gemini 的 localhost SSE 协议、错误终止、工具调用和模型目录刷新；不证明真实厂商端点、真实 usage 字段或模型能力目录。
- **事实**：`Usage` 将 input/output/cache/reasoning/total 都声明为必填；OpenAI、Anthropic、Gemini 适配器在字段缺失时补 `0`，并在没有 `totalTokens` 时由已知/未知字段相加得到总量。
- **事实**：`UIHost.setReasoningEffort()` 对不在当前 Provider `thinkingLevels` 中、但落在 `DEFAULT_EFFORT_TIERS` 的值，会把该值加入 UI 的 `thinkingLevels` 数组。
- **事实**：JSONL SessionStore 用一条 promise tail 串行写入；某次 append 拒绝后，tail 保持 rejected，后续 append 通过 `tail.then(...)` 不再执行，当前实例没有恢复写路径。
- **事实**：`session/recovery.ts` 为 `projectModelHistory()` 导入 `agent/context.ts` 的 `convertToLlm()`；该投影只被测试使用。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | usage 缺失字段被伪装为零，进而伪造总量 | Provider 可只返回部分 usage；现实现将未知 cache/推理/总量补为 0，UI 会标为 actual。 | Usage 协议字段应可选；只传 Provider 明示值，`totalTokens` 缺失时使用标记为估算的上下文计算。 |
| P1 | 已确认 | UI 能自行扩张 Provider 的思考能力集合 | `setReasoningEffort()` 会把默认档位加入 `thinkingLevels`，绕过 Provider/可信目录/配置事实。 | UI 仅展示并请求已声明档位；未知请求应显示错误或未知，不得写入能力事实。 |
| P2 | 已确认 | Session 单次写失败会永久毒化当前写队列 | rejected tail 阻断后续 append；错误虽会冒泡，但没有 retry/reopen/recovery port。 | 保留首个失败的可诊断错误，并提供显式 reopen/retry 或使每次 append 独立失败；不得静默继续。 |
| P2 | 已确认 | Session 反向依赖 Agent 投影规则 | `session/recovery.ts -> agent/context.ts` 仅服务测试 helper，破坏会话层独立性。 | 将 `projectModelHistory` 移至 agent/testing projection；session 只恢复 journal 与 durable state。 |
| P3 | 假设 | `modelContextWindow` 和 thinkingLevels 的“真实能力”仍完全信任用户文件 | 显式配置可作为来源，但没有目录/验证机制区分“用户限制”与“用户声称的物理能力”。 | 将来源与可信度写入模型元数据；配置可收紧已知能力，无法验证的声明在 UI 标为配置值。 |

### 5. UI、目录边界与代码质量

#### 已观察事实

- **事实**：`src/ui/ui-host.ts` 为 1934 行，拥有终端生命周期、输入解释、取消/退出、模型与 usage 投影、思考档位、队列、Job/Subagent 面板、timeline、滚动、剪贴板、通知、动画和 overlay 组装。
- **事实**：UIHost 直接持有 Job/Subagent port，并将 `Alt+A/J/T` 映射到 `openSubagents/openTasks/openTrajectory`；工具视图以工具名分类和格式化。
- **事实**：UI 的取消与外部回调在多处 `catch {}`；回调失败一般不会呈现给用户或操作记录。
- **事实**：CLI 的 `builtinUI` 用多个 `any` 将 UIHost 方法拼成 commands 所需对象，说明命令/UI 的稳定 port 尚未被类型化。
- **事实**：边界检查脚本只禁止 core/runtime/agent/ai/session/tools import `extensions` 或 `ExtensionHost`；不检查 session -> agent、UI -> 领域能力、CLI 的 `any` 适配或循环依赖。
- **事实**：主要大文件依次是 UIHost（1934 行）、InputLine（1132）、Transcript（1074）、Subject（915）、MouseSelection（654）和 Provider（582）。文件尺寸本身不是 bug，但 UIHost 同时跨越多个稳定所有权边界。
- **测试行为**：UI 测试大量通过 `(host as any)` 调用私有渲染状态；这验证具体实现细节，不能证明公开 UI port 稳定。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | UIHost 违反“UI 只负责展示、输入、焦点和组合”的边界 | 它决定产品面板、快捷键、能力投影和取消业务动作，成为 1934 行的跨域所有者。 | 以 action port 拆出 Job/Subagent/模型/会话动作；UIHost 保留终端事件路由与组件组合，内置和扩展共享 action registry。 |
| P2 | 已确认 | 工具分类与渲染硬编码在 UI | 新工具若需要专属语义展示，需要修改 `tool-view.ts`，扩展 renderer 不覆盖该能力。 | 在 Tool 定义或 registry 增加可选 renderer；默认 renderer 仅作 fallback。 |
| P2 | 已确认 | UI 到宿主的失败会被静默吞没 | 取消、退出、终端输入等 callback 多处空 catch，用户无法区分操作成功与失败。 | 仅保留可忽略的终端最佳努力操作；其它 callback 失败通过统一通知/诊断 port 可见化。 |
| P3 | 已确认 | `builtinUI` 的 `any` 适配掩盖接口漂移 | CLI 手工拼装多个 UI 方法，编译器无法保证命令与 UI 的协作契约。 | 提取窄的 `CommandUI` interface，由 UI adapter 显式实现；不把整个 UIHost 泄漏给 command 层。 |
| P3 | 已确认 | 边界测试覆盖不足 | 当前脚本只守住“核心不依赖 extensions”，其余反向依赖无法自动发现。 | 扩展为小而明确的 import rules：session 不依赖 agent，UI 不依赖 extensions/domain registry，CLI 是唯一 composition root；避免通用复杂架构 lint。 |

#### UI 核心实现细节

- **事实**：OverlayOptions 声明 offsetY，但 OverlayStack.renderAbove() 只使用 offsetX；offsetY 不会影响最终行位置。
- **事实**：ui/core/terminal.ts 在模块导入时注册进程级 exit/SIGTERM/SIGHUP/uncaughtExceptionMonitor 监听；这不是 ProcessTerminal 实例生命周期的一部分。
- **事实**：Container.clear()、WidgetSlots.clear() 和 OverlayStack 清空的 disposer 语义不统一；后者吞掉 disposer 错误，前两者没有组件 dispose 契约。

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | 已确认 | Overlay 的公开 offsetY 参数是死配置 | 扩展可以传入该字段但渲染位置不变，造成 API 与行为漂移。 | 实现垂直偏移或删除该字段；在未实现前不要把它作为开放接缝宣传。 |
| P2 | 已确认 | 终端模块导入产生全局副作用 | 任何导入 UI terminal 的消费者都会安装进程级信号监听，多实例/嵌入运行时难以管理。 | 由应用生命周期显式 install/uninstall signal bridge；底层 Terminal 只管理设备状态。 |
| P3 | 假设 | 组件清理模型不完整 | 当前组件多为纯内存，但未来扩展 widget/overlay 可能持有 timer、child process 或设备句柄。 | 明确最小 DisposableComponent 接缝，再让所有可持有资源的组件归属 activation；不要为纯渲染组件预建复杂生命周期。 |

### 6. 前台 Agent、工具与限制策略

#### 已观察事实

- **事实**：`Subject` 维护单一 active run 与 steer/followUp 队列；队列事件写入 SessionStore，工具调用前写 `tool_started`、完成后写 `tool_finished`，中断时由 AbortSignal 传播。
- **测试行为**：smoke/context 测试覆盖工具并行、顺序、取消后的 unknown、队列顺序、压缩和会话恢复；主要为 scripted Provider 和进程内工具。
- **事实**：ToolBroker 默认并行执行同一轮的独立工具，不设全局工具轮次或并发上限；这符合本地扩展默认受信任的取向。
- **事实**：`job_output` 对调用方给出的等待时间执行 `Math.min(requested, 600000)`，即无提示地截断到十分钟。
- **事实**：输入队列在内存中没有深度、年龄、内存或过载状态；虽然会话事件会持久化队列项，但运行期没有容量观测与压力测试。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | `job_output` 静默截断等待时间 | 工具 schema 允许任意正整数，实际最多等待 600000ms；调用方无法得知请求被改写。 | 移除硬上限，或以返回值明确报告并由调用者选择；取消信号已足以提供恢复路径。 |
| P2 | 已确认 | 前台队列没有可观测的过载语义 | 输入可无限累积，运行时无队列深度/年龄指标、优先级可视化或压力场景。 | 不要先加任意上限；先暴露深度、年龄和吞吐，并用持续输入/慢 Provider 场景决定是否需要明确 backpressure 策略。 |
| P3 | 测试行为 | ToolBroker 的并行与取消语义在 fake 边界成立 | 当前测试未覆盖真实 shell 副作用、真实网络 tool 或 provider 在取消后的延迟完成。 | 用一项真实本地子进程与一项可控 HTTP tool 建立取消/unknown/恢复的集成证据。 |

### 7. 命令、CLI 与终端路径（进行中）

#### 已观察事实

- **事实**：`CommandRouter` 会等待 command handler，并将 throw 转为可见错误文本。
- **事实**：多个 builtin command 的 handler 是 `ui?.open…()`；在 pipe/non-TTY 模式 `ui` 为 undefined 时，`/help`、`/think`、`/clear`、无参数 `/model`、`/tasks`、`/subagents`、`/trajectory` 会无错误地返回且没有输出。
- **事实**：CLI 的 `!command` 直接 import 并调用 `execCommandDirect`，不经过已由 `builtin:runtime-tools` 注册的 ToolBroker、tool lifecycle event 或 extension hook。
- **事实**：强制退出路径调用 `process.exit(0)`，明确跳过 session close、extension teardown 与 Job/Subagent 等待；这可作为用户选择的 force path，但当前没有持久化或可见 marker 说明哪些 work 被放弃。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | 非 TTY 内置命令会静默 no-op | 命令被识别且返回成功，但没有 UI、stdio 输出或错误；自动化调用无法判断实际结果。 | 为 command 提供明确的 stdio renderer/command result，或在没有 UI capability 时返回可见“不支持此交互”的结果。 |
| P2 | 已确认 | `!command` 是内置 shell 能力的生命周期旁路 | 它绕过 ToolBroker 和 ExtensionRunner；内置能力与项目扩展没有共享同一接缝。 | 保留“用户直接执行、不进入模型上下文”的语义，但经单独的 direct-command port 进入同一 capability registration/diagnostic/cancellation 机制。 |
| P2 | 已确认 | force exit 缺少丢弃工作标记 | 这是显式强制操作而非普通失败，但退出后无法从 session 判断哪些 Job/Subagent/写入被中断。 | 在可用时先追加一个 force-shutdown event；无法写入时明确提示未持久化，不等待或伪造结算。 |

### 8. 终端信号、Overlay 与真实入口测试（进行中）

#### 已观察事实

- **事实**：`ProcessTerminal` 在模块加载时注册全局 `SIGTERM`/`SIGHUP` handler；handler 只恢复终端并立即 `process.exit()`，不经过 CLI 的 `shutdown()`。
- **事实**：因此这些信号会跳过 Subject interrupt/wait、ExtensionRunner dispose、Job/Subagent close 与 SessionStore close。
- **事实**：native modifier helper 不可用时回退为 false；这是能力缺失的明确退化，没有伪造键盘能力。
- **事实**：OverlayStack 的 component disposer 失败会被空 catch 吞掉，且没有诊断 callback。
- **测试行为**：`cli-session.test.ts` 会真实 spawn 当前入口并连接 localhost OpenAI-compatible、Anthropic、Gemini fixture；它是“子进程 + 本地协议”证据，不是厂商 Provider 证据。未覆盖 SIGTERM/SIGHUP、pipe command 反馈或真实终端。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | SIGTERM/SIGHUP 绕过运行时关闭生命周期 | 外部终止会直接退出，可能丢失 session 尾部、Job cancel、Subagent dispose 和 extension teardown。 | 终端模块只负责恢复屏幕；把信号交给 CLI 生命周期协调器，在可控期限内执行 shutdown，再以信号退出码结束。 |
| P3 | 已确认 | Overlay disposer 错误不可见 | extension 或组件释放失败没有错误通道，排查 reload/close 泄漏困难。 | 将 disposer 失败送入 UI/extension diagnostics；继续释放其余条目。 |

### 9. Shell 工具与外部进程资源（进行中）

#### 已观察事实

- **事实**：`exec_command` 前台输出超限后会写到系统 temp 下的 `uina-exec-*.out.txt`；路径作为结果字段返回。
- **事实**：这些临时输出文件没有 owner、保留期、显式清理或 Session 记录；项目当前 `data/session.jsonl` 已存在，Shell spill 却不在其生命周期内。
- **事实**：后台 Shell 由 JobRegistry 的 `AbortSignal` 驱动，正常 cancel 会经 `executeShellProcess` 杀掉进程树；这条路径有明确的取消机制。
- **事实**：后台 stdout/stderr 收集器若抛错，callback 直接 resolve Job 的 `done` 为 failed，但不调用 process kill，也不完成 collector；子进程可能继续运行而 registry 已为 terminal。
- **测试行为**：smoke 测试验证大输出保留尾部和 fullOutputPath；未验证 temp 文件清理、collector 写失败、真实长进程取消和子进程树逃逸。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | 已确认 | Shell spill 文件没有所有者或清理生命周期 | 临时文件可能持续泄漏，且 session 重启后缺少稳定可恢复引用。 | 定义 producer-owned artifact port：记录 owner、创建时间、清理策略与可读路径；不要把临时目录当作持久存储。 |
| P2 | 已确认 | 收集器失败可使 Job 状态与真实进程分离 | Job 先 resolved 为 failed，进程未必被取消；后续副作用不再可由 registry 控制。 | 失败时先 abort/kill 生产方，再在资源释放后结算；若无法确认停止，结算为 unknown。 |
| P3 | 已确认 | 输出 spill 使用同步文件 I/O 位于流回调 | 大量输出时 appendFileSync/writeFileSync 会阻塞前台事件循环。 | 仅在真实负载测量后替换为串行异步 writer；保留输出顺序和可见写入错误。 |

### 10. 子智能体能力继承与异步状态统一（进行中）

#### 已观察事实

- **事实**：根 Agent 经 `activateRuntimeTools()` 获得 `get_time`、`exec_command`、Job tools 和 Subagent tools；Child Agent 的 `createChildTools()` 只注册 `get_time`。
- **事实**：因此子智能体不能使用根 Agent 的 shell、Job、项目扩展工具或未来已注册 capability；该差异没有来自 Provider 数据、项目配置或工具筛选 API 的显式声明。
- **事实**：DeepSeek Harness 的 Subagent seam 把“提供方能力/工具过滤”作为显式 request capability；其 one-shot subagent 可作为 Job 返回 job id，由 job_output 统一收集。
- **事实**：Uina continuable Subagent 有独立 Registry、状态机、输出 cursor、控制工具和 UI port；它不进入 JobRegistry，不发送正常 waiting/completion 通知，只在 failed/interrupted 时通知。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | 子智能体被硬编码限制为只有 `get_time` | `createChildTools()` 是固定白名单；内置和项目扩展没有共享 child lifecycle，能力被静默剥夺。 | 将 child tool set 作为显式继承/过滤 policy port；默认应继承父级可用能力，除非调用者或 Provider capability 明确收紧。 |
| P2 | 已确认 | 长时异步工作存在 Job 与 Subagent 两套平行状态/输出/通知模型 | 可继续语义合理，但它绕过 Job 的 lifecycle、完成通知、owner 输出语义；维护者需分别理解两个控制面。 | 保持 continuable Subagent 的独立会话身份，但投影到共享 Job/async-work lifecycle 或抽出共同的 cursor、终态、通知协议。 |
| P2 | 已确认 | 正常等待状态没有父 Agent 事件 | child 首轮完成后是 `waiting`，父 Agent 只会在失败/中断时收到通知；模型无法被自然唤醒来读取已完成输出。 | 定义“轮次完成但 child 仍可继续”的显式 runtime event；由父策略决定是否注入 followUp，不把每个 token 变成通知。 |

### 11. 持久会话的真实样本与重放投影（进行中）

#### 已观察事实

- **事实**：当前工作区 `data/session.jsonl` 有 528 条有效 JSONL 记录（1 header、353 message、171 event、3 compaction），无损坏行；这是本地实际数据的结构性检查，未读取或输出任何消息内容。
- **事实**：其中 tool message 的持久化状态为 48 个 `succeeded` 和 9 个 `unknown`；assistant message 有 132 个 `complete` 与 45 个 `aborted`。
- **事实**：`TranscriptContainer.loadSession()` 在重放任何 tool message 时固定写入 UI `status: "completed"`，不读取持久化 status。
- **事实**：同一重放路径把 aborted assistant 是否显示为 interrupt 绑定到 `msg.content.includes("已打断")`，即状态解释依赖中文内容文本。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | 会话重放把 unknown 工具伪装为完成 | 当前真实 session 已有 9 个 unknown 工具记录，重放 UI 一律显示 completed，直接违反“不伪造成功”。 | 将 `ToolResultStatus` 映射为 UI 状态；unknown/cancelled/not_started 必须有不同可见呈现。 |
| P2 | 已确认 | 中断投影仍依赖人类文案 | 仅有 `aborted` status 不足以触发 interrupt 展示，文案修改/多语言/扩展消息都会改变业务解释。 | 持久化或投影 typed interrupt entry/event；UI 只根据状态和结构字段渲染。 |
| P1 | 已确认 | 实时工具投影也把 unknown/cancelled/not_started 当作非失败 | `InteractiveTUI` 只以 `status === "failed"` 判错；轨迹与工具卡片状态只有 running/completed/failed。 | 让 UI 状态模型覆盖全部 `ToolResultStatus`，并让 unknown 明确显示“无法确认”，不计入成功轨迹。 |

### 12. Token、上下文分段与轨迹事实（进行中）

#### 已观察事实

- **事实**：流式文本的 UI token 计数由 `Math.ceil(text.length / 3)` 估算，但活动行展示为未标注的 `tokens` 与 TPS。
- **事实**：`calculateContextSegments()` 以字符长度除以 4 分配 system/prompt/assistant/thinking/tool token；即使收到 Provider `totalTokens`，也只是按字符比例缩放各段。
- **事实**：ContextBar 注释称该分段为“真实”，界面没有为分段标记估算；与 InputLine 的总 token `~` 标记不一致。
- **事实**：TrajectoryProjection 注释称“杜绝任何假数据”，但它把估算 token、UI 事件时钟和三态工具结果投影为 completed/failed 时间线节点。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 已确认 | UI 将字符估算伪装为 token/TPS 实测 | `text.length / 3` 没有 Provider tokenizer 或 usage 来源，但活动行不标注估算。 | 显示“估算字符速率/估算 token”，或在没有真实 token delta 时不展示 TPS。 |
| P1 | 已确认 | 上下文分段被伪装为真实 Provider 事实 | 分段仅按字符启发式比例缩放，不能证明各类别 token；文案反而称“真实”。 | 仅在 Provider 返回分项 usage 时展示精确分段；否则整体明确标记估算并弱化/隐藏分段颜色。 |
| P2 | 已确认 | Trajectory 的“真实审计”声明超出其证据 | 它是 UI 投影而非 durable audit，且继承了工具状态和 token 估算错误。 | 更名为“运行时可视化投影”；若需要审计，消费持久化 typed event 并附证据来源。 |

### 13. 死代码、重复契约与测试可信度（进行中）

#### 已观察事实

- **事实**：TypeScript 已开启 noUnusedLocals/noUnusedParameters，能清理局部变量，但不会报告未被仓库内部使用的 public export、兼容别名或失效配置字段。
- **事实**：仓库内部没有使用 UinaUIMsg、Component.wantsKeyRelease、InteractiveTUIOptions.onDirectCommand、InteractiveTUIOptions.onCompactRequest、EffortTierId、outputLimits 或 SPLIT_DIFF_MIN_COLS；它们仍作为代码/API 存在。
- **事实**：SPLIT_DIFF_MIN_COLS 声明为 110，但 split/unified 实际分界硬编码为 80；常量没有成为单一事实来源。
- **事实**：ui/core/types.ts 的 UinaUIMsg 与 ui/tui.ts 的 OutMsg 是两套相似但不等价的 UI 事件契约；后者承载 ToolResultStatus，前者没有。
- **事实**：ui.test.ts 约 3295 行、132 个用例，许多场景通过 (host as any) 操作私有字段；它很密集，但边界主要是组件内部实现而不是公开宿主接缝。
- **事实**：现有测试含 localhost 子进程 CLI 场景，但没有真实 Provider、终端信号、负载、collector 失败或跨重启 Job 场景。

#### 发现

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2 | 已确认 | UI 存在未接线 API 与重复事件契约 | 维护者无法判断哪些是稳定扩展面、哪些是历史残留；重复类型可能发生语义漂移。 | 对每个 export 做消费者审计；删除未接线兼容层，或明确纳入公开 API 并补行为测试。 |
| P2 | 已确认 | Diff 布局阈值常量失效 | 110 的意图与 80 的行为冲突，宽度策略无法由单一常量调整。 | 使用一个实际生效的阈值；若 80 是产品事实就删除 110 常量。 |
| P3 | 已确认 | 测试过度窥探 UIHost 私有实现 | 大量 any 断言会让重构成本高，却不能证明扩展/CLI 使用的公共接缝。 | 保留少量几何纯函数测试；把主要场景移到公开 InteractiveTUI/adapter 和真实入口。 |
| P3 | 未验证 | export 级死代码与外部消费者使用情况 | 仓库是 private，当前只能证明内部未使用；没有 API 使用者清单。 | 在删 export 前确认发布/嵌入契约；否则标记 deprecated 而不是维持无主代码。 |

## 验证结果与未验证边界

- **事实**：在基线 `6b24c80` 上，本次执行 `pnpm typecheck`、`pnpm test -- --reporter=dot` 与 `pnpm build` 均成功；测试为 11 文件、224 用例。
- **测试边界**：Provider 是 localhost SSE；Agent、Job、Subagent 主要使用 scripted/fake Provider 或进程内 producer；UI 为内存终端测试。
- **未验证**：真实 Provider usage/模型目录；真实 TTY 与 IME；真实 shell 的取消后副作用；不合作 Job producer；持续负载下的队列、Subagent 输出与内存；跨重启的外部 Job 对账。
- **静态检查结果**：TypeScript 的 `noUnusedLocals` 与 `noUnusedParameters` 已启用，未发现可由编译器证明的死局部符号；这不等于证明 export、运行时分支或未接线能力没有死代码。

## 阶段性结论（待补全）

### 当前较稳固的部分

1. `Subject` 的单 active-run、队列顺序、工具 lifecycle event 与 JSONL 未完成工具恢复，具备清晰的最小纵向路径。
2. 内置与项目扩展共享 ActivationScope，且 teardown 与 stale context 有测试；这符合微内核与统一生命周期方向。
3. Provider 对未知终止、异常 SSE 和非法工具调用倾向于显式失败，而不是伪造正常完成。
4. Job/Subagent 被放在 extensions，而不是塞入 Agent core；方向正确。Subagent 的可继续语义也应保留，不应误改成一次性 Job。

### 必须优先处理的根因

1. **事实可信度**：移除 usage 零值补全与 UI 自行扩张 thinking capability，建立“Provider 返回 / 可信目录 / 显式配置 / 估算”来源标记。
2. **无理由限制**：移除 Uina 固定的 Job 并发 10 与 `job_output` 十分钟截断；如果未来需要策略，应属于 Jobs 扩展的显式、可观察配置，而非 core/CLI 暗门。
3. **持久输出**：为长期 Job 与 continuable Subagent 设计一个最小 cursor + durable/spill output port，防止一个路径静默丢失输出、另一路径无限累积内存。
4. **UI 归位**：先抽 action/keybinding port 与 Tool renderer，再拆 UIHost；不要先按视觉组件名机械分文件。
5. **扩展可运营性**：Provider registry 必须非可选或 fail loud；扩展状态至少区分 declared/loadable/active/failed。

### 最小后续实验

| 实验 | 假设 | 通过条件 | 删除/停止条件 |
| --- | --- | --- | --- |
| usage 事实修复 | Provider 少字段时 UI 不再显示伪造零值 | partial usage 回执保存并显示为未知/估算；有 total 才标 actual | 若 UI 无法表达未知，先删减展示而非继续推导字段 |
| Job/Subagent 输出 port | 长任务完整输出可按 cursor 恢复且内存有界 | 超过当前 50 KiB 的真实子进程输出可读取完整尾部/存储引用；continuable child 不无限占内存 | 若没有真实长期 producer 场景，保持现状并只增加度量 |
| UI action seam | 新 builtin 或项目扩展无需修改 UIHost 即可注册动作 | 一个 Job/Tool action 通过 registry 注册、展示、卸载 | 若 action 仍只服务一个固定视图，保留为局部 callback |

## 阶段性决策（待补全）

**当前建议：先修复已确认的 P1 事实与隐式限制，再以并列小实验验证输出 port 和 UI action seam；暂不进行全仓 UI 或 Job/Subagent 重写。**

原因：现有核心纵向路径与扩展生命周期已经可运行并有测试，问题集中在少数错误的状态所有权、事实伪造和隐式策略。此结论仍待命令、终端、完整 UI、依赖图、死代码和真实运行检查补全。

## 发现汇总

> 审查进行中；这里只在完成证据链后添加条目。

| 优先级 | 状态 | 发现 | 证据/影响 | 建议 |
| --- | --- | --- | --- | --- |
