# Uina 当前方向与边界审查

审查日期：2026-09-05。基线：`6b24c80`。本报告评价当前小 Agent 是否适合继续成长，以及现有边界需要怎样纠正。未实现的周边能力不作为缺陷；没有以 Pi、DeepSeek Harness 的功能数量衡量 Uina。

## 1. 结论与证据边界

**总体方向成立，建议保留现有小内核，局部重构几处事实和生命周期边界。没有证据支持整体推倒重建。**

值得保留的是可注入的 Provider、工具与会话端口，共享的扩展激活生命周期，主体与 UI 的分离，以及使用有序日志保存事实的方向。需要纠偏的是：一些模块在传递同一件事时改变了它的含义；一些公共操作没有进入共同生命周期；部分 Provider 数据经过规范化后失真。这些会直接影响后续扩展组合，优先级高于新增周边功能。

这次审查没有验证 AGI、长期人格、自主生活或真实语音效果。它验证了现有机制的一部分，并给下一阶段提出可证伪的实验。

- 环境：Windows，Node `v24.13.1`，pnpm `11.5.2`。
- `pnpm typecheck` 通过，包含当前依赖边界检查。
- `pnpm test` 通过：11 个文件、224 项测试；另用 `vitest list --filesOnly` 确认了测试文件范围。
- `pnpm build` 通过。已核实构建清理目标为工作区内普通 `dist` 目录。
- 构建后的 `dist/src/main.js` 在全新临时工作目录与配置目录中，通过 localhost SSE 完成真实 `get_time` 工具回注，退出码 0。
- 新增四份隔离复现脚本；涉及真实临时 JSONL、本地 shell、内存 Provider/Job、localhost 协议。没有调用真实厂商模型、没有使用真实会话数据。
- 真实厂商协议兼容性、真实 TTY/IME、TTS、实际崩溃杀进程和持续负载未验证。对照官方协议的结论会另作标记。
- 审查开始时已有未跟踪文件 `docs/uina-deep-audit.md`；本轮未修改它，也未把其中结论当作本轮验证结果。

审查对象涉及持久化、副作用和取消，错误影响较高，因此使用了组合复现与干净目录 CLI 验证。此次交付只新增审查材料，没有修改业务代码或已有测试；未进行真实设备或外部服务操作。

分类：**A＝已有行为缺陷；B＝原则偏差或需要演进的边界；C＝合理未完成或未验证。** “缺少某项未来能力”不属于 A。

## 2. 已经走对的部分

| 现有设计 | 依据与判断 |
| --- | --- |
| 主体循环通过 Provider、ToolBroker、SessionStore、RuntimeHooks 工作 | [Subject 构造](E:/Uina/Uina/src/agent/loop.ts:106)。核心没有直接依赖 TUI 或 ExtensionHost，值得保留。 |
| 内置能力与项目扩展共享 activation | [activateBuiltin](E:/Uina/Uina/src/extensions/runner.ts:99)、[注册与清理](E:/Uina/Uina/src/extensions/runner.ts:160)。注册有归属，卸载有路径，已有测试验证。 |
| 历史事实与当次模型上下文可以分开 | [上下文转换](E:/Uina/Uina/src/agent/context.ts:20)。保留原始会话，通过投影产生模型消息，比直接让模型协议支配所有状态更适合未来扩展。 |
| 工具执行前记录启动，未完成结果保留 unknown | [会话恢复](E:/Uina/Uina/src/session/recovery.ts:247)。这是正确的恢复语义，后文的问题要求统一它，而非移除它。 |
| Job 拥有 handle，长工作通过 done 结算 | [Job 合同](E:/Uina/Uina/src/extensions/jobs/registry.ts:47)。主体不必同步等待所有外部工作。 |
| 子 Agent 有独立会话与 AgentFactory | [AgentHandle](E:/Uina/Uina/src/agent/runtime.ts:43)。可继续的子主体与一次后台操作可以分别存在。 |
| 未知上下文窗口不伪造；协议异常通常可见 | [配置](E:/Uina/Uina/src/ai/config.ts:36)、[Provider 流处理](E:/Uina/Uina/src/ai/gateway.ts:78)。现有局部数据失真不应抹去这些正确取舍。 |

