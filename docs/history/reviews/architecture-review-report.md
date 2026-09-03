# Uina 对照 Pi 的全方位代码与架构审查

审查日期：2026-09-03  
Uina 基线：`ac24825b591c94dc76eec5a6b0141bf92f3e39a9`  
Pi 参考基线：`e266507b606b9552fa277252644054afd4384b11`  
环境：Windows，Node.js `v24.13.1`，pnpm `11.5.2`

## 一、结论先行

Uina **有一个方向正确、已经跑通的最小 Agent 纵向切片，但目前不能称为真正稳定的微内核，也还没有达到 Pi 式的扩展开放性**。

更准确的判断是：

- 前台 Agent 主链路保持了相当好的克制：输入、模型流、工具调用、结果回注、取消和 JSONL 基本闭环已经成立。
- 最近加入的扩展、后台任务、子代理和复杂 TUI 没有围绕一个统一 host lifecycle 收拢，形成了多个并列状态岛。
- Core/Agent 已经直接认识 ExtensionHost，Provider 请求也携带 ExtensionHost，依赖方向开始倒置。
- UI 不再只是展示层。它拥有模型、thinking、usage、上下文分段、产品快捷键和 trajectory 等业务状态，其中部分是硬编码或重复状态。
- 模型能力事实存在明显违规：上下文默认值、thinking 名称猜测、默认模型目录、stale usage 都可能把未知或旧数据展示为事实。
- Jobs/Subagents 目前是有用的实验性实现，不是可靠的异步运行时：没有持久化 admission、没有重启对账，subagent 的终态和释放语义还有结构性错误。
- 文档已严重漂移。多个文档同时把已经存在的能力写成“非目标”或“未实现”，也把未接通的事件写成已设计完成。

因此建议不是继续补功能，也不是全仓重写，而是进行一次**收缩式重构**：先删除假事实和未闭环承诺，再恢复单一事实源、单一生命周期和内置/外置同构的扩展接缝。

## 二、审查方法与证据边界

本次采用四种证据等级：

| 等级 | 含义 |
| --- | --- |
| 事实 | 当前 checkout、命令输出、进程行为或文件内容直接证明 |
| 测试行为 | 自动化测试证明，但注明 mock、localhost 或真实依赖边界 |
| 实现 | 代码存在，但当前环境未证明其真实运行效果 |
| 未验证 | 缺少真实 Provider、TTY、设备、崩溃或跨平台条件 |

本次实际执行：

- 扫描 Uina 与 Pi 的仓库结构、package scripts、入口、关键包与测试布局。
- 完整阅读 Uina 的 Agent、Provider、Session、Tool、Extension、Job、Subagent、CLI 及主要 UI 代码。
- 对照 Pi 的低层 Agent、ExtensionRunner、Provider/Model runtime、session/runtime 组装和 TUI 边界。
- 执行 `pnpm typecheck`、`pnpm build`、`pnpm test`。
- 使用隔离临时 cwd/config 和 localhost SSE，从 Uina 的真实 `src/main.ts` 启动一次文本 CLI smoke。
- 再执行一次真实入口工具纵切：Provider 请求 `get_time`，Uina 执行工具、写入生命周期记录、回注结果并完成第二次模型请求。
- 编写并删除临时探针，验证 session 顺序、usage 生命周期和 thinking 输出生命周期三个反例。

没有执行：

- 真实 DeepSeek、Anthropic、Gemini 或其他收费 Provider 请求。
- 真实 Windows Terminal IME、鼠标、clipboard 和 resize 人工验收。
- Linux/macOS shell 和终端测试。
- 进程强杀、断电、跨重启 Job/Subagent 对账。
- 长时间压力、队列背压和资源泄漏测试。

## 三、当前现实

### 3.1 仓库形态

Uina 是单包 TypeScript 应用。源代码约 12,695 行，其中 UI 约 8,002 行；测试约 2,237 行。主要区域为：

| 区域 | 约行数 | 当前责任 |
| --- | ---: | --- |
| `src/core` | 95 | 跨层消息、Provider、usage、tool 类型 |
| `src/agent` | 1,078 | Subject、队列、上下文、压缩、Agent handle |
| `src/ai` | 763 | 配置、OpenAI/Anthropic/Gemini adapter、模型 registry |
| `src/session` | 696 | JSONL、恢复、记录类型 |
| `src/tools` + `tools` | 779 | broker、loader、shell/time 工具 |
| `src/extensions` | 1,452 | hooks、runner、命令、Jobs、Subagents、内置命令 |
| `src/ui` | 8,002 | terminal、renderer、editor、transcript、overlays、UI host |
| `src/cli` | 322 | 所有依赖和产品能力的组装 |

Pi 是约 23 万行 TypeScript 的 monorepo，包含 `ai`、`agent`、`coding-agent`、`tui`、protocol/client/server、session backend、telemetry 等包。它适合用来对照边界和成熟接缝，不适合按目录数量机械复制。

