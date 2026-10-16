# Minecraft World — 技术负责人协调文档（LEAD.md）

更新：2026-10-16。所有者：技术负责人（lead）。三个开发 AI 与 lead 都必须遵守本文。

## 0. 事实基线（2026-10-16 核实）

- Minecraft 在本仓库**零实现**：`src/`、`.uina/` 均无 minecraft/mineflayer 代码。
- 设计来源：主工作区 `E:/Uina/Uina/docs/proposals/mc/`（README/design/contracts/public-api/research + modules/driver.md、world.md、assets.md）。**该目录被 gitignore，worktree 内不存在；一律用绝对路径读主工作区。**
- 已有可复用接缝：`src/extensions/world-framework/`（WorldDef/ActionDef、五态 ToolExecutionResult、`ctx.expose("body.endpoint:"+bodyId)` 急停门、`emitEvent` 事件递送、`worldDataDir` 数据目录）。Minecraft 以普通 World 形态接入，**不改 Core**。
- 唯一例外：`tool_result_recorded` 通用事实需 Core 变更，当前源码没有——凡依赖它的递达保证一律标记为 Runtime/Core 依赖，未实现前不得宣称。

## 1. 目录与文件所有权（互不冲突）

根目录：`.uina/worlds/minecraft/`

| 路径 | 所有者 | 内容 |
| --- | --- | --- |
| `contracts/**` | **lead 独占** | 跨模块公共类型/错误码/入口签名（唯一合同源） |
| `worlddef/**`、`executor/**` | **lead 独占** | Uina 薄接入（façade/急停门/事件递送）+ Executor/运行管理 + 组合根 |
| `driver/**` | Driver AI | Mineflayer 适配、身体资格、控制、反馈、ClientFactsPort 实现、fake bot 测试替身 |
| `world/**` | World AI | 证据接收/ACK、查询切面、Watch 水位、SQLite 历史、领域记录、保留 |
| `assets/**` | Assets AI | 资产仓库、版本/CAS/请求账本、字节对象、强证据保留 |
| `tests/`（仓库根 `tests/minecraft-*.test.ts`） | 按前缀划属：`minecraft-driver-*` → Driver；`minecraft-world-*` → World；`minecraft-assets-*` → Assets；`minecraft-contracts*` / 其他 minecraft 前缀 → lead | 测试文件名即所有权；禁止跨写他人测试文件 |

规则：

1. **只改自己目录 + 自己前缀的测试文件**。发现他人模块的 bug：在集成报告登记，由 lead 转交，不得越界修复。
2. `package.json`（world 级）、`tsconfig.json`、`biome.json`、`scripts/check-boundaries.mjs`、world-framework 源码：全部归 lead。需要变更先登记。
3. 依赖新 npm 包（如 mineflayer、better-sqlite3 候选）必须经 lead 批准后由 lead 写入根 `package.json`；推荐优先 `node:sqlite`（Node ≥22 内置，避免新增原生依赖，Node 22.5+ 可用）。
4. `docs/proposals/mc/` 设计文档的修订也归 lead；发现设计不合理，提定点调整请求并附证据，不盲从文档。

## 2. 固定接缝（已落地的合同文件）

`contracts/` 已固化 public-api 的候选合同：`values`（Fact/Observation/Outcome/…）、`errors`（错误码唯一词表 + CallFailureError）、`callables`（目录与调用上下文）、`body`（BodyOps/PlayerPort/FeedbackFrame/WindowSession）、`client-facts`（ClientFactsPort 与证据/ACK）、`world`（WorldPort/Watch/DomainRecord/EvidencePort）、`program`（ProgramDefinition/ProgramAPI/Wait）、`assets`（AssetRepository/信封/Blueprint/Experience）、`executor`（ExecutorClient/RunSnapshot/SegmentRecord/RuntimeAssetSourcePort）。

模块固定入口签名（桩已就位，实现者保持签名）：

