# 设计变更记录

## 2026-10-22 · I1 原生化重构：K1 回退、缺陷修复与结构收口

- **K1 能力子集整批回退**：`capabilities/{mine,place,knowledge,body-common}.ts`、`contracts/knowledge.ts`、`driver/registry-knowledge.ts` 删除，`package.json`、`public-api.md`、`modules/capabilities.md` 一并回到 10-21 之前的 I1 口径；不保留兼容层，也不把草图当后续基准（`KnowledgeSource`、`body.attack` 的 `targetHurt`、equip 护甲槽等增补随之作废）。现行实现是 5 查询（self/inventory/block/blocks/entities）+ 2 动作（chat/goto）。
- **Body 申请收敛为单槽 FIFO 队列**（`runtime/body-queue.ts`）：同步占槽、单在途 acquire、授予前复验 `signal.aborted || !isOwnerLive(owner)`。修掉两处：同 tick 两次 acquire 都看到"无持有者"而双持有；Run 停止后排队/在途申请仍被照常授予并执行 work。
- **证据释放水线只统计证据消费者**：新增 `ClientFactsSubscribeOptions.consumesEvidence`，释放水线只在登记为消费者且处于同一 stream 的接收方之间取最小值。修掉 CurrentWatch 不 ack 导致水线永不推进（有界缓冲被无谓耗尽、按溢出报假缺口），以及 `acknowledge` 忽略 `ack.stream` 使旧流高位释放新流证据。
- **self 事实不造值**：`SelfState.health`/`food` 改 `number | null`，读不到即 unknown + 声明；`inWater`/`inLava` 改读客户端物理写在实体上的判定结果，不再按脚部方块名推导（waterlogged、气泡柱、流动水此前全错）。断线报 `unavailable`，不再报 `starting`。
- **完成语义如实**：dig 的 receipt 不再声称 "server block update confirmed"——I1 不区分本地预测与服务端更新，改为如实陈述并标 `client_block_update`；dispatch 失败不再记 `sent`。drive 任何退出路径（正常/停滞/中止）都撤键并释放 hold 使用，不再只在成功分支清理。
- **ref 发号带启动命名空间**：`ev:`/`gap:`/`body:`/`op:`/`eff:` 此前每进程从 1 发号，与持久历史库主键跨启动冲突；`world.md §5.3` 的命名空间规则统一到全部发号点。
- **查询校验统一到 schema**：能力输入交给本地 Ajv 实例编译 `descriptor.input`，删除手写的 sections 范围、整型向量与空输入检查；`ItemSelector.components` 这类未实现匹配显式 `INVALID_INPUT`，不再静默忽略。
- **结构收口**：新增 `driver/execution.ts`（EffectRecorder + fail）、`runtime/state.ts`（RunState/CallState 形状）、`runtime/rows.ts`（投影与持久行的纯函数）、`driver/facts/{index,view}.ts`（挂接与水线 / prismarine 值捕获分离）。engine 1613→1240 行、facts 754→408 行；三处 `recordFact` 转发层、两份逐字相同的 `fmtVec`/`fmtPos`、`fail`/`plain`/`nowIso` 的重复副本删除。
- 验收：`tsc --noEmit`、`check-boundaries`（9 规则含反证样例）、`tests/mc` 9 files / 46 tests 全绿；`tests/mc` 首次纳入版本库。**真服未复验**，本轮修复全部只有确定性单测覆盖。

## 2026-10-19 · 总开发规划与开发规范

- 重建总开发规划：先落实最小共享接缝，再并行推进正式基础设施，设原生真实闭环与完整主脑闭环两个集成节点；覆盖全部 16 查询 + 35 动作，按实际依赖组织八组玩法。
- 明确 Host 回执/v4、Minecraft 类型/构建接线和真环境基线的实际缺口；领域详细设计到工作包开始时补齐，不把基础设施也留到集成末尾设计。
- 新增开发规范，统一接口/资源/真实结果、成熟代码复用、局部重构与验证选择；取消每条能力都先做假 Bot 再跑真服的施工要求，不新增测试/插件框架。
- 将规范接入 README、概要和实现目录 LEAD；仅修订规划与规范，未开始产品实现。

## 2026-10-18 · 补全模型感知与交互

