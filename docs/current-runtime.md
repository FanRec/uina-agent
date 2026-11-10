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
| `extensions/runner.ts` | ResourceScope、项目/builtin 注册、来源诊断、异步 teardown | Agent 决策和工具业务实现 |
| `extensions/runtime-tools/` | 内置 shell、时间工具实现 | 项目扩展发现 |
| `ui/` | 展示、输入、焦点、组件组合；作为宿主的一个消费者 | 模型能力事实、Agent 状态转移、主体生命期 |
| `host/` | 主体生命期、provider/工具/扩展/会话的唯一装配、消费者事件流 | 任何 UI 类型（由边界检查强制） |
| `cli/app.ts` | 组合根：创建宿主、接入一个消费者、进程级信号与退出码 | 主体装配与 Agent 业务规则 |

## 宿主与消费者

`host/` 拥有主体的生命期，对外只暴露两件事：**一个输入入口**（`send` / `submitText` / `pushInput`）与**一条有序事件流**（`subscribe`）。消费者（TUI、stdio、远程观察者或未来的 TTS）可以随时接入或断开，主体是否继续工作与它们无关；消费者渲染所需的全部事实由 `snapshot()` 一次取齐，不再伸手进 Subject。

已由行为验证（`tests/host-separation.test.ts`）：不创建任何 UI 也能跑通 文本 → 工具调用 → 结果回注；**零消费者**状态下主体照常处理输入并写入会话；之后接入的新观察者只收到它接入之后的事件。`check-boundaries` 有一条规则禁止 `host/` import 任何 `ui/` 模块，因此这条边界不是口头约定。

投递模式规则（忙时 direct 升级为 steer、空闲时一律 direct）归属于宿主，不再由 UI 决定。

## 展示层（Presentation Core 与 Surface Adapter）

`src/presentation/` 是平台中立展示核心：事实（facts/ingest-live/ingest-replay/sanitize，外部文本在事实入口经 sanitizeExternal 清洗一次）、控制器（controller，视图/订阅/意图的唯一协调者）、投影（projection、tool-status、trajectory、projection/tools 的 ToolModel）、组合（composition/slots 的 SlotRegistry 与 SlotAck 回执）、动作（actions）、文案（copy）与能力（surface）。它不 import `src/ui`、`src/cli`、`src/extensions`、`src/ai`，也不使用终端/进程/文件模块（check:boundaries 强制）。

`src/ui/` 是第一个 Surface Adapter（TUI）：布局原语 `layout/fit.ts`（唯一截断/折行入口）、`layout/frame.ts`（computeFrame 帧几何纯函数）、`layout/panel.ts`（renderPanel 与面板部件，行宽精确守卫）；键位 `keys/keymap.ts`（浮层页脚提示由绑定生成）；工具文本渲染 `render-text.ts` 的 `renderToolBlock` 为 TUI 与 print/stdio 共用；槽位行渲染 `composition/render.ts`。第二个文本面是 `src/cli/stdio-render.ts`；无头面是 `createPrintUI`。TUI 与 print/stdio 均通过 `PresentationController.ingest()` 获得工具/回合/思考/正文事实：工具耗时由 controller 按事实两端的时刻统一结算，stdio 不再自行记录开始时刻，两种消费者的状态与耗时因此同源。投影节点含完整 assistant 正文（`AssistantNode`，像思考块一样按连续段累积，工具/思考边界切段）；恢复路径按回放事实的 `sourceSeq`（message entry 序）精确配对，容器正文不再直读 journal。扩展契约中 `terminal` 是可选 facet，`capabilities()` 声明能力，`notify`/`setWorking` 返回 SlotAck。NO_COLOR/TERM=dumb 下着色 SGR 退化（C 常量与 sgr 门）。

多前端同步（v1 已实施）：协议与客户端在 `src/presentation/sync.ts`（`{v:1}` 信封，`hello`/`intent` → `snapshot`/`fact`/`error` 五个消息 kind；连接生命周期 = 同步生命周期，快照是唯一修复原语，重连即快照，无游标）；`PresentationController.restore(view)` 是视图空间重建接缝（快照中 running 的段落恢复为开启段，流中 join 无缝续流）。网关是组合根应用模块 `src/cli/frontend-gateway.ts`（`--gateway`，默认 127.0.0.1，token 每次启用重生成）：自有 controller 吃同一条事实流，hello 即快照（握手期事实进有界缓冲），意图经穷尽校验与网关归属（`InputSource.channel`/`actor`）转发宿主；斜杠命令与队列撤回在远程面明确拒绝。浏览器薄面 `src/web-client/` 是 `SurfaceAdapter` 的第一个实现者（`pnpm build:web` 产出 dist/web 原生 ESM，零 bundler）。一致性测试（`tests/frontend-sync-consistency.test.ts`）钉住"直连 controller 与 网关+SyncClient 产出逐字段相同的视图"，含流中 join。
## TUI 消费者与扩展接缝

交互启动顺序为：读取 `HostSnapshot`、恢复 TUI 会话与草稿状态、接入扩展 UI、启动终端消费者，随后才启动 `Host`。`HostSnapshot` 与 `HostEvent` 位于 `host/events.ts`；UI 不持有可供 CLI 操作的 Host 引用。Host 事件到 transcript/trajectory 的平台中立投影集中在 `PresentationController.ingest()`（`src/presentation/controller.ts`），TUI 只消费投影节点并翻译成宿主渲染调用；CLI 只提供回溯装饰等宿主派生数据。运行中晚接入的订阅者只收到后续事件，不重建既有 transcript。

TUI 向 CLI 发出的动作是 `PresentationIntent` 联合（命名空间化：`input.submit`、`turn.cancel`、`turn.interruptAndDeliver`、`queue.pullBack`、`thinking.cycle`、`ui.interaction`）；CLI 路由后调用 Host。忙闲决策使用 Host 快照/查询，TUI 的 busy 值只是事件驱动的显示状态。草稿读写、通知和会话恢复通过 TUI 门面操作。应用 UI 动作使用判别联合请求 `{ name, payload?, signal? }`；扩展的作用域信号与调用者信号合并，作用域结束会关闭该调用打开的面板。模型选择回调纳入 ResourceScope 在途工作结算。

扩展的 `pi.ui` 只提供通知、确认/选择/输入、状态和类型化应用动作；ANSI 组件、overlay、编辑器控制、页眉页脚、gutter 与组件渲染器注册位于 `pi.ui.terminal`（组件挂载走中立槽位，`setWidget` 已删除）。renderer 注册由扩展 `ResourceScope` 管理，终端未接入时也注册到共享 renderer registry。没有预建 Web/GUI 布局层。

`@` 文件路径联想使用异步目录遍历，候选加载时显示“扫描中”；输入查询变化后，迟到的搜索结果不会覆盖当前输入或候选。

组件异常在组件边界内报告并隔离。弹窗按收到的宽高组织可见内容；空 ContextBar 不占行，存在上下文事实时提供 Ctrl+L 入口。时间线轨只在有多轮导航且历史可滚动时出现，无可滚动内容时不保留 gutter。布局与鼠标热区共用 `FrameLayout`。这些约束由 fake terminal 覆盖 40/50/80/120 列与 8/12/24 行；真实终端字体、配色观感和 IME 仍需现场验收。

## Agent lifecycle

`Subject` 对外以 `activeRun` 表示完整运行。`waitForIdle()` 会等待 turn 结束、extension handler、队列续跑和 observed output flush 全部结算。

每次请求先从 canonical history 构造完整 `RequestProjection`，跑完纯 `turn.transformContext` 链后统一测量；`turn.preflight` 只能归并 `fail > rebuild > send`，不能修改投影。compaction capability 只生成持久 checkpoint，Core 收到 rebuild 后从 canonical history 重跑整条投影链；journal 始终保留全量历史。`/compact` 空闲时当场完成，忙时立即显示 queued，并在 awaited `turn.afterEnd` 安全点、下一条队列输入恢复前完成。失败或取消不激活未持久化 checkpoint。AgentHandle 的 busy/status 从实际主体活动派生，dispose 等待活动与存储关闭。