- `driver/index.ts` → `createDriver(config): DriverHandle`（player + facts + connectionState）
- `world/index.ts` → `createWorld({facts, dataDir}): WorldHandle`（WorldPort + status）
- `assets/index.ts` → `createAssetRepository({dataDir, worldEvidence?, runtimeEvidence?})`
- `executor/index.ts` → `createExecutor({player, world, assets, callables, dataDir})`

合同变更流程：所有者在自己的集成报告里提出（缺口 + 证据 + 建议形状）→ lead 修订 `contracts/` → 主分支提交 → 各 worktree rebase。**禁止在模块目录内复制或分叉类型。**

## 3. 并行分工与纵向切片

### Driver AI（开工时自建 worktree，分支命名 `mc/driver`，见 §4）

切片顺序（每片全绿可集成）：
1. **S-D1 连接与事实**：fake bot（替身物理/协议，不用真实服务器）驱动 `createDriver` 返回 ready、`facts.sample()` 返回 self/inventory 纯值 + 正确 stamp；`subscribe()` 在替身协议入包时发 changed/reset。测试：`tests/minecraft-driver-facts.test.ts`。
2. **S-D2 身体资格**：acquire/release FIFO、旧 Operation 迟到写入拒绝（CONTROL_INVALID/REFERENCE_STALE）、drive 按实际物理步计数（替身物理循环）、dig/attack/interact/equip/useItem 派发与五态回执。测试：`tests/minecraft-driver-body.test.ts`。
3. **S-D3 窗口与反馈**：WindowSession 快照/revision/点击预期核验；FeedbackStream 帧序/validUntil/单次消费。测试：`tests/minecraft-driver-window.test.ts`、`tests/minecraft-driver-feedback.test.ts`。

明确不做（登记依赖）：真实服务器验收、真实 Mineflayer 依赖接入（等 lead 批准 npm 依赖后接）、Program 执行域桥接（归 lead）。

### World AI（自建 worktree，分支 `mc/world`）

1. **S-W1 接收与当前读**：`createWorld` 消费 `facts.subscribe()`（先订阅后采样）、receivedThrough/durableThrough 水位（含 gap 不越洞）、`read` 纯当前查询（self/inventory/block）返回 Observation + 同点 cursor。存储先用内存 + `node:sqlite` 打底。测试：`tests/minecraft-world-receive.test.ts`。
2. **S-W2 Watch**：read→watch→next 无漏失效（含 stamp 已前进但范围未知的保守失效）；reset 语义。测试：`tests/minecraft-world-watch.test.ts`。
3. **S-W3 历史与领域记录**：SQLite 持久证据、writeRecord CAS、retain/release 保留闭包。测试：`tests/minecraft-world-records.test.ts`。

明确不做：Driver 侧替身之外的协议事实、玩法领域 schema（由能力层后续提供）。

### Assets AI（自建 worktree，分支 `mc/assets`）

1. **S-A1 仓库核心**：put/revise CAS、名称头、digest 规范化、ASSET_EXISTS/REVISION_CONFLICT；程序/蓝图/经验三 kind 校验。测试：`tests/minecraft-assets-core.test.ts`。
2. **S-A2 字节对象**：受管不可变对象（唯一物理名、O_CREAT|O_EXCL|O_SYNC、数据库发布可见性）、stage/read。测试：`tests/minecraft-assets-objects.test.ts`。
3. **S-A3 请求账本**：requestId 幂等、REQUEST_CONFLICT、崩溃恢复语义（内存可测部分）。测试：`tests/minecraft-assets-requests.test.ts`。

明确不做：saveFromRun 的 Runtime capture 端（等 lead 的 Executor）、真实外部证据跨库时序。

### lead（主工作区 + 按需 worktree）

contracts/ 维护、Executor/运行管理、worlddef façade、Core 接缝（`tool_result_recorded` 若立项）、设计文档修订、集成与验收。

## 4. worktree 与门禁协议

