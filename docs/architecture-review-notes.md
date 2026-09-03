# Uina ↔ Pi 架构审查临时笔记

> 状态：审查中的证据账本。这里先记录观察与待证项，不把实现、文档或 mock 测试误写成真实运行事实。最终结论另见审查完成后生成的正式报告。

## 0. 基线与证据等级

- 审查日期：2026-09-03（Asia/Shanghai）。
- Uina：`E:\Uina\Uina`，分支 `master`，开始审查时工作树干净。
- Pi：`E:\Uina\ThirdParty\pi`，分支 `main`（跟踪 `origin/main`）；已有未跟踪目录 `.VSCodeCounter/`，与本次审查无关且不修改。
- 证据等级：
  - **事实**：当前环境直接观察到的文件、命令结果或运行行为。
  - **测试行为**：自动化测试证明的行为，必须注明 mock / 进程 / 真实依赖边界。
  - **实现**：代码存在，但尚未在当前环境证明运行结果。
  - **假设 / 愿景**：设计选择或产品目标，不能当作当前能力。

## 1. 规模与初步结构

- Uina：单包，`src/`、`tests/`、`tools/` 共 86 个 TypeScript 文件，约 15,429 行（含测试）；主要大文件包括 `ui/ui-host.ts` 约 1,139 行、`agent/loop.ts` 约 736 行、`ui/components/editor/input-line.ts` 约 808 行。
- Pi：monorepo；关键包为 `ai`、`agent`、`coding-agent`、`tui`，另有 `protocol`、`client`、`server`、session backend、telemetry。全量规模远大于 Uina，因此采用边界与纵向切片对照，不做逐文件机械对照。
- Uina 文档声明的纵向切片：terminal → cli/app → agent/loop → context/provider → text/tool call → ToolBroker → tool result 回注 → JSONL session。
- 文档漂移待核：README/DESIGN 仍把后台 Job、subagent 等列为非目标，但源码和测试中已经存在 `extensions/jobs`、`extensions/subagents` 及相应 UI。需要判断其闭环程度和边界归属。

## 2. 审查区域

1. **启动与纵向闭环**：CLI 输入、Agent turn、Provider 流、工具执行、结果回注、session 持久化、UI 输出。
2. **微内核归属**：`core` / `agent` / `session` 是否只拥有稳定事实、生命周期与最小端口；策略是否外泄或重复。
3. **扩展系统**：命令、工具、Provider、hook、UI renderer、组件的注册、作用域、卸载、错误隔离和内置/外置同构程度。
4. **模型与 Provider 事实**：模型能力、上下文、thinking、usage 的来源与用户配置收紧规则。
5. **慢路径与恢复**：background job、subagent、compaction/未来 memory、取消、重启、unknown、错误可见性。
6. **UI 边界**：UI 是否只负责展示、输入、焦点和组件组合；是否拥有本应在 runtime/extension 的业务规则。

## 3. 审查步骤

1. 找出双方真实入口、package exports、依赖方向和测试命令。
2. 沿 Uina 最小纵向切片逐调用读取，画出状态所有权与副作用写路径。
3. 读取 Pi 对应的 `ai`、`agent`、`coding-agent` extension/session/UI 接缝，提炼已被其真实代码采用的模式。
4. 分区记录：符合点、边界泄漏、重复状态、未闭环能力、开放接缝缺口、可删除复杂度。
5. 运行 Uina typecheck、测试、build，并执行不需要真实付费 Provider 的入口 smoke；真实 Provider/TTY/跨平台项按条件标为未验证。
6. 形成正式报告：当前现实、风险等级、总评、最小架构、快慢路径、验证契约、风险/删除标准、分阶段决策。

## 4. 初始待证问题

- `core/types.ts` 是否真是稳定跨层协议，还是一个被动的类型杂物箱。
- `agent/loop.ts` 是否同时拥有过多 provider、session、hook、tool/job/subagent 策略。
- `extensions/host.ts` 是否形成单一、可组合的扩展生命周期；内置能力是否走相同入口。
- Provider 是否可由扩展注册，还是配置中的封闭联合 + gateway 分支。
- UI extension 是否只是 renderer/component 接缝，还是 UI context 可直接操纵业务状态。
- job/subagent 是否持久化、可恢复、可取消、错误可见，还是仅进程内演示状态。
- 模型选择器与 context bar 的能力数据是否完全来自真实配置/Provider 元数据。
- session JSONL 是否成为唯一事实源，还是 runtime、registry、UI 各自维护重复权威状态。