- 新增 events@1、players@1、map@1 三个查询；目录为 16 查询 + 35 动作（P0 23、P1 18、P2 10）。事件复用历史/提交/Watch，明确增量位置、分页、缺口与等待；名单不等于实体，地图不推断中心。
- 获取来源并入 item.sources，实体探索并入 explore，告示牌读写并入 block/use；补齐 SelfState 与反馈。没有新增科技树规划器、条件 DSL、图片工具或学习系统。
- 地图工具通过既有 ToolExecutionResult.images 交付真实 PNG；guest 仍只收 JSON。图片缓存和原始事实分开，缺失与未知有明确呈现。
- 安全介入沿既有身体仲裁，明确默认触发/预算/结束和记录；EffectRecord.owner 分清 run 与 safety，不伪造 Call。普通饥饿由程序决定，不默认自动反击；重生不重跑旧任务。
- 同步模型指南、模块正文、公开类型、阶段门和反例；只修订文档，静态检查不证明产品实现或真实 Minecraft 验收。

## 2026-10-18 · 统一操作与模块职责

- take/stow 合并为 transfer@1：from/to 恰一，另一端为自身库存；统一选物、固定数量、moved/remaining、部分失败与未知。give 并入 drop.toward，只报告丢弃，不认证接收。现行目录为 13 查询 + 35 动作（P0 22、P1 16、P2 10），旧名无兼容别名。
- route.plan/goto、build.plan/build 共用业务目标；计划和执行仍各有只读/动作入口。Construction 以同一 Target/现场差异处理放置、清空、建造与修复，保留单格等便捷能力。
- Library 唯一管理三类工作文件、头、CRUD 与扫描；ProgramPort 删除文件 CRUD，保留执行材料、编译、逻辑段与 guest。describe 只展开合同/路径，原文由 get 读取，同一材料不建两套索引。
- 查询统一使用 QueryDescriptor，删除 NativeCallable.read；完整执行记录统一 readRecord，删除三种专用读取端口。Runtime 唯一身体队列，Driver 不再保存 grant FIFO。
- contracts 收缩为所有权/协作导航，行为归所属模块；概要收缩为目标/组成/流程。常驻指南只留 Program 附录 A；统一按工具/通知携带摘要，不逐模型请求隐式注入状态。
- 本轮仅修订文档。静态检查单独记录，不代表产品实现、Windows 或真实 Minecraft 验收。

本文件只记"何时改了什么、为什么"。当前状态与文档地图在 [README](README.md)，合同在各模块文档里；**冲突时以模块文档为准，本文件不作规范**。

倒序：最新在上。

## 2026-10-18 · 离线连接与 chat 指令

- 将 Microsoft 与 offline 列为并列连接路径；offline 不需要 accountId/正版 UUID，离线账号独占按配置服务器端点和名字划分，LAN 使用实际端口。
- 将原 say action/能力/PlayerPort 方法统一改为 chat，不保留调用别名。保持 `{text}`；首字符 `/` 发送一条玩家服务器指令，普通消息和指令共享 Runtime 受理及效果记录。
- 明确单行、版本长度、实际发送边界、上游发送队列与取消；sent 不证明服务器指令成功，未知发送不重试。开发规划和两种认证/命令验收同步更新。
- 本轮仅修订设计，未恢复产品代码、未连接服务器。

## 2026-10-18 · 完整开发规划

- 新增全模块实施路线，区分风险验证、Host 回执、Runtime、Driver/World、Program/Library、Executor 装配、P0/P1/P2 与真实服务器验收。
- 把 session v3/v4 兼容明确为编码前阻塞裁决；旧数据只在临时副本上验证，不自动改写。
- 阶段验收分开记录 Fake、Worker/进程、Windows OS、真实 Minecraft 和模型复用证据；这是一份规划，不代表实现已开始。

## 2026-10-18 · 清理旧 Minecraft 实现

- 按终态设计重新开始：删除旧 Driver、World、Assets、contracts、Executor、WorldDef 及 21 个旧专属测试/helper，不把旧行为当作新实现基线。
- 删除旧 Worker 验证脚本和 package 命令，移除指向旧源码的 TypeScript/格式配置与 Mineflayer 边界自测；保留 Mineflayer 依赖供新 Driver 继续采用。
- 保留并标注终态设计；更新开发入口，清楚标记旧 fake bot/源码核查为历史证据。没有删除 world-data 或 profile 数据。
- 本次仅重置代码；未重写新实现，未运行测试或游戏验收。

## 2026-10-18 · Executor 终态收敛