- **worktree 由各模块 AI 开工时自建**（不预建）：从当前主分支 HEAD 创建，如 `git worktree add <path> -b mc/<module>`；路径沿用 `C:/Users/34150/.codex/worktrees/mc-<module>/Uina` 惯例。开工后先 rebase 到主分支最新（contracts 可能已被 lead 修订）。
- 每个模块 AI 在自己的 worktree 工作，**只 commit 自己目录 + 测试文件 + 集成报告**；不 push。
- worktree 内 `pnpm install` 后门禁：`pnpm typecheck`（biome + boundaries + tsc）+ `pnpm vitest run tests/minecraft-<own-prefix>*`。全绿才能交付切片。
- 已知沙箱约束：vitest 用默认池；测试失败时 coverage json 不落盘；测试写临时目录，不碰 `data/`、`.uina/world-data/`。
- 集成：lead 在主工作区合并各分支（merge，不 rebase 他人历史），跑全量门禁，修复真实接口冲突；冲突处理原则见各模块集成报告。

## 5. 集成顺序

M0（已完成）：contracts 固化 + 模块桩（worktree 不预建，各 AI 开工自建，见 §4）。
M1：S-D1 ∥ S-W1 ∥ S-A1（三者无文件交集；S-W1 用 fake facts 接口替身也可先行，集成时换真 Driver）。
M2：lead Executor 骨架（受理/去重/run 记录/stop 意图，内存版）+ worlddef façade 接 ExecutorClient。requestId 由接入层（worlddef/lead）在提交前生成并持久，模型不填 ID。
M3：S-D2 ∥ S-W2 ∥ S-A2；Executor 接身体调度（FIFO 就绪队列；当前段不被普通请求打断；replace/preempt 显式核验，见 design §5.1）。
M4：S-D3 ∥ S-W3 ∥ S-A3；saveFromRun 闭合路径（lead RuntimeAssetSourcePort + Assets）。
M5：真实 Mineflayer 依赖接入（lead 批准依赖后）、真实服务器验收（需要 Runtime，单独立项，不并入以上切片）。

**进程部署决策（design §2.1 的分阶段落地）：** M2–M4（fake bot 阶段）Executor 与 Driver/World/Assets 同进程实例化，全部活动在 `ExecutorClient` 接缝之后——fake 阶段不存在"隔离游戏库与故障脚本"的风险面，不提前付 IPC 代价。M5 真实 Mineflayer 落地时，执行侧（Driver + Executor + World + Assets + 能力目录）整体迁入伴生进程，worlddef 留 Uina 进程；合同已按 IPC 形状设计（持久 requestId、lookup/wait/events、OwnerState attach），届时只换 transport，不改 contracts。脚本可终止执行域（design §4.5）仍单列 Runtime 依赖。

## 6. Runtime/Core 依赖登记（未实现，禁止伪造）

- `tool_result_recorded` 通用事实：Core 无此事件，短直返递达收据依赖它。
- 程序独立执行域（可终止 Worker/引擎）：未实现，FeedbackStream 的脚本侧 loop 桥接依赖它。
- 伴生 Executor 进程的受管启动/监督（进程树终止绑定）：未实现。
- 真实 Minecraft 服务端验收：全部控制/协议效果的最终证据边界。
- owner 急停门的持久化（world-data）：随 Executor M2 落地。

## 7. 模块集成报告（各 AI 追加）

<!-- 每个切片交付时在此追加：交付内容 / 合同偏差请求 / 未验证边界 -->

### Driver AI — S-D1/S-D2/S-D3（2026-10-16，分支 mc/driver，commit 3e2ad1a + ec8528b）