## 5. 进行中发现

### 5.1 已证明成立的部分

- **事实**：`src/main.ts` 只有错误边界，实际组装集中在 `src/cli/app.ts`；前台路径可从一个入口追到 `Subject`、Provider、ToolBroker、JSONL 和 stdio/TUI。
- **测试行为（当前 checkout）**：`pnpm typecheck`、`pnpm build`、`pnpm test` 全部成功；Vitest 为 9 个文件、90 个测试。
- **本地真实进程 smoke**：在隔离临时 cwd/config、localhost OpenAI-compatible SSE 下，从 `src/main.ts` 启动的一次性文本请求成功退出并输出预期文本。
- **本地真实进程 + 工具纵切**：Provider 第一次返回 `get_time` 调用，Uina 实际执行工具并进行第二次 Provider 请求；最终输出成功，JSONL 同时存在 `tool_started`、`tool_finished` 与 tool message。
- ToolBroker 的 schema 预编译、默认并行/按工具顺序化、取消后的 `unknown` 表达、JSONL torn-tail 修复与未完成工具恢复，属于当前最可靠的设计。
- 项目扩展 activation 拥有注册清理列表；reload/dispose 后旧 API 会失效。注册工具、命令、Provider、自定义 message/entry renderer 的方向正确。

### 5.2 关键反例（可复现）

1. **Session 顺序不是单一事实源**：构造 `message(A) -> custom_message(C) -> message(B)` 的合法 record 流，`recoverRecords()` 输出 `messages=[A,B]` 与独立 `customMessages=[C]`；CLI 的恢复方式最终形成 `[A,B,C]`，改变原始顺序 `[A,C,B]`。compaction 前的 custom message 也会在恢复后重新追加到摘要之后。根因是 snapshot 把同一有序日志拆成多个数组，再由 CLI 重组。
2. **Usage 会伪装成当前真实值**：第一次 Provider 请求返回 usage、第二次不返回；两次 `onTurnEnd` 都报告第一次的 `usedTokens=15`、`actual=true`。`lastReportedUsage` 没有按请求/运行清空；并且计算排除了 `cacheRead`，没有使用 `totalTokens`。
3. **thinking 输出生命周期不闭合**：Provider 先发 thinking delta 后抛出网络错误，扩展只收到 `output_start:thinking`，没有对应 `output_interrupted` 或 `output_end`。当前异常/取消路径只关闭 content channel。
4. **非 TTY 被 UI import 污染**：CLI smoke 正常输出后仍出现退出备用屏/键盘模式 ANSI 序列。根因是 `ui/core/terminal.ts` 模块加载时无条件注册全局 `process.on("exit")` 并向 stdout 写终端恢复码，而非由已启动的 terminal 实例拥有副作用。

### 5.3 微内核与依赖方向

- Uina 源码约 12,695 行（不含测试），其中 UI 约 8,002 行；“大”主要在 UI，不等于 core 大，但 `ui-host.ts`（约 1,139 行）已成为第二个业务协调器。
- `core/types.ts` 反向引用 `extensions/host.ts`（`ModelRequest.extensionHost`）；`agent/loop.ts` 直接认识完整 ExtensionHost；Provider adapter 也通过 ModelRequest 调扩展 hook。低层 Agent/Provider 因而不能脱离项目扩展运行，依赖方向与 Pi 的“低层 Agent 仅接收注入回调、coding-agent 层绑定 ExtensionRunner”相反。
- `extensions/commands.ts` 依赖 UI registry，`extensions/builtin.ts` 直接依赖 `UIHost` 和具体 overlay。扩展运行时、产品功能和 TUI 组装混在同一层。
- 当前至少有 ToolBroker、ExtensionRegistry、JobRegistry、SubagentRegistry 四套注册/状态容器。它们不是天然错误，但没有一个 host lifecycle 对它们统一拥有、刷新、卸载和持久化。
- `src/cli/app.ts` 手工创建并连线 Provider、两个 ToolBroker、Jobs、Subagents、ExtensionRunner、commands 和 UI，322 行已经承担 feature policy；新能力需要继续修改该文件。

