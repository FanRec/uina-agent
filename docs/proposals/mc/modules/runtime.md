# Runtime / Callable 详细设计

日期：2026-10-18（Asia/Shanghai）。状态：修订后的实施规格，Runtime 尚未实现，未经过真实 Minecraft 验收。

公共类型与错误只在 [public-api.md](../public-api.md) 定义，跨模块行为见 [contracts.md](../contracts.md)，目标见 [design.md](../design.md)，研究证据见 [research.md](../research.md)。本文负责 Runtime 的执行语义与内部算法。Program 引擎、桥接与容量算法由 Program 所有者负责；Executor 平台实现由其所有者负责，不在这里形成第二份规范。

## 1. 职责与不变量

Runtime 负责**执行归属、调用组合、身体仲裁与执行记录**。一个已受理游戏意图独立于主脑的一轮思考持续存在；原生能力与普通 JavaScript 使用相同调用语义；一个 Minecraft 玩家身体在多个运行之间有确定的取得、停止与交接边界。

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

## 2. 受理与调度

### 2.1 算法

1. Executor 一次持久保存 requestId、原请求和可信归属再发 IPC；stop 立即发送。Runtime 按 (owner,requestId) 查询 submissions，既有同意图返回原受理/报告引用，不重算；异意图 REQUEST_CONFLICT。未受理且已有持久撤销屏障则 REQUEST_CANCELLED。准备期间用同键 singleflight：同意图共享一次准备，不同意图拒绝；准备失败移除内存项，成功后用唯一受理映射接管。工具等待取消只移除该等待者，不取消共享准备。
2. 对新请求检查当前 attachment/门及请求键的内存关闭代次，再准备材料。程序按 `SourceRequest`（名字或临时代码）解析一次源码，解析头注释、校验语法并固定 `{name, source, digest}`，不执行用户代码；原生入口固定 descriptor/environment。损坏头/schema 报 `PROGRAM_INVALID`（reason=header）、非法选择子报 `SELECTOR_INVALID`、文件不存在报 `PROGRAM_NOT_FOUND`（program.md §3、§7）。
3. 准备结果是不可变材料，不是“提交瞬间最新”的承诺。读源码之后作者又改了文件，本段仍执行入场捕获的那份字节；不重读文件、不将 Library/World 读取放进 Runtime 事务伪造原子性。
4. 在 Runtime 单个短事务内重新检查**自己拥有的** owner 门/Runtime 装配代次、requestId 唯一约束/撤销屏障、替换目标/预期控制 owner 的镜像事实，写 submissions、Run/Segment、固定材料与入口参数。replace_pending 的旧 Run 结论与 preempt_current 指向旧 Run 的停止意图，都和新 Run 同事务提交。Driver 物理变化并不被该事务冻结；实际 acquire/写入仍由 Driver 核验。
5. Runtime 本地 admission 线性化区持有一次性的 preemption reservation，在单事务之前暂缓发出新的 Driver.acquire，但不封闭旧 Call/Body 的动作准入、不撤销现有控制。preempt_current 必须先确认新受理与指定旧 Run 停止意图一同 commit；commit 成功的同一调度续程里先递增该 Run 的 admission generation、封闭旧范围、取消其调用，再调用 Driver 撤销并等待屏障；reservation 释放后新工作才可获得资格。commit 失败/回滚不改变旧代次或旧 gate，释放 reservation 并照 FIFO 恢复 grant。如此数据库失败不会意外取消旧工作。reservation 不跨 IPC 等待、不阻塞独立 stop/emergency；若旧控制自然结束，只处理已固定的旧 runId，不追着新的当前主人取消。显式 stop 仍独立立即变更代次并撤销。公开 submit/continue 再按 §6 返回 RunReply.result 或 accepted。
6. commit 回执不明：保留原键，查询权威 Runtime 存储；未确认受理前既不执行新工作，也不因这次抢占撤销旧工作；查到已提交才落实既有停止意图。unknown 不改用新 requestId。lookup.not_found 不排除旧 IPC 稍后提交；明确同键重试仍安全地加入 singleflight/受理唯一约束，无需等旧 attachment 退出。提交后、撤销前崩溃由恢复流程先隔离旧控制并处理持久停止意图，不能越过交接直接启动新 Run。

singleflight 绑定本次准备的真实 attachment/关闭代次，不将旧准备改绑新 owner。代次失效先结束旧准备，重新查持久受理/撤销事实后才能为当前绑定准备。受理提交成功与调度启动之间再次复查请求/Run 关闭代次：已经收到 stop 的工作不能趁提交回调启动。唯一约束冲突只读取胜出的原受理，不将第二份材料发布为新段。

准备期间环境退役则放弃材料并明确失败/重新准备；这只是本地实现句柄存活核验。已提交入口使用入场捕获的字节，不能校验路径后再 import 可能变化的文件。程序调用所需文件届时不可读就 CALL_UNAVAILABLE，不重读当前文件。已经使用的源码/descriptor 在对应记录中留存。

### 2.2 调度单位与 phase

Body 队列项为某 Call 的最外层 withBody 申请，分配 readySeq；独立申请普通 FIFO，包括同一 Segment 的兄弟 Call。只有选中项进入 Driver.acquire；上一个 Driver.close 完成才发下一项。Driver 内部队列仅实现互斥/关闭，不表达业务优先级。取消在队列中删除自己的项；grant 与取消竞争时检查 scope，失效 grant 立即关闭且不执行回调。