- 确定 Windows 双命名 Job：同一适配内保留目录/账号两种真实独占，不做跨 Uina 自动抢占；自己的旧实例沿现有关闭/确认退役流程重建，不维护替代锁架构。
- 交付终态改为真实 Host 回执确认的 pending/committed。新增通用 Host 标记、状态查询和尝试退役合同；它依赖现有 Tool execution/Mailbox/Canonical history，尚未实现，不再接受旧工具交接窗口静默漏掉主动通知。
- 直返与后台共用 key=completionRef，查询补齐丢失回调/ACK；暴露交付状态与明确恢复，Host 忙碌不触发反复入队，允许重复呈现而不重跑动作。
- 16 KiB 仅为默认摘要预算，超出时保留 record 读取引用，不先导出；完整记录 auto 初始 256 KiB 内直接读，另可选 inline/file。文件只用于显式全文读取超预算或明确导出，缓存仍不是权威。
- 移除普通 config.json 的 timing/transport 参数，策略由内部统一注入；执行 façade 收敛为 selector/code，裸 selector 调保存程序，Library 的 name 与内部 SourceRequest 不改。
- 本轮完成终态合同修订与静态核对，未改产品代码、未提交；Host 接缝、IPC、原生绑定与真实游戏仍须实施验收。

## 2026-10-18 · Executor 审查修订

- 增加当前 launch 的可信 retirement 请求，使用优先 IPC 与 status/心跳锁存；心跳健康但隔离失败也能升级整树退役。
- 恢复确认同时绑定 attachment/gateRevision；带确认的调用不重建实例，不把旧确认移交新连接。
- stop 同一入口支持 Run 或原动作 requestId。撤销屏障、受理、continue 与调度启动在 Runtime 闭合；未受理撤销不虚建 Run。
- 同键准备 singleflight 与受理唯一约束支持明确重试，删除等待旧 attachment 退役的限制和发送前独立 attempted 提交；自动恢复仍只查证、不重发动作。
- readRecord 按不可变 record/completionRef 精确读原件，身份 Ref 固定最新截面；大记录导出 Runtime 所有的普通 JSON。报告 header 与正文形态分开，一份载荷失败不阻塞其他通知。
- 默认 wait 等完成/待决策并立即返回已有报告；显式 afterRevision 等变化，未来修订拒绝。控制/列表使用有完整性标记的小投影。
- 移除泛化 Run/Context policy 与 Executor defaultPolicy，保留具体能力参数及其有效值记录；校正 Uina 本地短窗口、取消与 void/null wire 规则。
- 本轮仅修改设计文档及静态检查材料；未实现上述协议、数据表、进程监管或游戏链路。

## 2026-10-18 · Executor 详细设计

- 增加 Executor 权威正文：一层六 action façade、请求与记录展开、配置、启动/关闭、受理查证和明确重试、状态与错误、BodyEndpoint、通知和故障推演。
- 采用 Uina 管理的 Node 伴生进程及私有 IPC；首个支持平台为 Windows。命名目录/账号 Job 合并独占、父退出绑定和进程树退役，不另建守护服务、锁文件抢锁或 Runtime 副本；实际 OS 行为待验收。
- 接入凭证独占 executor.db；Runtime 仍唯一拥有受理、执行与结算。say 复用 say@1 的 Runtime 路径；save from 在执行侧取快照，不搬源码绕回 Uina。
- 统一短窗口、input_accepted/input_settled、允许的通知重复/缺口；pendingDeliveries 改为分页引用，避免搬运整份结果集。无 Core 新事件、Host journal 扫描或动作自动重放。
- 查询 descriptor 补 examples，精确描述复用作者示例；无示例的文件条目明确缺失，不凭空猜参数。公开合同中的旧 world.status 名称对齐现行 world@1。
- Runtime/Driver/公开合同改为链接所属算法；概要、导航和旧 LEAD 同步。仅修改文档，未实现进程监管、IPC、接入账本或真实 Minecraft 链路。

## 2026-10-18 · Library 命名统一

- 将 `modules/assets.md` 改名为 `modules/library.md`，更新文档链接与现行模块名称，不保留旧文件别名。
- 清除受理和 World 保留合同中的旧资产发布语义；Library 仍是普通文件库，只保存弱链接，不参与证据强保留。旧 Assets 产品代码不在本轮修改范围内。

## 2026-10-18 · Program 最简设计修订