### 5.4 扩展性与开放接缝

- 正面：`ExtensionAPI` 已提供 hook、tool、command、provider、message renderer、entry renderer、UI primitive、自定义消息/条目；本地扩展默认直接加载，没有审批/沙箱。
- 缺口：package 是 private 且无 `exports`/extension SDK 入口，本地 TypeScript 扩展没有稳定可导入的公共类型面；目前更像“内部 API 对象”，还不是可演进的扩展平台。
- 内置与外置不对称：只有 commands 通过 `activateBuiltin()`；Jobs/Subagents 和 job/subagent tools 在 CLI 手工注册，普通 `tools/` 又走另一套 loader。
- root 有两个 ToolBroker。`registerTool()` 只进入 root broker；subagent 从 `ordinaryTools` 建立工具集，因此拿不到项目扩展直接注册的工具。child 默认甚至拿不到 `exec_command`，只有初次复制的普通工具。这是未声明的能力限制，而非统一扩展策略。
- `resources_discover` 的 `promptPaths` 收集后完全未消费；reload 不重新执行资源发现；发现的 tool path 不归 activation cleanup 所有，未来重载会遇到残留/重名。这条 API 未闭环。
- `input` 事件已经定义但没有任何 emit 调用；文档承诺的 `message_start/update/end`、`tool_execution_start/update/end`、`session_start/shutdown` 多数未进入当前 ExtensionHost 类型或运行路径。
- 没有 tool renderer 注册接缝、快捷键注册接缝；UI 中 Alt+A/J/T 等产品快捷键硬编码到 `UIHost`。
- handler 存储时没有 extension owner 元数据，运行时错误通常只能显示 `extensionName=unknown`；对“可定位”不足。dispose 只允许同步函数，不足以可靠释放未来传感器、连接或后台任务。

### 5.5 Provider、模型事实与协议

- `modelContextWindow` 对配置模型强制显式填写、`maxContextWindow` 只能收紧，这是正确设计。
- 但 extension Provider 可以不提供 context window，Subject 会静默回退 64K；UIHost、InputLine、ContextBar 又分别硬编码 64K/65,536/1M 等默认值，违反“未知就显示未知”。
- `resolveOfficialThinkingLevels()` 依据模型名子串猜测 thinking 能力，却以“official”命名并用于真实 UI/请求；这不是可信模型目录数据。UI 的默认 ModelPicker 还内置一批具体模型与营销描述。
- ModelRegistry discovery 失败在 `catch {}` 中静默吞掉，CLI 又 fire-and-forget refresh；用户无法知道目录是未刷新、失败还是确实为空。
- OpenAI adapter 的 localhost 协议测试较完整；Anthropic/Gemini 只有构造测试，没有真实/协议 fixture 闭环。
- 静态代码风险：Gemini tool result 用 `tool_call_id` 作为 `functionResponse.name`，而内部 tool message不保存函数名；任意非 `STOP` finish reason 都映射为 `length`。Anthropic 任意非 `tool_use`/`max_tokens` stop reason 都映射为 `stop`。这些会把协议异常或安全终止压扁成正常/截断状态。
- Anthropic usage 的 start/delta 片段各自归一化后覆盖，未累计；再叠加 Subject 的 stale usage，会使前端 usage 不能当作可信事实。

### 5.6 Job、Subagent 与慢路径

- JobRegistry 是纯进程内 Map；`start()` 在任何 durable record 之前启动 producer。崩溃后无法恢复 accepted/running，也无法转为 unknown。这与“能 outlive turn 的 Job 先持久化”不符。
- JobRegistry 默认硬编码 `maxActivePerOwner=10`，直接违背项目文档及用户要求的“无真实资源证据不加并发上限”。
- `close()` 会无限等待 producer 进入终态；缺少 operator reconcile/force-close 接缝。注意：不应因此草率添加任意 timeout，应该让 producer/host 提供显式 unknown/reconcile。
- SubagentRegistry 与 Jobs 是第二套不同状态机；child 使用 MemorySessionStore，重启丢失；输出数组无界增长。
- Subagent 终态语义错误：失败/中断先写入对应状态，`settle()` 通知后又统一改成 `settled`，最终快照丢失 outcome；正常完成一轮只进入 `waiting`，没有成功完成/通知语义。
- Subagent `close()` interrupt 但从不调用 `AgentHandle.dispose()`，child store/资源没有真正释放。
- child 固定使用启动时 Provider；root 后续切模型不会影响 child，也没有显式 per-child 模型选择。
- 空闲时 runtime notice 直接触发 run，却没有 durable queue/event record；与进程内 Job 叠加后，完成通知可能在崩溃时永久消失。