### 3.2 已成立的真实闭环

当前最可靠的纵向切片是：

```text
stdio/TTY input
  -> cli/app
  -> Subject
  -> ModelProvider.stream
  -> text 或 tool call
  -> ToolBroker validate/execute
  -> tool result 回注
  -> 下一次模型请求
  -> JSONL append
  -> stdio/TUI projection
```

证据：

- typecheck、build 全部成功。
- 9 个测试文件、90 个测试全部通过。
- localhost SSE 的真实 CLI 进程可以启动、生成文本并干净退出。
- localhost SSE 的真实工具闭环产生两次模型请求，执行 `get_time`，并在 JSONL 中写入 `tool_started`、`tool_finished` 和 tool message。
- OpenAI-compatible SSE 的分片 tool call、非法 JSON、缺失 finish、未知 finish、content filter 和取消都有测试。
- ToolBroker 的参数校验、并行工具、顺序工具、取消后的 unknown 表达有测试。
- JSONL torn tail、非法中间记录、未完成工具恢复为 unknown 有测试。

这些能力应保留，后续重构必须用相同纵切做回归基线。

### 3.3 未闭环或只在 mock 中成立的能力

| 能力 | 当前证据 | 结论 |
| --- | --- | --- |
| OpenAI-compatible 文本和工具 | localhost 协议 + 真实 CLI 进程 | 已闭环到本地协议边界 |
| 真实 DeepSeek/Ollama | 无当前运行证据 | 未验证 |
| Anthropic | adapter 实现；仅构造测试 | 未闭环 |
| Gemini | adapter 实现；仅构造测试 | 未闭环，工具映射有静态问题 |
| 项目扩展注册/卸载 | 自动化测试 | 基本闭环，资源发现/reload 未闭环 |
| Job | 进程内测试 + 真实后台 shell 测试 | 当前进程内闭环，跨重启不成立 |
| Subagent | mock Provider 测试 | 进程内实验实现，终态/释放不完整 |
| TUI | 大量 headless component 测试 | 组件行为较多，真实 TTY/IME 未验证 |
| Trajectory | 手工调用 projection 的单测 | 真实事件接线不完整，不能视为审计事实 |
| 长期记忆 | 无实现 | 未实现，不应暗示存在 |
| 语音/视觉/传感器 | 设计文档为主 | 愿景，不是当前能力 |

## 四、风险等级

本次审查按高风险架构评估处理，原因是：

- Agent 主循环、持久化、Provider 事实和异步副作用都会影响系统是否产生“假成功”。
- Jobs/Subagents 可以跨越对话回合并产生外部副作用。
- UI 正在展示用户会据此决策的模型能力和 usage 数据。
- 扩展 API 是未来语音、视觉、感知、记忆和自治能力的承载边界；一旦错误稳定下来，后续每个能力都会重复绕过核心。

当前深度足以作出“先收缩再扩展”的决定；但不足以宣称真实 Provider、真实 TTY 或跨重启可靠性已经通过。

## 五、微内核审查

### 5.1 什么应属于 Uina 微内核

结合 Uina 的连续主体目标，内核只需要拥有：

1. 一条 root input mailbox，以及明确的 steer/follow-up 送达点。
2. 一个 Agent active-run 生命周期与取消信号。
3. 一个有序的主体 journal 写入端口。
4. 一个 ModelPort 与一个 ToolPort。
5. 一条规范化输出事件流。
6. 一个 capability activation 生命周期，用来挂接工具、命令、Provider、hook 和 renderer。

这些都是稳定事实或最小能力接口。

不应进入内核的内容包括：

- DeepSeek/OpenAI/Anthropic/Gemini 的具体协议策略。
- shell、Jobs、Subagents、trajectory、model picker 等产品能力。
- 终端组件、快捷键、clipboard 和文件补全。
- 具体 compaction prompt、TTS 切句、传感器采样、长期记忆策略。

### 5.2 当前符合微内核理念的部分

- `Subject` 的 foreground turn、双队列、取消和工具回注是合理的核心候选。
- ToolBroker 只负责注册、schema 编译、prepare 和 execute，边界较窄。
- SessionStore 是一个小端口，JSONL 是可替换实现。
- ModelProvider 是可替换的流式接口。
- 本地扩展默认受信任，没有审批、沙箱或白名单。
- 没有工具轮次上限，也没有为了“完整”复制 Pi 的 session tree、RPC 或 protocol server。

### 5.3 已经越界的部分

#### A. Agent Core 直接依赖完整 ExtensionHost

`ModelRequest` 包含 `extensionHost`，`Subject` 直接调用 extension 的所有特殊 emit 方法，Provider adapter 又从请求里调用网络 hook。这造成：

```text
core/types -> extensions/host
agent/loop -> extensions/host
ai/provider -> extensions/host（经 ModelRequest）
```

