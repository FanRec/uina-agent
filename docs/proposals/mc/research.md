# Minecraft World：研究证据与架构验证

研究整理日期：2026-10-15（Asia/Shanghai）。推荐设计见 [design.md](design.md)，设计状态与已确认选择见 [README.md](README.md)。本文记录判断依据、替代方案和验证方法，不重复定义运行合同。

## 1. 证据范围

本文区分四类结论：

- **源码事实**：在指定提交或当前 Uina checkout 中能直接定位的行为；不等于该行为已经在真实游戏中通过验证。
- **项目自述**：README、论文或演示报告的能力与效果；不能当作本项目复现实验。
- **设计推论**：根据证据作出的取舍，可以被后续实验推翻。
- **待验证**：依赖版本、服务端、模型表现或实际负载才能确定的判断。

本次没有运行参考项目、连接 Minecraft 服务端、调用真实 Provider 或测量游玩成功率。下面的固定提交是研究快照，不表示项目最新版本；静态核查没有证明完整 Java 原版覆盖。

Uina 源码核查基点为 `db658580aed9415d8acc0c1e2fb98cda2470cef9`，并读取当前工作树相关实现。已有 Live2D 等改动不属于本设计。外部源码链接固定到提交，后续升级必须重新审查有关路径，不能把本文直接套到其他版本。

<a id="uina-seams"></a>

## 2. Uina 现有接缝与真实限制

