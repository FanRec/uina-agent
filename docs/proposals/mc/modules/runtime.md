# Runtime / Callable 详细设计

日期：2026-10-17（Asia/Shanghai / GMT+08:00）。状态：**统一终态设计；本次不实施代码**。设计合同、源码实现、替身验证和真实 Minecraft 验收分别表述，不互相替代。

公共类型与错误只在 [public-api.md](../public-api.md) 定义，跨模块行为见 [contracts.md](../contracts.md)，目标见 [design.md](../design.md)，研究证据见 [research.md](../research.md)。本文负责 Runtime 的执行语义与内部算法。Program 引擎、桥接与容量算法由 Program 所有者负责；Executor 平台实现由其所有者负责，不在这里形成第二份规范。

## 1. 问题、范围与不变量

Runtime 只解决三件事：**执行归属、调用组合、身体仲裁**。一个已受理游戏意图独立于主脑的一轮思考持续存在；原生能力与普通 JavaScript 使用相同调用语义；一个 Minecraft 玩家身体在多个运行之间有确定的取得、停止与交接边界。

Run、Call、Body 是三组内部职责，不要求三个服务、Manager 或独立状态机。Segment 区分换代码/交还前后的执行材料，Effect 区分程序返回与真实派发。目录、存储和记录屏障只服务这些事实。

### 1.1 范围与非目标

支持直接能力、临时代码、保存程序、普通并发组合、连续控制、世界等待、检查点交还、显式续段、自保介入、取消、查询与故障恢复。Runtime 不设计采集/战斗/施工算法，不复制当前库存，不拥有资产名称头，不提供 shell/npm/文件/网络脚本环境，不建设第二个 Agent、工作流语言、通用锁图、权限产品或跨库存储事务。

### 1.2 关键不变量

1. Runtime 提交受理事实前，新 Run 不产生游戏动作。同一可信 owner/requestId 只对应一次受理或确定拒绝。
2. 一个客户端最多一个有效 Body。Runtime 选择就绪申请，任一时刻最多一个 Driver.acquire 在途；Driver 唯一授予资格并强制物理失效和资源交接。
3. 同一 Segment 的独立 Call 可以同时等待身体；共享 Run 不等于共享 Body。只有明确委托的调用谱系复用资格。
4. 实际写入检查真实当前 Call、read/act 交集、作用域、委托和代次；旧代理、旧回调及旧执行域永久失效。
5. 关闭先封闭动作准入并处理控制，再等待记录。数据库故障不阻止停止，但不能在记录未提交时声称持久终结。
6. Run 终结必须在已收到的所属派发/回执材料提交屏障之后；记录屏障不等于服务端效果确认。
7. completionRef 引用一次不可变执行报告：terminal 表示 Run 已 finished，decision 表示执行段已交还而 Run 尚未终结。工具直返与后台输入使用同一报告，不追求跨 Runtime DB、Uina journal 和事件的恰好一次呈现。
8. decision 的历史事实与当前是否待处理分开。已消费 decision 不再主动作为新请求投递；最后跨 Host 竞态仍显式承认。
9. 重启恢复记录、门和可解释检查点，不恢复 JS 栈、Promise、Body 或自动重放未知副作用。
10. 只记录公共 Callable、有关 Operation/Effect 和执行边界；普通 helper、每次微任务和每 Tick 不自动成为持久业务事件。

## 2. 证据与本轮需要补齐的接缝

以下是源码范围内事实，不是端到端运行证明：

| 边界 | 已确认事实 | 实施约束 |
| --- | --- | --- |
| Runtime/Executor | executor 工厂仍为未实现；worlddef 尚未接执行 | 不将候选类型当作已经存在的运行服务 |
| Driver | Body/Operation、资格核验与 close 存在；缺完整 Runtime 来源与 ExecutionSink 接线 | 完整集成强制注入真实 HostCallVerifier；缺失就拒绝启用写能力，默认宽松核验不能进入生产路径 |
| Library | 当前工作树只有旧资产仓库代码（SQLite/CAS），与现行文件库设计不符 | 实现按 [Library](assets.md) 的文件约定重写；旧代码视为待替换，不向后兼容 |
| World | 当前读/历史/Watch、存储 Worker、领域记录与保留存在 | 重用所有者端口，不新增 Runtime 世界缓存 |
| World Watch | invalidation.ensureStream 当前拒绝多依赖类别；未建立通用时间到期调度 | 不假称现有 Watch 已支持混合依赖；具体算法由 World 补齐，时间复查可由 Runtime 条件计时器触发 |
| Uina 接入 | 工具结果广播不证明 canonical append；已有 input_settled；WorldEvent.render 可以返回 null | 直返只标记交付意图，异步输入可按 committed 确认；用渲染前复查过滤过时 decision |
| 生命周期 | WorldActivation 先关闭 scope 再 onStop；ResourceScope 只跟踪登记的 Promise | 已受理 Run 由 Runtime 独立持有；abort 时立即关闭门和停止，onStop 等待收尾 |

QuickJS、子进程、Windows Job 的机制研究只支持优先原型选择。没有实际引擎、进程树、真实游戏或断电验收；本次也不为设计修订运行无关产品测试。

## 3. 唯一所有权与依赖

| 所有者 | 权威事实/资源 | 不属于它 |
| --- | --- | --- |
| Runtime | Run/Segment/Call/Effect 执行记录、停止意图、门、Body 就绪顺序、completion 与 decision 消费 | Bot、库文件、当前世界、OS 进程树 |
| Driver | Bot、连接/身体/Operation 代次、实际写入、窗口/持续输入与安全交接 | 业务队列、Run 目标与结果递送 |
| Program | guest 调用、语言执行、能力桥接、执行域容量与 guest 退役 | Run 受理、Body 调度、整个 Minecraft 进程树监管 |
| Executor | Uina façade、可信来源、IPC、工具等待/结果递送、Minecraft 进程启动与最终进程树监管 | 第二份 Run 结论、游戏动作恰好一次 |
| World | 当前查询、观察/历史、Watch、领域修订与本地证据保护 | 身体操作、程序执行与任务队列 |
| Library | 程序/蓝图/经验的文件、命名与元数据；蓝图字节、经验文本 | 执行目标结论、身体操作与 Runtime 生命周期 |
| Uina Host | Subject、canonical journal、World 生命周期 | Minecraft 内部调度与运行状态 |

Program 的子执行域使用 Executor 注入的受管创建能力，全部属于同一个最终监管树；Program 管 guest 启停，Executor 持最终退出证明。Runtime 只等待这两者给出的退役事实，不再实现第三套进程管理。平台启动与 Job 绑定细节由 Executor 所有者设计，不在本文规定系统调用。

游戏进程默认同域拥有 Runtime 轻量调度、Driver 与 World 当前路径；各所有者的 SQLite 使用专用 Worker。原生重计算必须切片或卸载，不能通过宿主桥接重新堵塞游戏心跳/停止。