低层运行时不能在不了解项目扩展系统的情况下独立使用。Pi 的低层 Agent 采用注入式 stream、context transform、before/after tool callback；coding-agent 层才把 ExtensionRunner 绑定进去。Uina 应学习这一依赖方向。

建议不是再抽一个“大总线接口”，而是给 Agent 一个很小的 `AgentPolicies`/callbacks 对象：context transform、before/after tool、lifecycle sink。Provider 网络变换则属于 Provider runtime 的 request transforms，不进入通用 ModelRequest。

#### B. CLI 组装器正在变成产品内核

`src/cli/app.ts` 手工创建两个 ToolBroker、JobRegistry、SubagentRegistry、ExtensionRunner、Provider registry、commands 和 UI，并手工决定哪些工具给 root、哪些给 child。

每新增一种能力都必须修改 CLI，说明能力没有通过同一个 host seam 进入系统。CLI 应只选择运行模式并组装一个 runtime；具体内置能力也应以 activation 形式注册。

#### C. UIHost 已成为第二个状态机

UIHost 持有 model、thinking、usage、context segment、busy、trajectory、modal、queue notice 和产品快捷键。它不仅渲染 snapshot，还自行改变 thinking level，并硬编码 `/tasks`、`/subagents`、`/trajectory` 等产品动作。

这不符合“UI 只负责展示、输入、焦点和组件组合”。UI 应发送语义 action，runtime 决定状态；UI 只消费一个只读 projection。

#### D. 四套状态容器缺少统一所有者

ToolBroker、ExtensionRegistry、JobRegistry、SubagentRegistry 各自可成立，但当前没有一个 activation scope 统一回答：

- 谁注册了它？
- reload 时谁卸载？
- error 属于哪个 extension？
- 哪些状态应持久化？
- 哪些能力对子 Agent 可见？
- dispose 是否真正完成？

这正是当前边界模糊和闭环断裂的根因。

## 六、主要发现与优先级

### P0：必须先修复的事实错误

#### P0-1 Session 恢复破坏有序事实

JSONL 本来是单一有序日志，但恢复结果被拆成 `messages`、`customMessages`、`customEntries` 三个数组，CLI 再按类别重组。

已复现：

```text
原记录：message A -> custom_message C -> message B
恢复后：message A -> message B -> custom_message C
```

这不仅影响 UI。CustomMessage 参与模型上下文，所以恢复后模型看到的事实顺序也变了。compaction 前的 custom message 还可能在重启后重新出现在摘要之后。

根因是一个 durable sequence 被投影成多个并行权威状态。修复方向是让恢复返回有序 `SessionEntry[]`，模型上下文和 UI timeline 都从同一 entry sequence 投影。

#### P0-2 前端展示伪造或陈旧的模型事实

当前存在：

- UIHost 默认模型 `deepseek-chat`。
- UIHost/InputLine 默认 context window 65,536。
- ContextBar 默认 context window 1M。
- UIHost 默认 thinking 为 medium，默认支持所有档位。
- UIHost 默认 context segments 为一组非零虚构数据。
- ModelPicker 内置具体模型和营销描述。
- extension Provider 未提供 contextWindow 时，Subject 静默回退 64K。
- thinking 能力通过模型名子串猜测，并命名为 `resolveOfficialThinkingLevels()`。

这些与项目明确原则冲突。未知值必须保持 `undefined/null`，UI 显示“未知”；用户配置可以收紧已知上限，但不能创造能力。

#### P0-3 Usage 生命周期会把上一轮数据伪装成当前真实数据

已复现：第一次请求返回 usage，第二次不返回；第二轮仍报告第一次 usage，且 `actual=true`。

此外 `usedTokens` 使用 `input + output`，但 normalize 后 input 已减掉 cacheRead，导致上下文占用低估；代码已有 `totalTokens` 却未使用。

修复必须以“每个 provider request 一个 usage receipt”为单位，开始请求时清空；没有 receipt 就明确估算，并标 `actual=false`。

### P1：生命周期和边界错误

#### P1-1 Builtin 与项目扩展没有共享同一生命周期

审查时只有内置 commands 经 `activateBuiltin()`。后续 Jobs、Subagents、job/subagent tools 已迁入 `builtin:runtime-tools` activation scope，普通 `tools/` loader 已删除。

直接后果：

- project `registerTool()` 只进入 root broker。
- child 从 `ordinaryTools` 创建，拿不到这些扩展工具。
- child 默认也拿不到 job-aware `exec_command`。
- reload 不会统一刷新所有能力。
- capability 状态无法统一列出和诊断。

应让内置与项目扩展都产生一个 activation scope，由同一 API 注册和清理。区别只在来源与加载策略，不在生命周期模型。

#### P1-2 扩展事件面大于真实实现面

当前典型未闭环项：