### 5.7 UI 边界与真实数据显示

- UIHost 自己持有 model、thinking level、context window、usage segment 等状态；初值包含 `deepseek-chat`、`medium`、65,536 和虚构的 segment 分布 `sys=9000/pr=5/...`。InputLine 和 ContextBar 又各有重复默认。
- CLI 创建 TUI 时只传 `thinkingLevels`，没有传当前 `thinkingLevel`；UI 初始可能显示 medium，而 Subject 实际为 off/配置值。Shift+Tab 只调用 UIHost 本地 `cycleReasoningEffort()`，不会更新 Subject，形成明确的双状态 bug。
- startup 恢复时 CLI 用字符数/3自行伪装 segment 拆分，与 agent 的字符数/4 token 估算又不一致。
- TrajectoryProjection 被称为“真实运行时轨迹”，但 InteractiveTUI 没有调用 `onTurnEnd()`，thinking 也没有调用 projection 的 start/done；tool 只把 `failed` 当错误，cancelled/unknown/not_started 会记为成功。它是残缺 UI 投影，不是审计记录。
- ToolRecord 不保存 status，UI 只能从结果字符串猜测一部分状态。queue change 每次向 transcript 追加 notice，会把快照变化重复写成 UI 历史。
- `CustomMessage.display=false` 没有被 transcript/render path尊重。
- UI hook（尤其 `onToken`、`onToolStart`、`onTurnStart`）异常可以反向使 Agent turn 失败，说明展示层仍可拥有业务生命周期结果。
- `ui-host.ts` 同时负责渲染、状态、快捷键、clipboard 子进程、文件建议、产品命令路由、任务面板和轨迹投影，边界过宽；InputLine 中又重复了一套 clipboard 实现。

### 5.8 文档、测试与可运维性

- README/DESIGN 仍把 background Job、subagent 列为非目标；`12-factor-audit.md` 仍称没有事件总线/后台 Job；background design 又称 UI 状态投影未实现，但源码已有三个 dashboard/scene。文档无法作为当前事实索引。
- 41/90 测试集中在单个 `ui.test.ts`；大量测试证明组件能渲染或手工调用 projection，不证明真实 CLI 是否把事件接上。实际 trajectory 缺线就是典型假阳性。
- 当前没有 lint/format/依赖方向检查；源码仍有若干 `any` 和大量 inline type import。Pi 的质量门包含统一 check、依赖/导入/锁文件校验，Uina 尚无对应的轻量质量门。
- `build` 不复制 `src/ui/core/native/*.node` 到 dist；`start:dist` 在 Windows 会静默退化为无 native modifier helper。源码加载失败也静默处理，用户无法分辨“功能不支持”和“构建漏资产”。
- 导入 terminal 模块产生全局 process exit 副作用，是可组合性与非 TTY 污染问题。

### 5.9 Pi 对照结论（不盲从）

- 值得对齐：Pi 低层 Agent 只拥有 transcript、active run、queue、工具生命周期和注入式 stream/transform callbacks；coding-agent 层才绑定 ExtensionRunner。ExtensionRunner 按 extension 保存 handler，因此错误能带 `extensionPath`。Provider/Model 用结构化 Model 元数据与 registry/runtime 管理，并将目录刷新错误保留为可查询状态。
- 不应照搬：Pi 当前 monorepo 已包含 protocol/client/server、复杂 session tree、telemetry、project trust、丰富 UI 和大量 coding-agent 专属能力；Uina 当前没有对应真实场景。Pi 自定义模型路径也存在 128K 默认值，不能因为来自 Pi 就违背 Uina 的“未知不伪造”原则。
- Uina 应学习 Pi 的“分层和接缝”，而不是复制 Pi 的“功能数量与包数量”。