每个已启动的 `content` 或 `thinking` 输出 channel 恰好以一个 `output_end` 或 `output_interrupted` 终止。网络错误、取消和协议失败不伪造成正常结束。

续跑队列按预算分批：`InputQueues.batchForTurn` 只领这一回合能承载的前缀（条数上限 + 字符总量，单条就超长时仍放行，否则它永远出不去），剩余留在队列里由回合成功后的续跑继续消费。边界是三条：steer 先走且单独成批，用户发言不与任何输入合批，运行时来源只在同一世界内合并。此前合批没有容量概念——积压一次性提交历史再一次性塞进请求，超预算就整回合失败，而队列已经空了，没有东西会再叫醒它。

## 会话与恢复

`data/session.jsonl` 按真实时间追加 header、message、input、custom message/entry、rewind 和 lifecycle event。日志是权威事实；Session 从日志推导当前主线与全部历史节点，模型历史与 TUI 从同一主线投影。回溯只允许选择当前主线的安全历史祖先，退出路径只读，外部状态不撤销。设计与阶段验收见 [会话主线与回溯](session-rewind.md)。

工具已开始但没有最终结果时，恢复为 `unknown`，不推断外部副作用成功。打开日志时将末尾恢复结果追加落盘，之后的实时会话查询不会将正在执行的工具误判为崩溃。

扩展阻止执行时记录 `not_started` 及原因，不生成 `tool_started`；该日志可正常重开。`custom_entry` 是 capability 私有持久状态（Auxiliary）：仅登记在 auxiliary timeline，不进入主线 entries 与模型上下文。

队列移交通过一条携带输入 ID、内容和来源的 `input` 记录提交：提交前归队列，提交后归会话。用户输入投影为 user message，runtime 来源投影为隐藏 custom 消息，标明运行时来源，重开后仍可进入上下文，不伪装成人类发言。提交失败报告错误并保留待处理队列，失败轮次不自动续跑。这里保证输入归属，不保证外部副作用恰好执行一次。普通无 receipt 输入不承诺 producer 对账；带 receipt 的输入可经来源绑定的 HostDeliveryPort 查询持久提交事实，交付重试不能据此重跑外部动作。`input_accepted` 表示已受理进入直接启动或队列；`input_settled` 表示输入已进入 canonical history 或永久退役（不表示模型已回复或外部副作用成功）。World 可用该事实回收 deferred 输入占位，避免把 render 当作提交确认。

Host 默认装配事件帧 profile：未显式传入 `projection`/`systemPrompt` 时，模型请求中的外部输入（用户输入、runtime 来源且 `origin: external` 的观察）以 `external_event_frame` 三消息组（通知、合成调用、回执）呈现，内部 runtime 消息以带来源标注的 user 消息呈现且不重复加内部分类前缀；每请求执行帧协议校验，请求级预算门仍归 Subject。`examples/file-events.mts` 的文件变化观察标 `origin: external`。设计见 [外部事件帧设计](proposals/runtime/external-event-frame-design.md)。

header 为 v4，且只接受 v4：v3 及更早版本明确拒绝，没有迁移链，也没有旧版本 reader——旧 journal 直接开新会话。不会自动猜测修复非法生命周期记录，也无法补回已丢失的输入。

## 工具结果

`Tool.run` 返回 `{ result: string, status: ToolResultStatus, images?, details? }`。图片以 MIME/base64 附件保留，details 供程序与 UI 使用而不进入模型上下文。内置 shell、时间工具与项目工具共用此合同；旧项目工具需将字符串返回值迁移为该对象。`tool_result` hook 的 `isError` 改为 `status`，正文变换默认保留完整结论。Broker 的 `run()` 仍是仅取正文的便捷方法，执行事实由 `execute()` 返回。

World action 也必须返回该结构化合同；字符串结果不再隐式视为成功。外部效果动作在模型可见正文中保留最小的 `effect=accepted|applied|simulated|unknown` 事实，details 保留完整程序诊断与验证入口。

结果可附带 `continuation: "stop"`，在结果记录后结束当前决策，不丢弃其他排队输入。文件扩展用它表达明确的安静决定；UI 不需要过滤生成文本。

shell 非零退出码为 `failed`。Broker 接受 producer 已明确返回的结论；启动后被中止（取消、超时）且效果不可确认时为 `unknown`，正文附已收集的部分输出与 reason——不推断成败，规则见 dev/DECISIONS.md「工具层修复（2026-10-29）」。JSONL、实时 transcript 和恢复 transcript 保留五种结果状态；旧消息未记录状态时显示未知。UI 收到中断请求不会擅自将运行中工具定为失败，随后确认的结果可以更新已结束轮次中的对应工具卡。

## TTS 文件生成

Voice/TTS 的来源顺序、立即静音、确认停止、有限恢复、诊断输出和瞬态上下文合同见 [Voice/TTS 当前合同](voice-tts/voice-tts-runtime.md)。声音协议版本为 2；外部旧 Bridge 需要由启动方更新重启。自动化与真实设备验证边界分别记录，不把受理或健康接口当成实际播放。

实时字幕伴生服务由 TTS 扩展通过 `subtitle-companion.ts` 探测/启动；其独立实现位于 ThirdParty `realtime-subtitles` 项目。源码与模拟测试覆盖本地连接、队列和呈现逻辑，不证明 OBS、实际声卡时间同步或真实直播画面已验收；当前设计状态见 [实时字幕服务设计](proposals/voice/realtime-subtitle-service-design.md)。

项目 TTS 扩展注册独立 `tts_generate({text})`：原样提交完整文本，使用部署中的 Vendor/语音预设与共享合成锁，等待完整 PCM WAV 后保存到 `<pi.cwd>/uina/tmp/`。成功模型正文只含普通文件 `resource` 和采样计算的 `durationMs`；失败不返回文件引用。临时件同目录独占写入并在校验后原子发布，不覆盖已有文件。生成不播放、不驱动字幕或口型，已发布文件不随回合结束、静音或扩展卸载清理。详见 [TTS 文件生成](voice-tts/tts-file-generation.md)。

## Minecraft World

V2 当前目录有 18 个查询和 37 个动作。54 个既有 selector 各有唯一绑定，新动作 `build.resume@1` 用于可恢复的小型施工。`describe`、顶层 `run` 与 `mc.call` 共用 Catalog。用户通过 `tasks` 查询、停止、续段及查证，开发验收通过 Executor 读内部记录。采集策略由发布的 `collect@1` Program 承载，移动、挖掘、拾取和窗口事务由 Native 完成。