因此，“从小 Agent 起步”本身没有走歪。当前执行模型也没有不可逆地锁死 Uina 的未来；真正需要控制的是新增能力时，是否继续绕开已有接缝、重复解释同一份事实。

参考项目的取舍也有具体依据：DSH 的 [Job handle 合同](E:/Uina/ThirdParty/deepseek-harness/packages/jobs/jobs/src/types.ts:71) 将 done 与 producer 释放资源联系起来；Pi 将同一执行错误结论传给 [工具结束事件与结果消息](E:/Uina/ThirdParty/pi/packages/agent/src/agent-loop.ts:774)，并提供 [应用消息到模型消息的转换接缝](E:/Uina/ThirdParty/pi/packages/agent/src/agent.ts:98)。这些语义值得学习。DSH 的 [默认并发 10](E:/Uina/ThirdParty/deepseek-harness/packages/jobs/jobs-local/src/index.ts:28) 则属于它的运行策略，源码存在只能证明出处，不能证明 Uina 也需要继承。此次仅做相关源码对照，未全面运行或审计参考项目，也未进行 dsh-TUI 的视觉对照。

## 3. A 类：已有行为需要纠正的位置

### A1. 会话写入、恢复和上下文转换的合同尚未完全一致

**优先处理：存在正常操作后无法重开会话，以及恢复时丢失输入的路径。** [core 复现脚本](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/core.mts) 验证了三种情况：

1. 扩展在 `beforeCall` 返回 `block:true`。工具执行次数为 0，但 [loop](E:/Uina/Uina/src/agent/loop.ts:737) 写入没有启动记录的 `tool_finished(status:failed)`；[恢复器](E:/Uina/Uina/src/session/recovery.ts:247) 拒绝它。实际 JSONL 关闭重开报“工具未启动即完成”。应使用现有 `not_started` 语义保留拒绝原因，统一写入与恢复规则。
2. 扩展 custom message 被保留在 compaction 的尾部。[写入端](E:/Uina/Uina/src/session/jsonl-store.ts:83) 接受领域 `AgentMessage`，但 [读取端](E:/Uina/Uina/src/session/recovery.ts:306) 用只接受 Provider 四种 role 的校验器验证 retained tail。实际压缩成功后重开报“record schema 无效”。会话应验证自己的消息合同，在 Provider 边界再转换；不要通过删除 custom 内容掩盖问题。
3. [队列消费](E:/Uina/Uina/src/agent/loop.ts:847) 先持久化 `queue_consumed`，随后才 [追加输入消息](E:/Uina/Uina/src/agent/loop.ts:396)。截取实际运行在两步之间产生的合法日志前缀，恢复后原输入既不在队列也不在历史。这是崩溃窗口模拟，未实际杀进程。应让带输入 ID 的一次持久化提交同时完成“进入历史”和“离开队列”的投影；仅交换写入顺序会把丢失窗口换成重复窗口。

共同方向：明确领域记录及其有效状态转换，不需要增加一个旁路审计库，也不应放宽恢复器以静默忽略问题。

### A2. 仍在运行的工作，有时已被宿主认作结束

**优先处理：操作生命周期必须覆盖操作实际修改的状态和仍持有的资源。**

- [手动 compact](E:/Uina/Uina/src/agent/loop.ts:202) 没有进入 `activeRun`，也没有创建自己的 AbortController。延迟返回的 fake Provider 仍在执行时，`isBusy()` 为 false，`interrupt()` 无法取消，`waitForIdle()` 已返回。现有 [/compact 命令](E:/Uina/Uina/src/extensions/builtin.ts:182) 调用这条路径。应将它纳入主体活动/取消归属；不是再补几处“是否正在压缩”的旁路状态。[复现](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/core.mts)
- [Job 取消](E:/Uina/Uina/src/extensions/jobs/registry.ts:262) 在 producer 的 `cancel()` 抛错后直接结算为 `unknown`。验证中 producer 的 `done` 仍 pending，Registry 的 `close()` 已结束，再次取消返回 `already-finished`；稍后 producer 明确完成也被忽略。取消控制失败应作为可见诊断，宿主仍需观察实际 producer 结算；`unknown` 不能自动代表资源已经释放。[复现](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/extensions.mts)