- `input` 类型存在，但运行时不 emit。
- 文档描述 `message_start/update/end`，当前 ExtensionHost 没有对应运行路径。
- 文档描述 tool execution 三阶段，当前只暴露 tool_call/tool_result。
- 文档描述 session start/shutdown，当前 host 类型未实现。
- 审查时 `resources_discover.promptPaths` 会收集但不消费；后续该未闭环 API 已删除。
- reload 不重新执行 resources discovery。
- discovered tools 不属于 activation cleanup。

克制的做法不是尽快把 30 个事件全补齐，而是：只保留目前有真实消费者和确定顺序的事件；其余从 public API/“已实现”文档中移除，等纵向场景出现再加。

#### P1-3 扩展错误可见但不可定位

ExtensionHost 按 event type 保存裸 handler，没有 extension owner。handler 抛错后 `extensionName` 通常是 unknown。Pi 的 runner 按 extension 保存 handler，所以错误天然携带 extension path。

Uina 无需复制 Pi 的大 runner，只需让每个 registration 带 `activationId/sourcePath`，并由 activation scope 统一包装 handler。

#### P1-4 Agent idle/settlement 边界不够可靠

`Subject.runTurn()` 在 finally 开始阶段就把 `busy=false`，之后仍执行 UI hook、extension turn_end/agent_end、queue resume 和 observed flush。此时新的 `waitForIdle()` 会立即返回，尽管生命周期尚未完成。

Pi 的 active run promise 在最终 listener 完成后才清除。这一点值得对齐。Uina 应有一个明确的 `activeRun` promise，并让 idle 表示：持久化、必要 hook、队列转移和输出事件都已结算。

#### P1-5 输出 channel 生命周期不闭合

已复现：thinking 开始后网络错误，只发 output_start，没有 output_end/interrupted。取消和异常分支只处理 content channel。

每个已打开 channel 必须恰好以 end 或 interrupted 结束。可用一个很小的 per-request channel tracker 消除分支遗漏，不需要新增审计系统。

#### P1-6 UI 异常可以改变 Agent 业务结果

`onToken`、`onTurnStart`、`onToolStart` 等 hook 位于 Agent 执行栈内；其中一些未隔离。UI 抛错可能让 Provider stream 或工具轮失败。

UI projection 失败必须可见，但不能改变已经发生的模型/工具事实。Runtime event sink 与 UI listener 应分离；可靠持久化 listener 可以被 await，展示 listener 应由 host 隔离并报告。

### P1：异步工作不是可靠闭环

#### P1-7 Job 在 durable admission 前启动

JobRegistry 只写进内存 Map，随即调用 producer。外部副作用可能已经发生，但崩溃后没有任何 accepted/running 记录，重启也无法标为 unknown。

若 Jobs 作为正式能力保留，最小状态必须是：

```text
accepted -> running -> succeeded | failed | cancelled | unknown
```

并且 accepted 必须先持久化，再开始外部副作用。若暂时不做持久化，应把 Jobs 明确标为 experimental/process-local，不能在总体能力表中写“已实现”而不注明边界。

#### P1-8 Job 存在无证据的并发上限

`maxActivePerOwner` 默认是 10。项目文档却明确写“不增加并发上限”。当前没有负载证据或资源模型支持这个常数。

建议删除默认上限。未来若某个 producer 需要容量控制，让 producer/provider 声明资源约束，或由显式配置启用；不要把任意数字塞进通用 Registry。

#### P1-9 Subagent 是独立状态机，且终态语义错误

当前问题：

- child 使用 MemorySessionStore，重启丢失。
- 输出数组无界增长。
- 失败/中断先写对应状态，通知后统一改成 `settled`，最终 outcome 丢失。
- 正常一轮结束只进入 `waiting`，没有成功完成语义。
- close 只 interrupt，不调用 `AgentHandle.dispose()`。
- child 固定使用启动时 Provider，root 切模型后不会同步，也没有显式 child 模型选择。

应先决定 Subagent 的真实产品语义：

- 若它是长期可继续主体：状态应是 `idle/running/failed/disposed`，每次 send 有独立 run receipt。
- 若它是一次性后台任务：应复用 Job 生命周期，而不是再造 registry。

现在的 `settled` 同时承担“通知已发送”和“执行终态”，属于重复状态，应删除。

### P1：Provider 闭环不足

#### P1-10 Anthropic/Gemini 将未知协议状态压扁

静态实现显示：

- Gemini 任意非 `STOP` finish reason 都映射为 `length`。
- Anthropic 任意非 `tool_use`/`max_tokens` stop reason 都映射为 `stop`。
- Gemini tool result 用 tool call id 作为 `functionResponse.name`，内部 tool message 又没有保存函数名。
- Anthropic start/delta usage 分别归一化并覆盖，没有累计完整请求 usage。

这违反“协议异常不得静默吞错”。在真实 fixture 或 Provider smoke 完成前，Anthropic/Gemini 只能标为 implementation/unverified。

优先考虑复用成熟 Provider SDK。最值得实验的是只替换 Provider/Model 层为 `@earendil-works/pi-ai` 或官方 SDK，保留 Uina 自己的 Subject、连续主体和扩展模型。不要把 Pi coding-agent 一起搬进来。