内部可按 admission、calls、body、records 组织普通模块；目录和调用包装由组合根装配。文件名与类数量不是架构要求。Runtime 不 import Uina Host/UI，不穿透 World/库 的数据结构。

## 4. 模型、材料与持久记录

### 4.1 身份

Ref 由宿主生成且不复用，绑定 Runtime storageId。worldOwner 是持久接入归属，activation/attachment 是短期实例/传输，requestId 是一次新意图的重试键，invocation 仅审计。同键比较原语义请求，不以参数 hash 合并两个正常意图；JSON 对象键顺序无关、数组有序，拒绝非有限数/循环/非 JSON 值。

nativeEnvironment 是组合根冻结的确切原生 ref、descriptor 摘要、构建及所需 adapter/数据身份清单。Segment 引用它，不持久化函数指针、不复制全部资产。旧环境实际不可用时报 CALL_UNAVAILABLE；只有显式 current 才选新环境。

### 4.2 五种不同事实

| 模型 | 需要保存 | 活动资源/不可承诺 |
| --- | --- | --- |
| Run | 根意图/goal、owner、原请求、策略、累计有据进度、phase/revision、决策/结论引用 | 不持有另一份 Bot 状态 |
| Segment | 确切入口、字节/摘要/Manifest、绑定、环境、input/checkpoint、开始/退役事实 | 不持久保存栈、闭包或旧 Body |
| Call | 公共调用 parent/ref/input、access、绑定、返回/错误、进度、completion 合同 | helper 不建 Call；不是顶层任务 |
| Effect | 所属 Call/Operation、冻结要求、派发、原回执、证据及后续核验 | 不从最终库存猜动作因果 |
| completion | reportKind=terminal/decision、固定 Run 截面、completionRef | decision 不等于 Run 终结；交付状态不改变报告 |

BodyScope/CallScope 是活动资源，只记录授予/关闭事实，不另建可恢复状态机。Run goal 在受理时固定；续段不能降低目标，新目标另建关联 Run。进度按领域证据去重聚合，不把父子报告的同一批物品相加。

### 4.3 SQLite 结构与记录范围

一个 Runtime writer，最小表组为 metadata（storageId/schema/门）、submissions（owner/requestId、原指纹、首次解析与结果）、runs/segments、calls/effects、不可变 records、stop_intents、decisions、completions/delivery disposition。只有确有强 World 引用的记录才保存 evidence_holds；没有强引用不创建跨库保护工作。

事务更新当前物化行并追加必要审计事实，不建设 Event Sourcing。record 是已提交不可变截面；read/readSegment/readCall 返回最后提交的事实与修订，不临时造一个假称已持久的活视图。后续变化生成新截面。高频 progress 可以合并提交，反馈帧不默认逐帧持久。

受理、开始、停止意图、门、decision 消费与终结必须持久。Driver 事实同步进入 Runtime 非阻塞队列后批量写盘；尚未提交的真实派发尾部可在崩溃时丢失，因此恢复开放段始终标记尾部/效果可能缺失，不以“库里没有”证明没有动作。WAL/同步配置和持久性承诺以实际绑定/文件系统核验为准。

**存储位置。** 记录库与源码快照都在该 World 的数据根下（既有 world 激活约定给出的 `worldDataDir`：无 profile 时 `<cwd>/.uina/world-data/<worldName>`，有 profile 时 `<cwd>/profiles/<id>/state/world-data/<worldName>`），不另设配置项，各有唯一归属：

| 位置 | 内容 | 为什么在这里 |
| --- | --- | --- |
| `<worldDataDir>/runtime.db` | submissions、runs、segments、calls/effects、records、stop_intents、decisions、completions/delivery disposition | 按 requestId/segment 唯一约束和事务终结落结论；高频追加；恢复按 owner 枚举未结请求。不与 World 的 `world-history.db` 共库，也不假装跨库原子 |
| `<worldDataDir>/runs/<run>/sources/<sha256>.js` | 程序源码快照（确切执行字节，按内容寻址、同摘要去重） | 模型与文件工具要能直接读、能脱离 Runtime 存活；记录只保存 `{digest, snapshotPath}`，不内嵌源码正文 |

两侧一致性是单向的，不建双写事务或补偿协议：快照先落盘、记录后提交。记录中出现 `snapshotPath` 即表示文件当时已写入；之后读到缺失报 `NOT_FOUND`，**不从 `programs/` 重建历史**。反过来，写了文件但受理事务失败/崩溃留下的孤儿快照是惰性垃圾：恢复不据此推断任何 Run 存在，也不设自动 GC，需要回收时按目录枚举对照记录删除。`runs/` 按 run 惰性创建，只放源码快照；库的 `delete` 与段清理都不删它（程序见 program.md §2.6、§4.1）。

`runtime.db` 是单 writer（world 伴生进程内的 Runtime）。物理前提与 World 相同（WAL + `synchronous=FULL`），打开握手回报实际生效值；打不开或配置不满足就明确失败，不退化成内存库。这个自检结果由验证脚本消费（与 `pnpm verify:mc-worker` 同层），不新增面向模型的 capability：模型不需要知道存储细节，只需要在记录确实不可写时拿到失败的 `runs` 调用。

## 5. 受理：先准备不可变材料，再提交自己的事实

### 5.1 算法

1. Executor 为新意图持久保存 requestId、原请求和可信归属再发 IPC；stop 是立即发送的例外。执行侧先查询 submissions，同键同意图返回原结果，不重新解析；异意图 REQUEST_CONFLICT。
2. 对新请求检查当前 attachment/门并准备材料。程序按名从 `programs/<name>.js` 读一次源码，解析头注释、校验语法并固定 `SourceSnapshot{name,source,digest}`，不执行用户代码；原生入口固定 descriptor/environment。头注释无效或名字非法直接拒绝；文件不存在报 `NOT_FOUND`。
3. 准备结果是不可变材料，不是“提交瞬间最新”的承诺。读源码之后作者又改了文件，本段仍执行入场捕获的那份字节；不重读文件、不将 Library/World 读取放进 Runtime 事务伪造原子性。
4. 在 Runtime 单个短事务内重新检查**自己拥有的** owner 门/Runtime 装配代次、requestId 唯一约束、替换目标/预期控制 owner 的镜像事实，写 submissions、Run/Segment、固定材料和首次策略。replace_pending 的旧 Run 结论与 preempt_current 指向旧 Run 的停止意图，都和新 Run 同事务提交。Driver 物理变化并不被该事务冻结；实际 acquire/写入仍由 Driver 核验。
5. Runtime 本地 admission 线性化区持有一次性的 preemption reservation，在单事务之前暂缓发出新的 Driver.acquire，但不封闭旧 Call/Body 的动作准入、不撤销现有控制。preempt_current 必须先确认新受理与指定旧 Run 停止意图一同 commit；commit 成功的同一调度续程里先递增该 Run 的 admission generation、封闭旧范围、取消其调用，再调用 Driver 撤销并等待屏障；reservation 释放后新工作才可获得资格。commit 失败/回滚不改变旧代次或旧 gate，释放 reservation 并照 FIFO 恢复 grant。如此数据库失败不会意外取消旧工作。reservation 不跨 IPC 等待、不阻塞独立 stop/emergency；若旧控制自然结束，只处理已固定的旧 runId，不追着新的当前主人取消。显式 stop 仍独立立即变更代次并撤销。公开 submit/continue 再按 §13 返回 RunReply.result 或 accepted。
6. commit 回执不明：保留原键，查询权威 Runtime 存储；未确认受理前既不执行新工作，也不因这次抢占撤销旧工作；查到已提交才落实既有停止意图。unknown 不改用新 requestId。lookup.not_found 也不证明旧 IPC 不会稍后提交；重发须隔离/结束旧传输，并仍用同键。提交后、撤销前崩溃由恢复流程先隔离旧控制并处理持久停止意图，不能越过交接直接启动新 Run。