**交付内容**：Driver 核心全部落地（`driver/internal/` 8 模块 + `driver/fake/` 替身 + 组合根），按 LEAD §3 切片一次性交付：
连接/身份代次（connection/incarnation/body/operation/window/appearance）、写入资格门（acquire FIFO、revoking 不可逆、迟到回调凭创建时身份拒绝）、drive 实际消费步计数（physicsTick 为模拟后事件，第 N 步处理器内撤销持续输入）、dig target/preserve、feedback 帧协议（latest-only 槽、单帧单消费、双边界 validUntil、appliedStep）、窗口会话（revision 完整快照比较、click 预期核验、普通 close 前置条件、强制退役留证）、ClientFactsPort（同步 sample + view 失效 + thenable 拒绝、stamp/epoch、changed 合并、选定证据 + ACK 记账）。
门禁：biome ✓ / boundaries ✓ / tsc ✓ / `vitest run tests/minecraft-driver-*` 44/44 ✓。全量 `vitest run` 中 mcp/qq/tts/smoke 等 11 个既有失败与本模块无关（未触碰其文件）。

**合同偏差/协调请求（请 lead 裁定）**：
1. **空手 useItem 的错误码**：上游 activateItem 空手是静默 no-op（inventory.js L120-122），Driver 预检并报 `TARGET_NOT_MET` + dispatch=not_sent。词表无 PRECONDITION 类码，如 lead 认为应新增专用码请修订 errors.ts。
2. **equip 物品未找到**：同上用 `TARGET_NOT_MET`（progress.examinedSlots），理由相同。
3. **断连后 stamp.connection**：断连（未重建）时 identity 置为 null（当前事实源不挂接任何连接），连接重建（M5）时才生成新 connection ref。若合同期望"断连保留旧 ref"请明示。
4. **HostCallVerifier 接缝已就位**（gate.ts）：M2/M3 Executor 接入时由组合根注入实现即可，Driver 结构不变。
5. **连续根互斥的默认策略**：无 Runtime 委托信息时，同一 Body 最多一个连续根（drive/feedback 互斥）；dig(target) 与活动连续根冲突、dig(preserve)/attack/use-once 允许重叠（对应 driver.md §6.3 兼容表）。Runtime 委托谓词落地后由 verifier 携带。

**未验证边界（不做宣称）**：
- 全部测试基于 FakeClientBot（替身物理/协议，按 mineflayer 7b4bb8d2 已核实行为建模）；不证明真实服务器行为、真实协议时序、物理引擎精度。
- 真实 Mineflayer 适配（ClientBot 接缝 → mineflayer 实例）、自动重连策略、传感器目录、sections 真实 chunk 数据、§9 插件适配（Pathfinder/PVP/Inventory 台账）——均归 M5 及后续。
- 反馈帧率/validUntil/停滞超时为配置默认值，未实测调优（driver.md §8.5 要求实测决定）。
- evidence 材料回收策略按"所有已登记接收方 durable 覆盖"保守实现；多接收方/跨域重传路径未在真实 World 对接中验证。

### World AI（2026-10-16，分支 mc/world，commit 43cd7d6 / 72f8237 / dd2d328）

**交付**：S-W1 接收与当前读、S-W2 Watch 无漏失效、S-W3 SQLite 历史/领域记录/保留/恢复。
`world/internal/{reception,current-source,invalidation,queries,store,world-impl}.ts` + `world/index.ts`；
测试 `tests/minecraft-world-{fake-facts,receive,watch,records}.*`（32 例，全绿）；
门禁 `pnpm typecheck`（biome+boundaries+tsc）通过。

**合同偏差/缺口请求（需 lead 协调）**：

1. **writeRecord 所有权核验缺注入**：`WorldPort.writeRecord` 要求"从真实当前调用核验存活、
   act/schema 所有权"，但 `createWorld({facts, dataDir})` 无调用核验/schema 注册表注入，
   `writeRecord(change)` 签名也不携带 ctx。当前实现只做：结构校验、分区一致性（先同步采样刷新
   绑定视图）、CAS、schema/world/worldRevision 不可偷换。**建议**：WorldDeps 增加可选
   `records?: { schemas: Map<ExactRef, (value) => ValidateResult> }`，或写路径改经 CallContext。
   未注入前，schema 所有权只能信任调用方——不冒称已核验。
