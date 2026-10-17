# Minecraft World：跨模块详细契约草案

日期：2026-10-16（Asia/Shanghai）；2026-10-17 审查修订。状态：**供审阅的推荐设计；World 侧接收/当前读/Watch/历史/领域记录/保留已实现并通过集成验收，Driver 核心已实现（fake bot），未获真实游戏验证**。实现状态标注见 [World 详细设计](modules/world.md) 各节"实现状态/条件条款"注记。

本文承接 [概要设计](design.md)，只定义跨边界的行为、数据和失败合同，不另建完整方案或施工计划。概要负责目标和组成，本文负责下面五组接缝的具体语义；冲突时应同步修正文档，不能由实现者自行选择一套。方法、参数、返回与错误的唯一候选定义见 [模块公开接口及其链接的所有者合同](public-api.md)；本文维护全局行为约束，不重复类型或冻结所有玩法参数。

目的：调用方与被调用方由不同 AI 实现时，对受理、停止、等待、效果与恢复得到一致结果。评价仍是实际游玩效果、开放性与综合成本。四项已确认产品边界直接继承，不重新开放选择。Runtime 内部设计见 [Runtime / Callable](modules/runtime.md)，语言执行/桥接/容量算法见 [Program](../../../.uina/worlds/minecraft/modules/program.md)；2026-10-17 统一修订结果递送、执行域与资产来源边界，未修改代码。

<a id="judgments"></a>

## 1. 本次独立判断

保留“成熟能力 + 普通 JS + 本地反馈”的行动空间，共用游戏执行环境；不引入第二个长期规划 Agent、Steps 语言或另一套任务框架。需要收紧的地方如下。

| 问题 | 推荐选择 | 竞争方案及取舍 |
| --- | --- | --- |
| Run 完成主报告 | 同一 completion：短等待窗口内真实直返，超时后 World 输入通知 | 不增 Core 记录后事件，不保证跨日志恰好一次；工具交接不是 canonical ACK |
| 提交身份 | 接入生成并先持久保存 requestId；LLM 不生成 ID | invocationId 可选且可能跨模型请求重复，只作追踪；相同参数也可能是两次合法意图 |
| 同来源替换 | 有真实来源时按来源；现有 World 上下文缺少来源时必须给出被替换的提交引用 | 把所有 Minecraft 调用视为同来源更省字段，但会错误撤销别的调用方任务 |
| 原生插件控制 | 在实际写入及其异步来源处适配；不能只包顶层调用 | 直接交原始 Bot 最方便，但迟到回调、全局目标和物理写入会绕过控制归属 |
| 世界等待 | 被动订阅与主动复查分开，主动复查重新排身体 | 一律等事件无法发现关闭窗口后的炉内产物；一律轮询又浪费身体与协议调用 |
| “关键效果” | 改成由操作合同建立的完成证据要求，运行管理只汇总 | 脚本任意标非关键会掩盖未知；所有潜在后果都必须确认则连单次攻击尝试也无法诚实结束 |
| 依赖版本 | 保存单个程序入口，确切引用或已固定名称调用，固定原生环境并记录实际调用 | 撤回完整目录快照和模块作用域解析图；它们没有来自当前程序使用方式的必要性证据 |
| 生成代码隔离 | 独立、受限、可退役执行域；QuickJS+段子进程为优先原型 | Program 管 guest，Executor 唯一监管进程树；成本/语义未过真实原型前不宣称验证 |