准备期间环境退役则放弃材料并明确失败/重新准备；这只是本地实现句柄存活核验。已提交入口使用入场捕获的字节，不能校验路径后再 import 可能变化的文件。程序调用所需文件届时不可读就 CALL_UNAVAILABLE，不重读当前文件。已经使用的源码/descriptor 在对应记录中留存。

### 5.2 调度单位与 phase

Body 队列项为某 Call 的最外层 withBody 申请，分配 readySeq；独立申请普通 FIFO，包括同一 Segment 的兄弟 Call。只有选中项进入 Driver.acquire；上一个 Driver.close 完成才发下一项。Driver 内部队列仅实现互斥/关闭，不表达业务优先级。取消在队列中删除自己的项；grant 与取消竞争时检查 scope，失效 grant 立即关闭且不执行回调。

replace_pending 只替换整个 Run 从未开始的明确目标；已开始但再次等待身体的 Run 不符合。preempt_current 核验 expectedRun，按先 commit 后撤销的顺序停止指定旧范围；新工作在屏障后获得一次优先机会，不建插队栈。已受理新工作后来取消，不复活旧运行。独立 stop/emergency 则立即撤销，不等待新工作或受理事务；真正的 recorder 故障可另行触发故障停机，不能把普通抢占拒绝冒充故障停机理由。

phase 是记录投影：finished/awaiting_decision → stopping → running（存在活动控制/执行）→ queued（尚未启动或仅待资源）→ waiting（仅已登记条件等待）。混合分支的细节在 Call/等待项中保留，不用一个 phase 假装完整描述任意 JS 调度。没有自动身体时间片或任务时长上限；长期持有由委托决定，仍可停止/抢占。

## 6. Callable 解析与普通组合

组合根收集 NativeCallable 数组，校验 ref 唯一、access 判别、schema、completion/checkpoint/依赖支持，使用现有 Ajv。descriptor 是 describe、输入/输出验证与发现摘要的唯一来源。QueryDescriptor 是 World 查询投影，不再注册成可写能力。Program 从头注释提供同形描述，发现不加载全部源码。

裸名调用按名解析：capacities 内建名优先，其次 programs/ 下的程序文件名（冲突时内建胜出并记警告）；子程序 Q 用 Q 自己的解析结果，不继承 P 的同名绑定。名字非法或不存在报 UNKNOWN_CALL。

每次公共 call：解析确切 ref → 核验当前 scope/祖先准入与 access → 验证输入/支持 → 创建子 Call 和可信身份 → invoke → 校验输出/完成要求 → 按 §7 关闭与结算 → 返回领域值 O 或抛 CallFailure。内部调用不 submit 子 Run，不排顶层受理队列；只有真正需要身体时才排 Body 队列。

普通 JS helper 不进目录/执行日志。act 不等于身体，例如资产发布或聊天。父子权限为祖先约束和 callee 声明的交集；read 调 act 在执行前拒绝。已知子失败可被 catch 并走替代方法，记录保留；CONTROL_CONFLICT 默认归当前 Call，不自动退役 Segment。只有隔离失守、无法安全清理或根执行失败，才升级到段级结算。

## 7. 调用身份与结构化关闭

### 7.1 原生和 Program 身份

原生入口由 AsyncLocalStorage 绑定 CallFrame（Segment、祖先取消、access、委托 BodyScope、运行代次）。代理先读取真实当前 frame，再核对代理所属 scope/委托；不能先恢复创建者 act 上下文，否则被 read 捕获的写代理会升级权限。事件回调使用 Driver 创建 Operation 时登记的可信来源，回调执行前重验；普通业务无权自报来源。

Program 以可信 host bridge 绑定真实 CallFrame；输入中 callId/access 只作定位、不作授权。不同 Program Call 的语言环境/能力引用不相互泄漏，跨域只传 JSON 与宿主登记的资源句柄，guest 不能选择任意兄弟身份。运行与资源退役后迟到请求/响应不重新打开 scope。Program 如何实现 guest 隔离属于其模块，Runtime 不依赖 QuickJS 对象类型。

### 7.2 关闭算法

CallScope 登记 AbortController、公共子 Call、所有宿主入口操作和 disposer；不是任意 Promise 的解释器。return/throw 同一同步阶段关闭本 Call 新准入，取消未结算后代，等待已登记宿主操作；未 await 的写入不得逃逸，已派发结果/未知照记。

先停止属于当前范围的资源，再等待 Driver 对该范围的清理/交接事实；委托子 Call 只清自己的 Operation，不关闭祖先 Body。外层 BodyScope 退出才关闭 Body。未登记的外部异步业务不能获得有效写来源；受信任原生代码绕过端口的 OS 行为不在该隔离承诺内。

控制清理结束后，按 §11 固定所属已收到事实并结算 Call。普通子 Call 将完成截面有序入队后即可返回，不逐 Call 等待写盘；Segment 封口才等待记录屏障并提交 Run completion，覆盖此前全部子 Call 记录。查询只返回已提交截面，尚未落盘的子调用完成可以暂不可见。关闭/记录故障公开为故障与未知，不能把 scope.close 返回直接当“游戏目标成功”。

需要返回精确持久 record 的读/导出端口，在本次调用内固定对应材料和 ticket，等待该 ticket 提交后才发布引用；取消只结束读取等待，不删执行事实。普通 mc.call 返回领域值，不隐含持久 record。当前没有必须逐 Call 同步持久的领域消费者，不新增通用 durable 调用模式；以后若出现该承诺，由具体能力明示并只等待其必要前缀。

## 8. Body：排队、委托与自等待

### 8.1 三种情况