本轮仅修订文档，以下规则取代此前冲突裁决；产品实现、历史微基准及真实 Minecraft 验收均未更新。

- withBody 回调等待期间保留身体；waitUntil/sleep 不自动释放或延长输入有效期。原生能力自行持有时在长期等待前释放，接受委托时保留祖先身体。phase 与 control 分开描述。
- 领域能力自行判断目标，Runtime 删除独立目标状态、通用目标 verifier 与父子/跨段进度聚合；保留执行结果、效果核验和未知项。续段按新入口结算，不认证旧目标。
- decide 改为 guest 内同步异常，不发宿主 RPC；跨可信调用边界关联来源，根未处理才交还。
- 文件只允许一个可选结构化头。update 的完整源码替换与 metadata 补丁互斥；坏头通过完整源码修复。
- 保留共享 worker 与独立 guest，删除程序调用深度限制。通知保留三种递送状态，删除直返交接的专用恢复补报；交接缺口查询恢复，动作不重放。
- Program 与 Runtime 按开发阅读顺序重排，Driver 接缝合入所属章节；公开类型、示例、指南、导航及验收同步。

## 2026-10-18 · Program 组合、执行与复用合同修订

本轮为设计修订，未修改产品实现，未复跑历史微基准或真实 Minecraft 验收。以下条目取代早先同日的“终审/定稿”中与之冲突的裁决，历史原文仅记录当时选择。

- 保留 JS 文件与 call/read；等待改 waitUntil/timeoutMs，predicate 第二参数统一 {unknown}，多目标保留各自 versions，不合成全局游标。
- body.call 显式委托后，子上下文普通 call 继续传播同一 BodyScope；外部捕获上下文不升级，普通子退出不释放祖先身体。
- decide 产生可捕获的 NEEDS_DECISION；父可处理，根未处理才交还。程序 checkpoint 为自由 JSON + 来源，新段根只读 mc.checkpoint；领域 checkpoint 保留 schema。
- 改共享 worker + 每次调用独立 QuickJS runtime；取消段级容量队列。初始 1 worker/全局 32 guest/每 guest 16 RPC，满即拒绝。身体内 sleep(0) 仅让出计算，实际世界等待仍拒绝。移除默认累计 CPU 终止，保留连续计算预算并真正让出线程。
- 单段关闭只退役所属 guest；worker 故障先封闭其全部来源、撤销控制再终止确认，公开影响范围与未知效果。进度覆盖合并、日志有界批量传输。
- 目标型 collect 按本次入包数量完成，craft/build 不足抛带实际进度的领域错误；会话型 fight/follow 明确 ended，fight 可覆盖 retreatHealth。方块目标支持状态，物品选择复用 ItemSelector，区分连续/整数坐标与持久维度身份。
- 窗口回执给出可确认的自身变化，参照视图随其前进；后态不完整要求 snapshot。将原 orphans 推断改为记录父关闭时真实中断的 interruptedChildren。
- 程序元数据补 output/examples；损坏结构化头运行拒绝，完整新头可修复。普通文件可局部编辑；快照仅承诺源码追溯/恢复，不等于依赖锁定。
- 发现覆盖能力/程序/蓝图/经验并标 kind/callable。聊天事件明确属于 World 历史/游标扩展边界，本轮不新增事件系统。
- 更新权威正文、共享类型、完整脚本示例、模型指南与八条跨模块验收；历史案例和基准明确为旧证据，不记作当前通过。

## 2026-10-18 · 文档审查（不改设计，只改写法与去重）

