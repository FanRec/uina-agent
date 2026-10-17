# QQ World 阅读、关注与通知实现审查

2026-10-11 修复状态更新：下文保留修复前审查证据与旧行号。A01～A17 已获当前工作树源码和自动化修复证据，逐项验收与边界见 `../qq-world-acceptance.md`；本报告不再表示当前实现仍有全部原缺陷。真实 QQ 不可连接，平台验证未完成。

审查日期：2026-10-11，Asia/Shanghai。源码基线：`edfda45`。

原审查结论（修复前）：9 个领域积木的接口迁移已经完成，主要存储与扩展接缝成立；行为验收尚未完成。当前实现存在可复现的正文漏交付、未读封存、通知停摆与组合接口断路，不能依据“P6 封关”或现有测试全绿认定设计已全部实现。

本次使用 code-simplifier 技能审查职责、复杂度与可维护性。任务以核查现有实现为主，没有改动 QQ 实现或 Core，也没有借简化改变运行行为。设计 §9 的 R1~R7 优先于前文；明确裁剪的 leave_group/remove_contact/set_presence/mark_read/update 等不算缺陷。单一 `qq` facade 分派 9 个领域动作本身符合本项目的组合方式，不需要为满足工具数量而改成 9 个独立注册工具。

## 证据与复现

读取了项目基线、运行事实、设计与 devplan；核查调用链：World activation → QQ 装配 → transport/ingest → journal/control → scheduler/render → Subject 延迟求值与 input_settled，以及 facade → reader/行动执行 → 操作日志与媒体展开。

- `pnpm typecheck`：通过；格式检查 330 文件、8 条边界规则、TypeScript 检查通过。
- `pnpm exec vitest run qq-world tool-validation-diagnostics`：20 个文件、362 项通过。
- 独立对抗式复现：17 个需求性质断言全部失败，均为下面列出的具体反例。第一次草拟 F09 时测试同步屏障不完整，已修正为等待锁真正取得后再取消；这里只采用修正后的结果。
- 测试只使用临时目录、假传输与假时钟。F17 的 fetch 被替换，不访问实际 URL。没有运行 QQ 主进程或真实 Provider，没有读写真实会话、账号配置、认证、QQ v2 数据或 Pi。

复现文件：`docs/history/qq-reader-notification-review-2026-10-11.probes.test.ts`；17 项失败摘要保存在同目录的 `qq-reader-notification-review-2026-10-11.results.json`。单独运行：

```powershell
pnpm exec vitest run --config docs/history/qq-reader-notification-review-2026-10-11.vitest.ts --reporter=verbose
```

复现断言描述预期行为，在原审查源码基线上失败；修复后的正式测试见 tests/qq-world-regressions.test.ts。原独立 probes 留作历史；正式 F01～F17 已纳入普通 `pnpm test`。`docs/history/` 按项目已有 `.gitignore` 属于本地审查材料。

## 已确认缺陷

### A01 / P1：跟读会遗漏整条消息，却把全部消息记为已派发；字符过载阈值未实现

位置：`.uina/worlds/qq/src/render.ts:526-560`；`scheduler.ts:525-538`。

`renderFollowBody` 超预算时从最旧消息开始删除整条行组；调度器没有取得实际交付范围，而是直接用 `latestSequence` 推进消费书签。与 `read` 只推进到实际交付位置的行为不一致。

F01：10 条各约 1,900 字的消息，总正文超过 14,000 字；返回中第一条的唯一标识消失，书签却推进到 seq 10。后续 `read` 无法接续取回这些被遗漏的整条消息，必须额外猜测并历史回查。省略说明不能代替整条正文派发，也不能把系统裁剪等同于主体主动 skip。

F14：一条 20,000 字正文返回长度 20,075，仍推进到 seq 1，没有过载退让。当前只检查 `pending > 30`，不检查字符量，恢复挂起也只检查条数。降压分支只返回单会话提示，没有规格要求的全局摘要。

最小修复：复用现有 `renderReadWindow` 的按序选择与交付范围，不另造第二套消费窗口；字符/条数双阈值统一使用未派发缓冲。让 World 层渲染成果携带交付位置，调度器按成果记账，不再猜测最新位置。局部接口足够，不需要改 Core。

对应：§2、§4.2、§5.4、R1、T03/T07/T11。

### A02 / P1：延迟跟读不重验 focus/push，且已消费后的跟读不会空退役

位置：`scheduler.ts:192-200,318-323,484-542`。

候选在事实到达时决定为 follow，之后 closure 固定使用这个分类。出队时没有重新检查 `effectiveFollow` 或有效暂停/静音。`isMessageDerived` 排除了 follow，因此后面的 follow 空消费检查实际上无法进入。

