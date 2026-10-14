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

## TUI 消费者与扩展接缝

交互启动顺序为：读取 `HostSnapshot`、恢复 TUI 会话与草稿状态、接入扩展 UI、启动终端消费者，随后才启动 `Host`。`HostSnapshot` 与 `HostEvent` 位于 `host/events.ts`；UI 不持有可供 CLI 操作的 Host 引用。Host 事件到 transcript/activity/trajectory 的投影集中在 `InteractiveTUI.consume()`，CLI 只提供回溯装饰等宿主派生数据。运行中晚接入的订阅者只收到后续事件，不重建既有 transcript。

TUI 向 CLI 发出的动作是 `TuiIntent` 联合（提交、取消、插队递送、撤回队列、切换思考档位）；CLI 路由后调用 Host。忙闲决策使用 Host 快照/查询，TUI 的 busy 值只是事件驱动的显示状态。草稿读写、通知和会话恢复通过 TUI 门面操作。应用 UI 动作使用判别联合请求 `{ name, payload?, signal? }`；扩展的作用域信号与调用者信号合并，作用域结束会关闭该调用打开的面板。模型选择回调纳入 ResourceScope 在途工作结算。

扩展的 `pi.ui` 只提供通知、确认/选择/输入、状态和类型化应用动作；ANSI 组件、overlay、widget、编辑器控制、页眉页脚、gutter 与组件渲染器注册位于 `pi.ui.terminal`。renderer 注册由扩展 `ResourceScope` 管理，终端未接入时也注册到共享 renderer registry。没有预建 Web/GUI 布局层。

`@` 文件路径联想使用异步目录遍历，候选加载时显示“扫描中”；输入查询变化后，迟到的搜索结果不会覆盖当前输入或候选。

组件异常在组件边界内报告并隔离。弹窗按收到的宽高组织可见内容；空 ContextBar 不占行，存在上下文事实时提供 Ctrl+L 入口。时间线轨只在有多轮导航且历史可滚动时出现，无可滚动内容时不保留 gutter。布局与鼠标热区共用 `FrameLayout`。这些约束由 fake terminal 覆盖 40/50/80/120 列与 8/12/24 行；真实终端字体、配色观感和 IME 仍需现场验收。

## Agent lifecycle

`Subject` 对外以 `activeRun` 表示完整运行。`waitForIdle()` 会等待 turn 结束、extension handler、队列续跑和 observed output flush 全部结算。

每次请求先从 canonical history 构造完整 `RequestProjection`，跑完纯 `turn.transformContext` 链后统一测量；`turn.preflight` 只能归并 `fail > rebuild > send`，不能修改投影。compaction capability 只生成持久 checkpoint，Core 收到 rebuild 后从 canonical history 重跑整条投影链；journal 始终保留全量历史。`/compact` 空闲时当场完成，忙时立即显示 queued，并在 awaited `turn.afterEnd` 安全点、下一条队列输入恢复前完成。失败或取消不激活未持久化 checkpoint。AgentHandle 的 busy/status 从实际主体活动派生，dispose 等待活动与存储关闭。

每个已启动的 `content` 或 `thinking` 输出 channel 恰好以一个 `output_end` 或 `output_interrupted` 终止。网络错误、取消和协议失败不伪造成正常结束。

## 会话与恢复

`data/session.jsonl` 按真实时间追加 header、message、input、custom message/entry、rewind 和 lifecycle event。日志是权威事实；Session 从日志推导当前主线与全部历史节点，模型历史与 TUI 从同一主线投影。回溯只允许选择当前主线的安全历史祖先，退出路径只读，外部状态不撤销。设计与阶段验收见 [会话主线与回溯](session-rewind.md)。

工具已开始但没有最终结果时，恢复为 `unknown`，不推断外部副作用成功。打开日志时将末尾恢复结果追加落盘，之后的实时会话查询不会将正在执行的工具误判为崩溃。

扩展阻止执行时记录 `not_started` 及原因，不生成 `tool_started`；该日志可正常重开。`custom_entry` 是 capability 私有持久状态（Auxiliary）：仅登记在 auxiliary timeline，不进入主线 entries 与模型上下文。