| 情况 | 行为 |
| --- | --- |
| 根部 Promise.all 同时调用两个独立需要身体的能力 | 两个 Call 各有队列项，依次获得/释放 Body；不因此结束 Segment |
| BodyScope 内通过 scope.call/body.call 调受委托能力，或 scope.withBody 重入 | 明确继承同一个 Body；不重新排队；子退出只清自己的资源 |
| 当前 Body 调用谱系捕获外部 ctx/mc，试图再次独立 acquire | 派发申请前 CONTROL_CONFLICT；失败归该 Call，可 catch 改用正确委托接口 |

自等待检查只需当前 frame 的 Body 委托谱系：当前调用仍持有/借用 Body，却请求新的独立资格就拒绝。无关兄弟 Call 的持有/等待不构成冲突；不按 Segment 全局有无 Body 一刀切。body.call 的显式委托与权限交集同时成立，共享 runId 不授权共享 player。

Runtime 不检测任意 JS Promise 依赖图。若 Body 回调自行等待更早由无关分支创建、且不继承 Body 的 Promise，普通 JS 层可制造不可见等待环；合同要求先退出 Body 再 join 独立身体工作，或改用委托调用。公开 API 创建时能识别的重入必拒绝；不宣称能发现所有捕获 Promise 的死锁，显式停止仍必须可用。

### 8.2 组合与交接

同一 BodyScope 下兼容操作可重叠，真实兼容/冲突由 Driver adapter 的局部规则检查。Runtime 不建通道锁，不猜采集/瞄准意图。冲突错误默认局部；若已派发，先结算其效果/资源后返回，不能用失败漏掉动作。

外层退出：封闭 BodyScope/后代准入 → 取消未 await 工作 → Driver 撤销所属输入/插件/窗口 → 等待 close 屏障 → 下一个申请。清理可能释放蓄力物品或产生窗口后果，也要进入 ExecutionSink。未知服务器效果不阻止已经证明旧控制失效的交接；无法证明旧写来源失效就保持故障，并请求 Executor 隔离旧客户端，不能授予新主人。

自保算法归领域模块。协调内介入沿用资格，独立介入先退役旧控制再以 kind=safety 取得资格，受同一门和记录约束；不形成旁路身体控制器。

## 9. Program 执行合同与资源准入

> **已由 [`program.md`](program.md) §5 取代。** 执行域改为 worker 线程内的 QuickJS-WASM（不是段子进程），每次调用一个运行时；容量按段准入且只排队——原 §9 的"Body 内首次 Program 无容量时 `PROGRAM_CAPACITY`"一条取消：段内所有调用复用本域、不申请第二份容量，"持着身体等域"在程序路径上不存在（`program.md` §5.2）；`mc.wait` 与条件注册被 `mc.read`（返回观察版本）+ `mc.waitForChange`（版本原子比较，无漏唤醒）取代。Runtime 侧的硬保证（不堵事件循环、不暴露 Bot/Node、可强制取消、退役需事实）不变。

Runtime 依赖 public-api §7.1 的 ProgramExecutionPort：准备/检查入口、为 Segment 打开受管执行域、以宿主绑定的 API 调用、取消/退役并取得退出事实。它不规定 WASM 初始化、pending-job pump、编译包装、帧编码或 OS 启动 API。

必要保证：guest 同步/微任务死循环不堵 Driver；不能直接获得 Bot/Node/fs/net/仓库权威对象；宿主能力保持 Call/Body/read-act/取消合同；guest 退出不依赖 finally；迟到桥接可被宿主永久拒绝；资源失败明确返回，不默默换成普通宿主 eval。

**优先实现 QuickJS WASM + 每个涉及 Program 的活动 Segment 一个受管子进程**，同段子程序使用隔离 guest 环境。它是待真实原型验证的实现方案，不是领域不变量；只开发这一优先方案，失败后按 §16 更换实现并重过验证，不并行维护双执行器。

Program 已明确同段每次 Program Call 使用独立 QuickJS runtime/context、Promise bridge 和轮询 pump；不使用 Asyncify，不假设 context 是独立堆。Runtime 只消费原执行端口：普通 ProgramExecutionFailure.scope=call 保留局部失败，scope=domain 则在用户 catch 之前关闭段准入、取消兄弟并请求 retire，按退役/Driver/记录事实结算。类型和错误的唯一定义见 public-api §7.1；Runtime 不维护 guest CPU/IPC 队列或引擎句柄。

Program 所有者提供有限的活动执行域容量和内存/计算预算，以实际目标机器和压力测量配置；Runtime 使用其 FIFO 准入结果。排队可以产生 queued 状态，不取消 Run，不设置世界等待期限。容量不是“进程可以无限创建”的默认承诺，也不是通用 Quota/Policy 系统。

一个 Segment 至多一份活动执行域容量，首次 Program 调用共享打开 Promise；同段嵌套 Program 复用该域容量而隔离 guest，不再等待第二个进程名额。每个 guest 的内存由 Program 在同一域总预算内管理。~~排资源时不能持 Body：在 Body 内动态首次调用 Program，若不能立即取得容量，当前 Call 报 PROGRAM_CAPACITY，不排一个自持身体的资源等待~~（**已取消**，见 `program.md` §5.2：段内复用本域，容量只排队，不存在这一失败）。

await mc.wait 保留 JS 流程、闭包及活动执行域，长期等待确实占资源；mc.decide 是结束 Segment 并释放域的显式检查点交还。Runtime 不在容量紧张时擅自把 wait 转 decide，不虚构 Promise 持久挂起，也不为回收资源自动杀正常长期等待。独立 native Run 不因没有 guest 名额而被阻塞。

这是允许无限等待而不承诺公平开始时限的选择：全部域被长期 wait 占用时，新 Program 可能一直 queued。ProgramExecutionPort.capacity 提供唯一活动容量事实，ExecutorClient.programCapacity 按 owner 返回占用/排队数量、可见的 Segment、取得/排队时间和未确认退役；关联 Run/Call 可查询具体世界等待原因。此为带 observedAt 的实时观察，不是持久资源账本，不作为授予资格。停止/取消/查询及纯 native 入口不排 Program 容量队列；主脑可据此显式停止持有者或改变后续程序，Runtime 不自动换出、回收正常等待或代写 checkpoint。

反馈函数属于 Program：保留本地 step 闭包，调用 Driver feedback→next→step→apply，只桥接纯帧和受控输出，不传函数/Bot；具体 pump/编码/语言限制由 Program 负责。Runtime 只规定其宿主调用受同一 scope 和代次约束，退出必须关闭流。控制时效、appliedStep 与原生兼容性沿用 Driver 合同。

## 10. 等待、交还与续段

> **本节描述的 `mc.wait` 条件注册机制已删除（见 §9 横幅）。** 现行合同是 `mc.read` 返回观察版本（World cursor / 反馈帧 sequence）+ `mc.waitForChange` 在宿主侧做"读→原子比较→watch"的无漏唤醒循环，判定函数留在 guest，见 [program.md §3.5/§5.5](program.md)。以下内容保留作"能力侧被动等待、超时不计完成、取消不停止 Run"这些取舍的旁证。