不要求为任意不合作扩展增加超时兜底；这里的问题是宿主已知工作仍在运行，却提前丢弃其生命周期归属。

### A3. 工具结果在执行、持久化和 UI 之间发生有损转换

经过真实本地 shell 执行 `exit 7`，[exec_command](E:/Uina/Uina/src/extensions/runtime-tools/exec-command/index.ts:142) 正常返回包含 `status:failed` 的 JSON 字符串；[ToolBroker](E:/Uina/Uina/src/tools/broker.ts:117) 把正常字符串返回统一标成 `succeeded`。实测得到 `outer=succeeded, inner.status=failed`。[复现](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/extensions.mts)

UI 又进行了一次压缩：[实时 tool_done](E:/Uina/Uina/src/ui/tui.ts:241) 仅以 `status === failed` 判断错误，[会话回放](E:/Uina/Uina/src/ui/components/transcript/transcript.ts:632) 则把所有工具结果写为 completed。内存投影实测如下，未进行真人终端操作：

| 输入事实 | 实时卡片状态 | 重放卡片状态 |
| --- | --- | --- |
| succeeded | completed | completed |
| failed | failed | completed |
| cancelled | completed | completed |
| unknown | completed | completed |
| not_started | completed | completed |

[UI 复现](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/ui-cli.mts)。模型仍可能读到错误文本，部分 renderer 也可能从内容显示错误；这不消除外层状态与事实的矛盾。

建议由工具通过结构化结果提供状态与内容，Broker 原样传递执行结论，会话与 UI 使用同一语义。不要让 UI 解析 shell JSON 来重建业务事实。对于 cancelled、unknown、not_started，可以有简洁外观，但不能把它们计为成功。

### A4. 子 Agent 的“提交完成”被误认为“运行结束”

[SubagentRegistry.run](E:/Uina/Uina/src/extensions/subagents/registry.ts:106) 在 `handle.send()` 返回后设为 waiting；然而 [Subject.accept](E:/Uina/Uina/src/agent/loop.ts:277) 在忙时只完成入队。fake Provider 阻塞第一轮时再提交第二条消息，得到 `status:waiting, busy:true`。[复现](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/extensions.mts)

这是已有功能的矛盾快照。运行/空闲应从 AgentHandle 的真实生命周期派生；Registry 负责父子关系、名称、输出和释放原因。应减少对同一执行状态的重复维护，不应增加更多同步 if。

### A5. usage 被丢弃，或者被补成并不存在的完整事实