2. **changed refs 粒度**：Watch 精确分类目前按"当前源"整源投递（§9.2 允许的保守退路）；
   按 ref 过滤需要 Driver 侧 fact-ref 词表与查询依赖提取的约定，建议后续与 Driver AI/lead
   共同定一个最小映射（如 fact:self / fact:inventory / fact:block:<key>）。
3. **世界绑定来源**：当前把 Driver 采样/订阅返回的 `ClientFactScope` 视为可信绑定投影
   （§4.2 "Host 明确提供且可信"路径）；显式 unbound 分区的创建规则（何时判定"身份未知"）
   需要组合根给出判定输入，当前 status.binding 如实转发 scope。
4. **接收代次 ref**：`createWorld(options.receiver)` 由组合根在重挂载/重启时提供新代次；
   默认 `mcw:receiver:g1` 仅适合单实例。跨进程部署（M5）时需接组合根的代次分配。

**未验证边界（如实登记）**：

- 真实 SQLite 断电/进程崩溃恢复：已测 graceful close + 重开，未测 kill -9 后 WAL 恢复。
- 同身份不同载荷的跨重启检测：重启后重放冲突只静默保留先到版本（RAM 内可检出并报协议故障）。
- `evidence.list@1` 大数据量性能未测；node:sqlite 同步提交在游戏关键路径上的延迟未测
  （LEAD M5 伴生进程决策后再评估 worker 迁移；存储接口已按可替换设计）。
- 联合查询/证据 fence（world.md §6.3）、container.last 等领域查询、时间阈值（maxAge）失效、
  GC 发布门与删除：本切片未实现（无消费方，不预建）；retain/release 的保留闭包（Section
  基底传递依赖）在证据携带 deps 字段前只能按直接 ref 保留。
- 全量 `pnpm test` 中 tts-bridge/bilibili/mcp/qq-world 等 9 文件失败（40s 超时特征），
  与本模块零交集（未 import minecraft 代码），疑似本机 harness 敏感，未处理。

**对抗式审查修复**（2026-10-16 第二轮，commit 7fd8d3c）：

- **流身份竞态（严重）**：read/watch 当前路径原用采样前的 scope 构造流身份；绑定在同一采样内
  变化时 watcher 注册到已死流上永久挂死。改用采样原子返回的 capture.scope。
- **纯历史不依赖 Driver（严重，不变量 A）**：移除历史 read/watch 的 requireScope；历史流身份
  由 queryRef+规范化输入承载（分区代次由 cursor.epoch 绑定分量承载，重绑全量 reset）。
- **retain 虚假成功（严重）**：冲刷失败不再继续写保留关系；证据引用存在性校验
  （EVIDENCE_UNAVAILABLE），writeRecord 同校验——不建立悬空引用。
- 次要：awaitNext 立即交付清陈旧 pending（防重复投递）、Driver view 异常包装 SOURCE_UNAVAILABLE、
  gap/endStream 区间校验、changed refs 投递副本、SQLite busy_timeout、删死 API。
- 新增合同语义问题（无）：本轮未发现需改 contracts 的缺口；writeRecord 所有权核验缺口维持上轮登记。

### Lead 集成验收（2026-10-16，分支 codex/phase0-baseline，mc/driver + mc/world 已合并）

**合同偏差裁定（Driver 请求 1-5、World 请求 1-4）**：
1. 空手 useItem / equip 未找到用 `TARGET_NOT_MET` + not_sent：**接受**，登记语义——TARGET_NOT_MET 覆盖"前置条件不满足且未派发"（进度可为空）；不新增专用码。
2. 断连后 `stamp.connection=null`：**接受**，合同 ClientFactStamp 本就允许 null。
3. HostCallVerifier 接缝 / 连续根互斥默认策略：**接受**，与 driver.md §6.3 一致。
4. writeRecord 所有权核验注入：**挂起至 M2**，Executor（CallContext 路径）落地时由 lead 注入；当前结构+分区+CAS 校验保持，不冒称已核验。
5. changed refs 粒度 / 接收代次注入：**挂起**，按 M5 拆进程时统一定最小映射。