### 10.1 世界等待算法

有两个可组合层次，`waitForChange` 是基础原语，`WaitConditionDef` 是其上的领域便捷能力。基础层不理解雨、怪物、炉子或成功条件；领域层让稳定复用的规则提供固定输入 schema 和 ready/pending/decide 行为。Program 可以直接用普通 JS 对 World Observation 求值，无须把每个临时组合注册为 Callable/条件。

`wait` 与 `waitForChange` 都检查**当前调用谱系**没有持有/委托的 Body；否则 BODY_SCOPE_ACTIVE。不因同段无关兄弟有 Body/待申请而拒绝。先退出自己的 withBody；不能自动释放后让旧闭包持有 player。等待项按 Call 分别登记，支持 Promise.all，不覆盖成一个 wait 字段。`waitForChange(targets, {afterMs?})` 要求非空 targets，每项含 `{query, after}`；Runtime 为每项独立创建 WorldWatch 和受 Call signal 联动的 child signal，并竞速各自 `next(after)` 与单调计时器。任一 Watch 返回 `WorldChange` 即返回 `{target, change}`；timeout 返回 `{kind:"timeout"}`。获胜后只取消其他 child signal；父 Call 取消则取消全部。任一结果、取消、调用关闭或建 Watch 失败，都关闭全部已建 Watch、清理计时器，并在清理完成后结束调用。targets/afterMs 无效时报 INVALID_ARGUMENT；某个 Watch 创建失败时整体失败，不把部分观察伪装成完整等待。

具体顺序是：先校验非空 targets、各 query 和有限正数期限；立即启动期限计时，再为所有 target 并行建立带 child signal 的 Watch。全部建立成功后，各自调用 `next(after)` 并与期限竞速。期限在建立阶段先到也会取消建立；任一建立失败则取消其余建立并等待建立 Promise settle，关闭所有成功建立的 Watch 后返回原始失败。变化/reset、期限、父取消或 next 失败决定唯一结果；随后取消相应 child signal、关闭全部 Watch、移除父取消监听并清计时器。输家因取消产生的错误不覆盖已选结果，清理错误不得被伪装成成功，须附着为调用清理失败。

领域被动流程仍可由 `mc.wait({condition,input})` 封装：World.read 固定 observation/cursor → 领域 evaluate → 若 pending，复用相同的一次性 Watch/计时器原语 → changed/reset/timeout 后重新 read/evaluate。注册间变化由 World cursor 比较补获；changed 不是满足。计时器用单调相对时间，不刷新旧观察 observedAt。无 afterMs 且无相关变化就继续等待，不默认轮询；定义的领域 evaluate 可以返回正数复查间隔或当场 ready/decide。

时间只安排复查，不能证明游戏进度。Program 可分别 read 多个已装配 WorldQuery，在普通 JS 中组合各自 Observation，再把每个 `{query, after: observation.cursor}` 交给一次 `waitForChange`；任一独立 Watch 变化/reset 即唤醒，随后 Program 重读需要的事实并自行判断。各 cursor 仍由对应 World.watch 校验与各自 query 的确切身份、参数、World/binding 作用域和来源代次；错配不得静默等待。Runtime 不拆 cursor、不合并水位，也不提供这些独立读取的联合快照。若某项底层事实或查询不存在，仍须由其所有者补足，普通 JS 不能伪造观察。只有业务要求多个来源处于同一一致性切面时，才由 World 明确提供联合查询合同；当前 World 对单次联合 query 的混合依赖限制仍有效，但不妨碍多个独立 query 分别 watch。timeout/changed/reset 后重新读取是程序责任，Watch 合并变化不保证捕获瞬时条件。

领域条件若必须开窗口、移动或探索才能观察，仍可登记序列化复查意图：能力引用、参数、有关世界/目标、检查点、重新检查时机。到时以新的就绪序号参与身体调度，取得新资格后主动复查；当前普通行为不被定时器打断。普通 Program 不可把持久复查意图假装成可恢复闭包；`await mc.waitForChange` 期间闭包仍在活动执行域，重启不恢复。

### 10.2 decide 与 continue

mc.decide 从任何子 Call 交还整个 Segment：宿主接受时立即封闭段准入，取消兄弟分支，固定可序列化 checkpoint，撤销控制并确认 guest 退役/释放域，再经过记录屏障持久写 decision+completion。资源退役不等数据库恢复，持久失败不发布假的 decision。catch/finally 不能重新打开业务动作；Promise<never> 不承担不可捕获控制转移的保证。

continue 先在事务外准备确切新入口/input/环境与检查点兼容验证，再在 Runtime 事务核验 decision 仍待处理、门/停止/Run 未终态，保存新 Segment 并消费 decision；同键幂等，其他竞争者 DECISION_STALE。environment 默认 inherit，显式 current 才换原生环境。验证器/检查点 schema 缺失就不继续。

decision 消费立即使旧请求不再 eligible；旧记录和 completion 原文不删除。执行端与接入按 §13 过滤旧通知，不能在迟到渲染时重新制造一个待决策任务。

新段获得全新 Call/Body/活引用，必须重读世界/库存/窗口。检查点不是动作事务或安全重试凭证；未知投料/交易先核验，不能自动补发。根目标不可通过换代码降低。

## 11. Effect 记录、提交屏障与结算

### 11.1 可信来源和队列

Driver 在实际派发/回执/清理边界调用非阻塞 DriverExecutionSink；来源在 Operation 创建时由可信宿主绑定，Runtime 建 effect→Call/Operation 关联，不根据 guest 自述或“当前 Run”猜归属。sink 不拥有第二份 Operation，也不控制派发。

record 同步复制/校验最小事实并进入 Runtime 有序内存队列，返回本执行实例递增 ticket（起点 1；空前缀 H=0）；ticket 只是记录入口顺序，不是协议确认/物理步/World cursor。清理导致的事实也必须在 Driver 对应关闭 Promise 完成前入队。异步晚到证据仍关联原 effect，不能绑定新 Call。

队列/Worker 故障显式记录 recorder fault 并关闭新副作用准入；已经可能派发的材料标未知/缺口，不能回退 not_sent。停止与私有清理不依赖 record 持久成功。没有逐包 write-ahead 承诺，崩溃仍可丢未提交尾部。

### 11.2 局部关闭与 Segment 持久封口