replace_pending 只替换整个 Run 从未开始的明确目标；已开始但再次等待身体的 Run 不符合。preempt_current 核验 expectedRun，按先 commit 后撤销的顺序停止指定旧范围；新工作在屏障后获得一次优先机会，不建插队栈。已受理新工作后来取消，不复活旧运行。独立 stop/emergency 则立即撤销，不等待新工作或受理事务；真正的 recorder 故障可另行触发故障停机，不能把普通抢占拒绝冒充故障停机理由。

phase 表示执行活动，优先级为 finished/awaiting_decision → stopping → running（有执行或正在进行的操作）→ queued（未启动或仅等待取得资源）→ waiting（其余活动仅在等待）。持有身体本身不使 phase 变成 running；允许 waiting 且 control=active。control 表示身体归属/隔离状态，反馈帧和持续输入是否有效由 Driver 各自检查。混合分支详情保留在 Call/等待项中。没有自动身体时间片或任务时长上限；显式长期持有仍可停止/抢占。

## 3. 调用与身体

### 3.1 解析与普通组合

组合根收集 NativeCallable 数组，校验 ref 唯一、access 判别、schema、completion/checkpoint/依赖支持，使用现有 Ajv。descriptor 是 describe、输入/输出验证与发现摘要的唯一来源。QueryDescriptor 是 World 查询投影，不再注册成可写能力。Program 从头注释提供同形描述，发现不加载全部源码。

裸名调用按名解析：先精确能力 ref，再 `programs/<name>.js`（带 `@` 的选择子只解析为能力，不带 `@` 才可能是程序）。子程序 Q 用 Q 自己的解析结果；名字非法报 `SELECTOR_INVALID`，解析不到报 `PROGRAM_NOT_FOUND`。

每次公共 call：解析确切 ref → 核验当前 scope/祖先准入与 access → 验证输入/支持 → 创建子 Call 和可信身份 → invoke → 校验输出/完成要求 → 按 §4.3 关闭与结算 → 返回领域值 O 或抛 CallFailure。内部调用不 submit 子 Run，不排顶层受理队列；只有真正需要身体时才排 Body 队列。

普通 JS helper 不进目录/执行日志。act 不等于身体，例如资产发布或聊天。父子权限为祖先约束和 callee 声明的交集；read 调 act 在执行前拒绝。已知子失败可被 catch 并走替代方法，记录保留；CONTROL_CONFLICT 默认归当前 Call，不自动退役 Segment。只有隔离失守、无法安全清理或根执行失败，才升级到段级结算。领域能力在自身实现中判断声明目标，Runtime 只校验输出结构并保存其结果，不按 descriptor 再执行一套目标核验。

### 3.2 调用身份

原生入口由 AsyncLocalStorage 绑定 CallFrame（Segment、祖先取消、access、委托 BodyScope、运行代次）。代理先读取真实当前 frame，再核对代理所属 scope/委托；不能先恢复创建者 act 上下文，否则被 read 捕获的写代理会升级权限。事件回调使用 Driver 创建 Operation 时登记的可信来源，回调执行前重验；普通业务无权自报来源。

Program 以可信 host bridge 绑定真实 CallFrame；输入中 callId/access 只作定位、不作授权。不同 Program Call 的语言环境/能力引用不相互泄漏，跨域只传 JSON 与宿主登记的资源句柄，guest 不能选择任意兄弟身份。运行与资源退役后迟到请求/响应不重新打开 scope。Program 如何实现 guest 隔离属于其模块，Runtime 不依赖 QuickJS 对象类型。

<a id="body"></a>

### 3.3 身体申请、委托与交接

#### 3.3.1 三种情况

| 情况 | 行为 |
| --- | --- |
| 根部 Promise.all 同时调用两个独立需要身体的能力 | 两个 Call 各有队列项，依次获得/释放 Body；不因此结束 Segment |
| body.call/scope.call 显式委托，或已委托子上下文中的普通 call/withBody | 同一 Body 沿子调用传播；上层写句柄挂起；重入不排队；子退出只清自己的资源 |
| 当前 Body 调用谱系捕获外部 ctx/mc，试图再次独立 acquire | 派发申请前 CONTROL_CONFLICT；失败归该 Call，可 catch 改用正确委托接口 |

body.call 给被调方的真实 CallFrame 绑定委托；其普通 call 继续传播，不能由实现类型决定。没有委托的外部 ctx/mc 不自动升级；同 scope 只有一个控制委托路径，竞争时报 BODY_BUSY。

自等待检查只需当前 frame 的 Body 委托谱系：当前调用仍持有/借用 Body，却请求新的独立资格就拒绝。无关兄弟 Call 的持有/等待不构成冲突；不按 Segment 全局有无 Body 一刀切。body.call 的显式委托与权限交集同时成立，共享 runId 不授权共享 player。

Runtime 不检测任意 JS Promise 依赖图。若 Body 回调自行等待更早由无关分支创建、且不继承 Body 的 Promise，普通 JS 层可制造不可见等待环；合同要求先退出 Body 再 join 独立身体工作，或改用委托调用。公开 API 创建时能识别的重入必拒绝；不宣称能发现所有捕获 Promise 的死锁，显式停止仍必须可用。

#### 3.3.2 组合与交接

同一 BodyScope 下兼容操作可重叠，真实兼容/冲突由 Driver adapter 的局部规则检查。Runtime 不建通道锁，不猜采集/瞄准意图。冲突错误默认局部；若已派发，先结算其效果/资源后返回，不能用失败漏掉动作。

withBody 回调等待期间保留身体，不自动释放或重新排队。原生能力自行 acquire 时，应把长期等待放到自己的身体作用域外；借用祖先委托时，只关闭自己的操作，退出内部 withBody 不释放祖先。等待仍受取消、资格失效和输入过期约束。