**Lead 审查修复（本层负责，commit 见 git log）**：
- Driver：say 回执 `completion` met→**unknown**（chat 无本地确认路径，driver.md §13 sent≠服务器完成）；acquire 信号监听与会话注销泄漏（按会话结算，代次更替不再滞留条目）；op ref 撞号（Date.now+size → 会话内单调计数）；dig/attack/useItem/interact/equip 成功路径补 closeOperation（ops 积压）；连续根冲突时补 closeOperation；feedback.next 已中止 signal 挂死（abort 事件不再触发）；#onStep 尊重 waiter.after（不交付陈旧帧）；连接建立加 30s 期限（attachTimeoutMs，超时 faulted）。
- World：**SQLite 跨表分页真 bug**——evidence/evidence_gaps 两表 rowid 空间独立，合并排序丢/重数据；改为共享 store_seq 分配器（meta 计数器），SCHEMA_VERSION 1→2；world/index.ts 去掉 `as unknown as` 双重断言（WorldImpl 结构上本就满足 WorldHandle）。
- 登记不修：program↔assets 合同类型循环（纯 type 无运行时环）；blockUpdate/setSlot 粗粒度失效（M5 接真实协议入口时带坐标精细化，driver.md §11.6 的完整要求）。

**集成证据**：合并树 `pnpm typecheck`（biome+8 边界+tsc）✓；minecraft 全套 100 例（Driver 51 + World 35 + contracts/worlddef 7 + 集成 7）✓；新增 `tests/minecraft-integration.test.ts`（lead 所有）验证真实端口连接：FakeClientBot → createDriver → ClientFactsPort → createWorld（真实 SQLite tmpdir）——当前事实变化观察、瞬态证据捕获后可查、durable ACK 后 Driver 材料回收、read→watch→next 无漏/不自激、断连 reset+epoch 更换、存储故障当前读不受影响、内存存储语义一致。

### Lead 集成验收补充（同日第二轮：全量回归与 UI 联想回归修复）

- 全量回归对照：预合并基线 13 个失败文件 vs 合并树 14 个，失败集合在同树连续跑批间本就不稳定（负载敏感 flake，与两开发 AI 报告一致）；零 minecraft-* 失败。
- **确定性回归 1 例并已修复**：`.uina/worlds/minecraft/` 新增文件使 @ 文件联想深扫描预算（300 文件+100 目录）被 .artifacts/.uina 等过程目录耗尽，根级 package.json 落出候选集（tests/ui.test.ts Tab 补全稳定失败；probe 实证）。修复：src/ui/components/editor/file-candidates.ts SKIP 词表补 .agents/.artifacts/.workbuddy/.pytest_cache/.VSCodeCounter；probe 复验 root package.json 回 top-1。这是既有脆弱机制，minecraft 只是触发者。
- 修复后：typecheck ✓；UI + minecraft 全套 294 例 ✓；全量 13 failed（flake 噪声，与基线同量级）。

### Lead — world.md 审查修订登记（2026-10-17）

依据 `docs/proposals/mc/world-review-20261017.md`（world.md vs S-W1~W3 实现的结构化审查，五问框架逐项），修订设计文档并登记实现语义：