| 当前源码事实 | 依据 | 对设计的影响（推论） |
| --- | --- | --- |
| 一个 World 工具会把各 action 的说明和参数合并进 `oneOf` | [world-tool.ts](../../../src/extensions/world-framework/world-tool.ts) | 一个 façade 并不自动节省上下文；入口稳定，详细能力按需发现 |
| World 激活作用域管理工具与生命周期，事件的 `urgent` 映射为 `steer` | [world-activation.ts](../../../src/extensions/world-framework/world-activation.ts) | 可承接接入和资源回收；即时避险不能依靠模型抢占 |
| 工具批次与输入递送由 Subject 执行循环管理 | [loop.ts](../../../src/agent/loop.ts) | 模型事件递送不能被解释为即时身体停止 |
| 请求投影通过 `turn.transformContext` 链构建，检查和重建可再次执行投影 | [host.ts](../../../src/host/host.ts)、[loop.ts](../../../src/agent/loop.ts) | 状态投影保持纯读；不在构造请求时消耗“模型已看过”的变化游标 |
| World 可暴露同进程活引用，扩展接缝可连接其他能力 | [types.ts](../../../src/extensions/world-framework/types.ts)、[index.ts](../../../src/extensions/world-framework/index.ts) | 可提供状态读口；活引用不能直接跨游戏进程运输 |
| 工具结果有五种状态，`details` 不进入模型正文；外部效果要在正文说明 | [当前工具结果合同](../../current-runtime.md#工具结果) | 受理、游戏效果和未知结论必须进入可见回执 |

这些事实足以支持 World 接入、事件和状态投影的概要设计，不证明 Minecraft 后台任务已经具备跨回合、取消或跨重启恢复能力。相关机制仍需在 Minecraft World 内实现和验证。

<a id="seam-audit"></a>

### 2.1 详细设计前的当前源码复核

2026-10-15 在同一 HEAD 重新静态核查，新增以下限制。它们是源码事实，未运行 Minecraft 或真实 Provider；推荐行为集中在 [详细契约](contracts.md)。

| 已核实事实 | 源码依据 | 设计影响 |
| --- | --- | --- |
| ActionContext 只有 operationIdentity/signal；Broker 已有 ownerId/callerId/invocationId，但 WorldTool 没透传第三参数 | [types.ts](../../../src/extensions/world-framework/types.ts)、[world-tool.ts](../../../src/extensions/world-framework/world-tool.ts)、[broker.ts](../../../src/tools/broker.ts) | 操作名不等于调用来源。可在 World framework 透传现有上下文，不需要增加 Core 身份机制；root ownerId 也不是持久 subjectId |
| World stop 先 scope.close 后 onStop；scope 等待在途 Promise，后台句柄返回后的工作不由原 Promise 自动追踪 | [world-activation.ts](../../../src/extensions/world-framework/world-activation.ts)、[lifecycle-scope.ts](../../../src/extensions/lifecycle-scope.ts) | 受理后独立管理 run；生命周期 abort 立即封闭动作并请求停止，onStop 再等待，防止关闭互等 |
| 当前没有 tool_result_recorded；tool_result 广播早于 canonical tool append | [events.ts](../../../src/runtime/events.ts)、[loop.ts](../../../src/agent/loop.ts) | 短直返非 canonical ACK，允许故障补报/查询缺口，不增 Core 记录后事件 |
| Extension 有 session.list/read；JSONL append 完整写入并 sync 后更新查询 state；MemorySessionStore 无同等持久承诺 | [runner.ts](../../../src/extensions/runner.ts)、[access.ts](../../../src/session/access.ts)、[jsonl-store.ts](../../../src/session/jsonl-store.ts) | 不扫描会话判递送；输入用 committed，工具只记交接，未做断电实验 |
| 查询可读 main/all 已提交节点，不能查 queued Mailbox；deferred render 闭包不持久化，恢复后 placeholder 可因 missing_render 退役 | [session types](../../../src/session/types.ts)、[loop.ts](../../../src/agent/loop.ts)、[recovery.ts](../../../src/session/recovery.ts) | 正常路径可抑制重复，重启仍有递送不确定；同引用补报不等于恰好一次，也不证明模型已读 |
| 外部 Worlds 在 builtin world-framework 激活时加载；/reload 仅重载项目扩展；disable/enable 复用已导入 WorldDef | [host.ts](../../../src/host/host.ts)、[world index](../../../src/extensions/world-framework/index.ts)、[runner.ts](../../../src/extensions/runner.ts)、[registry](../../../src/extensions/world-framework/world-registry.ts) | 不假设 /reload 重载 World/能力或停止后台运行；接入生命周期不应依赖项目扩展重载来停止游戏 |
| 已有 BodyEndpoint safeStop/resume/interrupt 与已登记端点的 stopAll；interrupt 缺省回退 safeStop，具身卸载的 stopAll 未被 await | [seams.ts](../../../src/extensions/world-framework/seams.ts)、[body-router.ts](../../../.uina/extensions/embodiment/body-router.ts)、[embodiment index](../../../.uina/extensions/embodiment/index.ts) | Minecraft 显式实现 interrupt 保留后台任务；safeStop 接持久急停门，World 自己等待 teardown，不能声称 Host/Core 已有统一持久急停锁 |

固定上游源码的新复核：

- [Mineflayer furnace.js](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/furnace.js) 在开炉后订阅窗口进度，窗口关闭时移除监听。由此推论：释放身体后等待产物不能一律依赖被动窗口事件；定时应安排重新开炉核验，不证明熔炼完成。
- [pathfinder index.js](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js) 的停止/执行路径包含直接改写 position/velocity 及异步装备、挖掘、放置后续；[PVP.ts](https://github.com/PrismarineJS/mineflayer-pvp/blob/82e19b6ac66555f81d1e8e2f749233b4ae0bac4f/src/PVP.ts) 的停止超时会清理共享 pathfinder 目标与监听。由此推论：实际写入和异步来源必须一起适配，顶层 AbortSignal 不证明交接封闭。
- [Node 22 Worker 合同](https://nodejs.org/download/release/v22.0.0/docs/api/worker_threads.html#workerterminate) 说明 terminate 异步停止 JS，资源限制不覆盖所有进程内存；[VM timeout 合同](https://nodejs.org/download/release/v22.0.0/docs/api/vm.html#timeout-interactions-with-asynchronous-tasks-and-promises) 说明异步调度的 timeout 边界。Worker/子进程与隔离引擎是候选，不据此认定完整沙箱、宿主取消或 Tick 延迟已经通过。

### 2.2 公开接口评审后的取舍

本轮修正上一稿的三项推荐，具体合同仅在 [行为契约](contracts.md) 和 [公开接口](public-api.md) 维护：

- 提交 ID 由接入先生成/持久保存。当前 invocationId 可选，model 路径由 provider call.id 拼成；[Gemini 适配](../../../src/ai/providers.ts) 每个请求重置合成计数，缺原生 ID 时可在不同请求得到相同 gemini-call-1。因此不把它直接当持久幂等键，也不让模型承担 ID 管理。
- tool_result 早于 canonical append，不能确认工具结果已正式记录。2026-10-17 修订为同一 completion 短窗口直返/后台通知；tool_handoff 只记交接意图，异步输入用 input_settled.committed。接受故障呈现缺口/同引用补报，不增 tool_result_recorded、不扫描会话，不因缺 ACK 强制全部事件。
- 保存程序是单一 async 入口。内部确切 ref 调用即可防止推荐别名变化，记录实际调用与原生环境即可追溯；当前没有多文件 npm 程序包需求的证据，撤回目录快照、模块作用域导入图和公共原生冲突系统。缺失确切实现明确报错。
- 正常 API 采用同一 callable 描述与调用包装；查询/规划不另建执行器。显式身体作用域给插件和脚本闭包确定寿命，原生/程序共用等待；反馈函数留在脚本域，参数化传感和输出才经数据桥接。

本次不增 Core 记录后事实。Runtime 保存一次结论，Executor 选短直返/后台输入；完成记录与交付处置、decision 历史与当前待处理分别表达。输入 committed 非模型阅读，工具交接非 canonical，render 过滤与 append 不原子；消费 CAS 防旧 decision 再执行。这是设计取舍，不是已测得的成本收益。

本轮只完成静态核实、设计反例审查与文档/类型示例检查；没有运行真实游戏或测量这些方案的速度收益。

本轮必要补查：World invalidation.ensureStream 当前仅支持单一 current/history 依赖，未建混合 Watch/通用时间调度；WorldEvent.render 可返回 null。前者要求 Runtime 不能假称联合监听已可用，后者支持过滤过时 decision，但不保证 render 与 canonical 原子。`contracts/assets.ts` 里的旧 SQLite/CAS 仓库代码仍在树中，但已作废、未接入（现行 Library 是文件库，见 [Library](modules/assets.md)）；`ProgramPort`（旧的 `ProgramExecutionPort`）与容量统计仍是待实现设计。

<a id="driver-audit"></a>

### 2.3 Driver 详细设计的固定源码复核

2026-10-15 对照用户提供的完整 Driver 稿及评审，落入[模块正文](modules/driver.md)。下表是固定提交的源码事实与设计影响，不表示最终依赖已经选定、适配已实现或游戏测试通过。本轮额外重新只读抓取 physics、inventory、pathfinder 和 prismarine-windows 的关键路径；其他依据沿用本次设计讨论已读取的同提交源码。

| 固定源码事实 | 设计影响与未验证边界 |
| --- | --- |
| Mineflayer `7b4bb8d2b56be9cdb832474af873acd37e609746` 的 [physics.js L84–96](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/physics.js#L84) 顺序是 simulate/apply → physicsTick → updatePosition | 反馈观察 N，只能控制未来 M>N；确定的模拟前安装需窄接缝，不能依赖事件监听顺序。桥接延迟、丢帧和实际步数尚未实测 |
| 同提交 [digging.js L121–160](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/digging.js#L121) 在 await lookAt 后启动挖掘，计时完成会本地写空气；[generic_place.js L36–86](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/generic_place.js#L36) 也存在瞄准后的异步派发 | 创建时来源贯穿异步后续；实际预测/写入前重新检查，不能只取消顶层等待。挖掘过程完成与服务端格变化、入包分别核验 |
| 同提交 [inventory.js L576–677](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/inventory.js#L576) 可能等待后才取 currentWindow，现代点击在发包前 acceptClick 做预测 | 同一窗口串行；预测修改前和发包前都核验。Promise resolve、revision 变化不统一当作服务端成功 |
| 同提交 [inventory.js L873–890](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/inventory.js#L873) 有 stateId=-1 的主动全量同步点击，没有完整超时/取消；[L437–446](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/inventory.js#L437) 的旧版关闭还附加窗口外点击 | read 不暗发同步；适配重同步的手势前提、服务端兼容与非空光标后果仍需真实验证，不默认把同步/关闭称为无副作用 |
| pathfinder `d773d15ff1bb271090122b3c7106a519a68bbbd9` [index.js L161–166](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js#L161) 的公开 stop 置标志，[L340–355 / L400–442](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js#L340) 的内部停止事件早于位置/速度修正，free-motion 还可提前返回；[L493–528](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js#L493) 在挖放转换中也使用 fullStop | 完整插件可受控独占，不强制拆成每帧建议；取消屏障另建真实写入封闭。不能为“纯输入”直接删导航修正后宣称算法等价，窄桥/冰面/挖放需对照 |
| pvp `82e19b6ac66555f81d1e8e2f749233b4ae0bac4f` [PVP.ts L72–112](https://github.com/PrismarineJS/mineflayer-pvp/blob/82e19b6ac66555f81d1e8e2f749233b4ae0bac4f/src/PVP.ts#L72) 的停止超时会清共享 pathfinder 目标和 path_stop 监听 | 旧清理必须退役或留在交接屏障内；共享 Body 不能替代协调。战斗算法仍归 Combat |
| prismarine-windows `2.9.0` 对应 `42122d1c70f668b850bd4dfc647dacd2f52e8252`，[Window.js L199–206](https://github.com/PrismarineJS/prismarine-windows/blob/42122d1c70f668b850bd4dfc647dacd2f52e8252/lib/Window.js#L199) 的 drag/doubleClick 未实现，[L242–283](https://github.com/PrismarineJS/prismarine-windows/blob/42122d1c70f668b850bd4dfc647dacd2f52e8252/lib/Window.js#L242) 存在原地 count/cursor 修改 | 协议 mode 合法不等于适配支持；完整窗口不可变快照比较，不能只数 updateSlot。此版本只是核查样本，不是声称 Mineflayer 的依赖范围必然解析为它 |
| 同 Mineflayer 提交的 [blocks.js L263–274](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/blocks.js#L263) 可因光照创建空 Chunk；[API 的 activate/deactivateItem](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/docs/api.md#botdeactivateitem) 说明 release 可发箭 | 当前覆盖按真实数据来源建立；释放不是零效果清理。来源/时间分组及后果记录不能省略 |

据此修正而未扩张的选择：一套写入权威、连续/离散/有状态操作分别表达；可组合与受控独占两种复用；Controller 复用长期 Operation 代次；窗口会话跨多次点击；在算帧与待交付最新帧分开。公共形状只更新 public-api，跨模块行为只更新 contracts；模块算法不进入 Driver，不新建其余模块或通用策略框架。

<a id="driver-targeted-probes"></a>

### 2.4 Driver 定点修订：可执行反例与责任落实

2026-10-15 按“不推翻架构、不新建通用框架”复核 Driver。活动修订集中在模块 §5/6/8/9/10/17/18；公共合同只补兼容子操作的委托语义、可信当前调用、作用域内输入释放和域外终止责任，以及 dig 的 target/preserve 瞄准选项。其他生命周期、当前事实/窗口代次、反馈背压和模块所有权保持原设计。

本次缓存 7 份固定源码（Mineflayer physics/inventory/digging/generic_place/promise_utils，Pathfinder index，PVP 类），保留提交及 SHA-256。完整探针、原始来源、运行输出及修订前文档见[审查证据](../../../.artifacts/minecraft-driver-targeted-20261015T200732/README.md)。Node v24.13.1 / Windows x64 已执行：

| 探针 | 已验证的原始失败场景/执行边界 | 对设计的约束 |
| --- | --- | --- |
| inventory-probe（5 组） | 预测在被拒绝发包之前发生；注入 sleep 后改读新窗；dig 等待瞄准期间 stop 仍会迟发；旧 stop 取消后继；death 删除无关监听 | Adapter 捕获原资源，恢复、预测和发包前复验；每次 dig 独立任务/timer/stop；精准退役监听 |
| plugins-probe（5 组） | Pathfinder 旧 equip 后续仍 dig、全局删监听、path_stop 先于 fullStop；PVP 旧停止超时清新 goal、旧 attack 恢复覆盖目标、同一目标对象复用放过旧攻击 | 完整成熟执行可保留，但所有成功/失败/清理后续都需 Operation 归属；不能只依赖公开 stop 或 target 相等 |
| physics-probe（3 组） | Tick 监听设置的键影响未来步；监听排序改变样本，模拟后改动可进入当前包；无模拟仍可发 tick_end | 在原循环明确模拟前安装、模拟后采样、插件额外修改与发包；实际步不按 timer/包计数 |
| boundary-probe（2 组） | Promise/事件来源不同；将业务代理绑定创建 act 会错误恢复权限；整体堵塞时同域 stop/timer 不运行，父进程可终止并确认其直接子进程退出 | 当前权限由 Runtime 可信绑定；事件适配单独保留原生操作来源。Uina 侧 World 启动者持有终止权并等待 exit，不在 Driver 内自证整体健康 |

分组数量是探针组织方式，不是集成测试覆盖率。以上执行的是固定上游代码与替身依赖，或 Node 原生执行边界；权限 guard 只是示范，没有实现产品 Adapter/补丁或验证真实服务器。Inventory sleep 条件刻意注入，因为当前 digging 的 performance.now 与 clickWindow 的 Date 相减不能推断成自然触发。未运行任何真实游戏、反馈性能或 Uina/Program IPC 权限验收。

补充更正超时判断：固定 [promise_utils.js L48–110](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/promise_utils.js#L48) 的 once 默认 20 秒并经 onceWithCleanup 清监听；外层 withTimeout 是 Promise.race。应补的是 Operation 取消、队列/窗口归属和停止封闭，不能把未显式传 timeout 的调用写成无限等待。该默认时限本轮按源码核查，未做 20 秒墙钟实验。

独立进程监督的归属是 Minecraft World 的受管启动/生命周期代码，不新增 Supervisor 服务。[Node ChildProcess](https://nodejs.org/api/child_process.html#subprocesskillsignal) 的 kill/killed 不等于退出确认；本机探针只证明响应父进程可以终止其阻塞直接子进程。监督方自身退出与进程树保障需额外生命周期绑定；[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 的 kill-on-close 是可用机制，尚未在本项目实现或验证。无可靠退役证明时保持故障、禁止自动接管，服务器已派发效果仍 unknown。

<a id="world-audit"></a>

### 2.5 World 详细设计：交付、切面与历史证据

2026-10-15 根据当前合同、固定上游与独立反例审查建立 [World 详细设计](modules/world.md)。这不是 Minecraft 实现。保留 Driver 当前事实权威、World 历史/领域存储、领域语义所有者、记录 CAS、SQLite 和保守订阅；不修改 Uina Core，不恢复旧机制。

独立判断：保留捕获/跨域发送/接收/持久分层、R/连续 D、Section 和引用保留，否定“RPC 返回即可同步原子”和“所有 read 追平历史”。按实际依赖固定：纯当前不读 DB/pin tail/等历史 F 或 GC，纯历史不请求 Driver；联合查询只有声明同源前缀保证才用证据 fence，并只重验相关版本。当前检查点轻量对账仍保证 read→watch 不漏失效；同域共享材料，不模拟双份 outbox/传输重发；Section 历史与区域读共用，不为全部预测长期留版本。仅明确缺口对账可跨源洞，ACK 不隐去缺口。尚无性能实测证明成本足够低。

后续反例复查确认三处需要补清：最新 stamp 不证明空间范围已分类，未知区间按当前源一次保守失效后推进连续覆盖 C，而非 MAX 空间序号；数据库打不开不应挡当前接入，可信运行期绑定不足时用 unbound，历史/持久写明确降级；Observation.history 按源表达固定接收前缀与同 S 的比较目标，区分 behind/gapped/unknown/caught_up，后者也不代表 durable。未新增 notice 字段/区间日志、第二个 World 服务或全局强 fence。

重新核对固定 Mineflayer `7b4bb8d2b56be9cdb832474af873acd37e609746` 的以下路径，并从干净本地缓存保存原文及 SHA-256，见[源清单](../../../.artifacts/minecraft-world-design-20261015/upstream-manifest.json)：

| 源码事实 | 对 World 的约束 |
| --- | --- |
| [inventory L771–775](../../../.artifacts/minecraft-driver-targeted-20261015T200732/upstream/mineflayer--inventory.js) 先清 currentWindow 再发 windowClose | 后续 sample 无法还原已关闭内容，须原始入口捕获 |
| [entities L292–301 / L381–384](../../../.artifacts/minecraft-world-design-20261015/upstream/mineflayer--entities.js) entityGone 后删除对象，damage_event 只发事件且攻击来源可缺 | 保存出现/离开/事件载荷，不推断死亡或未知攻击者 |
| [chat L113–144](../../../.artifacts/minecraft-world-design-20261015/upstream/mineflayer--chat.js) 即时 emit，未建立可查询消息历史 | 不能靠当前 view/合并 notice 事后恢复聊天 |
| [health L24–38](../../../.artifacts/minecraft-world-design-20261015/upstream/mineflayer--health.js) 更新健康、death 后可随后 spawn | 最终健康值不足以还原中间死亡 |
| [blocks L242–274](../../../.artifacts/minecraft-world-design-20261015/upstream/mineflayer--blocks.js) 卸载列、仅光照可新建空 Chunk | 覆盖按真实方块入包建立；对象存在不是已知空气 |
| [furnace L36–39](../../../.artifacts/minecraft-world-design-20261015/upstream/mineflayer--furnace.js) 关窗移除进度监听 | 到时只安排能力重新取得身体复查，不证明产出 |

SQLite [isolation](https://www.sqlite.org/isolation.html) 与 [WAL](https://www.sqlite.org/wal.html) 支持数据库内部固定读快照，同时说明长读与 checkpoint 的关系；它们不提供跨 Driver 原子性。当前 [WorldActivation](../../../src/extensions/world-framework/world-activation.ts) 提供数据目录和生命周期，未实现本设计的证据/切面协议。

有限协议模型和文档检查保存在[证据目录](../../../.artifacts/minecraft-world-design-20261015/README.md)。原模型枚举落盘/ACK/固定/计算、联合 fence 与 Watch，并用错误 latest DB、活 tail、MAX 和只听未来作反例；它验证需要历史/联合保证时的边界，不要求每个 read 都执行这些步骤。依赖修订另有 dependency-query-probe：枚举历史积压/gap/存储不可用时的当前读取、Driver 离线下的历史读取、联合完整/部分前缀、当前/历史 Watch；检查模型实际访问的依赖与固定结果。运行时间/数量以最新 JSON 为准。两组都不运行 SQLite/真实 IPC/游戏，操作计数不证明实际性能。公开 TS、JS 语法、本地链接/锚点另作静态检查，不执行游戏示例。

availability-watch-probe 另检查 20→21 范围迟到、22先到不能越洞、同 H 不重复自激；DB opening/failed/read_only 与可信/未绑定身份的可用性组合；固定 history 进度及 gap/未知目标；存储恢复不偷换分区。其 passed 仍只属于有限模型，不证明 SQLite 损坏处理、实际跨线程顺序或真实崩溃恢复。

未验证：实际源提取/不可变缓冲、ACK/重传桥接、SQLite 故障和真实断电、父子域同时崩溃、Section 编码复制成本、长期积压/清理闭包、游戏结果与完整原版覆盖。所有保证仍是待实现合同。

<a id="assets-audit"></a>

### 2.6 资产仓库：探索过、已整体删除

2026-10-16 曾按"SQLite 目录 + 不可变对象包 + 发布 CAS"设计资产仓库，并核对了 Node v24.13.1 内置 SQLite 的 BLOB 绑定、Windows/NTFS 的 write-through 与 rename 语义。这些核对本身成立，但结论在 2026-10-18 被推翻：单作者、几百个文件的规模不需要版本目录；目录与内容一致性、孤儿、损坏治理反而是它自己制造的问题。

现在只保留**文件约定**（`programs/`、`blueprints/`、`experiences/`、`runs/`），确切内容由使用方在入场时记录摘要固定，见 [Library](modules/assets.md) §1、§2、§7。随之删除的还有：发布幂等表、证据副本、`AssetRepository` 对象、跨仓库引用。

**未验证项随之改变**：不再需要验证 SQLite 事务/断电，改为验证普通文件库在多进程写入、崩溃中断与并发编辑下的行为（例如 `save` 写到一半、两个进程同时改同一文件），这一项尚未实测。

## 3. 五个参考项目

### 3.1 Cortico

固定提交：`9469daf42cd427b230441a80219b0466dc02488c`。

**源码事实。** [技能契约](https://github.com/Pal-AI-Lab/Cortico/blob/9469daf42cd427b230441a80219b0466dc02488c/src/worlds/minecraft/skills.ts)集中声明技能、参数、队列模式与部分验收条件，由同一来源生成工具表面。`mc_do` 接受预定义技能步骤，执行顺序与依赖、预期效果另有约定；它不是普通语言程序环境。

[身体仲裁](https://github.com/Pal-AI-Lab/Cortico/blob/9469daf42cd427b230441a80219b0466dc02488c/src/worlds/minecraft/body-lease.ts)已经表达连接代次、控制者、效用和失效。不过 `observeLegacyCommit` 只记录是否本应放行，最后仍调用原路径；不能把这个研究快照说成所有身体写入已经强制仲裁。

[Mineflayer 修补](https://github.com/Pal-AI-Lab/Cortico/blob/9469daf42cd427b230441a80219b0466dc02488c/src/worlds/minecraft/mineflayer-fixes.ts)包含合成、挖掘与放置等同步处理。它们提供具体故障线索，但逐项适用的协议版本和补丁必要性需要重新核验。

[世界快照](https://github.com/Pal-AI-Lab/Cortico/blob/9469daf42cd427b230441a80219b0466dc02488c/src/worlds/minecraft/world.ts#L6301)在递送时读取当前状态，按段比较变化，并在首次、重连或上下文截断后补完整锚点。它对“发生了什么、何时唤醒、本次提供什么信息”的区分值得借鉴；Uina 的推荐设计采用纯读的短绝对摘要，不移植其增量基线状态。

**判断。** 借鉴统一能力说明、任务进展与效果证据；不继承固定 Steps 语言、效用仲裁框架或整个认知循环。Uina 的开放性需要普通程序与可扩展玩家接口。静态实现没有提供本次可复现的长期生存成绩，不能据此承诺游戏水平。

### 3.2 Voyager

固定提交：`55e45a880755d0c8c66ca7fb5fe7962ac8974f89`。

**源码事实。** [主循环](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/voyager.py)组织课程目标、代码生成、环境执行、错误反馈和 Critic 判断，再据此继续修复或记录技能。模型控制粒度是一段异步 JavaScript，可使用 Mineflayer 和注入的已有程序。

[技能库](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/agents/skill.py)保存源码与生成的说明，以向量检索挑选代码供模型使用，执行侧组合已有程序。同名技能改写保留文件副本，但活动映射覆盖旧内容；这不等同于依赖锁定和完整版本合同。

**效果边界。** [论文 v2](https://arxiv.org/abs/2305.16291v2)报告相对比较基线获得 3.3 倍不同物品、探索距离提升至 2.3 倍；这是作者实验结果，不是本项目复现。[游戏环境](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/env/mineflayer/index.js)包含保留库存、暂停昼夜、卡住时传送和补发部分工具等便利条件，主循环还调整时间与难度。因此不能把研究中的探索和技能积累直接换算为普通权限、持续昼夜与正常死亡代价下的生存表现，也不能只按提示轮数推导墙钟效率。

**判断。** 借鉴“生成程序—反馈修复—保留复用”的行动空间；复用程序时保留真实证据和固定版本。不移植课程 Agent、Critic Agent 与主循环，因为目标选择与反思已经归 Uina 主脑，也不能用模型判定替代操作核验。

### 3.3 MC Claw

固定提交：`341183035aa6f1b8ce9654f87d98d102a9ce19ed`。

**源码事实。** [动作执行器](https://github.com/mewamew/mc_claw/blob/341183035aa6f1b8ce9654f87d98d102a9ce19ed/bot-service/services/actionExecutor.js)按注册动作分派，汇总执行时间、死亡变化、错误背景和有关经验；正常返回的动作会进入成功日志。它还有连续动作后必须汇报的限制。冻结/恢复 Tick 的调用路径仍存在，但[服务入口](https://github.com/mewamew/mc_claw/blob/341183035aa6f1b8ce9654f87d98d102a9ce19ed/bot-service/index.js)中的冻结实现已禁用，不能据调用或返回字段声称世界真的冻结。这些属于项目交互策略，不是 Minecraft 能力的必需机制。

[复合采集](https://github.com/mewamew/mc_claw/blob/341183035aa6f1b8ce9654f87d98d102a9ce19ed/bot-service/handlers/findAndCollect_improved.js)在一次调用中寻找目标、接近、换工具、挖掘和拾取，并提供背包差异等诊断。但内部采集计数也会在拾取尝试后增加；该计数不能单独证明入包数量。

**判断。** 借鉴常用任务的便利程度与可操作的失败回执；不继承冻结世界、强制汇报次数或固定动作表作为能力上限。复用局部算法前需核查全局 Bot 状态、取消与真实成功条件，不能直接把 HTTP 正常返回接成 Uina 的目标成功。

### 3.4 Mineflayer

固定提交：`7b4bb8d2b56be9cdb832474af873acd37e609746`。

**源码事实。** [物理与输入](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/physics.js)提供本地控制状态和物理循环；[方块插件](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/blocks.js)维护客户端世界并响应方块更新。结合协议与数据生态，它是结构化玩家驱动的主要复用基础，不是完整自治玩家。

[挖掘插件](https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/digging.js)在本地计时结束后发送完成包，并主动调用 `_updateBlockState(..., 0)`。因此 `dig()` 返回或这个本地更新事件，不足以单独证明服务端接受，更不能证明掉落入包。其他操作的确认路径必须分别检查，不能推导成“所有 Mineflayer API 都没有确认”。

**判断。** 直接复用协议、物理、数据和常规交互；在适配边界保留预测与服务端观察的区别。完整 Java 原版是系统目标，不能因为驱动列出某种 API 就认定载具、远程战斗、复杂工作站或新版本协议已经可靠。

### 3.5 Maicraft

固定提交：`b2719b442fe43abe4eee9606c7b019da990c961f`。

**源码事实。** [环境更新器](https://github.com/Mai-with-u/Maicraft/blob/b2719b442fe43abe4eee9606c7b019da990c961f/agent/environment/environment_updater.py)周期查询自身、实体、区域与事件，更新共享环境；威胁路径直接调用 `kill_mob`，并切换模式暂停模型决策。它说明持续状态与即时反应有实际职责，也说明感知更新和行动策略可能产生隐性耦合。

[Agent 主循环](https://github.com/Mai-with-u/Maicraft/blob/b2719b442fe43abe4eee9606c7b019da990c961f/agent/mai_agent.py)从模型文本解析一批 JSON 动作并顺序执行，通过外部 MCP 操作游戏；有关执行路径没有形成 Voyager 式可执行程序生成与检索闭环。[容器缓存](https://github.com/Mai-with-u/Maicraft/blob/b2719b442fe43abe4eee9606c7b019da990c961f/agent/container_cache/container_cache.py)持久保留观察，但坐标键缺少世界与维度区分，不能直接作为 Uina 的世界记录合同。更新间隔的配置也不能证明实际反应频率，尤其更新路径中还等待长动作。

[MCP 客户端](https://github.com/Mai-with-u/Maicraft/blob/b2719b442fe43abe4eee9606c7b019da990c961f/mcp_server/client.py)对部分动作轮询中断标志，在中断或超时时取消客户端异步任务。这证明调用等待被取消；仅凭该文件不能证明远端游戏控制器已经停止或副作用不存在。

**判断。** 借鉴持续观察、重要事件和有关状态的聚合；不移植全局模式、更新器内战斗或 MCP 主循环。Uina 应把观察、策略、控制停止分开，并将实际停止结果反馈给主脑。这里没有本次游戏实测，无法比较它与其他项目的成功率。

### 3.6 横向结论

| 问题 | 参考证据 | 对 Uina 的判断 |
| --- | --- | --- |
| 高频操作交给谁 | Mineflayer 物理循环、采集/战斗插件和 Maicraft 威胁反应 | 本地反馈控制；模型选择目标、策略与委托深度 |
| 开放行动如何表达 | Voyager 的生成代码，相比 Cortico/MC Claw 的固定动作 | 常用动作直接调用，普通 JS 负责复杂组合 |
| 技能怎样积累 | Voyager 保存代码与检索，MC Claw 保存错误经验 | 代码与经验分别保存，关联确切版本和执行证据 |
| 成功如何可信 | 本地预测、复合采集计数和模型 Critic 的不同局限 | 分别确认目标进度、效果来源和未知，不能只看函数返回 |
| 长期运行难在哪里 | 客户端取消、插件全局状态、世界与模式控制 | 控制交接、恢复与信息新鲜度需要专门验收；已有代码不能代替证明 |

## 4. 成熟依赖的复用边界

下列提交用于分析插件行为，不是冻结最终依赖版本。采用时仍需检查许可证、传递依赖、Minecraft 版本与库之间的兼容性。

| 依赖与固定提交 | 已核对的行为与入口 | 建议 |
| --- | --- | --- |
| pathfinder `d773d15ff1bb271090122b3c7106a519a68bbbd9` | [index.js](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js)：目标、Movements、寻路与停止；`stop()` 设置停止请求，实际停止在执行路径结算 | 直接复用导航基础，适配停止完成与当前身体归属；不把停止请求视为确认 |
| pvp `82e19b6ac66555f81d1e8e2f749233b4ae0bac4f` | [PVP.ts](https://github.com/PrismarineJS/mineflayer-pvp/blob/82e19b6ac66555f81d1e8e2f749233b4ae0bac4f/src/PVP.ts)：Tick 更新、追击、攻击、盾牌和停止；会改写 pathfinder 目标与 Movements | 借用近战实现，通过同一控制机制接入；实体离开视距不等于击杀 |
| collectblock `2e3a79cc1ba6d233272287cb8eb54cd74b599099` | [CollectBlock.ts](https://github.com/PrismarineJS/mineflayer-collectblock/blob/2e3a79cc1ba6d233272287cb8eb54cd74b599099/src/CollectBlock.ts)：采集、工具与取消；会设置 Movements、修改相关选项并处理 `PathStopped` | 可复用流程，补齐资源风险策略、入包核验、取消结论和恢复；不能并列成为另一个身体主人 |

`minecraft-data` 和 PrismarineJS 的方块、物品、协议与世界数据优先复用，不重复手写原版数据表。`.schem` 与相应成熟解析库作为蓝图交换候选；格式支持不等于生存施工可靠。

QuickJS/WASM 等隔离运行时只是候选。必须同时验证异步宿主调用、局部反馈成本和强制终止；“隔离进程”“受限 API”“可终止计算”解决不同问题，不能用其中一项代替另外两项。

## 5. 重要替代方案与未采纳理由

以下是设计推论，不是对备选方案普遍优劣的判定；选定行为以 [概要设计](design.md) 为准。

| 选择 | 有竞争力的替代方案 | 推荐与代价 |
| --- | --- | --- |
| 行动表达 | 全固定技能；全部生成代码；独立 Steps DSL | 直接调用与 JS 共用执行机制。前者节省常见任务成本，后者保留创造空间；需要维护清晰的程序接口 |
| 程序操作面 | 暴露原始 Bot；仅允许封闭高级技能 | 受控玩家接口同时开放状态、事件、细操作和局部反馈。需要持续扩展接口，不能以稳定性为由永久阻止新玩法 |
| 身体调度 | 整个任务串行；移动/视角各自竞争；通用效用仲裁 | 完整行动段拥有控制，同一行为协调多个通道；世界过程等待可释放身体。需要处理重新取得控制和迟到工作 |
| 进程边界 | 与 Uina 同进程；每类插件独立服务 | 独立游戏执行进程承载客户端与局部反馈，减少脚本和库故障影响。代价是 IPC、启动和恢复；不让 Tick 往返主脑 |
| 感知路线 | 纯视觉键鼠；额外严格视野模式 | 使用客户端协议结构化数据并标识可见性与历史。纯视觉在特定界面有价值，但不作为所有动作的唯一基础 |
| 能力发现 | 全量 Schema；按当前情况隐藏技能 | 少量稳定入口加按需文档，保留基础能力类别。需要测量额外发现调用和猜参失败的综合成本 |
| 状态投影 | 全量世界快照；每请求推进增量游标 | 短绝对摘要加按需详细查询。重复少量状态，换取重试和压缩后的一致理解 |
| 运行回执 | 一律等待；一律立即返回任务 ID | 短动作尽量返回终态，长动作返回句柄，共用运行记录。具体交互窗口留给测量决定 |
| 程序复用 | 验证后才能发布成 Learned Skill | 保存即可显式调用；证据影响推荐，不作永久认证。调用者仍需理解适用条件 |
| 成功核验 | 函数不抛错；模型 Critic；每层重复验证 | 协议层辨来源，能力核验后置条件，运行管理汇总证据，主脑评价开放意图。需要保留无法确认的结果 |

用户已确认的 Java 范围、协议感知、可调整自保和独立于思考回合的任务生命周期，不在这里重新开放选择。具体库、隔离实现和性能数值仍是待验证判断。

<a id="validation"></a>

## 6. 架构验证场景

下面是应执行的实验设计，**没有在本轮执行**。测试地图可以使用管理员命令布置，受测玩家的正常生存流程不能依赖研究便利命令；必须记录实际启用的规则、难度、死亡代价和服务器插件。

| 场景 | 必须观察的行为 | 主要失败信号 |
| --- | --- | --- |
| 空背包制作石镐并建立基本生存条件 | 主脑规划，能力完成常规机械工作，缺物资时报告具体缺口 | 每一步都重新查询；计数达标但背包不符 |
| 洞穴探索、照明、采矿与返回 | 已知路线、资源与危险记录可用，未知区域明确标识 | 把未加载区域当空气；路线恢复只依赖旧坐标 |
| 采矿时出现苦力怕或坠落危险 | 旧控制停止，本地应对，主脑收到真实进度与损失 | 旧采矿回调继续输出；主脑响应之前持续送命 |
| 诱导僵尸进入自建陷阱 | 主脑调整默认防御，程序组合引诱、移动与机关 | 自保无条件杀死目标；必须新增固定技能才能尝试 |
| 熔炼期间收割与补给 | 投料已确认后释放身体，稍后核验产出 | 等熔炉时阻塞一切；区块未加载仍按墙钟宣称完成 |
| 蓝图施工缺料、冲突、改版与修复 | 现场差异和材料缺口可信；设计修改仍由主脑决定 | 施工器擅自替换设计；重做已经完成的副作用 |
| 自写跑酷与远程战斗策略 | 执行侧反馈能调整控制，失败轨迹可用于修订 | 只能选择预设 `until`；反馈延迟导致操作失真 |
| 未预设红石机关与精确点击 | 方块状态、面与点击位置可表达，流程可组合保存 | “支持原版”但接口不能表达具体交互 |
| 交易或容器转移后立即断线 | 未确认结果保留未知，重连观察后再决定 | 自动重放导致重复消费；断线直接标成功 |
| 多人拿走箱中物资或破坏路线 | 历史记录保留新鲜度，实际操作前检查现实 | 历史库存覆盖新观察；把他人变化算成自身成果 |
| 跨维度返回旧基地、服务器世界重置 | 世界身份、维度、连接代次各自正确失效与关联 | 地图串世界；重连丢全部记忆；旧实体引用继续动作 |
| 多个游戏日的自主游玩 | 回合结束后任务继续，重要事件促成决策，普通变化可合并；主脑可以选择停留或休息 | 不断空唤醒；主脑已选择继续且存在目标时无法接续；上下文持续膨胀 |
| 思考取消、停止任务、停用 World 与全局急停 | 分别验证生命周期含义；后三者停止相关游戏动作 | 取消一次思考误杀全部任务；明确停止后仍自动恢复 |
| 生成程序死循环、插件超时、执行进程崩溃 | 可终止计算，记录在途未知，资源清理与重连后重新观察 | 物理循环冻结；仅杀等待；旧代次回调复活 |

验证分清三类证据：单元和适配测试证明局部合同；真实服务端实验验证协议、控制与恢复；模型游玩实验验证交互成本、创造性和任务效果。三者不能互相替代。

### 6.1 指标与比较方法

| 指标 | 测量方式与解释边界 |
| --- | --- |
| 真实成功率 | 使用服务端或独立观察核验任务目标，报告样本量、种子与失败类别 |
| 效果误报 | 分别统计未完成报成功、效果未知却报确定、实际完成却报失败 |
| 控制响应 | 从危险/停止信号出现，到停止请求、旧输出终止和新控制生效分别测量 |
| 恢复表现 | 统计已完成工作保留量、重复副作用、未知结算和恢复后的剩余工作 |
| 实时表现 | 测量反馈延迟与抖动，覆盖服务端卡顿、网络延迟和脚本负载 |
| 综合成本 | 墙钟时间、模型往返、输入/输出 Token、工具与能力发现调用、错误修复次数 |
| 复用收益 | 相同及变化条件下比较新写、复用、修订后的成功率与成本；不能只数保存了多少技能 |
| 长期稳定 | 记录连接、内存、监听器、运行记录增长、事件重复和状态摘要规模 |
| 自主性 | 检查能否改变委托、调整策略并完成未预设玩法，不用“LLM 决策次数占比”替代 |

比较动作库、程序组合和底层控制时保持模型、游戏规则、初始物资与目标一致。结果按条件分组，不把任务选择更简单或研究环境更宽松误认为架构提升；不在概要设计中编造统一达标数字。

### 6.2 公共契约的专门检验

下表检验概要设计新增的协作语义，仍是待执行要求，不是已通过的测试。合同只在 [设计正文](design.md) 定义，本文不另设一套规则。

| 契约场景 | 应检验的边界 |
| --- | --- |
| 直接调用、JS 内调用与保存模块调用同一能力 | 参数、领域值、效果核验和取消含义一致；内部调用不重新提交顶层任务 |
| 木材不足后捕获领域失败并换树种 | 已完成数量保留，替代路径计算剩余目标；原失败不被清零或洗成成功 |
| 捕获未知交易效果后程序正常返回 | 未核验效果仍在，拟成功的结果不洗成确定成功；已确认取消或失败可保留对应结论及未知效果；新观察只证明其实际支持的结论 |
| 世界等待期间另一个行为取得身体 | 旧窗口和输入已释放；等待结束按新的就绪时间排队，取得身体后重新核验 |
| 排队、替换未开始项与显式抢占 | 普通请求不抢身体；替换不清掉有进度的运行；抢占后旧控制停止再交接 |
| 同一决策被继续两次或运行已终止 | 同一请求幂等；过期决策拒绝；新段保留原运行与证据，终态不复活 |
| 新模块版本在旧运行期间保存 | 旧执行段实际依赖不变，新运行或明确换版的新段按引用解析；缺失版本在有关副作用前报错 |
| 等待中的生成程序动态调用模块，再明确换版继续 | 动态名称使用原段映射；继续默认继承，明确换版只影响新段，原段证据不改写 |
| 本地反馈函数卡死、延迟或取消 | 心跳与停止分发不冻结；旧输出失效，不无限保持最后输入 |
| 已受理停止或急停时进程重启 | 保留停止意图与未知效果，不按普通崩溃恢复策略重新启动游戏动作 |
| canonical 成功但 ACK 前崩溃、旧通知缺 render、回溯 | 允许同 completionRef 补报，旧 placeholder 退役不关闭新尝试；不靠扫描全会话实现恰好一次 |
| 旧插件 equip/放置回调或 stop 超时跨控制交接 | 保留创建时资格，旧清理不能改新主人目标/输入/窗口，直接物理写入也受控 |
| 显式调用同名程序不同确切版本，旧原生环境不可用 | 普通程序版本可组合，确切实现缺失明确不可调用，不静默换到新版 |
| 换版继续使用不兼容检查点或变更目标设计 | 在新段副作用前拒绝/明确迁移；历史工作与当前目标进度分别保留 |
| 同连接重用实体/窗口 ID、重生或切换维度 | 活引用按出现/打开/身体代次失效，不仅比较连接或数字 ID |
| 部分扫描/稀疏蓝图与旋转后恢复 | unknown/preserve 不变 clear；坐标与 Block State 一起转换；迁址不混两处工程进度 |
| 直接回执与终态通知交界处失败 | 正常路径不重复决策；异常路径可按同一运行引用查询或补报，不宣称跨日志恰好一次 |

概要设计审阅应沿这些流程确认下一步由谁负责、何时取得或失去控制、返回什么以及证据保存在哪里。只有功能覆盖词语和原则，不足以证明合同闭合；也不需要为了这项审阅冻结实现类、完整参数 Schema 或超时常数。

## 7. 尚未验证的关键判断

1. **控制交接是否真正封闭。** 所有插件、临时会话和生成控制逻辑必须经过同一生效边界；需观测停止确认后的迟到动作，不能只测试 AbortSignal。
2. **哪些事实能达到什么确认程度。** 按动作与协议版本审查来源；无独立可用确认时保留较弱证据，不能假定存在统一的服务端成功回执。
3. **隔离执行与反馈是否兼容。** 验证异步宿主调用、事件订阅、局部循环、计算终止和异常清理；不提前认定某个引擎足够。
4. **能力开放面是否足以覆盖玩法。** 除常规任务外检验载具、生物、复杂 GUI、附魔酿造、特殊战斗、红石和跨维度；发现驱动缺口时扩展适配，不能仅增加技能名称。
5. **LLM 交互是否降低综合成本。** 比较直接调用、按需文档和普通程序；检验模型能否正确理解受理、进展、未知与历史状态。
6. **持久化能否支持真实恢复与改进。** 重连、重启、世界重置和依赖更新分别实验；保存代码与日志本身不证明持续学习有效。

<a id="draft-migration"></a>

## 8. 六份原稿的归并与删减记录

原稿文件名仅作来源标识，不保留旧编号链接或占位文件；完整原稿另存于本次整理的 `.artifacts/` 时间戳快照。新文档不继承原稿“规范”“定案”或版本号所暗示的批准状态。

| 原稿 | 保留并归入 | 调整、删除及理由 |
| --- | --- | --- |
| `1.md`：工程设计规范 | [目标](design.md)、[架构](design.md)、[感知](design.md)、[持久化](design.md)；核心场景移入本文第 6 节 | 取消阶段排期、完整类型与目录施工方案；改正全任务串行、强制自保优先级和“一份全知事实” |
| `2.md`：工具、技能与内核边界 | [接口](design.md)、[控制](design.md)、[结果](design.md) | 去掉独立 Steps Runner、通用只读预演与多层重复核验；功能规划由具体能力提供 |
| `3.md`：程序资产与成长 | [复用](design.md)、[持久化](design.md) | 保留代码留存、版本、检索、修订与证据；取消 Routine 必须验证发布后晋升 Learned Skill 的身份链 |
| `4.md`：精细控制 | [程序](design.md)、[控制](design.md)；精细操作场景移入本文第 6 节 | 去掉实现伪代码和 Tick 常数；有限终止条件不作为局部反馈的唯一入口 |
| `5.md`：Program API | [程序](design.md)、[接口](design.md)、[感知](design.md)、[结果](design.md) | 不冻结完整函数目录；开箱核验属于行动；程序输出计数不直接代表实际效果；不要求每次等待任意超时 |
| `6.md`：逻辑架构 | [架构](design.md)、[控制](design.md)、[运行流程](design.md) | 保留纵向功能组织与依赖方向；不用三套 Registry 扩张基础设施，删除阶段实施安排和过早类型定义 |

原稿中的建筑扫描、蓝图导入导出与修订、几何建造、补光与临时支撑、物资规划、长期世界过程、事故恢复和跨次游玩需求仍属于目标能力。原稿中的能力名称用作覆盖线索，不构成封闭操作清单；具体执行与数据归属由概要设计集中说明。

无意义的图标外链和空附件目录删除；功能无关的排版不存成新历史文档。研究记录保留重要取舍的依据，概要设计保持唯一完整方案，入口只负责导航和状态。