队列移交通过一条携带输入 ID、内容和来源的 `input` 记录提交：提交前归队列，提交后归会话。用户输入投影为 user message，runtime 来源投影为隐藏 custom 消息，标明运行时来源，重开后仍可进入上下文，不伪装成人类发言。提交失败报告错误并保留待处理队列，失败轮次不自动续跑。这里保证输入归属，不保证外部副作用恰好执行一次或跨重启 producer 对账。`input_accepted` 表示已受理进入直接启动或队列；`input_settled` 表示输入已进入 canonical history 或永久退役（不表示模型已回复或外部副作用成功）。World 可用该事实回收 deferred 输入占位，避免把 render 当作提交确认。

Host 默认装配事件帧 profile：未显式传入 `projection`/`systemPrompt` 时，模型请求中的外部输入（用户输入、runtime 来源且 `origin: external` 的观察）以 `external_event_frame` 三消息组（通知、合成调用、回执）呈现，内部 runtime 消息以带来源标注的 user 消息呈现且不重复加内部分类前缀；每请求执行帧协议校验，请求级预算门仍归 Subject。`examples/file-events.mts` 的文件变化观察标 `origin: external`。设计见 [外部事件帧设计](proposals/runtime/external-event-frame-design.md)。

header 为 v3，且只接受 v3：v2 及更早版本明确拒绝，没有迁移链，也没有旧版本 reader——旧 journal 直接开新会话。不会自动猜测修复非法生命周期记录，也无法补回已丢失的输入。

## 工具结果

`Tool.run` 返回 `{ result: string, status: ToolResultStatus, images?, details? }`。图片以 MIME/base64 附件保留，details 供程序与 UI 使用而不进入模型上下文。内置 shell、时间工具与项目工具共用此合同；旧项目工具需将字符串返回值迁移为该对象。`tool_result` hook 的 `isError` 改为 `status`，正文变换默认保留完整结论。Broker 的 `run()` 仍是仅取正文的便捷方法，执行事实由 `execute()` 返回。

World action 也必须返回该结构化合同；字符串结果不再隐式视为成功。外部效果动作在模型可见正文中保留最小的 `effect=accepted|applied|simulated|unknown` 事实，details 保留完整程序诊断与验证入口。

结果可附带 `continuation: "stop"`，在结果记录后结束当前决策，不丢弃其他排队输入。文件扩展用它表达明确的安静决定；UI 不需要过滤生成文本。

shell 非零退出码为 `failed`。Broker 接受 producer 已明确返回的结论；启动后遇到取消且工具抛错、无法确认结果时为 `unknown`。JSONL、实时 transcript 和恢复 transcript 保留五种结果状态；旧消息未记录状态时显示未知。UI 收到中断请求不会擅自将运行中工具定为失败，随后确认的结果可以更新已结束轮次中的对应工具卡。

## TTS 文件生成

Voice/TTS 的来源顺序、立即静音、确认停止、有限恢复、诊断输出和瞬态上下文合同见 [Voice/TTS 当前合同](voice-tts/voice-tts-runtime.md)。声音协议版本为 2；外部旧 Bridge 需要由启动方更新重启。自动化与真实设备验证边界分别记录，不把受理或健康接口当成实际播放。

实时字幕伴生服务由 TTS 扩展通过 `subtitle-companion.ts` 探测/启动；其独立实现位于 ThirdParty `realtime-subtitles` 项目。源码与模拟测试覆盖本地连接、队列和呈现逻辑，不证明 OBS、实际声卡时间同步或真实直播画面已验收；当前设计状态见 [实时字幕服务设计](proposals/voice/realtime-subtitle-service-design.md)。

项目 TTS 扩展注册独立 `tts_generate({text})`：原样提交完整文本，使用部署中的 Vendor/语音预设与共享合成锁，等待完整 PCM WAV 后保存到 `<pi.cwd>/uina/tmp/`。成功模型正文只含普通文件 `resource` 和采样计算的 `durationMs`；失败不返回文件引用。临时件同目录独占写入并在校验后原子发布，不覆盖已有文件。生成不播放、不驱动字幕或口型，已发布文件不随回合结束、静音或扩展卸载清理。详见 [TTS 文件生成](voice-tts/tts-file-generation.md)。

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