1. 同步关闭范围新准入；保存 return/throw/取消/decide 原因，禁止新业务子操作。
2. 取消并等待已登记子 Call/宿主操作；撤销范围所属资源。Driver 完成该范围控制屏障，相关清理派发/回执先进入 sink。借用祖先 Body 的子 Call 不释放祖先。根 Segment 同时请求 Program.retire，取得旧 guest/桥接退役事实；先封闭准入和撤销控制再等退出，不能互等于仍在等待本次 decide 的 invoke Promise。decide 通过宿主控制转移通道发起，不要求 guest 先 resolve 它的 Promise。普通子 Call 只退役自己的 guest 调用，不关闭整段 domain。
3. 执行固定合同需要的宿主只读核验并登记其结果；这是受限结算路径，不重开业务准入，不偷偷开窗/移动/发动作。无法核验则 unknown。
4. 普通子 Call：固定自己的已收到材料，按固定合同结算 execution、goal、effects 与 control，将不可变完成截面加入同一 writer 序列后返回领域值/抛错。入队不等于持久；无逐 Call flush。无法接收入队则锁存 recorder fault，停止新副作用并将故障上抛，不伪装已记账。其父段最终封口覆盖这些材料与完成截面。
5. 根 Segment：待后代局部关闭和核验材料均已入队，固定此刻 Runtime 已收到的所属事实集合及队列上界 H（含子 Call 完成截面）。调用 writer.flushThrough(H)，等待所有 ticket≤H 的已收材料持久提交或明确失败。全局 FIFO 前缀可包含其他 Call 的早到材料，但不等待 H 之后流量；不建每 Effect 一个 writer。
6. 屏障成功后按固定材料结算根 execution、Run goal、effects 与 control，再在短事务写阶段/最终结论、record、completionRef 和待交付项。H 以后到达的核验不混入本结论；尚待服务端结果留 unknown，不无限等未来证据。终结事务不得越过 H；commit 确认后才允许工具直返/事件递送。
7. guest 退役无法证明时，Program 保留未释放容量并请求 Executor 完成隔离；Run 不能报 succeeded，若控制也未隔离则 control=unknown 且禁止接管。flush/commit 失败：实际控制继续撤销，禁止新动作；记录存储 unavailable，不能输出一个假称持久 finished 的 completion。可独立给 StopReceipt.control；恢复按未闭合段处理。

屏障只覆盖 Runtime **已经接收**的材料。Driver 尚未发出的回调、未来服务端包、未入队/崩溃丢失的派发不被它“确认”。Driver close 的隔离承诺与 writer 屏障是两个先后保证，互不替代。Body 交接不必等待数据库；Run 对外终结必须等待上述持久边界。

### 11.3 后续核验与结果范围

Effect 原派发/原回执不可改；后续可信核验追加新记录，含 observedAt/来源/覆盖及所核验的原要求。Run completion 永久保留当时 unknown、停止原因与 H；readEffect 可以返回最新核验，read(run) 的历史终结不被洗白。晚到证据默认不新增 completion/主动唤醒，查询按需展开；真实重大新事件由领域按其事件合同报告。

completion 要求由可信能力/Operation 冻结。Program 默认 scope=execution；capability/goal 需要固定受信任 read verifier，return true 不成为认证器。ctx.verify 只能使用原 effect 声明核验者，不能改目标或替无关 effect 盖章。

五态：整个 Run 从未执行为 not_started；明确取消且控制停止为 cancelled；未处理错误/原合同确定不足为 failed；正常返回但必需目标/效果/控制未知为 unknown；固定合同和必要清理有据才 succeeded。failed/cancelled 也可带 unknownEffects。子失败可 catch 换路，原失败/未知仍保留；普通执行正常不能自动认证原采集/交易目标。

## 12. 停止、门、退役与恢复

工具 signal 只结束本次等待；stop/preempt 取消 Run；World abort 关闭 owner 门并停止所属工作；safeStop/失联关闭 emergency/owner_lost 门。门是原因集合，解除一项不解除其他项，重连/心跳不能自动解锁，不复活旧运行。

停止收到后先内存关闭准入、从 Body/Program 等待队列删除有关申请并撤销当前资格，再异步持久 stop_intent。StopReceipt 分开 intent 的持久性与 control 的当前事实；数据库坏了仍实际停止。finished Run 不被 stop 改历史。解除门才需要 expectedRevision CAS，关闭门不能被 CAS 冲突阻止。

Program 卡死：Runtime 封闭其桥接与资格，请 Program 退役 guest；Driver 清理。Program 退役无证明则报 unknown；凡共享物理资源仍未隔离就不得交接。整个游戏进程失响应由 Executor 域外终止/确认退役，不等待其中 stop/finally。Runtime 不规定 Job/launcher API，也不把发出 kill 当退出事实。

Executor 在启动前证明独占 Runtime 数据目录与唯一可写客户端、旧控制域/进程树已退役。SQLite 单 writer 不等于唯一 Bot。无法证明不接管；平台机制由 Executor 提供，不用 Runtime PID 表伪装锁。

恢复顺序：封闭准入 → 核验旧控制域退役 → 打开并核验 Runtime 库 → 读门/停止/开放段 → 追加恢复事实 → 建立新 attachment/世界绑定 → 显式准入新工作。

| 原状态 | 恢复 |
| --- | --- |
| finished | 保留原 completion/disposition；未处理后台项可递送，查询始终可用 |
| awaiting_decision | 仅仍待处理的 decision 可通知；消费过的历史项不重新唤醒 |
| 整个 Run 未开始 | not_started/runtime_restart；不自动开始 |
| 已开始且有停止意图，旧控制退役有据 | cancelled，保留未知和缺失尾部 |
| 已开始有有效检查点 | 旧 Segment 退役，生成恢复原因的待决策；显式 continue 建新段 |
| 已开始无可用检查点/环境材料 | unknown，公开材料缺口，可另建关联 Run |
| 旧控制退役不明 | control unknown、故障；不自动执行 |

await mc.wait 的条件记录可用于解释，但不恢复旧 await 或自动主动复查。实时断连使旧活引用退役；原生能力只有自己明确的恢复合同才可重新观察/排队，不能通用重放。

## 13. 同一 completion，短时直返与后台递送

### 13.1 所有权与等待窗口

Runtime 在每次段交还或 Run 终结时写不可变执行报告；reportKind=decision 表示当前段已封口、Run 仍待决策，terminal 才表示 Run finished。每段最多一份 decision，每 Run 最多一份 terminal；待决策时 stop 可另生 terminal，不改旧 decision，也不再次关闭已退役 guest。显式续段产生下一段及新报告。ExecutorClient.submit/continue 的唯一结果联合为 public-api §7 的 RunReply：先完成 Runtime 持久受理，再在配置的短等待窗口内得到本次提交的报告时返回 result（真实固定快照及 completionRef）；超时返回 accepted/run/segment/requestId，后续报告走 World 输入。窗口从执行侧确认受理后起算，毫秒数是接入配置，不冻结 200ms 为分界，不构成任务期限。