### P2：质量、UI 和可运维性问题

#### P2-1 Trajectory 不是审计事实

InteractiveTUI 没有调用 projection 的 `onTurnEnd()`，thinking 也没有接 start/done；tool 只有 status=failed 才标错，unknown/cancelled/not_started 被当成成功。

测试是直接手工调用 projection，所以不能证明真实接线。Trajectory 当前应改名为 UI activity projection，或者直接从统一 runtime event/journal 构建；在此之前不要称“审计轨迹”。

#### P2-2 UI 重复状态和硬编码 action

Shift+Tab 只改变 UIHost thinking level，不改变 Subject；CLI 初始化 TUI 时也没有传当前 thinking level。startup history 的 context segments 又用字符数/3自行估算，与 Agent 的字符数/4不同。

UI 应只接收：

```ts
RuntimeView {
  model?: ModelDescriptor;
  thinkingLevel?: ThinkingLevel;
  contextUsage?: ActualUsage | EstimatedUsage | UnknownUsage;
  phase: RuntimePhase;
}
```

所有改变通过语义 action 返回 runtime，不能在 UI 内直接修改权威值。

#### P2-3 CustomMessage 的 display 契约未生效

类型和持久化支持 `display?: boolean`，但 transcript 始终渲染。要么实现这个字段，要么删除它。保留无效字段会制造虚假的扩展能力。

#### P2-4 构建产物漏掉 native asset

`pnpm build` 不复制两个 `.node` 文件到 `dist/src/ui/core/native`。`start:dist` 会静默退化，Shift modifier helper 不工作，但用户看不到原因。

应在 build 中显式复制并验证 asset，或把 native helper 变成独立可选包并公开 capability status。

#### P2-5 UI import 污染非 TTY stdout

`terminal.ts` 在模块加载时注册全局 exit handler，并无条件输出终端恢复码。真实非 TTY smoke 已观察到这些 ANSI 序列。

退出恢复必须由成功 `start()` 的 ProcessTerminal 实例拥有，且只在对应 TTY 状态启用。

#### P2-6 文档与代码严重漂移

当前互相冲突的例子：

- README/DESIGN 把 Job/Subagent 列为非目标。
- `12-factor-audit.md` 称没有通用事件总线和后台 Job。
- background design 称 UI projection 未实现，但已有 task/subagent/trajectory UI。
- `pi-gap-map.md` 称没有并发上限，但 JobRegistry 默认限制 10。

建议将状态文档缩减为一个 `CURRENT.md` 或 README 的“当前事实”章节；设计提案明确标 proposal，不再同时维护多份能力清单。

#### P2-7 质量门不足

当前只有 build/typecheck/test，没有统一 lint/format/import boundary/check。源码已有 `any`、内联类型 import和跨层反向依赖。

不必复制 Pi 的全部供应链脚本，但至少应有一个 `pnpm check`：

```text
format/lint check
typecheck
dependency boundary check
focused tests
build asset check
```

## 七、扩展性与开放性评价

### 7.1 已经具备的开放接缝

当前 ExtensionAPI 已可注册：

- hook；
- tool；
- command；
- Provider instance；
- custom message renderer；
- custom entry renderer；
- UI widget/header/footer/overlay；
- custom message 和 entry。

这说明方向不是错误的。问题主要在 lifecycle、所有权和真实闭环，而不是 API 数量不够。

### 7.2 尚未达到 Pi 式开放性的原因

1. Uina 是 private app，package.json 没有稳定 extension SDK export；TypeScript 扩展没有正式公共类型入口。
2. 内置能力没有完整走相同 activation seam。
3. handler 没有 activation owner，诊断无法定位来源。
4. reload 只覆盖部分注册，不覆盖资源发现、Jobs/Subagents 或 child tool view。
5. tool renderer、快捷键等仍由 UI/内置代码硬编码。
6. 扩展 disposer 只能同步，未来设备、socket、watcher 和后台工作无法可靠 await。
7. capability 没有 `declared -> loadable -> healthy -> callable -> verified` 状态，只能看到“注册过”。

### 7.3 推荐的最小 ExtensionHost

不要继续扩张一个拥有几十个特制 emit 方法的 EventBus。建议核心只提供：

```text
ActivationScope
  - id / source
  - registerTool
  - registerCommand
  - registerProvider
  - registerRenderer
  - onLifecycle / transformContext / beforeTool / afterTool
  - dispose(): Promise<void>
```

每次 activation 产生一个 scope。所有 registration 都自动带 source，并在 scope dispose 时反序释放。Builtin 和 project extension 使用同一接口。

事件只在真实需要时加入；观察事件与变换事件分开，避免所有 handler 都返回 `unknown`。

## 八、建议的最小可行架构

无需现在拆成多个 npm 包。先在单仓内形成四个稳定边界即可：