- F02：follow 占位入队 → `focus=[]` → 求值仍返回 `[QQ 跟读]` 并消费正文。
- F03：普通通知占位入队 → `push.mode=off` → 求值仍返回纸条。
- F04：follow 占位入队 → `read` 已消费完 → 求值返回“无未消费正文”的非空文本，开启无意义回合，而非 `null`。

最小修复：在消费锁内重验当前关注、有效偏好和待处理窗口；失去跟读资格时按当前守护规则降级或退役，清空窗口返回 `null`。通知轨同样在求值时重验当前静音/暂停。

对应：§1.2、§5.3/§5.4、T12/T13。

### A03 / P1：新会话的首次重启会把正常未读封存

位置：`index.ts:110-115,183-192`；`control-store.ts:234-247`。

基线只在 World 启动时为已有会话建立，进程运行期间新出现的会话没有写入基线。因此下一次启动把该会话误当成迁移旧历史，以当时最新 seq 封存。

F06 使用完整 World 生命周期：启动空账号 → 收到新群消息 → inbox 显示 `pendingCount=1` → 停止并重启同一 World → inbox 变成 `pendingCount=0, archivedCount=1`。主体没有 read/skip，却失去了这条正常待读消息。

最小修复：区分迁移时已存在会话与上线后新建会话；新会话接收首条新消息时持久建立 0 基线。一次迁移不能在后续重启重新解释正常未读。

对应：§6.4、R4、T10；现有基线单元测试只证明 ensureBaseline 不覆盖，没证明装配层及时调用。

### A04 / P1：自身发言回送能压制对方的第一条新消息通知

位置：`scheduler.ts:40-47,188,204-211,223-228`；`ingest.ts:80-81,110-116`；`message-codec.ts:133,161`。

消息日志同时保存 `in` 与 `out`；`pendingCountOf` 对所有未派发消息计数。self echo 分类时不唤醒，却留在待处理计数内，导致下一条真实入站的 `pendingBefore` 已大于 0。

F05：先记录自身出站 echo，再收到一条普通群消息，等待 2.5 秒没有任何通知。私聊在不足 10 分钟且非 reply_self 的相同场景也沿同一分支被静默。这直接影响“主动先发言、对方再回复”的核心使用方式。

最小修复：历史保留自身发言，提醒资格和待处理计数只统计需要主体处理的入站事实。统一计数语义，而非为 echo 特设第二套游标。

对应：§1.1 主动参与、§5.1 首次未读通知、T01A。

### A05 / P1：render 的暂时异常会丢失首条消息提醒资格

位置：`scheduler.ts:510,544-548,437-458`。

派发前删除候选；render 捕获错误返回 `null`；retired 后只清占位，没有恢复候选或重新计算未提醒事实。后续普通群消息因待处理已经大于 0 也不能重建资格。

F07：render 临时抛错 → 返回 `null` → 修复渲染依赖 → retired、tick、agent_settled → 没有第二次投递。

最小修复：区分“已被消费的空退役”与“渲染失败的空退役”。失败保留或恢复候选，并按已有短脉冲节奏重试；避免立即重派形成忙循环。R7 的不向 Core 抛错仍应保留。

对应：§6.5 自愈、R7。

### A06 / P1：通知结算写盘失败会卡死整个 QQ 通知占位

位置：`scheduler.ts:437-458`。

`recordNotified` / `markReviewNotified` 在清除 placeholder 前执行；异常没有隔离或 finally。宿主即使捕获监听器异常，也不会替 QQ 清理占位。

F08：成功求值后注入 `recordNotified` 的 EBUSY → committed 回调异常 → `inFlight` 仍是原占位。该 input 已经结算，之后的新事实被占位挡住，通知无法继续派发。

最小修复：将占位生命周期释放与持久记账重试分开；保证结算总能释放占位，记录待补结算并按 World 周期重试。不能让一个已终结输入继续拥有锁存状态。

对应：§6.5 自愈与文件锁异常处理。

### A07 / P2：已有占位不能吸收新直接互动并升级为最新紧急现场

位置：`scheduler.ts:387-404,512-542`；`render.ts:383-486,765-778`。

闭包固定捕获所选 candidate；`offer` 更新的是 pending map，没有更新占位待渲染候选。读取最新消息列表仅刷新正文，不能刷新 candidate 的 trigger/eventRefs/requestRefs。

F10：群 A 普通纸条已排队 → 群 B 收到戳自己的 poke → 求值第一张纸条不含 poke 事件。B 没有新正文时连概览也看不到。poke 留待另一张纸条，并非规格要求的现有纸条内部升级。相同会话的 poke 也不会凭最新消息列表得到事件引用。