- [OpenAI-compatible parser](E:/Uina/Uina/src/ai/gateway.ts:102) 在 `finished` 后提前返回。输入 `text → finish_reason → choices:[],usage → [DONE]`，只输出 text 与 finish，没有 usage。[OpenAI 官方说明](https://help.openai.com/en/articles/10478918) 明确计量可以位于 `[DONE]` 前独立片段。应区分内容结束与流结束，继续处理计量，同时拒绝完成后新增内容。
- [Usage 类型](E:/Uina/Uina/src/core/types.ts:19) 全字段必填；[规范化](E:/Uina/Uina/src/ai/gateway.ts:279) 将缺失项补零。Provider 只提供 `prompt_tokens:10`、同时产生非空回答的组合实测，轮次结果为 `usedTokens:10, outputTokens:0, actual:true`，相同值进入历史。未知输出量不是实测零；总量不完整时不能作为完整真实上下文锚点。

两项均通过 [Provider 探针](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/provider.mts) 复现，网络由进程内 fetch stub 替代。应保留字段缺失，仅在 Provider 给出或组成项完整时提供可信总量；估算仍可存在，但需明确标记。

### A6. 声明 thinking 档位与实际请求控制存在脱节

[geminiRequest](E:/Uina/Uina/src/ai/providers.ts:375) 对 low 和 high 产生相同的 `includeThoughts:true`，off 只是省略配置。[Google 文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking?hl=en) 区分思考摘要开关与推理强度控制；后者取决于模型使用 thinkingLevel 或 thinkingBudget。因此当前选择 low/high 不会改变这部分请求，省略配置也不能保证关闭思考；实际默认行为取决于模型。

此外，[OpenAI-compatible thinkingRequest](E:/Uina/Uina/src/ai/gateway.ts:290) 将 xhigh/max 映射为 high，DeepSeek 格式不产生档位请求差异，Qwen 非 off 只产生同一个开关。这里确认的是当前编码行为，不是对所有模型真实能力作统一断言。

根因是“宣称可选的能力”和“适配器真正能够表达的控制”分别维护。应让 Provider 明确自己的控制方式及映射来源；显式配置可以声明外部事实并收紧有效集合，但不能凭配置列表让尚未实现的编码变得有效。没有关闭语义时，应显示默认/未知，不承诺 off。[探针](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/provider.mts)

### A7. Gemini 签名回注违反块级协议结构

[当前转换](E:/Uina/Uina/src/ai/providers.ts:354) 把 thoughtSignature 放进 functionCall 对象内；[Google 官方示例](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) 将签名和 functionCall 放在同一 Part 的同级字段。纯函数探针确认当前请求层级错误；需要签名的服务调用可能因此失败，这是依据官方合同的推断，未调用真实服务验证。

先修正 wire 字段位置。更深的演进问题是，当前消息将文本、thinking 和签名压入少量字符串，难以保留交错内容块与签名归属。继续支持这类 Provider 时，应保留块顺序和元数据，由 adapter 解释厂商细节；Core 无需理解签名含义。可对照 [Pi Google 块处理](E:/Uina/ThirdParty/pi/packages/ai/src/api/google-shared.ts:171)。

### A8. 已有 CLI 与构建交付还有两处收尾问题

- 构建后的 CLI 在干净临时目录遇到异常断流，确实打印“缺少 finish_reason”，却以 0 退出。[shutdown](E:/Uina/Uina/src/cli/app.ts:192) 固定设置成功退出码。外部脚本会把这次失败当成成功；一次性运行应将失败结论传到进程结果，交互式会话则可继续恢复。[实测脚本](E:/Uina/Uina/docs/history/reviews/2026-09-05-direction-evidence/ui-cli.mts)
- `pnpm build` 只编译 TS，没有复制 native helper。实测源目录 `win32-x64.node` 存在，构建目录对应文件不存在；[加载代码](E:/Uina/Uina/src/ui/core/native-modifiers.ts:28) 从当前模块相邻目录加载。可以确认产物缺资源，实际键盘退化未做人机验证。应补齐现有构建资源清单，不需要因此建设完整打包平台。

这两项是现有交付路径的局部缺陷，不是微内核方向错误。

## 4. B 类：原则偏差与需要保留的演进接缝

### B1. 无需求依据的默认并发额度

[JobRegistry](E:/Uina/Uina/src/extensions/jobs/registry.ts:109) 默认每 owner 10 个活动 Job，[CLI](E:/Uina/Uina/src/cli/app.ts:35) 无配置地启用它。无论参考项目是否有相同值，这都不能替代 Uina 自己的需求依据。按本轮用户原则，默认不应加入这个额度；用户明确配置时再启用。

输出展示截断、按游标读取、owner 归属、单次等待时长与并发准入是不同概念。未把它们笼统归为“限制”或要求全部删除。

### B2. UI 有时在补造能力或重新解释事实

[UIHost.setReasoningEffort](E:/Uina/Uina/src/ui/ui-host.ts:442) 遇到未声明但位于默认枚举的档位，会扩张 thinkingLevels。探针声明 `[off,low]` 后仍接受 high。正常 CLI 通常传入已经 clamp 的值，因此这里首先是公共 API 的边界偏差，不能夸大为每次界面选择都会绕过模型能力。

活动行也用 [字符长度估算 token](E:/Uina/Uina/src/ui/tui.ts:194)，却以 [tokens/tps](E:/Uina/Uina/src/ui/components/widgets/activity-line.ts:209) 展示，没有估算标记。可以直接标明估算，或减少展示，不需要另一套计量系统。

UIHost 的文件长、拥有焦点/输入/面板组合，本身不构成边界错误；通过 action port 请求取消也合理。真正应移出的，是模型能力判定与执行结论判定。纯展示缓存与从日志投影出的 timeline 可以保留。

### B3. 运行时输入已经存在，普通扩展的公开入口还未补齐

[AgentInput](E:/Uina/Uina/src/agent/loop.ts:75) 已有来源与 data，[内置通知](E:/Uina/Uina/src/cli/app.ts:378) 能唤醒主体；但 [ExtensionAPI](E:/Uina/Uina/src/extensions/runner.ts:15) 主要提供注册与追加记录，普通扩展尚无统一提交该输入的 API。

这属于尚未兑现的接缝，不把“还没有自主性”作为漏洞。下一项计时器、文件事件或感知扩展真正需要时，开放现有输入能力即可。新增渠道应复用这一入口，避免每项能力都改 CLI 闭包。常驻宿主与终端分离也应由真实无终端场景推动，不必现在引入守护进程/RPC。

### B4. “生成”与“已经表达”的事实应在接语音时分清

[spokenUntil](E:/Uina/Uina/src/agent/loop.ts:528) 当前来自已生成文本偏移。它不证明音频已经播放。未实现 TTS 是 C 类；现有字段语义可能误导未来调用方，是应留意的 B 类边界。

生成事实归模型流，实际播放/发送/动作完成归执行端。以后接 TTS，应使用真实播放确认支持打断，而不是让模型流替播放端报成功。无需现在预建统一具身平台。

## 5. C 类：本轮明确不当作缺陷的内容

| 当前状态 | 处理方式 |
| --- | --- |
| 长期记忆、TTS、视觉、传感器、主动意图未完成 | 产品路线缺口；用真实场景逐步验证，不按缺功能扣分。 |
| Job/Subagent 尚无跨重启对账 | 当前文档明确是进程内能力；未来真实任务需要跨重启时再定义持久化合同。 |
| 子 Agent 工具目前只有 get_time，未继承所有 root hooks | 能力集与生命周期尚需发展；当前显式绑定不是“安全漏洞”，不据此强制默认复制所有 root 状态。 |
| child 一轮结束进入 waiting，没有 settlement notice | 现有代码和测试区分可继续的空闲与最终释放。实测 waiting/busy=false 是一致状态；是否增加轮次通知是产品需求。 |
| Job 与可继续 Subagent 分开实现 | 语义不同，可以保留；只有对同一执行事实重复维护并出现矛盾时才需要纠正。 |
| 单进程、单主体串行轮次、可信本地扩展 | 合理起点。未要求沙箱、权限系统、固定工具轮次上限或多线程“认知模块”。 |
| 更多 Provider、真实厂商验证、TTY/IME、跨平台覆盖不足 | 明确验证边界；不把本地 fixture 通过升级为真实服务兼容证明。 |
| 没有通用 tool renderer、统一输入注册和完整常驻平台 | 按下一个实际扩展场景补最小接缝，不先追齐参考项目。 |

## 6. 应该往什么方向调整

建议只守住以下几种归属，不据此机械新增同名模块：

| 事实/职责 | 建议归属 |
| --- | --- |
| 输入排队、一次活动、取消、等待、历史更新 | Subject 的共同生命周期；手动压缩也必须纳入。 |
| 已接受输入、工具开始/结果、会话领域消息 | 单一有序 journal；一次关键移交有可恢复的提交含义。 |
| 模型可用能力、实际请求编码、内容块与 usage | Provider adapter；Core 保留必要事实，不推测厂商能力。 |
| 工具的执行结论和内容 | 工具明确返回，Broker 统一传递；会话/UI 不重新猜测。 |
| 注册、卸载、外部事件来源 | 扩展生命周期及公开 API；内置能力继续使用相同路径。 |
| 展示、输入、焦点、组件组合 | UI；允许视图缓存，不扩大 Provider 能力、不改写执行状态。 |

优先顺序建议：

1. **先修持久化与生命周期合同。** A1、A2 是目前底座自身的可靠性问题。针对已复现的组合增加少量回归验证，比扩张通用测试矩阵更有价值。
2. **贯通执行结果与模型事实。** A3、A4、A5，以及实际使用 Provider 对应的 A6/A7；同步纠正 B1 和 UI 的事实表达。目标是减少有损转换与重复状态。
3. **再做一个普通扩展产生非用户事件的完整场景。** 同一输入入口收到有来源的事件，主体决定行动或安静，后台结果能回到同一入口；期间用户仍能打断或交互。完成这条路径以后，再发展简单跨会话记忆与真实语音。

这些改动中，状态合同与生命周期修正适合局部重构；单个错误 wire 字段或缺失资源可以直接修正。无需把每个小 bug 都包装成整体重构，也不能用更多旁路条件掩盖所有权问题。

## 7. 下一阶段实验与验收

**实验一：闭合现有事实链。** 基线为本次 checkout、现有 CLI/测试及四份复现脚本。候选必须保持正常工具闭环，并让阻止工具、custom 压缩重开、输入移交恢复、手动压缩取消、Job 取消失败、子 Agent 忙时追加输入得到一致结论。若修复引入第二份状态表或靠解析展示文本恢复业务结果，应回到合同层缩小设计。按小提交保留回退路径。

**实验二：只比较一个成熟 Provider 适配方案。** 保持 Uina 的 ModelProvider 端口，选一个实际常用 Provider，把现有适配器与 Pi/成熟 SDK 的小适配原型放在同样的文本、工具、取消、部分 usage、thinking 控制与历史回放场景下比较。只有减少自有协议维护且不丢失 Uina 所需行为时采用；若依赖迫使核心围绕第三方重写，则放弃或缩小复用范围。此次未实施或验证该实验。

**实验三：非任务输入与表达。** 先做普通扩展事件→主体决策→一个真实能力→结果事件；不要同时建设记忆图谱、多 Agent 编排和自主运行平台。接 TTS 时记录输入结束、模型请求、首段文本、第一段音频接受、实际播放、打断与停止时刻，用实测基线明确首句与停止延迟预算。这里没有现成延迟数据，不能承诺实时效果。

新输入到首段输出只等待必需上下文与模型工作。长工具、记忆整理、整段音频播放通过可取消的异步活动继续，完成后回到已有输入路径；避免整段播放或长期整理进入同步 hook 等待链。若真实输入速率超过设备/服务吞吐，再依据测量定义排队、合并过时事件和取消语义，不预设并发额度。

最小产品证据应包括：事件没有伪装成人类消息；可以不说话；后台工作未阻塞交互；取消后不继续表达；失败可定位；未来加入记忆后，跨重启能回忆、影响选择并能纠正。前半部分检验工程接缝，后半部分仍需要实际场景和人的评价，不以 mock 测试代替“生活感”。

## 8. 复现方式与交付范围

以下命令从仓库根目录执行。证据脚本打印当前行为，不是“缺陷已修复”的验收测试；它们退出 0 仅说明探针执行完毕。

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec tsx docs/history/reviews/2026-09-05-direction-evidence/core.mts
pnpm exec tsx docs/history/reviews/2026-09-05-direction-evidence/extensions.mts
pnpm exec tsx docs/history/reviews/2026-09-05-direction-evidence/provider.mts
pnpm exec tsx docs/history/reviews/2026-09-05-direction-evidence/ui-cli.mts
```

core 探针使用临时 JSONL 与 fake Provider；输入丢失用合法日志前缀模拟崩溃窗口。extensions 探针执行无文件副作用的本地 `exit 7`，其余使用内存 producer/Provider。provider 探针只使用进程内 fetch stub。ui-cli 探针使用内存 UI 投影，并在临时目录启动编译后 CLI 与 localhost SSE 服务。

此次新增本报告及上述四份脚本；没有修复业务代码，没有更改已有测试，没有扩大实际 Provider/设备权限。最终建议为：**继续当前方向，先统一现有事实与生命周期，再让 Uina 的具体行为推动扩展。**