- `README.md` 重写：状态表 + 文档地图 + 四步读法 + 按问题查阅；删掉 3 KB 单段修订流水账（在 git 历史与本文件里）。
- `public-api.md` 828 → 657 行：§6 由整章旧程序/资产接口压成 8 行"旧概念 → 现在"对照表；头与 §1 只留"读什么、谁拥有什么"；§5 删掉对 World 内部算法的复述（留类型 + 一句指针）；`ReadCallScope` 删掉 `wait`/`decide`/`checkpoint`（那是 Program 的面），`Entry.program.source` 统一为 `SourceRequest`。
- `runtime.md` §9/§10 重写：原 §9 一边写"已被 program.md 取代"一边继续用 `ProgramExecutionPort`/段级子进程/已取消的 `PROGRAM_CAPACITY` 写成现行规格，现在只留 Runtime 侧硬保证、容量规则与指针；§10 的 `WaitConditionDef` 与条件注册删除，等待按 `mc.waitForChange(targets, predicate, {afterMs})` 的三种结局重写。
- `driver.md` §5.1 的"等 Runtime 定了再决定 Driver 排队形态"闭合为"一个在途 `acquire` + FIFO 交接"；`SOURCE_UNAVAILABLE` 不再被 Driver 复用为租约拒绝（改 `DISCONNECTED`/`INTERRUPTED`）。
- `world.md`：`world.status@1` → `world@1`（状态落字段，不造查询）；`historySettled` 改为内部 `historyReady`；§17 的公开合同增补表改为指针（唯一形状在 public-api）；首屏修订史移入本文件。
- `contracts.md`：`contractRef` → `CallableDescriptor`/`ExactRef`；`mc.decision` → `mc.decide`（仅根调用）；`UNSUPPORTED`/`PRECONDITION`/`EFFECT_UNCERTAIN` 收编为 13 码 + `dispatch`/`unknownEffects`；删"复查意图"（那是第二套任务系统）。
- `design.md`：示例与能力名统一到扁平动作（`collect@1`/`craft@1`/`goto@1`/`fight@1`…）；"沙箱待验证/配额按实测"改为已定的 worker + QuickJS 与预算表；容量段补 guest/RPC 槽位超限即失败。
- 全库删掉 52 个指向不存在标题的 `#english-anchor`，只留文件链接。

## 2026-10-18 · 终审后做减法

用户 review 指出"反复追极端并发、加机制"已经过度防御。删减如下（均已在 `modules/program.md`、`modules/capabilities.md` 生效）：

- **校验与执行统一到同一个 QuickJS**：`validate` 用 `compileOnly` 只编译，删掉宿主 V8 预编译与两套诊断（实测 0.4–0.5 ms，V8 的 0.37 ms 没有速度优势）。
- **`waitForChange` 收窄到 8 个有观察游标的查询**（self/inventory/block/blocks/region/entities/world/places）；静态与派生查询（item/recipe/route.plan/build.plan/container.last）`version: null`，不进 watch——不为派生计算建响应式依赖图。
- **程序头删掉 `lesson`/`addLesson`**：程序存"怎么做"，Experience 存"发生了什么、学到了什么"；三处写经验必然互相矛盾。
- **`mc.decide` 降为仅根调用**：子程序得 `DECIDE_NOT_ROOT`，要交还就返回一个值。任意深度打断父任务是非局部控制，与 JS 组合语义冲突。
- **`computeBurstMs` 5000 → 20 ms**：一个 worker 内所有 guest 共享线程，5 秒等于让兄弟 guest 断 100 个 tick；QuickJS 中断只能终止、不能挂起，长计算由程序 `await mc.sleep(0)` 分片。
- **验收重心移到真实玩法**：新增"阶段 0"五个场景（取得木镐、采矿回基地、按图建屋、整箱与熔炉、探索遇敌撤退）定义"可用"，四组压测降为支撑证据。
- **发现质量用黄金查询锁住**：`describe {query:"造房子"/"挖矿"/"整理背包"}` 的三条测试规定"该进前排的进、无关的不占前排"，不过就改 descriptor 措辞，不建检索层。
- 明确 `§0.3`：不在隔离、身体仲裁、窗口校验、效果结算之外再造调度器/状态机/安全层；附录 C 标注为参考骨架，冲突以正文为准。

## 2026-10-18 · Program 详细设计定稿

- 程序 = **单文件合法 JS**（`programs/<name>.js` + 一行 `// uina {json}` 头注释，入口 `async function main(mc, input)`）；取消版本号、Manifest、依赖表、绑定表、发布流水线。
- **执行即快照**：每次调用按 `sha256` 内容寻址存 `runs/<run>/sources/<sha256>.js`；段内同名固定同一份字节。
- 身体控制统一到**调用谱系上的 BodyScope**：`mc.withBody` 独立申请、`body.call` 委托继承、`mc.call` 从不继承；一次一个委托，第二个 `BODY_BUSY`。
- 执行域 = world 伴生进程内的 worker + 每调用一个 QuickJS-WASM；容量"计数 + 立即拒绝"：4 域（跨段排队）、8 guest/域、16 在途 RPC/guest。
- 取消只取消等待，不取消已发生的事：已派发操作继续进 `EffectRecord`，迟到证据以稳定 `effectId` 追加，Run 不重开；无法确认 → `unknownEffects`，不报 `succeeded`。
- 库只有五个操作（list/get/save/update/delete）；程序不是 AssetKind，蓝图与经验归 Library。