`modelContextWindow` 必须来自显式配置或可信 Provider/catalog 数据；未知上限保持未知并禁用自动 compaction。thinking 档位只来自显式配置或 Provider 目录：已移除按模型名索引的档位表，声明既不会被静默收窄也不会被静默抹掉，未声明即未知。Anthropic 的 `maxOutputTokens`、Gemini 的 `geminiThinkingFormat` 与 `thinkingBudgets` 都是必须显式声明的 wire 事实，缺失时在 Provider 创建阶段报错并指名字段，绝不由代码补造。UI 不补造 off，不通过 setter 或 slider 扩充可选档位。`ContextSnapshot` 描述当前已知投影（空闲时为 baseline，活动时含当前输入）；`RequestUsage` 只描述已经发生的 Provider 调用，不能覆盖上下文进度条。Provider 可选 `measureContext` 提供精确/专用测量，否则使用对 CJK 保守的 fallback 并标 approximate。首次输入前、模型切换和压缩完成后都会重新构造快照。OpenAI-compatible finish 后继续读取 usage-only 尾，非法后续内容报错。

Provider adapter 只向 Agent 发出规范化的 `stop`、`tool_calls` 或 `length`。Anthropic 的 `message_start`/content block/`message_delta`/`message_stop` 和 Gemini 的 candidate `finishReason` 都必须形成完整终止；未知、拒绝、安全拦截、非法工具参数和不支持的终止原因会作为可见错误抛出，不会伪装为正常结束。`length` 即使带有工具调用也只保留 assistant 事实，不执行副作用；只有 `tool_calls` 才进入 ToolBroker。usage 在单次 Provider 请求内按字段合并，跨请求不复用。Gemini tool result 的函数名从历史 assistant tool call 推导；`geminiToolCallIds` 只有显式配置为 `true` 才写入 wire。

模型目录刷新会逐个 Provider 收集错误并向 CLI 报告；刷新失败时不会把失败伪装成空目录，也不会保留未标记的旧动态模型。

Anthropic/Gemini 的 `providerReplay` 保存 adapter 自有的有序块与签名；Core 仅持久化和传递元数据。Gemini thoughtSignature 位于 Part，Anthropic 多个 thinking/signature 与 redacted-thinking 块保留归属。

## 活动与文件事件扩展

普通扩展通过 submitInput 进入同一 Subject 输入入口，通过 reportError 报告带扩展来源的外部失败。[文件事件示例](../examples/README.md) 验证文件观察、同步命令、即时结果快照、安静决定与卸载。停止观察后不再启动其新命令，进行中的命令通过自身取消信号结算。

Job/Subagent/Cognition 扩展已于 2026-10-06 应要求整体移除：后台命令执行、子代理与长期记忆工具不复存在，`exec_command` 仅保留前台模式；会话 journal 中历史任务效果事实（task.dispatch）只作为不可解释的聚合事实保留。

## 进程生命周期与信号

进程级信号由 `cli/app.ts` 安装并在 shutdown 时卸载；`ui/core/terminal.ts` 只提供终端恢复，导入它不会注册任何进程监听器。SIGINT 保持普通中断语义（Node 会把信号名作为监听器首参，因此必须包一层零参闭包，否则信号名会被当成 force 标志）；SIGTERM（以及非 Windows 的 SIGHUP）先执行完整关闭（等待活动轮次、扩展 teardown、session flush、杀掉已追踪的分离子进程），再以 143/129 退出。stdout/stderr 的 EPIPE 被忽略，其余写错误继续抛出。

shell 工具在 `exit` 之后按 stdio 空闲收敛（每个数据块重新计时 100ms），因此持有继承管道的分离子进程不会让工具永久挂起；子进程 PID 被登记，关闭时统一杀进程树。`exec_command` 的 `timeout`（秒）可省略；非法值直接报错，不做静默截断。

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

当前 World 位于 `.uina/worlds/live2d`。首批 MO 表演使用既有头、眼、嘴绑定；当前 rig 还提供独立的躯干 yaw/pitch/roll。头部是身体默认跟随底动，显式 torso 轨迹可以错拍、偏移或单独接管；不控制手臂，也不平移整个模型。内容单源为 [MO 目录](../.uina/worlds/live2d/models/mo/catalog.ts)，目录同时提供 status 与 cue 能力。