最小修复：占位只持有唤醒身份；求值从 World 当前 pending 快照选择并合并触发事实，在 QQ 纸条内部置顶直接互动。保留跨来源 FIFO，不增加 Core 抢占。

对应：§5.3、T02。当前 T02 只断言新消息文本出现，未断言 trigger 升级或 poke 事实出现。

### A08 / P2：到期事项的渲染快照与记账快照不一致，造成重复提醒

位置：`scheduler.ts:450-456,551-561`；`render.ts:751-764`。

followUpRefs/operationRefs 在入队时捕获，渲染却在出队时读最新全量。记录“已提醒”的对象不一定等于实际纸条呈现的对象。

F15：A 到期并排队 → B 到期 → 同一次求值文本已包含 B → committed 后 B 的 reviewNotified 仍为 false → 下一轮还能再次提醒 B。迟到回执集合使用同一类前后快照分离方式，也需要一起修正。

最小修复：在 render 求值时冻结本次实际呈现的提醒/操作引用，用这份成果做 committed 记账。排队后全部事项被 resolve 时，空成果应退役。

对应：§4.7 仅给一次查看机会、§5.3 延迟新鲜度。

### A09 / P2：暂停恢复路径仍沿用旧通知游标，把已读正文报成未读

位置：`scheduler.ts:357-364`；`facts-journal.ts:331-357`；`render.ts:659-665,805-821`。

新主路径用消费位与基线计算 pending，但暂停资格判断用 `hasUnread`，摘要用 `unreadCount`，两者仍基于 notifiedThrough。书签分轨后这不再等价于未消费。

F16：消息已通过 read 消费 → 设置已到期暂停 → tick 仍产生“暂停结束积压摘要”。封存历史也可进入这一旧路径。全局 `hasUnread` 还会让一个无积压会话的暂停到期被其他会话触发。

最小修复：恢复摘要复用消费位口径与当前有效推送范围；旧方法若保留，应明确命名为“未通知数”，不能输出“未读/待处理”。

对应：§2 双轨真实性、§6.4 基线、§6.5 零无意义打扰。

### A10 / P2：requests 续页断路，完整列表不能只读遍历

位置：`app.ts:900-925,940-947,1088-1090`；`tool.json:436-474`。

内部 listResult 默认每页 20 并返回 nextCursor；对外 requests schema 不接受 cursor/limit，handleRequests 也不透传。复制工具给出的续页线索会被自己的 schema 拒绝。

F12：21 条申请 → 第一页 20/21，返回 nextCursor → 通过真实 createWorldTool 调用 requests list+cursor → 参数校验失败。主体只能先处理/改变前 20 条才能碰到后面的条目，无法纯查询比较全体申请。

最小修复：保留明确可用的分页合同并透传；或明确返回完整受预算呈现的列表与有效续页方式。不要返回无法消费的 token。

对应：§4.8、工具组合完备性。

### A11 / P2：实际返回文本仍指导模型调用已退役 observe

位置：`render.ts:334-339,452-476`。

F13：JSON 卡片触发的实际通知包含 `observe scope="content"` 和 `observe(scope="conversation",...)` 指引。这些 action 已被 facade 删除，新 tool schema 会拒绝。此问题同时影响 read/browse 的富消息行，因为它们复用 contentSelectors。

最小修复：所有展开指引使用真实 `qq` 调用形状，例如 `{action:"browse",params:{contentTarget:{messageRef,segmentIndex}}}`；继续消费用 read。只保留日志内部审计 identity，删除模型可见的退役入口。

对应：P6 旧 action 退役、§4.4。devplan 所称“批次文案已改指 read/browse”与当前源码不符。

### A12 / P2：等候消费锁期间取消 read，仍会消费并返回成功

位置：`reader.ts:171-178`；`conversation-lock.ts:14-34`。

F09：另一动作持有会话锁 → read 开始等待 → AbortSignal 取消 → 释放锁 → read 继续推进到 seq 1，返回 succeeded。锁本身正确排队，问题是读操作在取得锁后没有重验取消。

最小修复：取得锁后、读取和持久推进前重验 signal；未开始消费的取消如实返回 cancelled/not_started。无需改通用锁或 Core。

对应：§2.1 持锁时序、打断边界。此反例不是“已成功派发后回滚书签”的要求。

### A13 / P2：browse 点查/历史分支忽略 includeMedia

位置：`reader.ts:271,281-305,336-364`；`tool.json:235-238`。