外层退出：封闭 BodyScope/后代准入 → 取消作用域结束时仍在途的所属工作 → Driver 撤销所属输入/插件/窗口 → 等待 close 屏障 → 下一个申请。清理可能释放蓄力物品或产生窗口后果，也要进入 ExecutionSink。未知服务器效果不阻止已经证明旧控制失效的交接；无法证明旧写来源失效就保持故障，并请求 Executor 隔离旧客户端，不能授予新主人。

自保算法归领域模块。协调内介入沿用资格，独立介入先退役旧控制再以 kind=safety 取得资格，受同一门和记录约束；不形成旁路身体控制器。

### 3.4 Program 执行与容量

Program 的语言/线程/预算合同以 [program.md §5、§7](program.md) 为准。Runtime 打开逻辑 ProgramSegmentScope，受理时固定的入口材料直接种入缓存；每 Call invoke 才在共享 worker 创建独立 QuickJS runtime。段不占线程槽，没有段级容量队列；常驻 guest 或单 guest RPC 耗尽立即失败，不持身体等容量。等待 guest 留在内存，其他段仍可执行。

Runtime 提供真实 CallFrame、host bridge 与取消信号，不依赖 QuickJS 类型。Program 的局部关闭只销毁所属 guest；段关闭不 terminate 共享 worker。故障升级需先封闭该 worker 全部在册调用准入、撤销所属控制，再强杀并确认 exit；受影响调用逐个结算，未知效果保留。Program 无退役证明时交由 Executor 隔离，容量不虚假释放；不自动重跑。

容量唯一来源是 ProgramPort.capacity()：Runtime 展示实际 worker/guest/RPC 及 waiting，不维护第二份配额；原生调用、停止和查询不因 guest 槽位排队。CPU 累计量是观察值或显式任务预算，不默认终止长期任务。

## 4. 等待、决策与关闭

<a id="waiting"></a>

### 4.1 世界等待

程序入口为 mc.waitUntil(targets, predicate, {timeoutMs?})。先 read 全部独立 target，再在 guest 判定；不满足时把各自 version 交给宿主 watch。每项 read→watch 复用 World 的原子比较合同，多项保留版本映射，不伪造联合快照/全局游标。watchable 决定可等，feedback 决定可做高频传感，两者独立。

期限从进入 waitUntil 起算，包含读取与判定；changed 重读重判，到期后最后重读再判，满足则 met，否则 timeout；来源/代次失效返回 invalidated 且不带值。known↔unknown 推进版本，predicate 收到 `{unknown}`。取消/任一 watch 建立失败清理其余资源，不让输家错误覆盖原结果；没有期限就持续到满足/失效/取消。

waitUntil/sleep 不改变 BodyScope 生命周期，持有或借用身体均可等待。为其他任务让出身体，需要作者先退出外层 withBody；不自动释放/续租，也不延长反馈帧和持续输入有效期。mc.sleep(0) 只让出计算。开箱/移动才能复查时显式 call；计时不证明产物完成。等待按当前 CallScope 登记和清理，不恢复旧闭包，不检测任意 Promise 依赖环。

### 4.2 决策与续段

mc.decide 在 guest 内同步抛出专用 NEEDS_DECISION，不发宿主 RPC。首次未处理地跨出 guest 时，宿主按真实 Call 关联来源；既有请求沿错误桥传播时保留原来源，忽略 guest 自填 origin。子调用先关闭自身范围再把请求交给父调用；父可 catch 处理或原样上抛。只有根未处理时 Runtime 才封闭段、取消后代、撤销控制、请求 ProgramScope.close、结算效果并持久写 decision/completion；不能先杀共享 worker。普通 JSON 的同名字段不触发交还。

Checkpoint 为程序/领域判别联合：程序是 `{kind:"program", value, origin}`，领域是 `{kind:"domain", schema, value, evidence}`。程序检查点不需要全局 schema 注册。continue 的程序根通过只读 mc.checkpoint 得到 value（缺省 null）；子程序不自动接收，需显式 input。原生入口仅接受其明确声明的领域检查点，不能隐式把程序 JSON 当成领域检查点。

continue 在事务外固定新入口/输入与检查点种类，事务内核验门、停止与 decision 仍待处理，再保存新 Segment、消费旧 decision；同键幂等，竞争 DECISION_STALE。明确重选原生环境才换装配代次，不能恢复旧 Call/Body/窗口。持久失败不发布假的 decision，显式停止优先于新的交还请求。

检查点不证明安全重试；新段重新读取现场，未知投料/交易先核验。continue 保留 Run 和历史段关联，新段按自身入口合同结算，不认证旧目标完成。工程/程序负责解释累计业务量，Runtime 不从多段报告推算。

### 4.3 调用关闭

CallScope 登记 AbortController、公共子 Call、宿主入口操作和 disposer，不解释任意 Promise。仅在 invoke/main 的返回 Promise 最终正常完成或未处理抛出（含 NEEDS_DECISION）跨出调用边界时，封闭本 Call 新准入；decide 仅同步抛出可捕获的专用异常，不提前封闭，捕获仍在途的子调用并写 closedByParent，再取消/结算它们；根 interruptedChildren 从这些记录派生。不能根据 parent/outcome 断言“是否 await”，也不能清理结束后从未结束集合重建该事实。已派发结果/未知照记。

先停止属于当前范围的资源，再等待 Driver 对该范围的清理/交接事实；委托子 Call 只清自己的 Operation，不关闭祖先 Body。外层 BodyScope 退出才关闭 Body。未登记的外部异步业务不能获得有效写来源；受信任原生代码绕过端口的 OS 行为不在该隔离承诺内。