| 入口 | 当前名称与表现 |
| --- | --- |
| express / cue 短手势 | `nod` 点头应声、`shake` 摇头否认、`wink` 左眼俏皮眨眼、`curious` 侧歪打量、`chin_up` 得意昂头、`head_toss` 哼一下 |
| express / cue 反应与视线 | `alert` 凝神警觉、`startle` 吓一跳、`surprise` 惊讶一顿、`glance` 偷瞄一眼、`eye_roll` 无语望天、`double_take` 再看一眼 |
| express / cue 空间手势 | `joy_hop` 雀跃一弹、`petrify` 石化、`close_up` 贴脸、`edge_peek` 边缘探头、`spin` 转圈（目录已装配；既往视觉结果只适用于当时的动作内容，不验证 2026-10-14 的曲线重写） |
| state.posture | `rest` 自然站定、`tuck` 垂头收起、`head_back` 仰头放松，仅控制头部 |
| state.expression | `smile` 明朗笑、`smirk` 半眯坏笑、`clear_face` 清除表情；smirk 嘴形与双眼开度均约 0.55，无偏嘴承诺 |
| state.attention | `user`、`screen`、`avert_down`、`avert_left`、`avert_right` 或既有坐标目标 |
| state.ambient | `sway` 头身错拍动作组：短片段轮换躯干倾斜、头部反应、视线转移和眨眼，片段边界避免立即重复；选择后持续运行并与说话/表情/视线并存，传 null 清除并回落 |
| 内部背景 | 3.8 秒不对称轻晃；思考时持续上侧目光与歪头，每约 3.6 秒轻微重新定向 |

`greeting/lean/brighten` 和 `wave` 别名已从 MO 目录删除，不保留兼容层；打招呼可组合点头与笑。工具为 express/state/costume/prepare_body/status/reload；姿态、表情、注视、环境通过 state 分别持有持续意图，express/cue 播放有限动作。`prepare_body` 创建按模型隔离的 Uina VTS 输入，不改写 `.vtube.json`；操作者需在 VTS 把三项分别映射到 `ParamBodyAngleX/Y/Z`，再 reload 并用 status detail 检查。音乐、气鼓鼓和偏嘴未发布。

头部手势为姿态增量，按当前姿态剩余范围同比缩小；普通手势不写入持续表情。作者用曲线函数、弹簧响应、姿势起落窗口和共享相位生成连续头身运动；`pts` 保留给眨眼、眼神路线与明确表演落点。相关轴在 bake 时共享轻量强度/相位变化，动作仍可用精确眼睑和语音节奏作锚点。惊吓透传短入场和弹簧速度重置。临时眼睑控制暂停自动眨眼，退出平滑交还最新表情；持续半眯仍正常眨眼。临时视线退出从当前眼球输出在约 120ms 内交还最新有效 attention。惊吓、惊讶的短暂张嘴与既有语音口型混合；嘴部接管与交还使用语音混合前的平滑开度作为起点，语音只混合一次。

背景由同一 director 仲裁；idle 和单片段 ambient 循环，MO sway 每段有限播放并在边界换选不同短动作。头部或躯干前景动作都会压低背景，完成后恢复。思考仍由 Host 事件驱动。失焦冻结；safeStop 取消实例并保留有效状态，resume 重建背景。MO idle/thinking 使用闭合周期曲线；sway 使用共享相位与强度的有限振荡短句并在片段边界收束，呼吸仍由 VTS 提供。

state.ambient 是静止态背景的可选形态：与 idle 互斥；带 variants 的 sway 由 autonomic 背景动作逐段交接，清除后回落 idle；thinking（transition 类）照旧叠加。选中项不在当前目录快照时诚实回落 idle。环境动作命名与别名纳入目录全局唯一命名空间，与动作/姿态/表情/注视/外观冲突即在绑定期拒绝。回合打断与 safeStop 不清除选中；内置微晃在 idle 有定义或 ambient 选中期间禁用，避免双重摆动。