核查发现：当前 Uina 已有具身 `safeStop/resume/interrupt` 接缝，但没有可直接套用的持久 Minecraft 急停门；`/reload` 也不重载 World 定义。证据及适用范围见 [研究记录 §2.1](research.md#seam-audit)。

<a id="ownership"></a>

## 2. 身份、依赖与唯一写入者

### 2.1 四种生命周期不能共用一个 ID

| 名称 | 身份与寿命 | 结束后保留什么 |
| --- | --- | --- |
| Subject 回合 | Uina 自己的推理与工具回注 | canonical journal；回合取消不撤销已受理游戏运行 |
| 游戏运行 `run` | 一次有归属的游戏意图，可以跨多个执行段 | 受理、各段、累计工作历史、停止意图和当前结论 |
| 执行段 `segment` | 一份入口、输入、检查点及依赖绑定的代码执行；可在内存中跨世界等待 | 代码、版本、领域结果及中断证据；待决策和进程崩溃不保留任意 JS 栈 |
| 身体控制段 `body` | 执行段的一次连续身体占用 | 资格、输入、临时资源及停止事实；释放后重新取得时一定是新资格 |

一个执行段可先持身体、释放并等待、再取得新身体资格。不得把 `run.phase === running` 当作持有身体，也不得让新代码段继承旧控制资格。

### 2.2 允许依赖矩阵

下表是 import/调用边界，不是独立服务清单。每项合同由拥有它的模块导出，不再集中到无归属的万能 `shared`。

| 模块 | 可以依赖的公开合同 | 禁止穿透 | 唯一写入者/装配责任 |
| --- | --- | --- | --- |
| Uina / Executor 接入 | World 公共 API、执行侧客户端、受管进程创建/退出事实 | Bot、能力算法、执行数据库表 | 拥有 façade、工具等待、输入尝试与最终进程树监管；不改 Run 结论 |
| 运行管理 | 能力导出描述与调用合同、受控玩家、只读观测、资产解析、记录存储端口 | 指定采集/战斗/建筑实现、Uina Subject/UI | 唯一写运行、段、调用、效果与停止记录；组合根注入具体能力 |
| Program 执行域 | ProgramExecutionPort、宿主绑定 API、Executor 受管创建能力 | Bot、Run 表、身体调度和独立进程树监管 | 拥有 guest/桥接/容量及退役；最终进程监管归 Executor |
| 能力/程序宿主绑定 | 当前调用上下文、受控操作、只读观测、明确声明的能力和资产 | 原始 Bot、顶层受理队列、其他模块数据库 | 产生领域进度/核验请求；不得直接改运行 phase |
| 客户端/控制适配 | Mineflayer/插件、控制资格核验合同、事实发布端口 | 具体玩法能力、Uina/Core | 唯一写连接状态、当前协议视图、有效控制资格与实际输入 |
| 观测与世界记录 | 客户端事实、自己的存储、领域记录写入端口 | 自动导航/开箱、运行调度内部 | 唯一写历史空间/容器/过程/工程记录；当前库存仍归客户端 |
| 资产/目录 | 文件包、SQLite 目录/CAS、模块元数据；可信 Program/Evidence 有限导出 | 活 Bot、身体调度、Runtime/World 数据表和另一份运行结论 | Assets 唯一写版本/名称头/副本与可选提交结果；Runtime 只导出固定事实 |
| 执行组合根 | 上述公开合同及其具体实现 | 向模块泄漏组合根容器 | 装配连接、运行管理、能力、执行域与存储；明确原生单例版本 |

读对象是快照或只读视图；跨进程不运输活引用。能力写工程记录须调用工程所有者提供的写入口并附执行/观察引用，不能自己写数据库。运行管理记录调用和证据关联，领域核验由能力实现，不把配方和方块规则搬进运行管理。

<a id="ingress"></a>

## 3. Uina 接入 ↔ 游戏执行侧

### 3.1 最小消息含义

所有跨进程值可按 JSON 编码；函数、Promise、Bot、窗口对象和原生 Error 不跨边界。大整数标识按字符串，时间为带 `Z` 的 UTC；Tick、单调计时与事实序号另列，不能互换。完整错误含稳定 code、领域 progress、引用及派发程度，不只是一句异常文本。

方法与所有返回判别形状见 [ExecutorClient](public-api.md#executor)。lookup/read/list/wait 分别返回 SubmissionLookup、RunSnapshot 或明确分页；领域 value 与错误不会藏在自由 JSON 信封中。调用者取消 wait 只结束等待，不改变运行。

### 3.2 受理的承诺点

1. 接入为一次新的 run/continue/library 动作生成 UUID requestId，在任何 IPC 前持久保存请求及可信归属。执行侧按持久 World 归属与 requestId 去重；临时 activation 不进入去重键。本次传输重试/查询复用该 ID，LLM Schema 不要求自造 ID；返回正文提供系统生成的 request/run 引用。持久化失败则不派发新工作；stop/急停立即发送，不等本地磁盘，可靠受理仍须执行侧持久停止收据。
2. 当前 attachment 有效时，先查已有去重映射并比较原始语义请求。同键同请求直接返回既有运行及最新状态，不重新解析别名/默认策略、检查新任务停止门或消费替换目标；能力下架、目标已结束、常态策略改变也不把既有受理变成拒绝。同键不同意图返回 `REQUEST_CONFLICT`；属性顺序/空格不构成不同，模型后来再次使用“最新版本”也不改变第一次的绑定。
3. 新提交先在事务外准备入口、确切版本/字节/摘要、声明依赖、语法/输入与支持检查，再在 Runtime 单个短事务只提交自己的去重映射、Run/Segment/固定材料、策略、必要替换结论和抢占停止意图。事务内只复核 Runtime 自己的门/装配代次/目标状态，不冻结 Assets head 或 World retain。捕获 @3 后 Assets 发布 @4，仍运行 @3，不承诺提交瞬间最新。事务确认后才启动并进入 RunReply 短窗口；失败不启动新动作，也不因未受理抢占撤销旧控制。原始请求与首次解析结果固定，重试不重算。实际 Driver 资格仍在 acquire/写入核验。
4. 取消发生在确定未派发前，可报告 `not_started`；执行侧已经提交受理后，工具信号只取消等待。IPC 派发后丢失回执且无法核实受理，报告 受理 unknown 和原键，不自动另起运行。
5. lookup 的 `not_found` 是指定存储/归属在查询时没有提交记录。只有原传输已经结束、旧 activation 被隔离且查询命中权威存储时，才可用同一个键重试；普通超时或查错存储不能证明未受理。

上述运行受理事务和 lookup 仅覆盖 submit/continue。library 使用可信归属和 Assets 自己的发布/CAS/可选内容绑定 operation，不生成 Run 或把资产状态写进运行受理表；不对可变工作目录伪造可靠重试。具体保存协议见 §8。当前源码没有现成 Minecraft 请求服务，共享协议/小型代码不等于必须共用物理数据库。

run/continue façade 在受理后的短等待窗口内得到已提交终结/待决策时直接返回真实快照；超时返回 accepted，后台 completion 通知。直接调用、代码和保存程序共用受理，内部 mc.call 不 submit。工具取消仅结束等待；observe/describe 和主动 runs.wait/read 是查询，不自动消耗通知。

工具层 status 针对这次接口合同：受理成功或已登记停止可返回 succeeded，但正文分别是 accepted/stopping；它们不把游戏运行结论设为 succeeded。受理程度不明返回 unknown；确定预取消而未启动返回 not_started。生产者已返回受理事实后，即使调用 signal 已取消，也保留该事实，不改写成“游戏已取消”。

### 3.3 替换、抢占与继续

默认普通就绪段按就绪序号 FIFO；新普通请求不抢占当前身体。替换只作用于明确归属且**整个运行尚未开始**的待执行提交，不能替换已有进度的续段或等待项。没有可信 caller 且没有 targets 时，拒绝 `REPLACE_SCOPE_REQUIRED`，不把 `operationIdentity` 当调用者身份。targets 在受理事务中核验，过期/不符合范围的请求明确失败，不静默扩大或缩小范围。

`preempt_current` 必须给出预期当前 run；受理时不一致则 `CONTROL_OWNER_CHANGED`。Runtime admission 线性化区在事务前只暂缓新的 Driver.acquire，不关闭旧 Call/Body 准入或撤销现有控制。先准备验证，再一并 commit 新受理和指定旧 Run 停止意图；确认后的同一调度续程先递增旧 Run admission generation、封闭/取消旧范围，再让 Driver 撤销并等屏障，新段才获得资格。事务失败不改旧 generation/gate，释放 reservation 后恢复 FIFO grant。提交未知先按原键对账，不提前撤销/执行；提交后撤销前崩溃由恢复先隔离旧控制。reservation 不阻塞独立 stop/emergency，后者仍立即撤销、不等新提交；急停和本地自保门仍优先。已受理优先段后来停止/失败不撤销旧运行已登记的取消。

模型再次普通 run 是新意图，不是原请求的自动重试；相同参数不能用 hash 合并。恢复原请求须引用系统返回的 request/run；若回执随进程丢失，接入从自身持久 pending 请求恢复该引用并先对账。现有 invocationId 不承担持久唯一性。

继续请求含 run、decision、接入生成的 requestId、确切入口或新代码，以及 environment（默认 inherit）。确切新入口/代码本身就是明确换版选择，只有 environment=current 才换原生环境，不再用含义过宽的 rebind 标志。用同一存储事务消费当前 decision 并建立新段；同键同请求返回既有新段，别的请求使用已消费 decision 返回 `DECISION_STALE`。已受理停止或运行已终止时拒绝继续。检查点与入口不兼容在任何新副作用前报错；旧决策不能被半消费。

### 3.4 三种取消与失联

| 信号 | 必须停止什么 | 必须保留什么 |
| --- | --- | --- |
| Action/工具等待 signal | 本次 RPC 等待、查询或回复构造 | 已受理运行；作用域结束另按下行处理 |
| stop | 指定运行的新动作、控制循环及后续身体段 | 已确认工作、在途未知、停止意图；重复 stop 不改写终态 |
| World 停用/Host 关闭/具身 safeStop | 关闭有关动作准入门并停止所属运行；急停门另持久保存 | 原意图、受理记录及未知效果，重新 enable 不自动重跑 |

World `onStart` 绑定独立的生命周期 signal。它一旦取消，接入立即关闭本地准入，并发起持久保存停用意图及执行侧停止；写盘失败不能阻止实际停机。`onStop` 等待结算，不能等到所有长动作工具返回后才首次发停止。作用域合并 signal 无法区分两种取消，必须同时观察这个独立信号。所有工具等待对取消及时结算，避免 `scope.close → 等工具 → onStop` 形成互等。

执行侧只接受当前 attachment/activation 发来的新请求，旧 activation 不能因迟到 IPC 再次准入。同一执行存储只允许一个执行侧写者及一组客户端所有权；启动第二实例必须明确拒绝，不能两边分别发有效资格。

推荐执行侧与拥有者建立有到期时间的存活绑定：短暂 IPC 抖动可继续，绑定失效立即关闭该 owner 的整个动作准入/续段调度并撤销控制，执行侧持久记录 owner_lost。其已受理运行按生命周期取消：从未开始为 not_started，已开始且控制停止为 cancelled，无法确认停止为 unknown，分别保留进度及未知效果；等待复查、queued 续段也不能再取得资格。旧 activation、迟到心跳和自动重连不能解除此门；当前 owner 明确对账解除后只允许新任务，旧终态不复活，可显式引用检查点建立关联的新运行。

期限属于可测量的故障检测配置，不能宣称网络分区时瞬时停止。每次执行侧重启先关闭动作门并恢复记录，完成当前拥有者握手、身份及停用/急停/owner_lost 对账后才准入；停止意图不能只保存在已经崩溃的那一侧。仅失去 Uina 通信不是完成或停止证据，游戏连接中断的恢复策略也不自动解除 owner_lost。

### 3.5 接入既有全局身体控制

Minecraft 通过 `ctx.expose("body.endpoint:" + bodyId, endpoint)` 加入现有具身路由。该端点的 `safeStop()` 立即关闭内存准入并撤销旧资格，同时持久设急停门、停止有关运行并等待控制停止；持久化失败仍继续停机，返回故障及持久性未知，不能只 reject 而让旧动作继续。只有持久意图和控制停止均有据才正常 resolve。`resume()` 只明确解除门并重验连接，不自动解除其他停止门或复活旧运行；想继续工作需显式新段/新运行。

必须实现 `interrupt()`：思考打断只影响本次思考关联的瞬时表现，不停止已受理游戏任务，也不进入 paused。不得依赖当前框架“缺省回退 safeStop”的行为。具身 focus 变化不自动取消 Minecraft。`/reload` 只重载项目扩展，不能当作 Minecraft 运行或 World 代码重载；执行侧显式加载资产版本与此分开。

<a id="delivery"></a>

## 4. 运行记录 ↔ 直返与 World 输入递送

Runtime 在每次段交还或 Run 终结的同一事务写固定 report/record、completionRef 与 pending disposition，结论不随交付渠道复制；每段最多一份 decision、每 Run 最多一份 terminal。待决策时 stop 可另生 terminal 而不改原 decision，显式续段产生新段/报告。ExecutorClient.submit/continue 返回唯一 RunReply 联合：先持久受理，配置短窗口内取得本次提交报告则返回 result（含 completionRef），超时返回 accepted；waitSignal 取消只结束等待，已受理则返回 accepted/当前已知事实，Run 继续。接入同实例串行协调窗口选择和后台 drain，窗口有效时暂缓该 segment 通知，不建跨库 claim/租约。

completionRef 是执行报告引用，不等于 Run 终态凭证。唯一公开联合 CompletionReport 以 reportKind=terminal 对应 snapshot.phase=finished；reportKind=decision 对应 awaiting_decision，仅表示当前段交还。kind=result 也不自动表示整个 Run 成功/终结；消费 decision 后产生新段，待决策时 stop 另生 terminal，旧报告永久保留。

直返前先在 Executor 已有请求记录固定 request/segment/completionRef，再 settleDelivery(tool_handoff)，它只表示选择/准备交工具返回，抑制正常通知，不证明 canonical。桥接完成响应交接后本地关闭请求。恢复只枚举本 owner 未结请求、按原键 lookup 对账；completionRef 必须属于原提交段。input_committed/过时 decision 关闭本地项，pending 走正常 drain；tool_handoff 且 eligible 则用 (requestId, completionRef) 唯一键建立一个持久补报意图，重启续用，按既有 attempt/committed 流程重试，不回退 disposition。无需扫描 Host 会话或历史已关闭请求。一个补报意图仍可因 ACK 丢失重复呈现，绝不重做动作；本地已关闭但最终交接丢失的结果仍可查询，不承诺严格至少一次/恰好一次。标记失败可返已提交快照但通知可能重复；不增 Core tool_result_recorded。

后台 pendingDeliveries 派生 eligible：finished 可投；decision 仅仍未消费且为当前待处理项、未被停止/终结时可投。历史 decision/报告不可变，过时请求不再主动唤醒。emitEvent 前和 deferred render 前复查 readDelivery；过时或状态不可核实时 render=null，前者不再 eligible，后者保留重试；render 不消费 decision/写 ACK。

接入持久保存 attempt inputId→completionRef，正常每项一个活动 attempt。input_settled.committed 后 settleDelivery(input_committed)，只证明 canonical，不证明模型已读。null/retired/missing_render 不作 ACK；失败退避、新 attempt 重试，健康时定时/连接恢复推进。canonical 已写而 ACK 丢失可同引用补报，绝不重发游戏动作。停用暂停递送，记录可查；主动查询不改变 disposition。

render 检查和 Host append 不原子：检查后 continue 消费 decision，旧文仍可能进入 canonical。报告注明确切 decision/记录时事实，continue 消费 CAS 返回 DECISION_STALE 阻止重复行动。不以历史不可变为由主动重投已过时请求，也不宣称完全消除最后展示竞态。完整算法见 [Runtime §13](modules/runtime.md#13-同一-completion短时直返与后台递送)。

<a id="control"></a>

## 5. 运行管理 ↔ 受控玩家 ↔ 原生控制器

### 5.1 资格必须跟着创建动作的来源走

资格内部至少绑定 run/segment 或本地自保介入、body、connection、incarnation 与不可复活的 generation。它是宿主资源，不是脚本可组装的可写 DTO；公开取得/操作/回执只在 [Body/Driver 接口](public-api.md#player) 定义。

资格由驱动侧维护的同一控制边界授予；运行管理决定调度，驱动负责核验谁仍可生效。资格是宿主绑定的不可伪造引用/句柄，脚本不能自己组装字段获得权利。持有一个资格可以协调移动、视角与使用物品；不把这些通道拆成竞争队列。

每个命令、定时器、事件处理器、Promise 后续、插件目标与窗口保留创建资格，实际写入前核验；不为旧回调补当前 owner。Runtime 将独立最外层 Body 申请排同一 FIFO，包括同 Segment 的兄弟 Call；只有选中项进入 Driver.acquire。scope.call/body.call 明确委托复用。持 Body 谱系捕获外部入口重新独立申请时局部 CONTROL_CONFLICT、可 catch；普通同时申请不退役 Segment。不建任意 Promise 等待图，持 Body 不得 join 无关的独立身体工作。

同一 Body 内不同操作也有不可复活的 Operation 代次；Controller 是长期 Operation 的角色，不额外维护一层总是一起变化的代次。写入还须核验宿主绑定的当前调用身份、access 及所属调用作用域，捕获父 act 的 player 不能在 read 子调用升级权限。窗口会话 Operation 跨越 open 返回和多次 click；click 是短子操作，不因其完成而退役整个窗口。

统一的是写入权威，不是输入形式：连续控制、一次性输入和长状态机分别适配。完整原生插件可受控独占运行，也可复用算法参与组合；独占不要求控制计算逐 Tick 变成建议。组合的依赖、临时排他和顺序由算法所有者的普通代码表达，Driver 不推断通用资源优先级。共享 Body 或嵌套调用本身不等于已协调，未经当前协调者委托的重叠写入仍报冲突。

协调来源落实为 withBody 提供的同一 scope/player 及其被许可的 scope.call 子调用。兼容子操作可在连续控制仍存活时执行，不以全局串行或默认关闭反馈流换取正确性；省略输入只撤销所属资源，不清别的合法子操作。真实冲突由协调者安排，Adapter 以局部代码检查实际行为；不引入通道锁/队列。dig 的 preserve 瞄准选项等确切形状只在 public-api 维护。

Runtime 通过宿主绑定提供实际当前调用及父约束、access、存活和委托关系；Driver 不能从旧 Permit 推断权限。代理入口不得先恢复创建 act 再验证，原生回调保留自己的真实 Operation 来源，Program IPC 由可信桥接解析宿主登记的调用帧，不接受业务消息自报权限。具体实现可用异步上下文或等价机制，但须验证捕获 act 代理在 read 子调用失败及域外事件/迟到 IPC 的归属。

写入边界包括按键、视角、装备/副手、挖掘/攻击/使用、窗口/槽位、插件目标与配置，以及插件直接修改的本地 position/velocity。连接维护、协议确认与必要客户端物理仍继续，但不能借此绕过身体所有权产生业务动作。资格绑定到插件的适配调用及回调；不能把共享原始 Bot 长期交给多个插件主人。

### 5.2 停止与交接屏障

收到停止立即关闭有关内存准入、撤销资格并开始清理，同时持久写意图；停机不能等待磁盘成功。只有意图落盘后才确认“可靠受理”，持久化失败/卡住也继续实际停止，返回已知控制事实和持久性故障，不承诺该意图可跨重启恢复。重复停止读取/补齐同一意图，不改原终态；停止处理中不能提前报告 `control: stopped`。

只有下列条件成立才交接：旧动作源不可再生效；已派发到本地队列的命令已处理或被拒绝；持续输入撤销；所属插件、订阅和窗口已停止/退役；已跨外部边界的效果取得回执或登记未知。未知世界效果不要求伪造取消回滚，也不妨碍已经证明旧输入失效的交接。

撤销后必要的中性化/关闭由驱动持有的清理句柄执行，只可清理旧段自己的状态；普通旧资格不能再发动作。窗口关闭、按键释放和插件停止全部比较旧资源代次。全局 `clearControlStates`、`setGoal(null)`、`removeAllListeners` 等不能迟到后作用于新主人。插件 stop resolve 只是一个输入，不能代替整个屏障。

中性化只描述撤销控制，不保证零游戏效果：释放蓄力物品、强制关窗或插件修正均可能产生实际后果，必须关联清理派发与未知。普通窗口 close 的非空光标前置条件不能阻止作用域退出/停机时的强制退役；清理不擅自添加丢弃/搬槽以制造“干净成功”。

无法证明插件已被隔离时不交接；可断开/终止该客户端实例以建立隔离，然后新连接与资格重新建立。清理失败保留具体 unknown/fault，不能无限报告正在正常执行。`stopped` 只表示旧控制不再产生输入/动作，不保证服务器已派发的位移、击退、重力或投射物停止。

Driver/Executor 整个事件循环阻塞时，域外终止责任由 Uina 侧 Minecraft World 的受管进程启动/生命周期代码承担，持有精确进程句柄与启动代次；不是依赖堵塞进程的 stop/finally。先关本地准入并隔离 attachment，终止所有持有控制写通道的所属执行域，确认匹配的 exit/进程树退役后才允许新连接；kill 请求已发送不等于完成。监督方退出所需的 OS 生命周期绑定也归该启动者；无终止/退役证明则保持故障、禁止自动接管。退出事实不结清服务器已收效果，恢复仍保留 unknown；不增加通用 Supervisor 服务或新的 Executor 公共方法。

### 5.3 生成程序及反馈

客户端心跳、控制核验、停止处理、必要自保在驱动执行域；生成程序和反馈函数在可独立终止的域。桥接只传快照、调用及带资格的输出；不跨 Uina 传逐 Tick 函数，不暴露 Bot。宿主中的大查询、寻路计算也不能阻塞驱动关键路径。

自保若由当前复合控制器统一协调，沿用其资格；独立紧急控制器先使旧资格失效并经过相同停止屏障，再取得 kind=safety 的新资格。介入事件/效果关联被中断运行，不建立第二套任务队列；原能力有明确恢复点才可重新观察并排队，否则退役旧段并交还主脑。驱动里的自保没有旁路，急停/owner_lost/World 停用门均禁止它取得新资格。

反馈帧包含 connection、incarnation、body、流/Operation、单调序号、已完成客户端物理步、采样时刻和必要字段组的来源/有效性。反馈回调顺序执行，一个在算帧加一个保留最新状态的待交付槽；新采样不立即废掉仍有效的在算帧。输出绑定所属流和已交付帧，重复消费、过期、乱序、失效或退役均拒绝，不能补播。字段与返回只在 [public-api §4](public-api.md#player) 定义。

实际时序为观察第 N 步结果、异步计算、在仍有效的后续 M>N 步模拟前安装并由该步消费。apply 正常返回必须有 appliedStep，不只确认接收入队；资格与有效期在准入和真实安装边界都核验。不能以模拟后 physicsTick 的监听顺序冒充模拟前接缝。drive 按实际消费步计数，完成指定步数后、下一模拟前撤销本次持续输出；定长 drive 不依赖脚本逐帧续命。反馈输入则有明确有效期，未及时更新时由驱动撤销并记录故障。预算依据实际控制测试配置，不伪造普适毫秒数。

强制终止前先撤销资格；Driver 清理不依赖 guest finally。Program 负责 guest 执行/退役，经 Executor 受管创建能力接入同一进程树；Executor 唯一持最终监管与退出证明，Runtime 只消费事实。QuickJS WASM+活动 Segment 子进程为优先原型，独立/受限/可终止是合同；引擎/平台算法不在 Runtime 重复规定，见 [Runtime §9](modules/runtime.md#9-program-执行合同与资源准入)。

### 5.4 世界等待与复查

身体内定长输入/短等待保持资格；世界 wait 只检查当前 Call 谱系未持有/借用 Body，否则 BODY_SCOPE_ACTIVE，先退出自己的 withBody。无关兄弟有身体/排队不拒绝本 wait。被动 read→evaluate→对各独立 query/cursor 分别 watch；任一 changed/reset 或定义 afterMs 到期后重读，时间不是成功证据。单个联合 query 若含混合依赖，仍须由 World 自己维护 opaque cursor；World 不支持时明确拒绝。多个独立 Watch 不合并为联合 cursor/快照，Runtime 不比较或拼接异量纲水位。

条件若必须开窗口、移动或探索才能观察，登记可序列化的**复查意图**：能力引用、参数、有关世界/目标、检查点、重新检查时机。到时以新的就绪序号参与身体调度，取得新资格后主动复查；当前普通行为不被定时器打断。熔炉估计完成、区块卸载或别的玩家改变槽位，只影响何时复查和事实缺口，不提供产出证明。

await mc.wait 保留闭包与活动 guest/容量，无默认期限；有限容量由 Program FIFO 准入，同段嵌套不再占第二域，持 Body 不能排 guest 容量队列。全部域长期等待可使新 Program 无限 queued；Program 是容量事实唯一所有者，ExecutorClient.programCapacity/runs.program_capacity 提供带 observedAt 的总量和 owner 可见 Segment/时间，关联 Run/Call 提供具体等待条件，不建第二份资源账本。停止、取消、查询及纯 native 入口不排容量队列；主脑显式干预，不自动换出正常 guest。明确 decide/checkpoint 结束段并释放 guest，新段不恢复旧闭包。重启只恢复条件/检查点记录并交还，不自动复查/重放。旧域退役不明保持故障；从未开始为 not_started，已开始无可用检查点为 unknown。

Program 的自由等待不以领域注册或组合查询为前提：`mc.read(query)` 返回固定 Observation 和该 query 的 World cursor；`mc.waitForChange([{query,after}, ...], {afterMs?})` 要求非空列表，并为每项独立创建 WorldWatch，任一 changed/reset 或本地 timeout 即结束本次等待并关闭其余 Watch。普通 JS 可读取多个独立事实、组合判断并在任一依赖变化后重读，不新增领域 Callable、WaitConditionDef、组合 QueryDescriptor、Runtime 状态机或 DSL。World 拥有各 cursor/依赖和不漏失效，并核验 cursor 与 query 身份/作用域/来源代次匹配；Runtime 拥有取消、BodyScope 检查及全部 Watch/计时器清理。单项 Watch 建立失败则整体失败并清理已建项。独立 read/watch 不构成联合快照；只有业务确需同一一致性切面时，才由 World 提供显式联合查询。底层事实本身不存在时仍须由其所有者补足，不能靠运行时代码编造证据或 cursor。

等待取消属于正在等待的 Call，不等于工具等待取消或停止 Run；Body 谱系持有资格时返回 BODY_SCOPE_ACTIVE，兄弟的身体活动不阻止它。timeout 不升级 observation freshness，也不是世界变化；循环必须重新 read 后重新判断。query 与 cursor 不匹配、来源 reset、Watch 不可用均沿 World 既有错误/变化合同返回，Runtime 不维护 cursor Registry。

<a id="effects"></a>

## 6. 能力/程序 ↔ 执行记录与结果

### 6.1 成功的 `await` 返回领域值

每个可调用导出有不可变 `contractRef`，声明输入/输出、完成范围、错误、支持条件与验证方法。内部调用不返顶层工具信封。宿主自动记录调用父子关系、确切版本、实际派发、进度及证据；程序不能删除这些记录。

| 返回/错误 | 能力调用的含义 | 对外层执行的影响 |
| --- | --- | --- |
| 领域值 | 满足该能力已声明的完成合同 | 可用于后续组合，不推断更大意图 |
| `TARGET_NOT_MET` | 目标不足且进度有依据，带已完成量和原因 | 可捕获并换方法；该子调用仍未达标 |
| `UNSUPPORTED/PRECONDITION` | 不支持或条件不满足，明确派发程度 | 已发生的效果不消失，不同错误不能一律当零效果 |
| `EFFECT_UNCERTAIN` | 有相关派发且完成要求尚不能确认，带效果引用 | 可捕获以核验/改策，不能进入盲目自动重试 |
| 取消/资格或连接失效 | 段已不能继续使用旧身体 | catch 不恢复资格，必要清理由宿主完成 |

### 6.2 用完成证据要求取代模糊的“关键效果”

操作/能力合同在派发前声明自己承诺什么，由宿主建立完成证据要求。例如转移 8 个物品需要有关槽位与数量变化，采集需要实际入包，放置需要目标格及要求的状态；一次攻击输入只承诺攻击尝试被执行，不承诺击杀。适配层记录原始派发及预测/服务端事实，领域核验方法把这些事实与特定要求关联，运行管理只保存判定及来源。

这些要求不是脚本可写的 `critical: false`。捕获异常、换一段代码、改返回值或生成断言都不能豁免原要求。相关能力的核验方法可以依据新证据追加 `met/not_met/unknown`；当前状态达到目标不足以证明历史交易发生过，因果不可知时仍 unknown。已确认目标不足属于已结算失败，可以由外层替代路径处理；未确认消费/交易不能如此清账。

临时代码默认只声明“执行程序”的合同。若调用方需要判断组合游戏目标，可在受理时绑定明确的能力核验入口及参数；保存模块也可以声明此入口，公开来源/版本与适用性。普通 JS 查询和断言仍可自由使用，但 `assert(true)` 和 `return {completed:true}` 都不会自动获得对用户目标的认证。模型如何定义开放目标仍归主脑，不创建通用目标 DSL 或隐藏 Critic。

低层 attempt 接口可在尝试本身确认后成功，正文明确完成范围和可知后果；不能把交易/库存转移的未确认操作改走“attempt”逃避其完成证据要求。若确有只派发用途，导出须明确不同的合同，后续核验责任与未解决效果仍保留。

### 6.3 通用结算顺序

局部关闭先后：关闭范围准入 → 取消/等待已登记子 Call/宿主操作 → Driver 完成所属控制/清理屏障（可得清理事实先入 sink）→ 登记只读完成核验。普通子 Call 按已收到的固定材料结算，将完成截面有序入队后可返回/抛错，不逐 Call 等待写盘，不终结父 Run、不释放借用的祖先 Body。根 Segment 另确认 Program guest 退役，待所有后代材料及完成截面入队 → 固定 Runtime 已接收上界 H → writer.flushThrough(H) → 按固定截面结算根已知/未知 → 事务提交阶段/根终结+completion → 才允许交付。Body 交接可先于写盘，Run 对外终结不能越过记录屏障。

发布精确持久 record 的读取/导出端口另等对应材料提交后才返回稳定引用；普通 mc.call 的领域值不隐含该保证。没有现成消费者要求逐 Call durable，不新增默认同步持久模式。

ExecutionSink 非阻塞入队不是持久 ACK。flush 只保证已接收 ≤H 材料已提交或明确失败，不确认未来服务端包，不补丢失尾部；失败不输出假 durable finished，实际停止继续。晚到证据追加原 Effect 核验，不改原 completion 的 unknown、取消原因和历史结论；readEffect 另给最新判断。普通 helper/微任务/每 Tick 不生成持久事件。

运行记录分开保存 `execution`（返回/抛错/中断）、`goal`（未声明/满足/未满足/未知，带合同范围）、`effects`（逐项来源与完成要求）。对 Uina 的五态只是本次合同的结论，不能覆盖这三组事实。

1. 整个运行从未开始执行：`not_started`；不能把已有工作的 queued 续段当未开始。
2. 已确认因取消结束且控制停止：`cancelled`；保留未知效果。停止仍在进行先保留非终态；永久无法确认则按已知边界结算 unknown 并公开故障。
3. 未处理程序错误或入口要求确定不满足：`failed`；仍可有未知副作用。
4. 正常返回，但控制清理、入口要求或某项必需完成证据尚未知：`unknown`，即使 goal 现在满足。
5. 本次声明合同满足且必要清理有据：`succeeded`，明确 scope 是程序执行、某项能力还是特定游戏目标。

子调用已知失败经 catch 处理不永久毒化父程序；它的原结果和进度仍公开。没有外层目标时，程序正常返回只能得到 scope=execution，不把捕获的失败包装成原目标成功。`mc.decision` 是退役当前段的控制转移：保存检查点、失效资格、完成清理后进入 awaiting_decision；不是以上终态，也不是可忽略普通值。

| 反例 | 必须得到的结果 |
| --- | --- |
| 橡木已入包 19 但不足，改采桦木 13，外层原木目标有据满足 | 外层可成功，原橡木调用仍失败，数量按各调用真实增量计算 |
| 捕获木材不足直接 return completed | 程序可正常结束；原采集目标没有成功证据 |
| 交易回执未知，别人给了目标物品 | 可确认当前持有目标，交易/消费仍 unknown，不自动重发 |
| 交易未知后又发生未处理错误 | failed 与 unknownEffects 并存 |
| 本次取消已停止但最后一次点击结果未知 | cancelled + control=stopped + 有关 unknownEffects |
| 本地预测挖空/实体消失后正常 return | 不据此证明服务端接受、入包或击杀 |

<a id="observations"></a>

## 7. 观测与世界记录 ↔ 执行

### 7.1 事实与可写引用

| 数据 | 必需绑定与失效规则 |
| --- | --- |
| 持久世界 | `worldId + worldRevision`；服务器地址只是连接位置，不是世界身份 |
| 空间对象 | 世界、维度、坐标种类；整数 block 与连续 position 分开；未知维度不填默认值 |
| 实时事实 | connection、incarnation、事实序号、观察 UTC/单调时间、来源与覆盖范围 |
| 实体句柄 | connection、维度/身体代次、网络 ID 和本次出现代次；UUID/历史位置只用于重新定位 |
| 窗口/槽位 | connection、窗口本次打开代次、槽位视图版本和预期物品条件；不能只凭网络 windowId |
| 历史容器/地图 | 世界、维度、目标和最后观察时间/来源；历史记录不产生可写资格 |

客户端可能无法自动确定服务器是否换了存档。使用明确世界绑定与可靠证据；地址、出生点或局部地形不证明存档身份/重置，不开发复杂指纹识别。身份未知时创建显式未绑定分区，不自动合并旧地图；发现冲突要求明确重绑/新世界代次。普通重连、跨维度或玩家修改不新建 worldRevision。重绑退役旧 binding/活引用，在途证据按原分区接收，不按接收时当前世界改标签。协议可知与当前可见分别标记，预测不能标服务端事实。

混合当前状态按必要字段组保留来源、真实观察时间和证据，外层采样时间不刷新旧来源。Unknown 是覆盖/知识缺口，不是协议来源。Driver 在协议入包与本地预测写入处保留来源，不能仅从共享 blockUpdate/updateSlot 事件反推；区块对象存在或光照到达不证明方块已知。服务端同值更新、来源升级及覆盖失效也属于观察变化。

连线变化、死亡/重生、跨维度、实体重现和窗口重开由客户端更新相应代次，写入处校验；不是只在工具入口校验一次。不能把“对象不在当前视图”当死亡，把未知格当空气，或把没打开过的箱子当空箱。物品选择包含组件/附魔/耐久条件，精确选择失败不静默换物。

### 7.2 查询、订阅、写记录

`observe/read` 只查询已有视图，响应含覆盖、未知项和新鲜度；缺信息时返回可行动的缺口。移动/开箱等主动感知由能力执行，不能藏在 read 中。订阅先更新当前视图再发布版本变化；快照与订阅可用同一事实序号复查，不能要求消费者自己凑另一份实时库存。

客户端事实入口由 Driver 拥有，唯一方法见 [ClientFactsPort](public-api.md#client-facts)：宿主内同步采样固定当前纯值、scope、Driver 水位和选定证据头；订阅原子登记。World 先订阅后采样/复查，不将合并通知当事件日志。Driver 在原始事实失效前捕获不可变证据；captured、sent、World received、SQLite durable 分别成立，跨线程/进程不能推断同步原子提交。证据按源身份/选定序号去重；durable ACK 是唯一确认层，只覆盖已证明持久（载荷或已持久缺口覆盖）的连续前缀；缺口必须显式保留，reset 不补回事实。Driver 水位、源证据序号、查询游标、物理步与反馈序号互不替代。

默认 Driver 与 World 轻量接收同域，共享一份不可变捕获/待落盘材料并按提交回收，不模拟跨域双份 outbox/传输重发；SQLite 历史在专用存储 Worker 线程（有序提交/原子读取/崩溃显式降级），不占用游戏事件循环。跨域纯当前读使用轻量有序当前检查点，按 stamp 纳入失效后固定样本/cursor，不等待历史大载荷/持久 ACK；纯历史不请求 Driver。只有联合查询声明需包含截至当前样本的历史前缀时，才用证据 fence 与相关非 Driver 版本/绑定/时间核验；前缀等待不得占住普通当前读。独立 RPC 到达不证明共同原子切面。查询与反馈复用纯采样；区域查询才固定请求 Section，历史与区域读共享必要基底，不为所有当前预测保留长期版本链，不跨 Tick 拼扫称同点。Driver 不调用 World 数据库，World 不复制可写当前库存。

> **实现状态（2026-10-17 架构重构）**：当前实现与 Driver 同进程——ACK 已收敛为 durable-only（received 层/重传/outbox 已删除，无消费者不保留）；历史读取为提交屏障 + 读取视图版本作 cursor；SQLite 在专用 Worker 线程（WAL + synchronous=FULL 显式设定并如实报告）；fence/Section 版本链未建立且无消费者不预建。三轮补充：createWorld 交付句柄不等 SQLite（当前基线先行，历史独立 opening → ready/unavailable，status 如实报告）；存储入库前核验身份（同 (stream,seq) 同载荷、同 gap ref 同区间），冲突按源协议故障结算不冒认持久。逐节见 world.md。

World 切面只固定本查询实际依赖的值/版本/有关 cursor，不新增普通/严格模式。纯当前同步采样，不读 DB、不等历史；纯历史走提交屏障（先等已接收上界持久化，再在同一读取边界取得数据与提交版本，cursor 即该版本），不采 Driver、不默认追平源头、不静默遗漏查询开始前已接收的证据，也不把已读到的提交再次通知；联合查询固定所需两侧并如实表达各自进度。持久缺口不是完整源历史。相关绑定变化使在算 read 失效，显式旧历史可整份返回；分页固定同版本。World 维护当前/历史/领域/时间的失效水位，但每条 Watch 只用实际依赖。当前 Watch 登记后核对当前检查点，不等历史证据；纯历史仅本地比较/登记。潜在新对象区域也在依赖内。Watch 不保存完整事件、不操作游戏。细算法归 [World 详细设计](modules/world.md#snapshot)。

当前检查点 stamp 已推进、空间范围却尚未收到时，World 不能只查旧空间索引。每当前源维护连续已分类或已保守覆盖水位 C；看到 H>C 且不能证明范围完整，先对该当前源依赖一次全源保守失效，再推进 C。不能把 MAX(收到范围stamp) 当连续覆盖；同 H 不重复自激，新 read 真实采样 H 并纳入保守水位后固定 cursor，迟到范围只细化。这个规则不访问 DB/F，也不唤醒无当前依赖的纯历史 Watch。

有历史观察的 Observation 携带按源的 history 进度，区分固定接收前缀、同当前 S 的比较目标与 caught_up/behind/gapped/unknown；未知/异源不比较，ACK含 gap 不能因数字大而称追平。caught_up 仅指至少接收到目标前缀，不表示持久、历史值仍是当前或本次动作因果。纯当前省略，普通联合不为填进度等待历史；后续 ACK 不改写旧结果。

事实所有者按明确采集范围保存有价值观察，不默认逐 Tick 落盘；地形采用 Section 基底/必要变化，容器完整观察与有意义更新，实体出现/消失/关键事件，聊天/事故按实际价值保留。领域记录统一绑定 world/worldRevision，空间规则由领域 schema 强制。Record CAS 只保护同记录修订；基于旧证据的判断可保存，新原始观察不可被覆盖，当前有效性由领域查询解释，不扩成通用观察事务。客户端检查与写入不是服务端事务；多人竞争及未知按实际回执保存。

SQLite 是 World 权威历史，索引派生。持久 DomainRecord 自动保护其本地证据及依赖；Runtime 等实际持有强引用的外部记录所有者先通过 WorldEvidencePort retain（证据和保留关系已持久），再发布强引用，引用持久移除后才 release。普通弱溯源不进入该承诺。跨库中断宁可孤立保留，清理不能破坏运行证据、领域修订、活动快照或 Section 基底；不扫描 Subject 全会话猜引用。未封口源/未持久尾部在崩溃后保留未知或 gap，不把数据库可读推断为当前同步。

SQLite 的启动/核验不作为当前接入的前置门。world.status@1 在同一个 World 内分别报告 current/history/binding；存储 opening/损坏/无法打开时，Driver 就绪仍可当前读/Watch，持久身份只用可信运行期绑定，否则显式 unbound，不凭地址恢复旧地图。历史默认 STORE_UNAVAILABLE，只有可独立核验且查询声明的范围才 partial；writeRecord/retain 无法持久提交就拒绝，不发 durable ACK。恢复先核验归属/连续性，不能自动认领 unbound 历史；只重置实际受影响历史资源，Driver/binding未变不重置当前 Watch，也不绕过 Runtime 的持久受理门。

状态投影纯读当前短绝对摘要；不推进模型阅读游标。事件是复查/决策机会，目标状态在实际使用时再验证。只读规划明确其所用观察，不保证动态世界最终执行成功。

<a id="assets"></a>

## 8. 资产/目录 ↔ 执行

### 8.1 发布、编辑与独立事实

Assets 采用 SQLite 目录/CAS + 不可变普通文件包。现有文件工具/编辑器拥有可变工作文件；明确 publish 才产生 Revision。数据库拥有 name/head/version 与可选 operation 提交结果，包 Manifest/源码字节是内容权威。文件安装和数据库发布不伪装原子；崩溃可留下不可见孤儿对象，不建设资产 pending/capture 工作流。

ReadLibrary/WriteLibrary、PublishRequest、ProgramManifest、ProgramSourcePort 和 EvidenceExportPort 的唯一具体定义按 [public-api §6.3](public-api.md#63-文件包library-与可信来源导出) 链接的 Assets 所有者合同。Runtime 不另存资产发布结果，不把 Assets 操作 submit 成游戏 Run。可选 operation 绑定完整固定内容身份，只与正式发布同事务保存结果；来源可变或提交不明时报告 unknown，不盲重试。

### 8.2 固定版本、源码与运行导出

顶层名称首次受理解析为确切 ref。Program 只保存 async 函数体、descriptor、显式 Program 资产依赖与可选闭合 bindings；原生 ref 不是资产依赖。子程序独立解析自己的声明。本段 nativeEnvironment 与实际入口/调用版本固定，动态确切引用在自身调用前核验；旧原生环境不可用明确失败，不假冒新版本。

Runtime 从 readPayload 完整捕获并验证字节后编译同一份内容，不能校验路径后再 import 文件。publishFromRun 必须指定 run/segment/不可变 record，由 ProgramSourcePort 导出实际源码/Manifest/入口 effectiveBindings 或冻结原生 descriptor。原生段生成只调用确切 ref 的函数体包装，dependencies=[]、bindings=[]；不复制 input/checkpoint/value 或整段历史。流生命周期只持有本次读取 pin，不建立持久 owner C/O、capture claim 或跨库 retain/release。

继续时明确确切入口/新代码，environment 默认 inherit；检查点 schema 与原目标兼容且 decision 未消费才能提交新段。旧运行事实不被改写。换版不能静默降低原目标，若是新目标则新建关联 Run。

### 8.3 Blueprint、工程与经验

Raw Blueprint 保留原始字节；Target 的 set/clear/preserve/unknown 由 Construction 领域 Schema 解释，原件不因 decoder 不可用而失去导出能力。已知 air 的处理需明确 set_air/preserve，来源未知的格不能变成 clear。现场 Plan/Project 拥有世界/维度/落点与进度，不回写蓝图；迁址新建关联工程，改版按新现场差异重算，不用旧完成数冒充新目标完成。

Experience 的判断/适用条件/解释发生变化才新 Revision。新增 Evidence 只关联材料，不自动改变 stance、support 或内容摘要；不能把一次执行 succeeded 升级为普遍可靠。

### 8.4 可信 Evidence 与保留

普通 sourceLinks 是可失效的作者出处。attachEvidence 只能选择确切 sourceRef 与 link/copy 意图，不能接受模型提供的“可信事实”或 Principal。宿主按真实归属路由到 Runtime/World 导出端口；来源端核验访问与不可变修订，给出原时间、prediction、unknown、coverage 与完整程度。

Assets 拥有已完整安装的副本；它不成为当前世界或运行结论的可写权威。link 可失效，copy 必须诚实标 self_contained/partial，不能把未读完流注册成完整证据。不为发布资产反向保留整段 Runtime/World，也不要求 Experience 的作者 support 自动成为跨库强边。Runtime 自己若需发布强 World 引用，仍按 WorldEvidencePort 承担自己记录的保留责任。

几何转换、解析、分析与施工属于相应领域 Callable，不属于仓库和 Runtime。可重建缓存按确切源/解释器/参数失效；未来领域持久分析不新增第四种通用资产或学习调度器。

<a id="flows"></a>

## 9. 两条完整协作流程

### 9.1 采集、回执丢失与停止

| 步骤 | 调用/事实 | 所有者与结果 |
| --- | --- | --- |
| 1 | 主脑调用 collect(额外 32)，接入持久生成 request=q17 | 接入绑定 World/activation；执行事务建 r17/s1 与入口完成合同 |
| 2 | 受理已提交，IPC 回执丢失 | 游戏可以开始；工具报告受理未知并保留原键，不生成新请求 ID |
| 3 | 按系统返回/持久 pending 中的 q17 查询 | 返回同 r17；重试同键不重复采集 |
| 4 | s1 取得 b1，内部导航/采集共用资格 | 驱动核验；入包 19 是实际增量，不是挖掘调用次数 |
| 5 | 思考取消 | RPC 等待结束；r17 继续，不触发 safeStop |
| 6 | 明确 stop(r17, stop-4) | 持久停止意图、撤销 b1，先返 stopping；末次点击已发但未知 |
| 7 | 旧 equip 后续迟到，企图挖掘 | 仍持 b1，写入处拒绝；旧清理不能清新主人输入 |
| 8 | 屏障完成，执行侧结算 | finished/cancelled、control=stopped、collected=19、unknownEffects=[eLast] |
| 9 | 超过原工具窗口，终态经 World 输入 | 同 completionRef；input_settled.committed 后确认；窗口内完成则直返，故障重复不重放游戏 |
| 10 | 停止受理后执行侧崩溃/重启 | 先恢复停止意图与未知，r17 不自动续跑；终态交付不确定可同引用补报 |

完成采集走正常核验/清理路径，不走停止路径；直接返回 succeeded 只确认 collect 合同满足。独立对话、普通查询与结果递送都不取得身体。

### 9.2 熔炼等待、身体复用、缺料与换版继续

| 步骤 | 调用/事实 | 身体、状态与下一责任人 |
| --- | --- | --- |
| 1 | A 的 s1 开炉、投料并核验变化 | A/b1；未知投料不直接自动重投 |
| 2 | 关闭本次窗口，停止所属输入/插件；登记复查条件与检查点 | 屏障后 A=waiting，无身体；炉内进度不假装持续可见 |
| 3 | B 开始收割 | B/b2；A 估计到期只能让复查就绪，不能抢占 B |
| 4 | A 的复查到期或有可用事实变化 | A 按新就绪序号排队；取得 b3 后重验连接/地点、重开新窗口读槽位 |
| 5 | 燃料不足且没有委托补料 | A 保存格式化检查点；退役 s1、释放 b3，进入 awaiting_decision/d1 |
| 6 | 主脑可另建补料运行 C | A 不保留 JS 栈或身体名次，C 正常排队 |
| 7 | 主脑向 A/d1 提交确切入口/新代码的 s2；默认继承原生环境 | 原子消费 d1；换版先验证检查点/入口目标兼容，不把旧执行证据改写 |
| 8 | s2 重新观察炉内和背包，补燃料/取产物 | 新资格与窗口；数量基于实际观察，不依据墙钟或旧槽位 |
| 9 | 最终合同满足并完成清理 | A 终态；累计投入/取回历史保留，当前目标按其合同判断 |

若步骤 2 后进程重启：不恢复旧 await，检查点记录交还主脑；显式 continue 才建新段，不能自动复查。若已经受理停止/急停，则不创建可执行复查段。若身份不明、区块不可观察或物资被其他玩家取走，分别报告缺口与新事实。

<a id="verification"></a>

## 10. 可证伪的检验边界

| 合同检查 | 必须证明什么 | 本文没有证明什么 |
| --- | --- | --- |
| 受理事务每个交界处断 IPC/kill | 同键不重复受理；不确定受理不自动新提交；停止意图优先 | 游戏动作恰好一次 |
| 原生回调跨停止/交接迟到 | 旧输出/清理不影响新主人，物理直接写入也在覆盖面 | 某个插件 stop Promise 足够 |
| while(true)、微任务死循环、阻塞宿主查询 | 心跳和停止路径可用；终止后无旧输出，输入不无限保持 | 特定 Worker/引擎已经适用 |
| 直返交接、输入/canonical/ACK 交界失败及 decision 消费竞争 | 正常短任务无额外唤醒；过滤过时请求；故障重复/缺口明确，同引用不重启游戏 | 工具交接已 canonical、绝无过时呈现、跨日志恰好一次 |
| 关炉后等待、区块卸载、他人取物 | 被动/主动复查区别正确，重新排身体和读现实 | 等时长就等于熔炼完成 |
| 捕获失败/未知、替代路径、取消 | 上节三组事实及五态不被 return 洗掉 | 任意生成断言等价用户意图 |
| 确切版本组合、动态调用缺失、原生环境不可用、检查点换版 | 不漂移或假冒旧版；缺失在相应调用前暴露 | 任意动态 JS 可完整静态预检 |
| 同连接实体/窗口 ID 重用、重生/跨维度 | 旧活句柄失效，历史身份可重新定位 | 服务器总能提供可信持久世界 ID |
| 部分扫描导出、蓝图旋转、迁址/改版 | unknown 不变 clear，状态转换正确，工程不混现场/目标 | 全原版方块状态转换已实现 |

本次只核查当前源码、上游机制文档和设计一致性；Driver/World 有静态可见实现，但 Runtime 未实现，Assets 当前有代码且本轮未验收，未运行真实服务端、Provider 或游玩实验。合同草案中的执行隔离、协议证据、停止屏障、检查点恢复和建筑转换都仍需在各自边界验证。完整游玩场景与质量/成本指标沿用 [研究记录 §6](research.md#validation)，不以文档/类型检查替代。