控制清理结束后，按 §5 固定所属已收到事实并结算 Call。普通子 Call 将完成截面有序入队后即可返回，不逐 Call 等待写盘；Segment 封口才等待记录屏障并提交 Run completion，覆盖此前全部子 Call 记录。查询只返回已提交截面，尚未落盘的子调用完成可以暂不可见。关闭/记录故障公开为故障与未知，不能把 scope.close 返回直接当“游戏目标成功”。

需要返回精确持久 record 的读/导出端口，在本次调用内固定对应材料和 ticket，等待该 ticket 提交后才发布引用；取消只结束读取等待，不删执行事实。普通 mc.call 返回领域值，不隐含持久 record。当前没有必须逐 Call 同步持久的领域消费者，不新增通用 durable 调用模式；以后若出现该承诺，由具体能力明示并只等待其必要前缀。

### 4.4 停止、门与恢复

工具 signal 只结束本次等待；stop/preempt 取消 Run；World abort 关闭 owner 门并停止所属工作；safeStop/失联关闭 emergency/owner_lost 门。门是原因集合，解除一项不解除其他项，重连/心跳不能自动解锁，不复活旧运行。

停止收到后先内存关闭准入、从 Body 队列删除有关申请并撤销当前资格，再异步持久 stop_intent。StopReceipt 分开 intent 的持久性与 control 的当前事实；数据库坏了仍实际停止。finished Run 不被 stop 改历史。解除门才需要 expectedRevision CAS，关闭门不能被 CAS 冲突阻止。

stop 支持 Run 或原动作 requestId。后者立即关闭该键内存准入、取消未受理准备，并把按 (owner,requestId) 唯一的撤销屏障写入现有 stop_intents；已受理就关联并停止实际 Run。屏障先提交，受理事务拒绝；受理先提交，停止事务命中既有映射。还未受理的停止只产生持久 stop record，lookup=cancelled，无虚构 Run/completion；屏障不因 retry、重启或过期清除。停止命令 ID 与被停止的请求 ID 分开。continue 在消费 decision 前后按同一事务排序：消费前撤销不消费旧 decision，消费后停止已经建立的新段。持久性失败仍保持内存关闭，不能声称跨重启保证。

Program 卡死：Runtime 封闭其桥接与资格，请 Program 退役 guest；Driver 清理。guest 退役无证明则升级共享 worker 故障，先封闭其全部在册来源，再确认退出；无证明仍 unknown。凡共享物理资源仍未隔离就不得交接。整个游戏进程失响应由 Executor 域外终止/确认退役，不等待其中 stop/finally。Runtime 不规定 Job/launcher API，也不把发出 kill 当退出事实。主循环仍健康而旧执行源不能隔离时，必须通过组合根 requireRetirement 锁存当前 launch 的退役请求；它经优先 IPC 和 status/心跳交给 Executor，定义见 [Executor §5.3](executor.md)。不以普通日志代替升级，不等待持久写盘。

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

waitUntil 的观察与等待记录可用于解释，但不恢复旧 await 或自动主动复查。实时断连使旧活引用退役；原生能力只有自己明确的恢复合同才可重新观察/排队，不能通用重放。

## 5. 记录与结算

### 5.1 身份与固定材料

Ref 由宿主生成且不复用，绑定 Runtime storageId。worldOwner 是持久接入归属，activation/attachment 是短期实例/传输，requestId 是一次新意图的重试键，invocation 仅审计。同键比较原语义请求，不以参数 hash 合并两个正常意图；JSON 对象键顺序和编码空白无关、数组有序，字符串内容（包括 code）逐字符保留，拒绝非有限数/循环/非 JSON 值。

段在入场时固定三样东西：入口（原生能力的确切 `ExactRef` + `descriptor.digest`，或程序的名字/来源/摘要/快照）、输入、以及运行环境 `{serverVersion, protocol}`。环境变了只影响新段：旧段按入场时的字节与目录跑完，不中途换能力实现；旧环境已不可用时报 `WRONG_STATE`（能力）或 `PROGRAM_RETIRED`（域已退役）。

### 5.2 执行记录与进度

| 模型 | 需要保存 | 活动资源/不可承诺 |
| --- | --- | --- |
| Run | owner、原请求、入口参数、根调用最后进度、phase/revision、决策/结论引用 | 不持有 Bot 状态，不累计领域完成量 |
| Segment | 确切入口、源码字节/摘要或 descriptor 摘要、环境、input/checkpoint、开始/退役事实 | 不持久保存栈、闭包或旧 Body；不存绑定表 |
| Call | 公共调用 parent/ref/input、access、绑定、返回/错误、进度、completion 合同 | helper 不建 Call；不是顶层任务 |
| Effect | 所属 Call/Operation、冻结要求、派发、原回执、证据及后续核验 | 不从最终库存猜动作因果 |
| completion | reportKind=terminal/decision、固定 Run 截面、completionRef | decision 不等于 Run 终结；交付状态不改变报告 |

BodyScope/CallScope 是活动资源，只记录授予/关闭事实。Run.progress 展示当前段根调用最后报告，新段初始为空对象；各 Call/Segment 保留自身进度，不对父子或跨段数据求和。工程累计量由领域对象维护，程序累计量通过自己的 JSON/检查点维护。Run.completion 取当前段入口的 execution/capability 及说明，随报告固定；不保存独立目标状态，不认证旧目标因续段已经完成。

<a id="storage"></a>

### 5.3 存储与提交

一个 Runtime writer，最小表组为 metadata（storageId/schema/门）、submissions（owner/requestId、原指纹、首次解析与结果）、runs/segments、calls/effects、不可变 records、stop_intents（Run/请求键屏障与停止命令去重）、decisions、completions/delivery disposition。只有确有强 World 引用的记录才保存 evidence_holds；没有强引用不创建跨库保护工作。