1. **文档修订**（docs/proposals/mc/）：
   - world.md §5.4：登记 received ACK 层与重传路径在同域部署无消费者（惰性合同形状），去留挂 M5 拆域决策；届时若不拆域按"合并为单一 durable 提交回调"裁剪。
   - world.md §6.2：追认同域标准路径为 flush-then-read（先同步冲刷接收尾再固定 v 读库），S-W3 实现已采用。
   - world.md §6.3/§6.4/§12：标注为条件条款——tail 并集仅拆域后生效；fence 无真实消费者不预建；GC/删除门在 append-only 现状下无触发条件。
   - world.md §7.1：Section 版本链推迟，当前为薄透传；格式解析届时复用 Prismarine（历史版本化仍自建）。
   - world.md §10.1/§10.3 **合同对齐**：存储保留最新修订值 + 单调 revision 计数，修订历史不逐版追加（`UPDATE revision+1` 覆盖前值，Memory/SQLite 一致）；"指向确切记录修订"降为 `record_revisions` 追加表建立后的条件能力，此前消费方不得假设旧修订可读。
   - public-api.md §5：watch(query, after) 的 after 比较统一发生在首次 next(after)，watch 登记时不消费（行为与登记即固定基线等价）。
   - contracts.md/README.md：状态行更新为实现进度事实。
2. **对实现无代码改动**：本次为文档-实现对齐，全部偏差已如实登记；writeRecord 所有权核验注入仍挂 M2，changed refs 精确分类仍挂 M5（维持原裁定）。

### Lead — driver.md 审查登记与代码修复（2026-10-17）

依据 `docs/proposals/mc/driver-review-20261017.md`（driver.md vs S-D1~S-D3 实现的结构化审查，五问框架逐项；上游源码声称全部核实属实）。逐机制判定保留，仅 §8.4 物理窄接缝降级；本次修复三类问题：

1. **预测来源标注（§11.6 合同对齐）**：`ClientFactsSource` 增加 predicted 标记集——dig 完成把目标格入集、click 把窗口 ID 入集；真实 `blockUpdate(pos)`/`setSlot(windowId)`/`windowClose(windowId)` 到达即清除；`view.block()`/`view.window()`/会话 `snapshot()` 命中标记时 `source:"prediction"`，本地预测不再冒充 server 事实。
2. **回执证据（§13 合同对齐）**：dig 回执携带预测证据 ref（`EffectReceipt.evidence` 不再恒空）。
3. **窗口版本统一（§12.2 单一版本空间）**：`WindowSessionImpl.#revision` 为唯一权威，经 `noteWindowObservation` 登记供 `view.window()` 投影；删除 facts 侧第二个 `windowRevision` 计数（未登记窗口 revision=0 + unknown 注记）。
4. **文档修订**（docs/proposals/mc/modules/driver.md）：§8.4/§9.6 PHY-STEP 降级为条件条款——已核实真实 physics.js 仅在真实模拟分支 emit physicsTick，同进程事件计数与"模拟前安装/模拟后计数"精确等价，无需补丁；接缝仅在安装异步化（M5 桥接）或需归属插件模拟后修改/wire 取证时，以 wrap `simulatePlayer` 单点补丁实现，不 fork 循环。

**M5 封闭清单（审查发现 3/4/7，实现层现无消费者，不预建）**：openContainer 归因核对（绑定第一个 windowOpen，未核对目标上下文/窗口类型）；click 在途撤销封闭（clickWindow 等待期间 op.onRevoke 未设，真实 inventory 的 sleep/晚 ACK 路径会现出）；apply 双边界 validUntil 拆分（当前安装同步、单边界等价）；inventory 槽位预测标注（fake 的 acceptClick 钩子只改窗口，M5 按真实写入点扩展）。

**登记不修**：received ACK 层同域惰性与 `evidenceThroughAll()` 跨流取 max（与 world 审查发现 2 同源，挂 M5 拆域决策）；evidence 材料在无 durable ACK 时只增不减（选定证据速率低，登记监控点）；endUse/使用会话归属按 Body 粒度（细化归 HostCallVerifier 接线时裁定）。

**验证**：biome ✓ / boundaries ✓ / tsc ✓ / minecraft 全套 66 例 ✓（新增 dig 预测标注、窗口预测标注与版本同源回归用例）。