同一接入实例按 request/segment 串行选择本次接口响应。初始等待有效期间，后台 drain 暂缓该 segment 的 completion；终结、窗口到期、工具等待取消发生竞争时只选择一次本次响应。窗口关闭后不再把随后终态塞回已经返回的 accepted。waitSignal 只解除本次等待：已确认受理就返回 accepted/当前已知事实，不停止 Run；取消后解除本地暂缓，后台递送继续。受理前已确定取消则 not_accepted/not_started；原受理查证 unknown 不捏造 accepted。显式 runs.wait/read 是查询，不办理 tool_handoff。

这里只需要 Executor 的在途等待映射和 Runtime 的 delivery disposition，不建立跨存储 claim/lease、tool-result-recorded 事件或两套结果状态机。

### 13.2 直返交接与失败边界

直返前先从已提交 completion 读取固定快照，并用 settleDelivery 记录 tool_handoff（原 requestId）。它表示 Executor **选择并准备将该报告交给工具返回通道**，不是 canonical ACK。记录成功才正常直返并抑制主动通知；失败时不能声称已抑制通知，可直接返同快照但保留后台项，并明确故障可能重复。

tool_handoff 持久后到真实返回之间崩溃，存在报告尚未呈现而通知已抑制的窗口。恢复固定采用以下算法，不留“查询或补报”的实现选择：

1. Executor 在既有持久请求记录中保留 requestId、归属、受理 segment，以及选中直返的 completionRef；直返前先保存这些关联，再 settleDelivery(tool_handoff)。工具桥接完成响应交接后将本地请求关闭；这只用于发现未结请求，不是 canonical ACK。
2. 重启只枚举本 owner 的本地未结请求，不扫描 Host 会话或所有历史 tool_handoff。用原 requestId lookup；found 的 completionRef 必须属于该次提交的 Segment，不能误用 Run 后来续段的报告。未完成就由正常 drain 等待；unknown/unavailable 保留重试；不重做游戏动作。
3. 对已存在报告 readDelivery：input_committed 或已过时 decision 就关闭本地项；pending 交给正常 drain；只有 tool_handoff 且仍 eligible，才以本地唯一键 (requestId, completionRef) 持久建立一次恢复补报意图。已存在该意图就续用，不因再次启动重新创建。
4. 补报复用同一固定报告和 §13.3 的 eligibility/render/attempt/committed 流程，但允许读取 disposition=tool_handoff 的该项。重试只换传输 attempt，不新增报告或回退 disposition；input_committed 后关闭本地项，过时 decision 不再唤醒。

“一次”指一个可重试的补报意图，不是恰好一条 Host 输入；补报已入 canonical 而 ACK 丢失仍可重复。桥接已交出响应而本地关闭尚未落盘也可能补报重复；本地关闭不证明 canonical，因此最后交接丢失仍可由原 request/run 查询。不得宣称严格至少一次或恰好一次交付，不默认重发已关闭历史请求，不增 Core 事件。

同一 request 重试可能再次读到/返回同 completion；不产生新 Run、不自动重发游戏动作。主动 read/wait 只是查询，默认不改变递送状态；只有原 run/continue 窗口的直返是 tool_handoff。

### 13.3 后台输入与过时 decision

1. Runtime 终结事务创建 pending completion。pendingDeliveries 只返回 pending 且当前 eligible 项；tool_handoff/input_committed 项不正常重投。
2. finished completion 仍可交付；decision completion 仅当该 decision 仍是当前未消费待处理项且 Run 未停止/终止时 eligible。消费/失效只是从已有 Runtime 状态派生，不改历史正文，不新增任务状态机。
3. Executor 在 emitEvent 前再检查 eligibility，持久保存 attempt inputId→completionRef（恢复补报另绑定 §13.2 的本地意图）。一个 completion 正常只一个活动 attempt，失败退避重试，健康启用时由计时器/连接恢复推进，不能只等下一次用户输入；故障恢复补报是正常 pending 枚举之外的明确例外。
4. deferred render 读同一固定报告，并对 decision 再查询当前消费状态；已过时返回 null，不作为新请求唤醒。不在 render 中写 ACK/消费 decision，也不把旧报告重算为另一个目标。查询不可用时先返回 null/保留 pending，不能把未知当仍待处理。
5. input_settled.committed 才以可信 attempt 映射 settleDelivery(input_committed)。这证明进入 canonical，不证明模型已读。retired/missing_render/null 不作 committed ACK；过时项直接不再 eligible，其他失败可用新 attempt ID 重试。
6. canonical 已写、ACK 前崩溃可重复呈现同 completionRef。用户看到的 decision 报告带确切 decision 与“记录时的请求”；行动前核验当前 Run，continue 原子消费，旧请求 DECISION_STALE。

不能把 render 检查与另一个 Host journal append 伪装成原子：检查后 decision 被消费、随后文本入 canonical 的最后竞态仍可能发生。通过投递前/渲染前过滤减少无效唤醒，通过 decision CAS 阻止重复执行；不为消除这点展示竞态引入跨库协议。若未来出现必须保证无过时呈现的真实消费者，再单独证明最小 Host 接缝。

停用暂停输入递送，记录仍可查；恢复不重复动作。普通 progress 合并且不唤醒；urgent 只用于真实重大事件，不能代替游戏急停。rewind 不撤销已记交接事实，显式 replay 是新呈现意图。

## 14. Library / World：材料与引用责任

库是普通文件，不向 guest 暴露任何库对象：程序在 `mc` 环境里没有 `assets`；按名取蓝图是 `blueprint@1`（Construction 实现），文本库操作是 `library` 工具动作。运行副作用与库写入分别记录，`library` 不 submit 为游戏 Run。

Runtime 在入场时读一次程序源码并固定 `SourceSnapshot`（program.md §2.3 的快照）；`library.save` 从段保存时用同一份快照字节，来源段被清理就报 `NOT_FOUND`，不重读当前文件。库不冻结工作文件，作者随时可改；在途段不被影响，这由快照保证，不由库保证。

Runtime 必须长期复核的 World 证据，先按确切不可变 record owner 调 WorldEvidencePort.retain，确认材料/依赖及保护持久，再提交 Runtime 强引用。retain 成功而 Runtime 事务失败可留孤立保护；只有证明引用不会发布/已持久移除才 release。Runtime 事务不原子提交 World 保护。普通溯源可为弱链接，失效如实报告；不让每次移动/攻击都无条件等待跨库 retain。World 不可用时强引用发布失败或按明确合同只保存已复制材料/弱关联，不能暗中降低承诺。

领域记录写入还须校验 schema 所有权、世界分区及 CAS；Program World 只读，变更经领域 Callable。接线缺口明确实现，不能把结构校验当领域授权。Runtime 不设计 World 的查询/保留/GC 算法。

## 15. 可证伪验收

