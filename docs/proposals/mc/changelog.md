# 设计变更记录

本文件只记"何时改了什么、为什么"。当前状态与文档地图在 [README](README.md)，合同在各模块文档里；**冲突时以模块文档为准，本文件不作规范**。

倒序：最新在上。

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