仅 contentTarget 分支使用 includeMedia；messageRefs 与 direction 分支直接返回文字，虽然 schema 接受该字段，grant 也因此检查 observation。

F17：本地图片消息 → browse messageRefs+includeMedia=true → 假 fetch 调用 0 次，images 未返回。参数被接受却不兑现能力，也没有告知只对 contentTarget 有效。

最小修复：复用已有媒体展开与图片标签函数；或在合同中限定到具体模式并明确拒绝无效组合，避免静默忽略。

### A14 / P2：1~2 秒后入队的承诺在主体忙时不成立

位置：`scheduler.ts:462-478`。

F11：isBusy=true → 普通首条消息短防抖到期 → 没有 emit，没有 notice_enqueued。候选要等 agent_settled 且不忙才有机会派发。

这把延迟从 1~2 秒拉长到当前活动的剩余时间；也让 QQ 自己模拟“是否可入队”的调度，而规格要求的是先进入邮箱，再按 FIFO 等待出队求值。当前实现有延迟渲染函数，但忙时占位根本未进入 Runtime 队列。

最小修复：短防抖完成后投递单一占位，运行时邮箱负责出队时机；QQ 保持快照与自合并，不承担 Subject 忙闲调度。

对应：§5.1/§5.3、T01A。

## 源码核查确认的缺口（未做真实平台验证）

### A15 / P2：断线覆盖事实没有实现接线，T05 的 gap 分支未被证明

`reader.ts:338-339` 只根据 archiveBefore 与消息时间判 gap；事实记录没有 gap 区间类型，World transport status 只写连接事件，没有把弱缺失信号转为 coverage 的路径。`recordArchive` 是归档标记，生产 QQ 路径没有调用；不能把它当作重连错误覆盖记录。`messageRefs` 分支还以“本地点查都找到”直接输出 continuous，不读取覆盖标记。

R6 并未要求从 OneBot ID 猜缺失，只要求显式弱信号的诚实记录与展示。当前没有这一实现，也没有相应注入测试。不能声称连续即平台完整；没有信号时应明确本地覆盖已知边界，确有信号时记录并查询相关区间。

证据：`facts-journal.ts:19-37,191-194,316-318`；`index.ts:224-246`；`reader.ts:300,338-359`；`transport.ts:29-30`。

### A16 / P2：收件箱/全局概览不完整，活跃探索能力缩水

inbox 只枚举 journal.messages.keys，不包含仅有事件或刚关注但无消息的会话，不查询好友/群目录，也不给会话名。旧 contacts/groups/conversations 删除后，这些发现能力没有新的模型入口。主体知道引用时可以主动 send，尚不能通过工具发现从未在本地出现的好友/群，或读取本地没有保存的会话历史。

inbox 最多 50 行，没有会话筛选或续页，超过 50 的较旧会话无法通过本工具只读遍历。situationalOverview 在默认预算下最多使用 600 字，按 map 插入顺序截断，缺少未读互动计数及紧急会话排序。因此“全局所有待处理会话”和“会话名、含几次 @你”的要求只部分落地。

最小方向：先明确收件箱的可发现集合与遍历合同；必要的目录查询放回现有查询积木内部，避免恢复旧 12 scope 或扩张成 36 工具。正常通知用真正的概览，详细正文交由 read/follow；目前普通纸条沿用完整现场渲染，可能一次推送近 14,000 字后又让 read 重复交付相同正文。

证据：`reader.ts:101-138`；`render.ts:383-486,492-518`；`app.ts:929-962`。这是源码可见的能力边界，未证明真实平台历史 API 的可用性。

### A17 / P2：qq-status 的“只读、真实诊断”声明不成立

脚本调用 journal.recover 会创建日志/截断不完整尾行，control.load 会迁移旧控制文件并写盘；不是纯只读。unknown 操作数被硬编码为 0，focus 是新 AttentionModel 的空集合，也不能代表运行进程。存在 Subject profile 时，实际 World 根为 `subject.stateRoot/world-data/qq`，脚本固定读 worldDir/v2，可能读另一个目录；注释还指向已退役 observe.operations。

没有执行此脚本，避免碰真实数据。最小方向：使用明确数据根、只读解析、实际操作日志的 count；无法观测进程内 focus 应返回 unknown，不要制造空焦点事实。恢复/迁移留给生命周期所有者。

证据：`scripts/qq-status.mts:23-36`；`jsonl-log.ts:34`；`facts-journal.ts:101-113`；`control-store.ts:121`；`src/extensions/world-framework/world-activation.ts:99-104`。

## 验收结论与测试边界