雀跃独占 `model:transform`，以五次 VTS 原生分段移动推进，不发送逐帧空间请求。取消、失焦、回合打断或异常切断关联参数动作并执行归位清理，清理结算后释放占用；失焦期间新空间请求以 cancelled / not_started 返回，回焦不会续播旧空间表演。每段与归位前校验设备模型身份、目录代次、连接代次和模型代次，避免把旧位姿写给新模型。归位回读失败或失联保留未知。参数反馈复用客户端逐播放注入观察，只计入本次真实合成贡献；完成时仅等待已发请求，取消不等待确认。没有本次所需输入接受证据即返回 unknown；姿态、表情、注视只报告 local_intent。`restored` 单独描述空间归位。

空间特技分段可携带段级 effects（染色/后处理）。external-actions 统一拥有位姿、效果和外观请求的执行及清理：只恢复自己尝试发送的项，纯效果不移动模型，效果动作与外观请求共享 effect:* 独占。需要 post 时先捕获有效开关/preset 基线，读取失败或开关字段缺失即发送前 failed/not_started；仅 tint 不读写 post。恢复前后核验模型、连接与目录代次，失效后不向新环境写旧状态；位姿读回、tint 白色请求接受、post 开关及具名 preset 分别核验，不保证所有滤镜值逐项保真。details.cleanup 为 not_needed/confirmed/unknown，restored/restoredEffects 由它派生。必要清理未知时普通完成 unknown，取消保留 cancelled 并明确未知。safeStop 等待外部请求与完整分项事实，清理未知不再漏报；暂停取消持续状态的等待而保留意图，resume 继续剩余过渡并允许新执行，不自动重发或恢复，最近未知诊断保留。

2026-10-14 曲线函数创作模型落地：动作定义改为 `(rng) => MotionPlan` 工厂（每轴单通道 absolute/offset，曲线即函数），compileMotion = 校验 + 域探测 + 冻结，sampleMotion 纯采样合同不变；目录只存词表与定义，runtime 独占 per-play bake（随机幅度纹理逐播结清）。MO 目录按新模型重建（17 动作 + sway 短语，`pts` 扁平速记 + `elastic` 生成器 + 双侧眼睑共享曲线）。新增合成故障停车（composeTick 捕获采样异常 → fault 登记/时钟停止/播放结算/工具 `fault` 拒绝，在途 spatial 清理不受影响）与 `pnpm run mo:preview -- [--seed <seed>] ...` 预览轮播（express 主脑同路径，就绪等待 + 失败退避）。`pnpm typecheck` 全绿；live2d 定向 235/235（旋转驱动时序用例仍为已登记调度敏感项）。真实 VTS/MO 视觉验收（纹理观感、`mo:preview` 真机复跑）未做。

2026-10-14 MO 动作程序化再创作：idle/thinking 使用闭合周期曲线；sway 由四个有限振荡短句组成，各轴共享片段强度与相位偏移，并在句尾收束。nod、shake、wink、curious、chin_up、head_toss、alert、startle、surprise、glance、eye_roll、double_take、joy_hop、petrify、close_up、edge_peek 的头身运动使用弹簧、姿势窗口或阻尼摆动，相关轴共享 bake 强度。眨眼、特定眼神路线及 spin 的空间阶段保留精确关键点。本轮完成格式与类型检查；目录定向测试已通过，真实 MO/VTS 视觉自然度尚未验收。

2026-10-13 架构重构：目录编译前隔离作者数据，提供 resolve/list/resolveCue 冻结记录，无公开 Map 或重复解释器；MO sway 中文别名可执行。state 一次预校验并绑定目录代次，cue 复用同一准入与执行，拒绝不记 started。生产 Worker 与进程内装配同源；预取消零投递，运行取消等待结构化清理结论，线程退出撤销全部登记与订阅并使保留引用离线，迟到 sync 不复活。启动回滚及正常停止聚合错误而释放资源，context abort 与 onStop 保留在途结果。当前完整合同见 [Live2D World 运行合同](live2d/live2d-world-runtime.md)。以下历史验证记录仅证明对应当次运行，不代替重构后的自动验证或真实设备验收。