玩法搜索支持中英文别名与词项，候选给出公开入口。任务查询、完成通知和请求前简报展示由根提交派生的任务名与目标。玩法搜索词与任务名均为展示数据，不参与执行绑定或续段资格。 [游玩体验验收](proposals/mc/archive/world-refactor-v2.md#游玩体验)

`build.resume@1` 冻结显式目标格、存档身份、维度、源码和 Addon 装配摘要。符合恢复资格的任务重连后通过既有认领事务创建新 Segment。无法确认的写入保留在 Effect 记录中，现场读数作为续段决策的证据。Fabric 支持范围以验收中的注册表和 SpectatorPlus 组合为准。 [V2 验收记录](proposals/mc/archive/world-refactor-v2.md)

`describe` 可按需打开内置采集与恢复施工 Program 的当前源码。施工进入待决策时，任务查询从现有报告给出可读检查点和只读查证入口。

能力候选标出必填参数，普通完成通知直接给结果。私聊和明确点名的公屏消息即时进入 Minecraft 回合。连接及常用观察采用简短正文，完整事实通过 `detail:"full"` 按需读取。 [工具表达验收](proposals/mc/archive/world-refactor-v2.md#工具表达与往返)

活动会话的短 Guide 以「查询结果是否会改变下一步」区分行动、查证和等通知。按需的 `recovery_playbook` 用探索、施工和等待材料示范如何接回进度。完成投递按当前页读取历史尝试，单条 Host 回执确认失败时继续处理其余通知。扫描期间的即时唤醒和受理保护解除后的补扫均保留。 [游玩节奏与完成投递验收](proposals/mc/archive/world-refactor-v2.md#游玩节奏与完成投递)

以下为历史批次记录。早期 I1/K1 在 `.uina/worlds/minecraft/` 建立了原生动作、采集、容器与合成熔炼闭环。连接级 DriverProtocol 当前实现 Java 1.21.11；未来版本沿同一窄端口接入，未支持版本的相关操作明确失败。玩家库存与容器共用 mode-0 的服务端槽位/光标确认，装备、移槽、丢弃不进入上游异步预测写入链；ItemValue 与选择器保留有效组件、堆叠上限和剩余耐久。采矿只认实际服务端方块更新，Runtime 保留直接/嵌套未知效果；查询先执行统一 schema 校验。World 沿既有 SQLite 证据链保留最后容器观察，历史不代表当前库存。

实际入口是 `pnpm dev:mc`、`dev:mc:k1`、`dev:mc:k2`、`dev:mc:containers`、`dev:mc:k3`、`dev:mc:production-repair`。`dev:mc:repair` 与 `dev:mc:production-repair` 默认使用独立 Temp 数据根；前者覆盖工具/物品实例选择、取消、导航与历史重开，后者覆盖满背包制作、组件匹配、弱燃料分批、等待期间并发身体动作及取消后取货。

生产链修复将合成、熔炼拆开，取货共用实例匹配与跨槽分装，进度累计服务端确认量。自有熔炼在世界等待前关窗并释放身体，复查重新申请；燃料批量受实际槽位与刻数约束。WindowClickReceipt.confirmed 直接携带确认时的服务端快照，避免确认后读取失败漏记。当前类型/9 条边界、MC 28 文件/236 项、构建通过；本轮真服验收与边界见 [生产链修复实施](proposals/mc/archive/production-repair-implementation.md)。先前 [Driver repair](proposals/mc/archive/driver-repair-implementation.md) 的源码/构建产物各 15/15 属于其历史验证。

批 4 已实现 Windows x64 Executor 平台：双命名 Job、精确进程身份、受管 bootstrap/Companion、固定 JSON IPC、持久身份/launch 及本地门意图、心跳、关闭/退役与显式恢复。Runtime 在批 4 使用 schema v2（本批 6 已升级 v3），固定 owner/storage，受理及开始先提交；Owner 独立三门与 Driver 写入检查共用同一权威。开发场景 `pnpm dev:mc:executor` 经正式受管入口验证，开发 harness 复用同一执行侧装配。证据见 [平台实施记录](proposals/mc/archive/executor-platform-implementation.md)。

批 5 已实现通用 Host 持久回执与 journal v4：工具/输入共享 receipt 标记、来源绑定的 inspect/retire、输入去重与 CAS 退役；committed 只由 canonical append 完成后生成。提交索引沿 Session reducer 增量恢复且跨回溯保留，内存会话标 volatile。ExtensionAPI.delivery(scope) 与 World context.delivery 复用同一端口；详见 [批 5 实施记录](proposals/mc/archive/host-delivery-implementation.md)。批 6 已接正式 WorldDef、原生模型工具、固定报告/分页记录与 Host 回执可靠通知、BodyEndpoint；批 6 当时 Runtime schema v3、Executor ledger v2；批 7 已升级 Runtime v4 并接正式 Program 执行。默认关闭、仅支持显式 offline 1.21.11 配置；批 8 已接 Library 文件管理/统一发现与程序来源复用；批9B已接continue与替换/抢占调度。源/产物与真实 deepseek-flash 校准见 [原生接入实施](proposals/mc/archive/native-host-implementation.md)。旧数据库不自动迁移，验收使用独立临时数据根。普通窗口支持范围、真实 Paper 验收及未验证项见 [MC 开发报告](../dev/MC-WORLD.md)。

批 7 提供 `run {code,input}` 与命名程序，支持 `mc.read/call/progress/sleep/withBody`、console 及现有精细 body/window 操作；每 Call 独立 QuickJS runtime，共享 Worker，源码在段内固定并保存确切快照。父句柄委托期间挂起，取消和清理不依赖 guest 合作；Program 容量直接投影到状态。程序只读加载归 Library；批 8 已接完整文件管理/统一发现、确切 Call 来源保存和修改复用，见 [实施记录](proposals/mc/archive/library-implementation.md)。批 9A 已接 waitUntil、确切查询版本、events 增量 Watch、world_change 状态与停止清理；历史库 v2，旧 v1 拒绝自动迁移。决策/continue、调度与引用清理在批9B落地，反馈在批10接通。入口 `pnpm dev:mc:program`（真实模型加 `-- --model`），实施和验证边界见 [批 7 记录](proposals/mc/archive/program-implementation.md)。

Minecraft 批 9A 源码、产物与模型证据见 [等待实施记录](proposals/mc/archive/wait-implementation.md)，正式入口 `pnpm dev:mc:wait`；当批保持10查询+15动作；完整I2后由批9B收口。

Minecraft 批 9B 已接 `mc.decide(reason, checkpoint?)`、根程序只读 checkpoint、显式 continue、多段固定报告及消费有效性、replace_pending/preempt_current；World 提供 retain/release 和指定分区/截止序号的显式历史清理。Runtime schema v5 / history v3 / Executor ledger v3，旧库拒绝自动迁移，Host journal v4 不变。正式 I2 入口 `pnpm dev:mc:i2`，历史维护 `pnpm dev:mc:history -- --help`；仍为25/51能力；批10已接feedback/loop与默认自保，其他玩法未计入。实现及本轮证据见 [批9B实施记录](proposals/mc/archive/decision-implementation.md)。

Minecraft 批10接通 body.feedback/loop、真实物理步应用回执、过期撤销与默认 lava/drowning/low_health_damage 自保；同一 Runtime 身体队列授予 safety，强制退役不等待 guest 合作。Runtime schema v6，旧v5拒绝自动迁移；history v3、ledger v3和Host journal v4不变。入口 `pnpm dev:mc:feedback`，实现与验证边界见 [批10实施记录](proposals/mc/archive/feedback-implementation.md)。

Minecraft 批11–13 已实现并真服验收：批11 领域记录（G1 关闭）与 `places`/`remember`/`forget`/`route.plan`/`explore`（真服 9/9）；批12 `follow`/`flee`/`surface`/`fight`（G3 关闭：SurfaceProbe 站立/露天判据；真服 7/7 + 5/5）；批13 `region`/`tunnel`/`excavate` 与 G4 关闭（`ctx.verify` 注册表 + `verify/dig@1` + 程序桥 `mc.verify`，核验 append-only、跨重启可复查；真服 `dev:mc:spatial` 8/8）。入口 `pnpm dev:mc:places`、`dev:mc:mobility`、`dev:mc:combat`、`dev:mc:spatial`。

批14–19 已实现并真服验收：批14 蓝图与施工（`construction/` 模块 + `.schem` 解码 + `build.plan`/`build`，K5 关闭）；批15 专用工作站五动作（`brew`/`enchant`/`anvil`/`grindstone`/`trade`，G2 关闭）；批16 玩家名单（`players` + entities 玩家名覆写）；批17 地图与 G11 图片出口（`map` → `ToolExecutionResult.images`）；批18 K8 四动作（`sleep`/`fish`/`ride`/`lead`，G23 登记）；批19 关闭 G21（pathfinder 台阶补丁 + goto 无进展看门狗）并接 K8 最后一项 `transit@1`。**能力面 16 查询 + 35 动作 = 51/51 全部落地**，以 `createCapabilityCatalog()` 的静态目录装配为准。入口 `pnpm dev:mc:build`、`dev:mc:stations`、`dev:mc:players`、`dev:mc:map`、`dev:mc:k8`、`dev:mc:climb`、`dev:mc:transit`；逐批证据与裁决见 [MC 开发报告](../dev/MC-WORLD.md)。

批20（2026-11-03）关闭横向缺口 G6/G7/G8：G6 节流 digest 推送（`world/digest.ts` 按查询依赖采样、10s 前缘节流、内容哈希去重、独立事件类型 `minecraft_digest`、主脑忙时只保最新一份）；G7 `inventory@1 {since}` 增量游标（协议槽位变更标记 → 差量 + 变化后总数）；G8 `run {wait}` 按调用短窗覆盖（0 只受理不等）。真服 `pnpm dev:mc:digest` 7/7；tests/mc 771 项全绿。剩余横向缺口 G9/G10（运行时调度）、G12/G13（认证与平台）、G14–G17（复验与终态报告）、G24（tunnel 上行净空）登记于 [known-gaps](proposals/mc/known-gaps.md)。

批37（2026-11-08）把 G6 的关闭方式整个换掉：状态不再推送。digest 链路（定时采样、10s 节流、内容哈希去重、`minecraft_digest` 事件类型、忙时只保最新一份）全删，改为 `world/state-frame.ts` 采样 + `state.snapshot` 只读 RPC，由 `WorldDef.requestContext` 经 `turn.transformContext`（`tail` 相位）在每次模型请求前注入一份当前快照，宿主侧 250ms 超时即本轮不注入。理由是推送本身选错了方向——旧坐标与旧背包排队等模型处理没有价值，只有当前值有意义，而每次现读一次既能保证新鲜又不在空闲时产生任何 Subject 输入。同批事件按种类分流（死亡/断线/私聊/本地没脱险 → steer，其余排队）、已脱险的安全干预带 `interruptedRun` 上报而取消/失效不上报、同一世界的后续输入在宿主侧合成一次决策、失败终态保留调用侧报告的进度。真服 `pnpm dev:mc:state-frame` 7/7（含走路 20s 零事件、每帧都是身体当前所在格）；接缝由 world-request-context、qq-world-framework-seams、smoke 覆盖；tests/mc 903 项（901 通过，`mcp-extension-loading` 2 项为既有基线红）。

批39（2026-11-08）修正批37 的一处判据：安全干预的终态要不要告诉模型，不能看终态值，要看起因。同一句 `ended: invalidated` 有两个来源——连接身份变了（`connection`/`death` 事实已经在说同一件事），或者没有任何别的事实承担的失败（抢占失败、会话关闭出错、崩溃恢复留下的未结算记录）。`RuntimeSafety.cancel(reason, cause)` 由调用点声明起因、`changed(record, cause)` 带出，`companion/safety-route.ts` 的 `safetyNeedsAttention(ended, cause)` 是唯一判定（世界自己关门与连接变了导致的失效不说，其余都说）。起因只在内存里活一次干预的生命周期，不进库——记录本身的 ended/outcome 已经说清发生了什么。

批41（2026-11-08）把 MC 顶层换成纯异步受理：`run`/`chat`/`runs.continue` 删掉默认 3 秒等待窗与公开 `wait`，只回 `accepted`/`not_accepted`/`unknown`，终态一律经 `minecraft_completion` 投递；Program 内的 `await mc.call()` 不变。工具结果增 `continuation:'yield'`，整批都是可靠委派的结果时 Subject 才结束本轮，混合批次照常请求模型。完成通知从单槽串行改为一轮最多 8 个 key 集中入队（新接线 `submitInputs` → `onInputs` → `Subject.acceptBatch` → `emitEvents`），每条独立 attempt、独立 Host committed 回执与 ACK；批量受理只表示逐条持久入队，不等于模型已读。`accept` 在 idle 且队列空时仍同步直启，避免 `waitForIdle()` 在回合未提交时空转返回。请求前状态帧增加有界活跃任务简表（最多 4 条，与世界事实分别标采样时间），Runtime 列表查不到时正文写明"未知"而不是省略，不产生定时推送。完成通知的批量入口缺省或宿主少回一条回执时都让本轮对账显式失败并记进诊断，不静默丢弃、不留假在途。`heldRequests` 保留为受理期间压住同 request 完成通知的屏障；`shortWindowMs`/`toolAttempt`/`heldTools`/`RunReply` 等旧双通道接口已删。批20 G8 的 `run {wait}` 关闭方式由本批替换，缺口仍关闭。验收见 [changelog 批41](proposals/mc/changelog.md)；真实服与真实模型对照窗口本轮未跑。

批42（2026-11-08）教学与闭环：`WorldDef` 新增可选只读 `environmentGuide`，`WorldActivation` 在 `turn.prepare` 把活动世界的 ENV 追加到 systemPrompt（多世界依次追加、停用摘除、不写 Session）；Minecraft 的 ENV 在 `onStart` 预载、无活动会话时返回 null。`describe` 增 `kind:'guide'`，六份官方只读 Guide 随包发布并按需读正文，`nativeGuide` 压成入口。`goto@1`/`route.plan@1` 默认 `placeToReach:false`。Body 撤销在真实发起点写不可变 `retiredBy`，`interruptible()` 从 Effect 账本现算 `dispatch/effects`，`user_stop` 不自动续跑。Window 保留 `window_items.stateId` 做迟到包防护，回执增 `outcome/diagnostics`；真服探针证明工作台会先回"仅同步"的 full，因此内容未变仍按 unknown，不设 rejected。`excavate` 的 `remainingCount` 计入未访问格；`collect` 候选分 permanent/transient/unknown，已派发 TIMEOUT 不换候选，候选耗尽先清扫地面掉落；`craft` 暴露 `station` 来源。MINE Program 以最新 `self/inventory` 终验，不满足即 `mc.decide`。真服 `dev:mc:task` MINE/SHELTER/NIGHT 全 PASS；`pnpm typecheck` 全绿；tests/mc 808 passed（唯一失败为既有 `node_api.h` 环境项）。

Minecraft Task 重构（2026-11-10）将正式用户工具的 `runs` 换为 `tasks.get/list/stop/continue/trace`。任务句柄来自原 Profile 和根提交，普通用户与模型通过同一入口查证受理、停止和继续。完成通知与请求前任务简报用同一任务身份。Runtime、Executor Ledger 和 Host 回执仍各持原有事实，受理拒绝和派发前停止可查，查不到记录时保留不确定。采集和施工 Guide 提供可复制的单文件 Program，见 [当前公开合同](proposals/mc/public-api.md#用户任务入口)。

## QQ World


QQ World 的模型工具表面是单一 `qq` 工具：`{action, params}` 分发到 14 个积木（inbox / read / skip / browse / send / interact / remind / requests / profile / people / files / fetch / search / expressions）。绑定账号由 World 注入，模型不再填写 account。工具参数唯一真源是 `.uina/worlds/qq/tool.json`，由 `scripts/generate-qq-tool-schema.mjs` 生成声明；合同 fixture 位于 `tests/fixtures/qq-world-interaction-examples.json`。授权词表仍为 8 个 grant 名，`requiredGrants` 检查所需集合：在线 inbox 需要 observation，同时修改 push 还需要 attention.manage；没有增加授权名称。

发现动作保持只读：people 查好友、群成员与人物资料，重名返回全部候选；expressions 查系统 face/reaction 数字编码并提供现有 send/interact 模板，不支持自定义贴纸。files 浏览一个群文件目录，名称筛选不递归；fileRef/folderRef 绑定账号、群和平台对象，目录畸形或返回未支持的续页信号明确失败。四个在线发现动作 people/files/fetch/expressions 均需要 observation；search 纯本地读取 text/fileName，支持会话、发送者、方向和带时区时间过滤，明确 local、撤回/归档与覆盖风险，平台完整性未知。默认每页 20，返回可直接消费的 nextCall；数据集改变时 cursor_stale，不暗中换来源或跳过。

fetch 接受 mediaRef、fileRef 或 messageRef+segmentIndex，返回 `{kind:"file",path}` 普通文件资源；现有 send 的模型入参为 content 数组中的 path，不把运行时 resource 宽容分支当 schema。附件定位字段随消息保留，平台点查/转发只补 media_locator 证据，不写 received/dispatched。群文件重新核验原目录稳定 ID，URL 过期最多刷新一次；远端平台路径没有共享映射时明确不可用。文件流式取得到当前账号 downloads 根，大小与本地 SHA-256 提供实际证据，平台摘要校验保持未验证；原始编码不转换、不解析、不转写。临时目录中的文件与来源元数据统一发布，正式文件跨调用与重启保留，启动只清理自有未发布目录。下载期限沿用 connection.requestTimeoutMs；取消/停止后无迟到发布。未增加下载缓存、后台重试、任务管理器或租约；显式出站 allowedRoots 策略仍独立检查。

发现实现审查后，消息分段拉取复用同一附件已刷新定位；来源位置与已知平台对象定位共同约束引用复用，转发位置替换对象分配新引用。私聊文件缺少专用 hash 时明确定位不可用，不猜通用 get_file。下载的地址刷新共用取消与期限；发布流程集中拥有字节、元数据和临时目录。表情目录只在载荷与分页成果成功后补呈现名称；本地检索按实际时间排序和标记归档，大小写展开后的片段位置映射回原文。分析与反例见 [QQ 发现审查](qq/qq-world-discovery-review-2026-10-11.md)。

查询与消费解耦：`inbox` 每次请求在线好友、群目录（best-effort，仅补全名称，失败不阻塞红点一瞥），合并本地消息、事件、关注与偏好会话，返回名字及未知标记。参数、游标与查询全部成功后，先持久保存 push，再更新内存 focus。limit/cursor 分页绑定目录身份与查询条件，普通目录分页不因未读计数变化失效。`requests list` 默认每页 20 条，limit/cursor 透传，nextCursor 可直接续页。

`read` 与响铃窗口共用顺序阅读窗口和会话锁，仅消费入站消息；自身发言留在历史中，不参与待处理数。窗口返回正文、实际交付消息与位置，媒体展开、取消及生命周期检查完成后，read 才记录 dispatched。响铃窗口最多 30 条/14,000 字符；手动 `read` 默认 20 条、最多 100 条，两个上限分别约束自动交付和显式阅读。skip 也在锁内重验并单调推进消费书签（单书签，旧通知账本已并入）。超长消息允许显式折叠，提供真实 browse 调用及富媒体展开引用；未交付整条消息保持待处理。

冷启动初始化持久记录 readerInitialized：首次迁移保留已有会话基线，仅封存迁移当时的历史；初始化之后新会话基线为 0，正常未读跨重启保留。消费位为 max(dispatched, baseline)，不回退过去错误推进的书签，也不自动批量恢复错误封存内容。推送偏好 accountPush/conversationPush 只含 `{off, pausedUntil}` 并持久化，focus 只在进程内存在且开窗无视静音；账号或会话任一静音、任一未到期暂停即静音。旧控制字段（AttentionOverride 与 v2 mode/filter）一次性归并为 `{off, pausedUntil}`，迁移后不再落盘旧字段。

通知短防抖（quiet 1200ms，自窗口首条起 maxWait 2000ms 封顶）后直接提交唯一 ID 的延迟唤醒占位，由 Runtime FIFO 决定出队时机。候选三类：ring（私聊/temp 与在场会话的正文窗口，交付即推进书签）、tap（群 @/引用自己、戳一戳、相关撤回、申请——单条交付，书签不动）、internal（到期事项、连接与账号状态、迟到回执升级）。求值时重验静音（focus 例外）、待处理数、事项与申请状态；多候选按 internal→私聊响铃→拍肩→群响铃排序合并为一批，整会话 14,000 字符预算封顶，装不下的整会话留待下轮。成功求值缓存同一份文本与交付边界，用于同输入重试与结算；空内容正常退役，渲染失败保留候选。结算先释放占位，再幂等补账（仅 ring 推进书签）；渲染、投递和补账失败共用可取消的 2 秒重试计时器。Subject 的 canonical input 提交失败仍由现有邮箱恢复机制处理；本地阅读位置与 SessionStore 不构成跨进程原子事务。

`browse` 保持 contentTarget > messageRefs > direction 优先级，三个模式都兑现 includeMedia。点查本地优先，缺失调用 get_msg；历史 source 默认 local，显式 platform 使用 SDK 已有好友/群历史 API，around 合并两侧并去重，平台失败不隐式回落本地。平台只读结果不写 received/dispatched；文字/卡片 contentTarget 默认每页 4096 个 Unicode 字符，转发默认每页 20 节点，contentTarget.cursor 可续页。所有模型指引使用真实 `{action, params}` 形状。

覆盖风险来自可回放的显式传输错误、断线与解码失败区间，按查询窗口展示；不从 message_id 猜缺失，不把 archive 当断线。没有风险信号也只表示本地观察，平台完整性保持未知。`scripts/qq-status.mts` 用纯只读解析，支持 --data-root（QQ World 数据根）与 --profile-root（Subject stateRoot），不创建、截断或迁移文件；unknown 操作数来自实际日志，无法读取进程内 focus 时显示 unknown。恢复和迁移仍由 World 生命周期执行。

行动积木复用平台链路，模型表面全换而底层审计语义单源继承（intent 先落盘、unknown 不重发、echo 归并、回执归属核验）：`send` 分段数组与 replyTo 进入真实发送载荷，一次调用拆批保持内容顺序，只给首条可引用的子消息加引用，没有可引用子消息则发送前失败；`interact` 的 retract 经所有权核验；`remind` 仅 list/create/resolve，reviewAt 变更靠 create 新建（follow_up.update 已裁剪，control-store 无 update 入口）；`requests` 的 pending/confirmed/unknown 从关联操作日志派生，已确认或结果未知的申请不盲目再次处理，迟到确定回执不会被本地超时降级，群邀请按 sub_type 裁决；`profile` 承接账号与形象三写。`observe` 不再对模型暴露，仅保留 requests/self/expressions 三个内部入口；启动 enrichment 与新增 expressions 动作复用系统表情处理函数，face 数字编码供 send 的 face 段与 interact 的 react 使用（数字编码校验在运行时，schema 无 pattern）。

`account.leave_group` / `remove_contact` / `set_presence` 为故意裁剪，链路全删；capability 三维探测退役，媒体可用性由平台回执如实呈现。提醒候选携带实际事件/申请引用，呈现申请对象与说明、戳一戳人物、撤回操作者/作者及消息、reaction 增删/编码/数量。

每次传输恢复都先核验绑定身份，再开放动作并通知恢复。连接、身份核验及动作等待有期限和取消边界；确定未派发与派发后未知分别表达，不自动重发。连接与账号状态由 World 状态与 `scripts/qq-status.mts`（只读）核验——`observe.status`/`capabilities` 工具表面已退役。操作日志内部 identity（`world:qq/speak`、`account.set_profile` 等）保留为审计锚点，非工具表面。World 停止后取消调度并释放传输/Host 订阅，迟到投递失败不能重新排期。

QQ World 的平台消息、历史与点查共用 QQ 消息解码器，保留字符串/数字编号、引用回复、提及、表情与附件关系；已撤回消息的保存原文明确标注。附件标签保留消息、分段和转发节点对应，Provider 在对应图片之前运输标签；目录已核验的表情名称可用于呈现，缺失保持未知。普通正文不重复传输 URL，成功操作保留结果和消息引用、诊断数据保留完整操作记录；裁剪区分完整/部分/省略。事实仍为 UTC，日期与时区偏移仅在呈现层按对应时间转换。

工具参数继续由完整 schema 校验；Broker 与 WorldTool 只精简错误说明，按当前选择器报告相关字段，完整 AJV 错误快照在 `details.validationErrors`。自动验证包含隔离平台测试以及 World → Subject → JsonlSessionStore 集成，不证明真实 QQ 对端呈现或模型理解质量。2026-10-11 真实只读连接探测不可用，身份、在线目录与平台历史仍未获真实服务证据；验收映射与验证命令见 [QQ World 验收](qq/qq-world-acceptance.md)。

## Rhythm World（自主节拍）

当前 rhythm 位于 `.uina/worlds/rhythm/`，是主体唯一的通用唤醒来源（旧 ticker/pacing-ticker 已整体更名重写，不留兼容层）。工具面为 6 个动作：`status`、`set_interval`、`pause`、`resume`、`remind`、`cancel_reminder`。

节拍到期发送 `pacing-opportunity` 内部事件（queued、channel world），正文由引擎在投递时刻用现场快照合成：除时间外自带一行"当前节奏"（实际间隔、下次唤醒），主体在被唤醒时即知道自己的节奏，无需先查询。实际间隔 = max(基准, 安静退避下限)，退避只放慢不反向加速，外界有动静即回落；忙碌与 30 秒人类避让存在但属工程防碰撞。写动作返回一律回显生效后的真实节奏行，不只报被设置的值。

提醒 `remind` 按相对秒数设置，到期以 `reminder-due` 事件原文再现，不受静默/退避/日配额影响；投递至少一次（入队成功且移除写盘成功才消失，失败 15 秒重试，重启补投）。日配额读 `worldDataDir/config.json` 的 `maxDailyAttempts`，缺失即无上限并在 status 中如实呈现"未设"。全部文案出自 `src/format.ts` 单一格式器。机制事实与边界见 [.uina/worlds/rhythm/DESIGN.md](../.uina/worlds/rhythm/DESIGN.md)。

## 能力注册

所有能力经 ResourceScope 注册：

- `builtin:runtime-tools` 注册 `get_time`、`exec_command`。
- `builtin:workspace-tools` 默认注册 `read_file`、`write_file`、`edit_file`、`read_image` 和文件 renderer；Host 可用 `workspaceTools: false` 禁用，扩展可显式 replace。
- `builtin:session-tools` 注册历史查询/回溯工具与 `/history`、`/rewind`。
- `builtin:commands` 注册内置命令；`/session` 仍用于查看会话用量。
- 项目 MCP 扩展注册单个 `mcp` 代理工具。全局 MCP 配置的 `uina.mcpPurposes` 为已配置的全局 server 提供用途索引，通过 `turn.prepare` 加入 system prompt；`/reload` 后重建。索引不保证服务在线或远端工具目录最新；远端能力仍由 MCP 目录发现与校准。
- Screen MCP 服务实现位于 `.uina/mcp-servers/screen-mcp/`，当前源码状态见 [IMPLEMENTATION_STATUS.md](../.uina/mcp-servers/screen-mcp/IMPLEMENTATION_STATUS.md)。仓内有合成协议和桌面接口测试；真实桌面采集、真实视觉 Provider、默认尺寸与实际延迟门仍未验收。
- 项目扩展从 `.uina/extensions/` 的脚本、一级目录入口或 `package.json#uina.extensions` 加载；CLI `-e` 与 Host `extensionPaths` 可指定额外入口。在 `activate(pi)` 中调用 `pi.registerTool()`、`pi.registerCommand()`、`pi.registerProvider()`、renderer 或 hook 注册 API。

没有独立的 `tools/` 扫描或执行旁路。脚本加载使用 jiti，并刷新本地子模块；导入预检失败保留旧 activation，激活失败回收局部注册。ResourceScope 发出取消、执行 teardown、等待公共 API 在途调用并释放自己的注册。

公共接口支持工具调用、服务注册/调用、模型注册/使用、压缩策略、独立工具 renderer、Markdown 显示变换与上下文贡献。重名默认报错，显式 replace 注册可在注销时恢复前一个存活实现；共享 header/footer 也按所有权恢复。程序化工具调用写入带来源的自定义条目，不伪造模型调用。设计、API 语义和示例见 [扩展契约](extensions.md)。

**两条并存的数据通道（铁律：纯数据走 `callService`，活引用走 `share`）。** `callService` 对入参与返回值双向 `structuredClone`，只能承载纯数据——函数被丢弃，带闭包或原型方法的对象直接抛 `DataCloneError`。因此另有 `pi.share(name, value) → dispose` 与 `pi.shared(name)` 的同进程共享表：零语义、不序列化、重名即报错、生命周期随 activation scope 回收。把**行为**交给其他扩展时走共享，把**数据**交给其他扩展时走服务，两者不互相替代。App 侧只拿到写方 `ctx.expose`（登记活引用），不具备读取他人共享值的能力。

`Subject` 和 Provider adapter 只依赖必填 `RuntimeHooks` / `ProviderHooks`，不认识 `ExtensionHost`。CLI 将现有 Host 适配为 root view；无扩展 Agent 使用同一个 no-op view。所有 runtime hook 输入是冻结快照，变换必须显式返回新值；`ExtensionRunner.runtimeHooks(scopeIds?)` 只过滤同一 Host 的 handler 可见性，不创建第二个 Host、错误通道或 activation 状态。

## 模型事实

`imageInput` 来自明确配置或模型注册/目录事实；未知保持未知。内置 Provider 仅在明确不支持（`false`）时拒绝图片；未知允许尝试，保留附件及服务端错误，不自动改写能力事实。文本与图片附件经过会话恢复及上下文投影；OpenAI-compatible、Anthropic、Gemini 各自编码。TUI/stdio 默认显示图片元数据，未实现终端位图显示。字符 token 估算不包含未知的图像成本。

`modelContextWindow` 必须来自显式配置或可信 Provider/catalog 数据；未知上限保持未知并禁用自动 compaction。每请求输入预算由 `inputBudgetTokens` 显式覆盖；缺省上限为 60,000 tokens，并始终不超过窗口减去输出预留后的可用值，`0` 表示只受窗口约束。thinking 档位只来自显式配置或 Provider 目录：已移除按模型名索引的档位表，声明既不会被静默收窄也不会被静默抹掉，未声明即未知。Anthropic 的 `maxOutputTokens`、Gemini 的 `geminiThinkingFormat` 与 `thinkingBudgets` 都是必须显式声明的 wire 事实，缺失时在 Provider 创建阶段报错并指名字段，绝不由代码补造。UI 不补造 off，不通过 setter 或 slider 扩充可选档位。`ContextSnapshot` 描述当前已知投影（空闲时为 baseline，活动时含当前输入）；`RequestUsage` 只描述已经发生的 Provider 调用，不能覆盖上下文进度条。Provider 可选 `measureContext` 提供精确/专用测量，否则使用对 CJK 保守的 fallback 并标 approximate。首次输入前、模型切换和压缩完成后都会重新构造快照。OpenAI-compatible finish 后继续读取 usage-only 尾，非法后续内容报错。

Provider adapter 只向 Agent 发出规范化的 `stop`、`tool_calls` 或 `length`。Anthropic 的 `message_start`/content block/`message_delta`/`message_stop` 和 Gemini 的 candidate `finishReason` 都必须形成完整终止；未知、拒绝、安全拦截、非法工具参数和不支持的终止原因会作为可见错误抛出，不会伪装为正常结束。`length` 即使带有工具调用也只保留 assistant 事实，不执行副作用；只有 `tool_calls` 才进入 ToolBroker。usage 在单次 Provider 请求内按字段合并，跨请求不复用。Gemini tool result 的函数名从历史 assistant tool call 推导；`geminiToolCallIds` 只有显式配置为 `true` 才写入 wire。

模型目录刷新会逐个 Provider 收集错误并向 CLI 报告；刷新失败时不会把失败伪装成空目录，也不会保留未标记的旧动态模型。

Anthropic/Gemini 的 `providerReplay` 保存 adapter 自有的有序块与签名；Core 仅持久化和传递元数据。Gemini thoughtSignature 位于 Part，Anthropic 多个 thinking/signature 与 redacted-thinking 块保留归属。

## 活动与文件事件扩展

普通扩展通过 submitInput 进入同一 Subject 输入入口，通过 reportError 报告带扩展来源的外部失败。[文件事件示例](../examples/README.md) 验证文件观察、同步命令、即时结果快照、安静决定与卸载。停止观察后不再启动其新命令，进行中的命令通过自身取消信号结算。

Job/Subagent/Cognition 扩展已于 2026-10-06 应要求整体移除：后台命令执行、子代理与长期记忆工具不复存在，`exec_command` 仅保留前台模式；会话 journal 中历史任务效果事实（task.dispatch）只作为不可解释的聚合事实保留。

Host 级 SubjectProfile 仍可通过 `--profile` 显式启用，为主体绑定身份、session/settings 路径和资源根；`pi.subject` 仍供 World Framework 与 Voice 偏好存储使用。它不装配 Cognition，也不提供长期记忆整理能力。

## 进程生命周期与信号

进程级信号由 `cli/app.ts` 安装并在 shutdown 时卸载；`ui/core/terminal.ts` 只提供终端恢复，导入它不会注册任何进程监听器。SIGINT 保持普通中断语义（Node 会把信号名作为监听器首参，因此必须包一层零参闭包，否则信号名会被当成 force 标志）；SIGTERM（以及非 Windows 的 SIGHUP）先执行完整关闭（等待活动轮次、扩展 teardown、session flush、杀掉已追踪的分离子进程），再以 143/129 退出。stdout/stderr 的 EPIPE 被忽略，其余写错误继续抛出。

shell 工具在 `exit` 之后按 stdio 空闲收敛（每个数据块重新计时 100ms），因此持有继承管道的分离子进程不会让工具永久挂起；子进程 PID 被登记，关闭时统一杀进程树。`exec_command` 默认 120 秒超时，`timeout`（秒）参数可覆盖，不提供无限档；非法值直接报错，不做静默截断。取消或超时返回 `unknown` 并附已收集输出。

## 已验证与未验证

本节中带日期的测试与设备结果是各自工作树的历史快照，不代表当前 checkout。2026-10-14 文档审阅期间重新运行了 `pnpm typecheck` 和若干离线定向测试；具体范围与结果见[逐篇审阅台账](document-audit-register.md)。本轮没有运行全量测试，也没有连接真实 Provider、QQ、VTS 或设备。

会话回溯实现：类型与 5 条边界检查、28 文件 406 项测试通过；`pnpm dev:baseline --quick` 通过。隔离构建和编译 CLI 四组探针通过，包括三次 localhost 请求完成查询、回溯和继续。增强后新增：被放弃切片的外部操作清单、跨压缩点回溯、回溯重展开超限时的自适应压缩、废弃分支任务结果的来源标记、只读历史检视器（/history、/branches、Alt+H）与专用回溯卡片。详细分阶段结果及证据边界见 [会话设计](session-rewind.md)。

2026-09-13 文件/图片转正：`pnpm typecheck` 和全量 27 文件、377 项测试通过；隔离目录执行相同 build 与 verify:cli 脚本通过，Windows x64 native 已加载。localhost 编译 CLI 无需 `-e` 或 imageInput 声明即可完成图片工具回注；文件范围读取、格式签名、禁用装配及显式替换恢复已测试。这些结果不代表真实视觉服务端接受或识图质量。

本次扩展组合实现：类型/边界检查、27 个测试文件共 375 项通过；隔离目录完成相同 package build 脚本、Windows native 加载及编译 CLI 验证，包括 `-e` 加载 TS 目录扩展后的 PNG 工具回注。原目录 clean build 受正在运行的 Uina native 文件锁影响，隔离构建复用已安装依赖，以 npm run 执行相同脚本，未中断该进程。真实 DeepSeek 文件事件验收通过；视觉服务端接受与识图质量仍未验证。新增范围见 [扩展契约](extensions.md)。

历史检查曾通过 `pnpm typecheck`、`pnpm test`、`pnpm build`；测试覆盖本地 OpenAI-compatible、Anthropic、Gemini SSE，三种 Provider 的编译 CLI one-shot 工具回注、SessionEntry 恢复、ResourceScope teardown 和 runtime tool activation。该记录未给出可对应当前 checkout 的基线，不作为本轮全量验证结论。

以下仍未验证或未实现：其余真实 Provider 服务端、真实 TTY IME、ARM native 实际加载、跨平台 shell、实际断电、长期负载、语音、视觉、感知和分布式运行时。

2026-09-09 硬化与重构后，`pnpm typecheck`（含边界检查）、`pnpm test`（18 文件、281 项）、`pnpm build` 通过。临时 JSONL 验证恢复，UI 验证组件及事件，均不等于实际断电或真实 TTY 操作。

编译 CLI 在隔离配置与工作目录通过 localhost 工具回注（2 次请求，退出 0）；协议失败错误可见、退出 1，Windows x64 native 资源实际加载成功。

真实 DeepSeek v4 Flash 已验证 off/high/max、usage、流式取消及普通文件扩展完整场景。后台运行期间用户答复在 715 ms 到达，安静决定没有回复文本，实际命令失败回注，后台取消在 523 ms 后确认，卸载后不再投递。完整范围、延迟与复现入口见 [交付证据](history/reviews/2026-09-05-plan-delivery.md)。



## Live2D 动作与语音播放

当前 World 位于 `.uina/worlds/live2d`。MO rig 保留头、眼、嘴与躯干 yaw/pitch/roll 标定；头部是默认身体跟随目标，显式 torso 通道可错拍、偏移或接管。不控制手臂。当前 MO 登记了 17 个有限动作及 7 个变体、默认 idle、thinking 和 4 个 sway 环境片段；跳跃、贴脸、探头、转圈及石化使用显式空间或效果事件。

| 入口 | 当前名称与表现 |
| --- | --- |
| express / cue 动作 | 点头、摇头、眨眼、歪头、偷瞄、惊讶等；完整名称与别名由 status 返回 |
| state.posture | sleep、neutral_posture |
| state.expression | closed_eyes、neutral_expression |
| state.attention | `user`、`screen`、`avert_down`、`avert_left`、`avert_right` 或既有坐标目标 |
| state.ambient | sway；传 null 清除额外环境片段并回落默认 idle |
| 内部背景 | 默认自动循环 idle；thinking 随 Host 事件切换，自律通道按 rig 的 VTS/Uina 来源声明独立工作 |

工具 schema 仍是 express/state/costume/prepare_body/status/reload；state 负责持续姿态、表情和注视，express/cue 消费有限动作目录。动作重建后无需迁移入口或旧格式适配。`prepare_body` 创建按模型隔离的 Uina VTS 输入，不改写 `.vtube.json`；操作者需在 VTS 把三项分别映射到 `ParamBodyAngleX/Y/Z`，再 reload 并用 status detail 检查。

身体动作作者合同为 `ActionPlan`、命名 Timeline、局部曲线组合器、空间事件与 seed 派生随机流，详见 [Action 作者合同](../.uina/worlds/live2d/MOTION-AUTHORING.md)。Director 每帧分别记录作者采样目标、最终合成帧、来源贡献与 clamp hit；这些本地诊断仅由预览启用，不改变模型可见工具结果。作者机制目前由合成目录测试覆盖，不代表已重建任何 MO 动画或完成视觉验收。

普通 status 和 detail 均返回 `background: { default, current, running }`：default 表示默认 idle 是否存在，current 来自实际播放句柄，running 核对内部时钟、连接、身份与暂停/焦点。`catalog.ambient.current: null` 仅表示未选择额外环境片段，不表示没有 Idle。前景动作可压低后台贡献；running 不证明 VTS 画面效果。

Idle、thinking 和 sway 使用现有作者曲线与独立随机流；随机仅在 Bake 抽取。身体 baseline-offset 是对默认头部跟随的修正量，范围审计检查实际 Director 合成，不能把原始 torso offset 当作绝对姿态。

若后续目录动作声明空间事件，ExternalActions 以 `model:transform` 与 `effect:*` 独占资源，在预检后与 Director 同步 `t0` 调度。纯效果 marker 到时即可发送；含位姿 span 的事件先确认至少剩 100ms，再发效果，ACK 后再次确认窗口和当前模型位姿才移动。ACK 消耗位姿窗口，不重置时钟或重发请求。位姿窗口不足时取消并立即清理；正常路径等完整身体 ActionPlan 结束后再恢复位姿和效果，效果状态持续到下一同类效果事件或动作结束。取消、位姿失败和错过窗口立即清理；单次效果分发失败会继续身体播放与剩余计划，最终记为 unknown。相对旋转只在事件边界与归位前读取位姿；发现同模型被手动移动时中止后续空间事件，不写回旧基线，并将位姿清理记为 unknown。清理请求由结构化分项结算记录，空间追踪覆盖作者请求的 dispatch/ACK 和调度迟到。100ms 尚未真实 VTS 校准。当前这些机制由合成空间动作和假设备覆盖，没有 MO 生产动作触发它们。

空间特技分段可携带段级 effects（染色/后处理）。external-actions 统一拥有位姿、效果和外观请求的执行及清理：只恢复自己尝试发送的项，纯效果不移动模型，效果动作与外观请求共享 effect:* 独占。需要 post 时先捕获有效开关/preset 基线，读取失败或开关字段缺失即发送前 failed/not_started；仅 tint 不读写 post。恢复前后核验模型、连接与目录代次，失效后不向新环境写旧状态；位姿读回、tint 白色请求接受、post 开关及具名 preset 分别核验，不保证所有滤镜值逐项保真。details.cleanup 为 not_needed/confirmed/unknown，restored/restoredEffects 由它派生。必要清理未知时普通完成 unknown，取消保留 cancelled 并明确未知。safeStop 等待外部请求与完整分项事实，清理未知不再漏报；暂停取消持续状态的等待而保留意图，resume 继续剩余过渡并允许新执行，不自动重发或恢复，最近未知诊断保留。

2026-10-14 Action 作者层重构与审查收口：以命名 Timeline、ActionPlan、纯函数曲线与 Bake 编译器替代旧 MotionPlan；Director 与 ExternalActions 共用编译动作、有效时钟与共同 t0，自然结束按标称 wall end 退场，handoff 输出和 handle 结算共用进度；Runtime 使用 selection/performance/autonomic 隔离随机流。旧作者 API、MO 动作备份和复制夹具已删除；动画内容未迁移，MO motion/ambient/idle/thinking 为空。mo:preview 支持连续、单次、固定次数、seed、离线采样及真实空间请求追踪。作者输入快照、数值边界、空间窗口、同模型位姿所有权和在途 VTS 插值归位由回归覆盖；真实 VTS/MO 观感和 100ms 位姿阈值校准未完成。定向 Live2D 31 个测试文件、294 项通过；`pnpm typecheck`、8 条边界检查、`git diff --check` 通过；`mo:preview --list` 显示当前动作目录为空。

2026-10-15 按用户要求清空 MO 姿态与表情目录中的旧预设；当前动作、姿态、表情、ambient、idle 和 thinking 目录均为空。通用状态接口保留，后续重建时再登记模型内容。

2026-10-13 架构重构：目录编译前隔离作者数据，提供 resolve/list/resolveCue 冻结记录，无公开 Map 或重复解释器；MO sway 中文别名可执行。state 一次预校验并绑定目录代次，cue 复用同一准入与执行，拒绝不记 started。生产 Worker 与进程内装配同源；预取消零投递，运行取消等待结构化清理结论，线程退出撤销全部登记与订阅并使保留引用离线，迟到 sync 不复活。启动回滚及正常停止聚合错误而释放资源，context abort 与 onStop 保留在途结果。当前完整合同见 [Live2D World 运行合同](live2d/live2d-world-runtime.md)。以下历史验证记录仅证明对应当次运行，不代替重构后的自动验证或真实设备验收。

2026-10-13 集成验收：Live2D 23 文件、207 项通过，48 个源码/测试文件格式通过，8 条边界及独立 TypeScript 检查通过。原工作区全量 1998 通过、2 失败、1 项预期失败；失败为 smoke 旧 JSON 断言和 session-settings 写盘等待超时（后者独立复跑 7 项通过，暂未稳定复现）。完整 typecheck 仍被 262 项范围外格式诊断阻断，未改写全仓。真实 VTS/MO 的本轮空间/效果恢复、取消失焦及重启验收尚未进行，详细日志与证据边界见运行合同。

2026-10-11 验证边界：`pnpm typecheck`（格式、8 条依赖边界、TypeScript）通过；16 个相关 Live2D 测试文件、108 项通过，未运行全仓、Provider 或音乐集成。定向回归覆盖实际 director → 弹簧/平滑/补偿 → 注入观察链，包括 Wink/自动眨眼、最新 attention 交还、背景跨周期/冻结/恢复、讲话口型混合、雀跃取消/异常/未到 ACK/模型更换、旧 ACK 不计入新播放，以及已连接客户端启动时钟。真实 VTS/MO 已检查 Wink、两种笑容与部分头部/反应关键姿势；雀跃完整执行取得本次输入接受与归位回读证据，预览结束后原构图误差小于 0.000001，并恢复原输入。关键姿势截图不能证明完整节奏的自然度；完整静音三组对照及真实讲话状态的视觉验收仍未完成。后续调节继续只针对幅度、停顿、先后和收势。

2026-10-11 审查修复验证：新增 5 项回归，覆盖惊讶/惊吓入场与自然收势的单次语音混合，以及雀跃移动中、移动 ACK 未到、参数收势等待期间失焦后的取消、归位和回焦再执行。9 个相关 Live2D 测试文件、73 项通过，`pnpm typecheck` 通过；本轮未运行全仓测试或真实 VTS 视觉验收。

2026-10-12 ambient 环境循环：新增 `ambient` 工具与目录词表（`sway` 左右摇摆），环境循环命名与别名纳入全局唯一命名空间，选中替换 idle、清除回落、目录更替清空、内置微晃选中期禁用。新增 9 项回归（`tests/live2d-ambient.test.ts`，覆盖目录编译冲突、静止态替换/回落、interrupt 不影响、幂等、未知名字拒绝、目录更替清空）并在 MO 目录装配断言 `sway` 条目。`pnpm typecheck` 通过；13 个 Live2D 相关测试文件全部通过（含本轮前 61 项既有回归）。全仓 vmThreads 跑批中 18 项失败均位于 extension-runner / compaction / qq-world / tts / host-separation 等与 Live2D 无导入关系的文件（进程 spawn 型用例，符合已知沙箱约束），判定为既有沙箱失败而非本次回归；CRAP gate 因沙箱全量跑批存在既有失败而未取得 coverage，未验证。真实 VTS/MO 的 `sway` 观感（幅度、周期、自然度）未做视觉验收。

2026-10-12 特效框架（染色/后处理）：协议层 tintModel/updatePostProcessing/readPostProcessing、段级 effects 契约与运行时捕获-分发-三向归位落地（a2ca3b8）。审查修复补齐：目录 effects 绑定期校验回归（非法通道/渐变、末段携带、空载荷、纯效果段合法）、所有权守护用例 E（无 effects 特技零 tint/post 请求）、假设备后处理状态模拟使恢复读回真实核对、恢复结算增加具名 preset 一致性核对、效果派发措辞纠正为同段顺序派发、catalog 空间校验块缩进归位。19 个 Live2D 测试文件、157 项全部通过，`pnpm typecheck` 通过；CRAP gate 未取得 coverage（沙箱全量跑批有既有失败），真实 VTS 视觉验收未做。注意：`.uina/**` 在 biome format 门禁之外（files.includes 未纳入），live2d 代码格式依赖手工纪律。

旧版 2026-10-10 Live2D 实施与验证记录已归档至 [Live2D 旧实现记录](archive/live2d-legacy-implementation-notes-2026-10-10.md)；当前合同与未验证边界见 [Live2D World 运行合同](live2d/live2d-world-runtime.md)。


2026-10-19 MO 自然表演升级：当前目录已包含动作、日常变体、姿态/表情与自然背景短句，旧的空目录记录仅为历史。Runtime 对有限 idle/thinking/ambient 每段重新 Bake，最近两次选择排除，背景终点连续接续；显式状态优先，前景增量保留当前背景姿态。既有可听电平接缝内增加稀疏头身强调，闭眼/姿态/前景/thinking/ambient 抑制，生命周期清除旧候选。`mo:preview -- --scenario idle|speech|mixed [--offline]` 提供固定 seed 场景；模拟电平不能代替实际 TTS。真实 MO/VTS 已做短时连接、输入接受与少量画面快照检查，最终连续录像及真人质感验收尚未完成。完整合同见 docs/live2d/live2d-world-runtime.md。

批 8 Library 正式入口为 `pnpm dev:mc:library`（真实模型加 `-- --model`）；三类普通文件管理与四类统一发现使用同一材料，save from 校验正式 Call/快照，兼容大 Call 的文件记录返回。在途段固定源码，新段重读。MC 40 文件/305 项、相关 Host 5 文件/27 项、typecheck/build、源码/产物真服各7/7和真实deepseek-flash复用4/4通过；证据与明确未交付范围见 [批 8 实施记录](proposals/mc/archive/library-implementation.md)。