| 需求组 | 当前证据 | 审查裁定 |
| --- | --- | --- |
| 9 积木 facade、绑定账号、旧 action 裁剪 | schema/fixture/装配与执行路由存在，常规测试通过 | 接口迁移成立；返回指引与部分参数尚未收口 |
| 通知轨与消费轨分离、单调 seq、锁 | dispatched/notified/skipped 分轨，锁异常释放正确 | 基础机制成立；出站计数和旧恢复路径破坏统一语义 |
| T01 首条/短防抖、私聊复苏 | 常规测试成立；F05/F11 暴露反例 | 条件性成立，不能全场景封关 |
| T02 升级延迟纸条 | 只证明消息文本新鲜；F10 事件升级失败 | 不完整 |
| T03/T04 读/跳过 | 顺序 read、部分 skip、latest skip 有有效测试 | 主路径成立；F09 的锁等待取消需修 |
| T05/T15 浏览与优先级 | contentTarget 优先级与本地锚点窗口成立 | gap 弱信号未接线，媒体部分模式未实现 |
| T06/T13/T14 关注/继承/重启焦点 | AttentionModel 单元性质成立 | F02/F03 说明真实延迟投递未遵守动态配置；不能等同端到端验收 |
| T07/T11 跟读交错/打断 | T07A 直接写 dispatched 模拟 follow，另测 read-read 并发 | 尚未证明真实 follow-read-store 链路，且 F01/F14 已证实漏交付 |
| T08/T09 外部行动 | 真实实现有 durable intent、回执、unknown、所有权检查；fake 测试通过 | 存储与协议模拟证据成立；真实 QQ 对端效果未验证 |
| T10 冷启动迁移 | ensureBaseline 单元测试成立 | F06 证明新会话生命周期不成立 |
| T12 空退役 | 普通通知分支单测成立 | F04 证明 follow 分支失败；异常不能冒充无内容 |
| 到期事项/自愈 | 有 tick、一次提醒字段、render catch | F07/F08/F15/F16 证明恢复与快照结算不完整 |

规格矩阵编号还存在纯文档问题：T01A/B、T04A/B、T07A/B 拆开后共 18 行场景，不是 §8 声称的“16 项”。编号本身不证明端到端覆盖；devplan 的 P3/P4 状态栏与 P6 封关声明也需按实际证据收口。

## 第一性原则与最小修复顺序

工具积木不仅要有一个清晰名字，还必须满足输入能兑现、输出可被下一工具合法使用、失败不暗改成功事实、查询可以完整遍历。上述问题集中在这些组合契约，而不是积木数量。

系统根因有四类：渲染正文与交付边界分开推断；一次性基线缺少新会话生命周期；可变注意力/候选在错误的时间点冻结；旧通知游标与旧文案残留在新消费体系。单独修文案或加更多 facade 无法解决。

建议按依赖关系处理：

1. 先修 A01/A03/A04/A06，守住消费事实、正常未读、入站资格和占位释放。
2. 共用顺序窗口，修 A02/A05/A07/A08/A09；让一次 render 产出文本、交付范围、通知事实引用，结算使用同一成果。
3. 修 A10/A11/A13/A16 的可遍历性、参数兑现与可组合指引，去掉失效入口；修 A12/A14 的时机边界。
4. 接好 R6 弱覆盖事实，修只读 CLI；逐项补真正穿过 World/Subject 的 T02/T07/T10/T11/T12/T13/T14 测试，再更新封关结论。

保持 9 积木、现有 Extension/World 边界与 Core 零侵入；无需权限新系统、认知消费推断、分布式事务或第二套阅读器。校正：`reader → scheduler → render → scheduler` 的运行时 import 环不成立，相关引用是 type-only，scheduler 没有运行时 import render。真实维护性问题是消费查询职责位于 scheduler；将其移到 World 的 consumption.ts 可解耦，但不能把它描述为修复运行时 import 环。旧内部账户分支可按职责平铺成直接领域处理函数，操作日志 audit identity 保持稳定，不必为保留旧入参形状再套一层映射。

## 工作树归属

开始时工作树干净。本次新增的报告、复现与独立配置均位于被忽略的 `docs/history/`；临时测试已从常规 tests 目录移出，临时结果 JSON 已清理。未修改 QQ 生产源码、Core、Pi、配置、认证或真实数据。

审查期间出现 `.uina/worlds/live2d/director/director.ts`、`.uina/worlds/live2d/endpoint.ts` 与 `.uina/worlds/live2d/runtime.ts` 的并行修改，它们属于用户/其他任务，本次未触碰，也不归入 QQ 审查成果。未运行全仓测试、真实 Provider、真实 TTY、真实 QQ 或长期负载验证。