## 2026-10-18 · 能力面详细设计

- 新增 `modules/capabilities.md`：**13 个查询 + 37 个动作**，扁平名 + `@1`，取代 `program.md` 旧 §3.4 的 7 查询 + 10 动作目录。
- 统一 **13 个失败码**（NOT_FOUND / UNREACHABLE / MISSING_MATERIAL / MISSING_TOOL / INVENTORY_FULL / CONFLICT / WRONG_STATE / TARGET_NOT_MET / INTERRUPTED / TIMEOUT / INVALID_INPUT / INTERNAL / DISCONNECTED）+ `hint` + `progress` + `remaining`。
- 参数冻结三层：Run 输入与策略在受理时冻结；Call 的输入/默认值/能力版本在派发前冻结（记 `CallRecord`）；世界状态、路径、目标选择持续观察。原则"意图稳定，世界动态"。
- 三个试算查询（`route.plan` / `build.plan` / `recipe.plan`）与执行共享实现；`build.plan` 返回蓝图 `digest`，`build` 用 `expectDigest` 发现漂移。
- 收编：`region@1` 几何读（palette + 索引，≤8192 格）、`container.last@1` 只记真实观察、`goto`（当前维度内）与 `transit`（跨维度/交通）分工、`fight` 的 `stance` 三档落成阈值表。

## 2026-10-18 · 数据布局固定

所有 Minecraft 数据在同一 `worldDataDir`（`.uina/world-data/minecraft/`）下并列：`programs/`、`blueprints/`、`experiences/`、`runs/<run>/sources/<sha256>.js`、`world-history.db`、`runtime.db`。程序按约定路径读写，不散落。

## 2026-10-17 · 架构重构

- World SQLite 迁入专用 Worker（提交屏障化历史查询）。
- ACK 收敛 durable-only：删 received 层/重传/outbox 与 R/recv 持久字段，schema v3。
- Driver 状态唯一所有权收编：gate 资格、会话使用归属、KeyHold、窗口 revision live getter、`setSlot` 单路径、say 停用准入。
- 历史 cursor 改取读取视图提交版本（双量纲水位：current=失效事件序，history=存储提交版本；混声明拒绝）。
- 身体调度唯一权威归 Runtime；`driver.close` 必须结算排队申请；durable 物理前提（WAL + synchronous=FULL）显式设定并核验；`pnpm verify:mc-worker` 用真实构建产物验证 Worker。

## 2026-10-15 · 目录整理

六份编号讨论稿合并为本目录的概要（`design.md`）、行为契约（`contracts.md`）、公开接口（`public-api.md`）、研究记录（`research.md`）与各模块详细设计；原稿快照存 `../../../.artifacts/minecraft-design-originals-20261015-144602.zip`。

## 2026-10-15 ~ 10-17 · 各模块定稿与重构（原先写在正文首屏，已移到这里）

- **Driver（10-15 定稿，10-17 修订）**：PHY-STEP 物理窄接缝降为条件条款（同进程事件计数已满足 drive/feedback 合同，接缝只在安装异步化或插件归属取证时实现）。10-17 架构重构：Gate 成为资格与操作记录的唯一权威（无第二份 active 指针/操作集合）；原生使用状态唯一权威 = Body 会话；按键持有收编为 KeyHold（撤销只清本根）；窗口 revision 唯一权威 = WindowSession；`say` 经 gate 停用准入（不要求 Body Permit）；删除 Operation 的资源标签字段，资源归属改由 KeyHold/useControl/会话登记等具体机制承载。
- **World（10-16 定稿，10-17 三轮修订）**：SQLite 专用 Worker + 提交屏障化历史查询 + ACK 收敛为 durable-only；历史 cursor 改取读取视图版本、双量纲水位、durable 物理前提核验；§9.1 失效只按查询可见边界定义（混合查询与时间阈值为条件条款）；§13.1 两段初始化（当前基线先行、历史独立 opening）；存储身份冲突核验；schema v3 对齐。
- **Runtime**：§9/§10 的 Program 执行合同、等待原语在 10-18 由 `program.md` 取代，正文已改为指针与 Runtime 侧硬保证。