| 场景 | 必须成立 |
| --- | --- |
| 约 200ms 的调用且在配置窗口内完成 | 返回持久真实终态/completionRef，正常无额外主动输入 |
| 窗口超时或工具取消后完成 | 返回 accepted 或结束等待，Run 继续；后台交付相同结论 |
| 根部 Promise.all 两个 Body 调用 | FIFO 依次执行，取消只删对应项，不段级报错 |
| preempt_current 校验失败或事务回滚 | 不因此取消旧 Run；独立 stop/emergency 仍立即撤销 |
| 抢占提交后、撤销前崩溃/commit 回执未知 | 不提前启动新 Run；对账已提交停止意图，恢复先隔离旧控制 |
| 大量顺序轻量 mc.call | 每次逻辑关闭/入队即可返回；根封口 flush 一次必要前缀，精确 record 读另等提交 |
| Body 内委托调用/捕获外部 ctx 重入 | 前者复用；后者局部 CONTROL_CONFLICT，可 catch；不挂死等自己 |
| Body 内 join 预先创建的无关竞争 Promise | 文档明确不可自动识别；作者调整组合，显式 stop 可解除 |
| 未 await 原生操作派发后函数立即返回 | 先封闭/清理，已收到 ticket 纳入屏障；不得终结先于记录 |
| 射箭停止后才收到可信命中 | 原 cancelled/unknown completion 不改；原 Effect 追加核验可查 |
| DB/Worker 故障或 flush 卡住 | 实际 Body 停止不等待；没有假的 durable finished |
| 作者在入场后修改程序文件 | 本段仍执行入场捕获的字节；不重读文件、不静默漂移 |
| 全部执行域长时间 await mc.waitForChange | 新 Program 可长期 queued；可查 limit/occupied/queued/Segment/时间/世界等待原因，native/stop/取消/查询不排容量 |
| tool_handoff 后崩溃且本地请求未结 | 同原报告建立一个持久补报意图；再次恢复续用，过时 decision 跳过，绝不重做动作 |
| decision 报告后显式 continue | reportKind=decision 不被当 finished；新段 terminal 报告保留不同 completionRef |
| Body 内动态首次 Program 无容量 | 原用例删除（见 `program.md` §5.2）：段内复用本域，不申请第二份容量，不会出现该失败 |
| decide 后 continue | 释放旧 guest；新段新引用，旧闭包/未 await 分支不能恢复 |
| decision 已消费但输入尚排队 | 投递/渲染复查抑制；最后 canonical 竞态可能展示历史，continue 不重复消费 |
| 多源/时间条件 | 各 query/cursor 独立 Watch，任一失效或 afterMs 唤醒；不拼水位/承诺联合快照，afterMs 只复查 |
| 临时“雨停且附近无怪”组合 | Program 分别读取已有事实对应的 QueryDescriptor，在 JS 判断；将各 query/cursor 放入一次等待，任一变化/reset/timeout 后重读。不要求组合 QueryDescriptor；示例名称不代表已实现。若底层事实缺失，明确不可用，不能伪造 |
| waitForChange 超时、取消、部分 Watch 失败 | timeout 要求重读；cancel 关闭所有已建 Watch/计时器且不停止 Run；任何建立失败关闭已建 Watch 并失败；reset 触发重读，旧 cursor 不继续使用 |
| 停止/进程强杀/重启同时发生 | 无旧资格复活，无未知动作重放，旧域退役不明则不接管 |
| act→read 捕获旧 player/assets | 原生和 guest 实际写入口均拒绝升级 |

验证分四种边界：临时库/Fake Driver 检查机制；真实 Program 引擎/IPC 检查语言、资源和退役；真实 SQLite 强杀/故障检查提交与恢复；固定 Java/服务端/Mineflayer 版本和可复位存档检查物理交接、插件清理、反馈延迟与游戏结果。任何一组通过都不能代替其他组。本次仅完成设计与静态一致性检查。

## 16. 取舍、实验与实施边界

| 问题 | 裁决与被放弃的复杂度 |
| --- | --- |
| 结果交付 | 同一结论短直返/长通知；放弃跨日志严格去重和全事件额外成本 |
| 身体组合 | 独立申请排队，委托复用，谱系内重入局部失败；不为仲裁限制普通并发，也不建通用死锁检测 |
| 记录可靠性 | 有限接收上界+writer 屏障；不承诺所有实际动作都有持久 write-ahead |
| 版本一致性 | 捕获不可变材料后提交自己的事实；不追求跨库提交瞬间最新 |
| 过时决策 | 历史不可变、待处理从消费事实派生；过滤而不伪造跨 Host 原子呈现 |
| 执行域 | 必要隔离合同与可替换实现分离；QuickJS/段子进程优先原型，不锁死领域 |
| 长期等待 | 普通 await 保留闭包和成本；显式 checkpoint 结束旧段，不偷偷做持久工作流 |
| 进程所有权 | Executor 最终监管、Program guest 退役、Runtime 等事实；无三套独立进程管理 |

必须验证的关键假设与失败路线：

1. Program 优先原型：真实 async/嵌套调用/微任务死循环/分配压力/取消/桥接身份与泄漏，测启动、RSS 和长期 wait。失败先修实现/配置；必要时换受限引擎/执行域，维持同一 Runtime 合同，不退回不具隔离保证的 eval。
2. 反馈与整体成本：同场景对照原生控制器，测 sample→guest→apply 的 p50/p95/p99、age 拒绝、停止尾延迟；无法满足已确认玩法时改执行域/桥接实现或复用满足该玩法的原生算法，不删自由度后宣称完成。
3. Executor 退役：由该所有者验证精确实例/后代监管、父进程强杀、失败启动、所有权独占；证明不了就不自动接管。Windows Job 是候选机制，本文不固化 launcher 细节。
4. 记录故障：真实 Worker/磁盘故障与派发、清理、freeze H、flush、terminal commit 各交界；确认不提前结论且停止独立。屏障失败绝不靠 fallback 零值修复。
5. 交付竞态：短窗口边界、tool_handoff 后崩溃、输入 committed 后 ACK 丢失、continue 与 deferred render 竞争；量化正常模型唤醒/请求/token 成本，公开允许的故障重复/查询缺口，不预造 Core 事件。
6. World 消费边界：用真实所需混合查询验证 read→watch 无漏变化、reset 与时间复查；World 若仍不支持则对应条件不可用，不在 Runtime 拼水位修补。

实施闭合要求：一次同步更新源码合同与组合根；实现 Runtime 记录/准入/CallScope；接 Driver 真实 verifier 与 sink/关闭事实；接 Program 合同/容量与 Executor 监管；实现等待/decision/交付及有限导出，最后过真实过程验收。这是依赖关系，不是 MVP/过渡架构。

本次不改业务代码、不改现有资产仓库代码、不改真实 Provider/会话/认证。Program 拥有引擎和桥接算法，Executor 拥有平台算法；本文所引用的唯一公共合同不在那里复制。只有实际消费者证明不足才加接缝，不为旧接口保留旁路兼容系统。