```text
┌────────────────────────────────────────────────────────────┐
│ App Host                                                   │
│ 输入适配、运行模式、ActivationScope、错误/health/close     │
├────────────────────────────────────────────────────────────┤
│ Agent Runtime                                              │
│ active run、mailbox、context、model/tool ports、输出事件    │
├──────────────────────┬─────────────────────────────────────┤
│ Ordered Journal      │ Provider Runtime                    │
│ 单一 entry 序列      │ model facts、auth、protocol、usage  │
├──────────────────────┴─────────────────────────────────────┤
│ Frontends / Extensions                                    │
│ TUI、stdio、Jobs、Subagents、memory、speech、sensors       │
└────────────────────────────────────────────────────────────┘
```

### Agent Runtime 只拥有

- root/child Agent 的通用 run 状态；
- input queue 和 delivery order；
- ModelPort；
- ToolPort；
- context transform callbacks；
- cancellation；
-规范化生命周期事件。

它不 import UI、ExtensionRunner、JSONL、Job 或 Subagent。

### Ordered Journal 只拥有

- 单一有序 `SessionEntry`；
- append、flush、recover；
- unfinished side effect 的 unknown 表达；
- entry 到 model context/UI timeline 的纯投影。

不要再返回多个破坏顺序的权威数组。

### Provider Runtime 只拥有

- Provider 注册与实例化；
- ModelDescriptor 与数据来源；
- 网络请求/重试/取消；
- protocol normalization；
- per-request usage receipt；
- catalog refresh status/error。

建议的模型事实类型至少区分：

```ts
type Known<T> = { value: T; source: "provider" | "catalog" | "config" };

interface ModelDescriptor {
  providerId: string;
  modelId: string;
  contextWindow?: Known<number>;
  thinkingLevels?: Known<readonly ThinkingLevel[]>;
}
```

未知就是缺失，不提供 UI 默认。

### Frontend 只拥有

- 展示 projection；
- 输入编辑；
- 焦点、overlay、组件组合；
- 将按键映射成 semantic action。

它不决定 thinking 能否使用，不计算权威 usage，不维护 Job/Subagent 终态。

## 九、快路径与慢路径

### 9.1 快路径

```text
input accepted
  -> bounded input transforms
  -> context projection
  -> one provider stream
  -> first visible token/output event
```

快路径中不应包含：

- model catalog network refresh；
- compaction，除非已到明确阈值；
- Job/Subagent 等待；
- trajectory 聚合；
- extension reload；
- memory consolidation；
- UI filesystem 扫描。

当前缺少真实延迟测量，不能给出伪精确预算。建议先记录：input accepted、context ready、request sent、first byte、first content、turn settled 六个时间点，再据实制定预算。

### 9.2 慢路径

以下应是显式异步工作：

- Job；
- 一次性 subagent task；
- 长期 child agent 的每次 run；
- compaction；
- model catalog refresh；
- memory indexing/consolidation；
- TTS synthesis/playback；
- sensor processing。

慢路径结果统一通过有来源的 runtime input 回到 root mailbox，但 admission、终态和通知投递必须有 durable receipt。

### 9.3 容量与背压

当前不应发明新的工具轮次、subagent 深度或并发限制。应先删除 Job 的默认 10 上限。

可以保留已有 shell 输出 50KB/2000 行展示边界，因为它有明确目的：保护 UI/模型上下文，同时保留完整输出路径。需要继续观察的真实资源指标是：

- mailbox depth 和最老消息年龄；
- active Jobs/children；
- retained output bytes；
- journal append latency；
- Provider request concurrency；
- UI render time。

只有这些指标证明容量问题后，再把策略放在正确 owner 上。

## 十、分阶段收缩与重构顺序

### 阶段 0：Truth pass——先停止展示假事实

目标：不改总体架构，消除用户可见谎言。

- 删除 UIHost、InputLine、ContextBar 的模型/context/thinking/segment 假默认。
- 删除 runtime 使用的 `DEFAULT_MODEL_GROUPS`；若 UI 测试需要，移到 test fixture。
- 将模型名启发式 thinking 改为显式配置或可信 catalog。
- 每个 Provider 请求重置 usage；无 usage 时显示估算/未知。
- 让 model discovery error 可查询、可显示。
- 修复 Shift+Tab，使其发送 runtime action，不在 UI 本地改变权威状态。
- 更新 README 的当前事实；将旧设计稿明确标 proposal/archive。

删除标准：任何无可靠来源的具体数字或 capability 均删除，而不是换一个“更合理”的默认值。

### 阶段 1：恢复单一事实源和完整 lifecycle

- Session recovery 改为有序 entries。
- custom message/entry 的 model/UI projection 保持原顺序。
- 修复 `display=false` 或删除字段。
- 引入 activeRun promise，重新定义 waitForIdle/settled。
- 用小型 tracker 保证 output channel 成对结束。
- UI listener 与可靠 runtime listener 分离。
- 新增对应反例测试，并从真实 CLI 入口覆盖一次恢复。