事务更新当前物化行并追加必要审计事实，不建设 Event Sourcing。record 是已提交不可变截面；read/list/wait 返回由其派生的有界摘要，readSegment/readCall/readEffect 返回对应当前已提交完整截面。readRecord 接受确切 record/completionRef；身份 Ref 先解析并固定一个已提交 record。不能临时造一个假称已持久的活视图。后续变化生成新截面。高频 progress 可以合并提交，反馈帧不默认逐帧持久。

受理、开始、停止意图、门、decision 消费与终结必须持久。Driver 事实同步进入 Runtime 非阻塞队列后批量写盘；尚未提交的真实派发尾部可在崩溃时丢失，因此恢复开放段始终标记尾部/效果可能缺失，不以“库里没有”证明没有动作。WAL/同步配置和持久性承诺以实际绑定/文件系统核验为准。

**存储位置。** 记录库与源码快照都在该 World 的数据根下（既有 world 激活约定给出的 `worldDataDir`：无 profile 时 `<cwd>/.uina/world-data/<worldName>`，有 profile 时 `<cwd>/profiles/<id>/state/world-data/<worldName>`），不另设配置项，各有唯一归属：

| 位置 | 内容 | 为什么在这里 |
| --- | --- | --- |
| `<worldDataDir>/runtime.db` | submissions、runs、segments、calls/effects、records、stop_intents、decisions、completions/delivery disposition | 按 requestId/segment 唯一约束和事务终结落结论；高频追加；恢复按 owner 枚举未结请求。不与 World 的 `world-history.db` 共库，也不假装跨库原子 |
| `<worldDataDir>/runs/<run>/sources/<sha256>.js` | 程序源码快照（确切执行字节，按内容寻址、同摘要去重） | 模型与文件工具要能直接读、能脱离 Runtime 存活；记录只保存 `{digest, snapshotPath}`，不内嵌源码正文 |

两侧一致性是单向的，不建双写事务或补偿协议：快照先落盘、记录后提交。记录中出现 `snapshotPath` 即表示文件当时已写入；之后读到缺失报 `NOT_FOUND`，**不从 `programs/` 重建历史**。反过来，写了文件但受理事务失败/崩溃留下的孤儿快照是惰性垃圾：恢复不据此推断任何 Run 存在，也不设自动 GC，需要回收时按目录枚举对照记录删除。`runs/` 按 run 惰性创建，只放源码快照；导出另在 exports/，不混入 runs/；库的 delete 与段清理都不删源码快照（程序见 program.md §3.4、§4.1）。

`runtime.db` 是单 writer（world 伴生进程内的 Runtime）。物理前提与 World 相同（WAL + `synchronous=FULL`），打开握手回报实际生效值；打不开或配置不满足就明确失败，不退化成内存库。这个自检结果由验证脚本消费（与 `pnpm verify:mc-worker` 同层），不新增面向模型的 capability：模型不需要知道存储细节，只需要在记录确实不可写时拿到失败的 `runs` 调用。

组合根传入 Executor 固定的 expectedStorageId/worldOwner；恢复前核对 metadata。预期旧库却缺失、身份不符时失败，不先自动创建空库再把旧请求判为不存在。首次配对与接入凭证缺失的处理由 [Executor §3.2](executor.md) 定义。