2026-10-13 集成验收：Live2D 23 文件、207 项通过，48 个源码/测试文件格式通过，8 条边界及独立 TypeScript 检查通过。原工作区全量 1998 通过、2 失败、1 项预期失败；失败为 smoke 旧 JSON 断言和 session-settings 写盘等待超时（后者独立复跑 7 项通过，暂未稳定复现）。完整 typecheck 仍被 262 项范围外格式诊断阻断，未改写全仓。真实 VTS/MO 的本轮空间/效果恢复、取消失焦及重启验收尚未进行，详细日志与证据边界见运行合同。

2026-10-11 验证边界：`pnpm typecheck`（格式、8 条依赖边界、TypeScript）通过；16 个相关 Live2D 测试文件、108 项通过，未运行全仓、Provider 或音乐集成。定向回归覆盖实际 director → 弹簧/平滑/补偿 → 注入观察链，包括 Wink/自动眨眼、最新 attention 交还、背景跨周期/冻结/恢复、讲话口型混合、雀跃取消/异常/未到 ACK/模型更换、旧 ACK 不计入新播放，以及已连接客户端启动时钟。真实 VTS/MO 已检查 Wink、两种笑容与部分头部/反应关键姿势；雀跃完整执行取得本次输入接受与归位回读证据，预览结束后原构图误差小于 0.000001，并恢复原输入。关键姿势截图不能证明完整节奏的自然度；完整静音三组对照及真实讲话状态的视觉验收仍未完成。后续调节继续只针对幅度、停顿、先后和收势。

2026-10-11 审查修复验证：新增 5 项回归，覆盖惊讶/惊吓入场与自然收势的单次语音混合，以及雀跃移动中、移动 ACK 未到、参数收势等待期间失焦后的取消、归位和回焦再执行。9 个相关 Live2D 测试文件、73 项通过，`pnpm typecheck` 通过；本轮未运行全仓测试或真实 VTS 视觉验收。

2026-10-12 ambient 环境循环：新增 `ambient` 工具与目录词表（`sway` 左右摇摆），环境循环命名与别名纳入全局唯一命名空间，选中替换 idle、清除回落、目录更替清空、内置微晃选中期禁用。新增 9 项回归（`tests/live2d-ambient.test.ts`，覆盖目录编译冲突、静止态替换/回落、interrupt 不影响、幂等、未知名字拒绝、目录更替清空）并在 MO 目录装配断言 `sway` 条目。`pnpm typecheck` 通过；13 个 Live2D 相关测试文件全部通过（含本轮前 61 项既有回归）。全仓 vmThreads 跑批中 18 项失败均位于 extension-runner / compaction / qq-world / tts / host-separation 等与 Live2D 无导入关系的文件（进程 spawn 型用例，符合已知沙箱约束），判定为既有沙箱失败而非本次回归；CRAP gate 因沙箱全量跑批存在既有失败而未取得 coverage，未验证。真实 VTS/MO 的 `sway` 观感（幅度、周期、自然度）未做视觉验收。

2026-10-12 特效框架（染色/后处理）：协议层 tintModel/updatePostProcessing/readPostProcessing、段级 effects 契约与运行时捕获-分发-三向归位落地（a2ca3b8）。审查修复补齐：目录 effects 绑定期校验回归（非法通道/渐变、末段携带、空载荷、纯效果段合法）、所有权守护用例 E（无 effects 特技零 tint/post 请求）、假设备后处理状态模拟使恢复读回真实核对、恢复结算增加具名 preset 一致性核对、效果派发措辞纠正为同段顺序派发、catalog 空间校验块缩进归位。19 个 Live2D 测试文件、157 项全部通过，`pnpm typecheck` 通过；CRAP gate 未取得 coverage（沙箱全量跑批有既有失败），真实 VTS 视觉验收未做。注意：`.uina/**` 在 biome format 门禁之外（files.includes 未纳入），live2d 代码格式依赖手工纪律。

旧版 2026-10-10 Live2D 实施与验证记录已归档至 [Live2D 旧实现记录](archive/live2d-legacy-implementation-notes-2026-10-10.md)；当前合同与未验证边界见 [Live2D World 运行合同](live2d/live2d-world-runtime.md)。