### 阶段 2：统一 capability activation

- 引入 activation scope/source attribution/async dispose。
- Builtin commands、tools、Jobs、Subagents 都通过同一 API 激活。
- 合并 root/ordinary tool 的隐式分叉，改为显式 capability view/filter。
- reload 对一个 activation 集合做原子替换。
- resources discovery 要么完整接通并归属 activation，要么暂时删除未用字段。
- Agent/ModelRequest 移除对 ExtensionHost 的直接依赖，改用注入 callbacks。

### 阶段 3：决定 Jobs/Subagents 的去留

Jobs：增加最小 JobStore，先持久化 accepted，再 start；重启 running -> unknown，提供 inspect/cancel/reconcile。

Subagent：先明确是长期 child 还是 one-shot task。长期 child 复用通用 Agent runtime 和 store；one-shot 复用 Job。删除当前覆盖 outcome 的 `settled` 状态，close 必须 dispose handle。

如果本阶段不准备实现可靠语义，应把 Jobs/Subagents 从默认 builtin 中移到 experimental extension，而不是继续围绕不稳定状态做更多 UI。

### 阶段 4：Provider SDK 实验

在当前 adapter 旁边做一个可删除实验，只替换 Provider/Model 层：

- 候选 A：`@earendil-works/pi-ai`。
- 候选 B：官方 Anthropic/OpenAI/Google SDK + Uina 的薄 normalization。

用相同 fixture 比较协议覆盖、错误语义、usage、thinking、tool call、依赖体积和维护成本。若候选没有显著减少 Uina 自有协议代码或提高可靠性，就删除实验，不迁移。

### 阶段 5：UI 收口

- UIHost 只组合 terminal、renderer、focus、overlay、editor 和 projection。
- 产品快捷键进入 command/keybinding registry。
- clipboard 平台实现只保留一份。
- trajectory 从 runtime event/journal 构建；否则删掉“审计”命名。
- 为 TTY/IME/build native asset 添加真实 smoke，而不是继续增加 headless 渲染快照。

## 十一、实验契约

### 基线

- Uina commit：`ac24825b591c94dc76eec5a6b0141bf92f3e39a9`。
- Pi 参考 commit：`e266507b606b9552fa277252644054afd4384b11`。
- 固定场景：文本回复、一次工具回注、取消、session 恢复、extension reload、background completion notice。

### 可证伪假设

收缩式重构应同时满足：

1. 前台文本/工具 smoke 行为不退化。
2. Agent/Provider 层不再 import ExtensionRunner/Host 或 UI。
3. session entries 恢复保持严格顺序。
4. 未知 context/thinking/usage 不显示具体值。
5. builtin 与 project extension 使用同一 activation/dispose 路径。
6. Job admission 在副作用前持久化，或明确从默认能力移除。

### 比较指标

- 同场景的 Provider 调用次数和首 token 时间。
- 核心依赖边数量。
- CLI composition 中手工注册分支数量。
- 权威状态源数量。
- lifecycle 反例测试数量及通过情况。
- extension reload 后残留 registration 数量。
- crash recovery 后 unresolved external work 的状态。

### 停止条件

- 重构要求一次性迁移全部 UI/Provider/Session。
- 新架构需要更多并列 registry 或重复状态才能工作。
- 前台快路径增加新的同步网络调用。
- 候选 Provider SDK 强迫 Uina采用 coding-agent 专属 session/product 模型。
- 候选不能通过当前真实 CLI 文本/工具 smoke。

### 回滚与删除规则

- 每阶段独立提交，保持当前入口可运行。
- Provider SDK 作为旁路实验，未证明优势就删除。
- 未接通的 event/field/default 直接删除，不保留兼容层；当前项目没有用户要求的兼容负担。
- Dashboard 如果没有可靠 runtime projection，就先降级或移除，不能继续用 UI 局部状态补齐。

## 十二、证据计划

### 层 1：静态规则

- 禁止 `src/agent`、`src/core` import `src/ui` 或具体 ExtensionRunner。
- 禁止 UI model/usage/context 的非测试硬编码具体值。
- exhaustive mapping Provider finish reason。
- SessionEntry schema 严格验证 status、usage 数值和关联 ID。

### 层 2：进程内组合

- ordered journal projection 保序。
- usage receipt 每请求隔离。
- 每个打开的 output channel 恰好一个终止事件。
- activation dispose 后零 registration。
- builtin 与 project extension conformance 共用同一测试。

### 层 3：子进程/协议

- 当前 localhost CLI 文本和工具 smoke 固化为测试脚本。
- malformed SSE、断流、未知 finish、取消。
- build 后从 repo 外启动 `start:dist`，验证 native asset/status。
- extension reload 后工具/command/provider/renderer 不残留、不重复。

### 层 4：真实依赖

- 每个实际支持的 Provider 至少一个文本、thinking、tool、usage、取消 smoke。
- 真实 Windows Terminal IME、resize、clipboard、鼠标选择。
- Linux/macOS shell 取消和进程树。