完整读取的 RecordReply 只选 inline 或 file，不改变不可变材料。大记录在 Runtime 自己的存储/文件 I/O 路径导出至 `<worldDataDir>/exports/<sha256>.json`，作为可再生缓存，不新建权威表或强保留；原子发布与失败规则见 [Executor §5.5](executor.md#large-results)。RunSummary、CallSummary 和 CompletionHeader 只投影同一截面，省略项须标完整性，不能变成另一份目标/进度聚合。

### 5.4 效果来源与记录队列

Driver 在实际派发/回执/清理边界调用非阻塞 DriverExecutionSink；来源在 Operation 创建时由可信宿主绑定，Runtime 建 effect→Call/Operation 关联，不根据 guest 自述或“当前 Run”猜归属。sink 不拥有第二份 Operation，也不控制派发。

record 同步复制/校验最小事实并进入 Runtime 有序内存队列，返回本执行实例递增 ticket（起点 1；空前缀 H=0）；ticket 只是记录入口顺序，不是协议确认/物理步/World cursor。清理导致的事实也必须在 Driver 对应关闭 Promise 完成前入队。异步晚到证据仍关联原 effect，不能绑定新 Call。

队列/Worker 故障显式记录 recorder fault 并关闭新副作用准入；已经可能派发的材料标未知/缺口，不能回退 not_sent。停止与私有清理不依赖 record 持久成功。没有逐包 write-ahead 承诺，崩溃仍可丢未提交尾部。

### 5.5 局部关闭与段封口

1. 同步关闭范围新准入；保存 return/throw/取消/decide 原因，禁止新业务子操作。
2. 取消并等待已登记子 Call/宿主操作；撤销范围所属资源。Driver 完成该范围控制屏障，相关清理派发/回执先进入 sink。借用祖先 Body 的子 Call 不释放祖先。根 Segment 同时请求 ProgramScope.close，取得旧 guest/桥接退役事实；先封闭准入和撤销控制再等退出，不能互等于仍在等待本次 decide 的 invoke Promise。根未处理 NEEDS_DECISION 才开始该控制转移，不等待仍在等待结算的根 invoke Promise。普通子 Call 只退役自己的 guest；逻辑段关闭也不终止共享 worker。
3. 执行固定合同需要的宿主只读核验并登记其结果；这是受限结算路径，不重开业务准入，不偷偷开窗/移动/发动作。无法核验则 unknown。
4. 普通子 Call：固定自己的已收到材料，保存 execution、领域结果、effects 与 control，将不可变完成截面加入同一 writer 序列后返回领域值/抛错。入队不等于持久；无逐 Call flush。无法接收入队则锁存 recorder fault，停止新副作用并将故障上抛，不伪装已记账。其父段最终封口覆盖这些材料与完成截面。
5. 根 Segment：待后代局部关闭和核验材料均已入队，固定此刻 Runtime 已收到的所属事实集合及队列上界 H（含子 Call 完成截面）。调用 writer.flushThrough(H)，等待所有 ticket≤H 的已收材料持久提交或明确失败。全局 FIFO 前缀可包含其他 Call 的早到材料，但不等待 H 之后流量；不建每 Effect 一个 writer。
6. 屏障成功后按固定材料结算根 execution、领域结果、effects 与 control，再在短事务写阶段/最终结论、record、completionRef 和待交付项。H 以后到达的核验不混入本结论；尚待服务端结果留 unknown，不无限等未来证据。终结事务不得越过 H；commit 确认后才允许工具直返/事件递送。
7. guest 退役无法证明时，Program 保留未释放容量并请求 Executor 完成隔离；Run 不能报 succeeded，若控制也未隔离则 control=unknown 且禁止接管。flush/commit 失败：实际控制继续撤销，禁止新动作；记录存储 unavailable，不能输出一个假称持久 finished 的 completion。可独立给 StopReceipt.control；恢复按未闭合段处理。

屏障只覆盖 Runtime **已经接收**的材料。Driver 尚未发出的回调、未来服务端包、未入队/崩溃丢失的派发不被它“确认”。Driver close 的隔离承诺与 writer 屏障是两个先后保证，互不替代。Body 交接不必等待数据库；Run 对外终结必须等待上述持久边界。

### 5.6 后续核验与结果范围

Effect 原派发/原回执不可改；后续可信核验追加新记录，含 observedAt/来源/覆盖及所核验的原要求。Run completion 永久保留当时 unknown、停止原因与 H；readEffect 可以返回最新核验，read(run) 的历史终结不被洗白。晚到证据默认不新增 completion/主动唤醒，查询按需展开；真实重大新事件由领域按其事件合同报告。

完成范围只有 execution 和 capability。Program 正常返回仅表示程序执行完成；原生能力自行核验其声明目标/会话结束条件，结果及证据随调用保存。Runtime 不维护通用目标状态，不按 descriptor 自动执行目标 verifier。Effect 的领域核验仍可通过 ctx.verify 使用该 effect 原已声明的核验者；它只追加效果判断及来源，不替程序认证整体游戏目标。

五态：整个 Run 从未执行为 not_started；明确取消且控制停止为 cancelled；未处理错误/当前入口声明要求确定不足为 failed；正常返回但必需效果或控制清理未知为 unknown；当前入口返回且必要效果和清理有据才 succeeded。能力目标是否满足由能力负责，Runtime 不重新求值。failed/cancelled 也可带 unknownEffects；捕获子失败可以换路，原记录和未解决效果仍保留。terminal 的完成范围取最后一段入口，不据此认证历史目标。

## 6. 执行报告与交付处置

<a id="delivery"></a>

Runtime 在段交还或 Run 终结事务中写不可变 CompletionReport、completionRef 与 pending disposition。decision 表示段已封口、Run 待决策；terminal 对应 finished。每段最多一份 decision，每 Run 最多一份 terminal；待决策 stop 可另生 terminal，旧 decision 不改。

pendingDeliveries 只按 [public-api §7](../public-api.md) 分页返回 pending 且 eligible 的报告引用，readDelivery 读取有界固定 header 和当前 eligibility，正文由 readRecord(completionRef) 取得 inline/file。terminal 可投；decision 仅当前仍未消费、Run 未停止/终结时可投。eligibility 从已有运行事实派生，不新建任务状态机。

settleDelivery 只接受 HostCommitReceipt，将 pending 幂等变为 committed，不回退。Runtime 核验当前可信 Executor 绑定、owner 与 receipt.key=completionRef；Host namespace/session/record 的真实性由 Executor 经绑定 HostDeliveryPort 确认，不能用 guest/模型数据代替。Runtime 不读 Host 日志或 executor.db，不因工具返回/入队/render 改处置或 outcome。两种交付渠道复用同一回执类型；状态查询/退役接缝见 [Host 持久交付回执](../../runtime/delivery-receipts.md)，接入算法见 [Executor §8](executor.md)。

submit/continue 的受理在执行侧完成，ExecutorClient 的 Uina 侧适配再组织短窗口，返回带 CompletionView 的 RunReply；等待取消不取消已受理 Run。窗口选择、Host 投递/ACK、重试与保证边界只由 [Executor §8](executor.md) 定义。Runtime 不管理 Host 队列、模型回合、跨库交付租约或 Core 工具记录事件。

Run 等待与请求重试不共享一个取消域。wait 默认忽略普通进度，等 finished/awaiting_decision；已有报告立即返回。显式 afterRevision 等一次变化，未来修订拒绝，finished 始终立即返回；超时返回 timeout，不制造 revision，也不取消 Run。小型 CompletionHeader 与正文可用性分开：content=unavailable 不改原 outcome；通知允许交付真实 header 后按 HostCommitReceipt ACK，完整材料故障不能阻塞其他报告。

## 7. 模块所有权与材料引用

### 7.1 所有权

| 所有者 | 权威事实/资源 | 不属于它 |
| --- | --- | --- |
| Runtime | Run/Segment/Call/Effect 执行记录、停止意图、门、Body 就绪顺序、completion 与 decision 消费 | Bot、库文件、当前世界、OS 进程树 |
| Driver | Bot、连接/身体/Operation 代次、实际写入、窗口/持续输入与安全交接 | 业务队列、Run 目标与结果递送 |
| Program | guest 调用、语言执行、能力桥接、执行域容量与 guest 退役 | Run 受理、Body 调度、整个 Minecraft 进程树监管 |
| Executor | Uina façade、可信来源、IPC、工具等待/结果递送、Minecraft 进程启动与最终进程树监管 | 第二份 Run 结论、游戏动作恰好一次 |
| World | 当前查询、观察/历史、Watch、领域修订与本地证据保护 | 身体操作、程序执行与任务队列 |
| Library | 程序/蓝图/经验的文件、命名与元数据；蓝图字节、经验文本 | 执行目标结论、身体操作与 Runtime 生命周期 |
| Uina Host | Subject、canonical journal、World 生命周期 | Minecraft 内部调度与运行状态 |

程序在 world 伴生进程内的 worker 线程里执行：共享 worker 承载每调用独立 QuickJS runtime，Segment 只是逻辑调用范围（program.md §5.1）。Executor 只监管伴生进程这个最终进程树；Runtime 等 Program 给出的退役事实，不实现第三套进程管理。

游戏进程默认同域拥有 Runtime 轻量调度、Driver 与 World 当前路径；各所有者的 SQLite 使用专用 Worker。原生重计算必须切片或卸载，不能通过宿主桥接重新堵塞游戏心跳/停止。

内部可按 admission、calls、body、records 组织普通模块；目录和调用包装由组合根装配。文件名与类数量不是架构要求。Runtime 不 import Uina Host/UI，不穿透 World/库 的数据结构。

### 7.2 Library / World 引用

库是普通文件，不向 guest 暴露任何库对象：程序在 `mc` 环境里没有 `assets`；按名用蓝图是 `build.plan@1`/`build@1` 的 `from`（Construction 实现），文本库操作是 `library` 工具动作。运行副作用与库写入分别记录，`library` 不 submit 为游戏 Run。

Runtime 在入场时读一次程序源码并固定快照（program.md §3.4）；`library.save` 从段保存时用同一份快照字节，来源段被清理就报 `NOT_FOUND`，不重读当前文件。库不冻结工作文件，作者随时可改；在途段不被影响，这由快照保证，不由库保证。

Runtime 必须长期复核的 World 证据，先按确切不可变 record owner 调 WorldEvidencePort.retain，确认材料/依赖及保护持久，再提交 Runtime 强引用。retain 成功而 Runtime 事务失败可留孤立保护；只有证明引用不会发布/已持久移除才 release。Runtime 事务不原子提交 World 保护。普通溯源可为弱链接，失效如实报告；不让每次移动/攻击都无条件等待跨库 retain。World 不可用时强引用发布失败或按明确合同只保存已复制材料/弱关联，不能暗中降低承诺。

领域记录写入还须校验 schema 所有权、世界分区及 CAS；Program World 只读，变更经领域 Callable。接线缺口明确实现，不能把结构校验当领域授权。Runtime 不设计 World 的查询/保留/GC 算法。

## 8. 验收场景

| 场景 | 必须成立 |
| --- | --- |
| 约 200ms 的调用且在短窗口内完成 | 返回持久真实终态/completionRef，正常无额外主动输入 |
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
| 多个 guest 长时间 waitUntil | 未耗尽常驻容量的新程序可执行；耗尽时立即容量失败，calls/worker/waiting 可查；没有段级容量队列 |
| 工具返回前后崩溃 | 无真实 Host 回执就保持 pending，恢复核对后补投；同 ref 重复允许，动作不重做 |
| decision 报告后显式 continue | 新段按自己的入口结算，历史调用/进度可查，不认证旧目标完成 |
| 持身体等待熔炼/睡眠 | phase=waiting 可与 control=active 并存；输入有效期独立，其他 Body 申请排队，stop 可清理 |
| 父子调用及多个段报告相同数量 | 原样保留各自进度，Run 只取根最后报告，不重复累计 |
| Body 内首次/再次调用 Program 且常驻 guest 已满 | 新子调用派发前 PROGRAM_CAPACITY；Body 不等待容量，父可处理，已有工作与效果保留；scope 退出正常清理 |
| decide 后 continue | 释放旧 guest；新段新引用，旧闭包/未 await 分支不能恢复 |
| decision 已消费但输入尚排队 | 投递/渲染复查抑制；最后 canonical 竞态可能展示历史，continue 不重复消费 |
| 多源/时间条件 | 各 query/cursor 独立 Watch，任一失效或 timeoutMs 唤醒；不拼水位/承诺联合快照，timeoutMs 只复查 |
| 临时“雨停且附近无怪”组合 | Program 分别读取已有事实对应的 QueryDescriptor，在 JS 判断；将各 query/cursor 放入一次等待，任一变化/reset/timeout 后重读。不要求组合 QueryDescriptor；示例名称不代表已实现。若底层事实缺失，明确不可用，不能伪造 |
| waitUntil 超时、取消、部分 Watch 失败 | timeout 最后重读重判；调用取消清理 Watch/计时器并按范围中断；建立失败清理其余；reset 返回 invalidated，不带旧值 |
| 停止/进程强杀/重启同时发生 | 无旧资格复活，无未知动作重放，旧域退役不明则不接管 |
| act→read 捕获旧 player/assets | 原生和 guest 实际写入口均拒绝升级 |

验证分四种边界：临时库/Fake Driver 检查机制；真实 Program 引擎/IPC 检查语言、资源和退役；真实 SQLite 强杀/故障检查提交与恢复；固定 Java/服务端/Mineflayer 版本和可复位存档检查物理交接、插件清理、反馈延迟与游戏结果。任何一组通过都不能代替其他组。本次仅完成设计与静态一致性检查。

## 9. 实现状态与验证边界

### 9.1 当前源码接缝

以下是源码范围内事实，不是端到端运行证明：

| 边界 | 已确认事实 | 实施约束 |
| --- | --- | --- |
| Runtime/Executor | executor 工厂仍为未实现；worlddef 尚未接执行 | 不将候选类型当作已经存在的运行服务 |
| Driver | Body/Operation、资格核验与 close 存在；缺完整 Runtime 来源与 ExecutionSink 接线 | 完整集成强制注入真实 HostCallVerifier；缺失就拒绝启用写能力，默认宽松核验不能进入生产路径 |
| Library | 当前工作树只有旧资产仓库代码（SQLite/CAS），与现行文件库设计不符 | 实现按 [Library](library.md) 的文件约定重写；旧代码视为待替换，不向后兼容 |
| World | 当前读/历史/Watch、存储 Worker、领域记录与保留存在 | 重用所有者端口，不新增 Runtime 世界缓存 |
| World Watch | invalidation.ensureStream 当前拒绝多依赖类别；未建立通用时间到期调度 | 不假称现有 Watch 已支持混合依赖；具体算法由 World 补齐，时间复查可由 Runtime 条件计时器触发 |
| Uina 接入 | 工具结果广播早于 canonical append；已有 input_settled；尚无持久回执查询 | 实现通用 Host delivery 端口，直返与后台均凭真实回执确认；渲染前复查过滤过时 decision |
| 生命周期 | WorldActivation 先关闭 scope 再 onStop；ResourceScope 只跟踪登记的 Promise | 已受理 Run 由 Runtime 独立持有；abort 时立即关闭门和停止，onStop 等待收尾 |

QuickJS/worker 的微基准与进程监管研究只说明局部可行性，不证明本次共享池方案。没有实际引擎、进程树、真实游戏或断电验收；本次也不为设计修订运行无关产品测试。

### 9.2 技术取舍与待验证项

| 问题 | 裁决与被放弃的复杂度 |
| --- | --- |
| 结果交付 | 同一报告短直返/长通知，Host 索引查询修复回调/ACK 丢失；保证至少一次持久呈现，不追求恰好一次 |
| 身体组合 | 独立申请排队，委托复用，谱系内重入局部失败；不为仲裁限制普通并发，也不建通用死锁检测 |
| 记录可靠性 | 有限接收上界+writer 屏障；不承诺所有实际动作都有持久 write-ahead |
| 版本一致性 | 捕获不可变材料后提交自己的事实；不追求跨库提交瞬间最新 |
| 过时决策 | 历史不可变、待处理从消费事实派生；过滤而不伪造跨 Host 原子呈现 |
| 执行域 | 共享 worker + 每调用独立 QuickJS runtime；逻辑段不预占线程，关闭只退役自己的 guest；隔离合同与引擎实现分离，换引擎不改 Runtime 合同（program.md §5） |
| 长期等待 | 普通 await 保留闭包和成本；显式 checkpoint 结束旧段，不偷偷做持久工作流 |
| 进程所有权 | Executor 最终监管、Program guest 退役、Runtime 等事实；无三套独立进程管理 |

必须验证的关键假设与失败路线：

1. Program 优先原型：真实 async/嵌套调用/微任务死循环/分配压力/取消/桥接身份与泄漏，测启动、RSS 和长期 wait。失败先修实现/配置；必要时换受限引擎/执行域，维持同一 Runtime 合同，不退回不具隔离保证的 eval。
2. 反馈与整体成本：同场景对照原生控制器，测 sample→guest→apply 的 p50/p95/p99、age 拒绝、停止尾延迟；无法满足已确认玩法时改执行域/桥接实现或复用满足该玩法的原生算法，不删自由度后宣称完成。
3. Executor 退役：由该所有者验证精确实例/后代监管、父进程强杀、失败启动、所有权独占；证明不了就不自动接管。Windows 命名 Job 与启动/退役顺序见 [Executor §4](executor.md)。
4. 记录故障：真实 Worker/磁盘故障与派发、清理、freeze H、flush、terminal commit 各交界；确认不提前结论且停止独立。屏障失败绝不靠 fallback 零值修复。
5. 交付竞态：工具/输入 canonical append 前后崩溃、ACK 丢失、Host 长忙/回调丢失、retire 与新尝试/append 竞争；量化正常唤醒/请求/token 成本。按通用 Host 回执核对，不使用 Minecraft 专属事件或另一套交付数据库。
6. World 消费边界：用真实所需混合查询验证 read→watch 无漏变化、reset 与时间复查；World 若仍不支持则对应条件不可用，不在 Runtime 拼水位修补。

实施闭合要求：一次同步更新源码合同与组合根；实现 Runtime 记录/准入/CallScope；接 Driver 真实 verifier 与 sink/关闭事实；接 Program 合同/容量与 Executor 监管；实现等待/decision/交付及有限导出，最后过真实过程验收。这是实现依赖关系。

本次不改业务代码、不改现有资产仓库代码、不改真实 Provider/会话/认证。Program 拥有引擎和桥接算法，Executor 拥有平台算法；本文所引用的唯一公共合同不在那里复制。只有实际消费者证明不足才加接缝，不为旧接口保留旁路兼容系统。