### 层 5：恢复和压力

- 强杀发生在 tool/job accepted、running、result-before-commit 三个时点。
- Job 重启对账为 unknown，不推断成功。
- 多个 Job 完成通知顺序。
- 长时间 child 输出的内存边界。
- mailbox 持续输入、Provider 慢响应和 UI 慢 listener。

## 十三、行为与运维要求

Uina 未来作为开放主体，至少应能回答：

- 当前 build/commit、配置 profile、Provider/model 数据来源是什么？
- 当前有哪些 activation/capability，来自哪个 extension？
- capability 是 declared、loaded、healthy、callable 还是 verified？
- 当前 active run/job/child 的 ID、状态和开始时间是什么？
- 为什么失败，错误属于哪个 Provider/tool/extension？
- 哪些外部副作用处于 unknown？
- 操作者如何 inspect、cancel、retry 或 reconcile？

这些信息应来自权威 runtime/journal，不应由 trajectory UI 再维护一套审计状态。

建议的核心产品场景：

1. 用户输入，模型回复；网络中断时显示部分输出和明确错误。
2. 工具成功/失败/取消/unknown 都能恢复并继续对话。
3. extension reload 后能力原子替换，错误可定位到文件。
4. background work 先返回 ID，重启后能说明真实状态或 unknown。
5. child agent 可继续时保持独立上下文；被释放后不可再调用。
6. Provider metadata 未知时 UI 明确显示未知。
7. 未来 memory 必须验证 write/recall/use/correction，而不是仅有存储。

## 十四、风险与删除标准

| 机制 | 风险 | 删除/降级条件 |
| --- | --- | --- |
| DEFAULT_MODEL_GROUPS | 展示不存在或过时模型 | 没有可信 catalog 来源，立即移出 runtime |
| UI context segments | 伪造 token 组成 | 不能从 Provider/tokenizer 得到，显示 unknown |
| thinking 名称猜测 | 把猜测当能力 | 无 catalog/显式配置，删除猜测 |
| trajectory audit | 不完整事件造成假审计 | 未改为权威事件投影，改名或移除 |
| Jobs builtin | 崩溃丢失外部副作用 | 无 durable admission，对外标 experimental 或禁用默认 |
| SubagentRegistry | 第二状态机、终态丢失、资源泄漏 | 未明确长期/一次性语义，先移出默认 |
| resources_discover promptPaths | 审查时 API 存在但无消费 | 已删除该未闭环 API |
| 默认并发 10 | 无证据限制开放性 | 无测量与明确资源 owner，删除 |
| 多份状态文档 | 持续漂移 | 不能自动或人工稳定维护，归档为 proposal |

## 十五、最终决策

建议决策：**保留现有前台 Agent/工具纵向切片，立即停止扩功能，执行分阶段收缩式重构。**

不建议：

- 全盘搬运 Pi monorepo。
- 继续给 `Subject` 或 `UIHost` 添加特殊分支。
- 为 Jobs/Subagents 追加更多 dashboard、限制或兜底。
- 通过更多 mock UI 测试掩盖真实接线缺失。
- 为保持当前内部 API 进行兼容层堆叠。

第一步最可逆、收益最高的工作包是：

1. 删除所有模型/上下文/thinking/UI 假默认。
2. 修复 per-request usage 和 Shift+Tab 双状态。
3. 将 session recovery 改为有序 entries，并加入已复现的顺序回归测试。
4. 修复 output channel closure 和 activeRun settlement。
5. 更新唯一一份“当前事实”文档。

完成这一步后，再进行 activation scope 与 Agent/Extension 解耦。只有这两层站稳，语音、视觉、记忆、感知、自治和更多 Provider 才会拥有真正开放且不会腐蚀核心的接缝。

## 附录 A：Pi 应学习与不应照搬的内容

应学习：

- 低层 Agent 与产品 ExtensionRunner 分离。
- model/provider 是带真实 metadata 的领域对象，而不是 UI 字符串。
- extension handler 保留 source path，错误可定位。
- 内置/扩展工具共享事件与执行生命周期。
- authoritative snapshot 与 transient progress 分离。
- active run settlement 包含 listener 完成。

不应照搬：

- coding-agent 专属工具和 system prompt。
- session tree/fork/lane，除非 Uina 出现真实需要。
- protocol/client/server，除非出现远程宿主场景。
- project trust/权限模型，除非 Uina 明确进入不受信工作区。
- 完整 TUI 图片、LaTeX、主题和设置系统。
- Pi 自定义模型中的猜测默认值；Uina 的真实数据原则优先。

## 附录 B：本次生成文件

- `docs/history/reviews/architecture-review-notes.md`：审查过程中的临时证据账本。
- `docs/history/reviews/architecture-review-report.md`：本正式报告。

本次没有修改 Uina 运行代码，也没有修改 Pi。所有 smoke/probe 临时脚本均已删除。
