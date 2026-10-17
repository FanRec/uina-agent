# Minecraft World — 技术负责人协调文档（LEAD.md）

更新：2026-10-18。所有者：技术负责人（lead）。三个开发 AI 与 lead 都必须遵守本文。

## 0. 事实基线（2026-10-18 核实）

- Driver 已接真实 Mineflayer（4.39.0，`driver/mineflayer/` 为默认工厂），但**尚未对真实服务器验收**；World/Assets 仍是 fake/本地实现，`executor/index.ts`、`worlddef/index.ts` 仍未实现。
- 总设计来源仍为主工作区 `E:/Uina/Uina/docs/proposals/mc/`（README/design/contracts/public-api/research + modules/driver.md、world.md、assets.md、runtime.md）；Program 的模块详细设计按本次目录约定落在 `.uina/worlds/minecraft/modules/program.md`，该文件是 Program 内部唯一设计源。
- 已有可复用接缝：`src/extensions/world-framework/`（WorldDef/ActionDef、五态 ToolExecutionResult、`ctx.expose("body.endpoint:"+bodyId)` 急停门、`emitEvent` 事件递送、`worldDataDir` 数据目录）。Minecraft 以普通 World 形态接入，**不改 Core**。
- 唯一例外：`tool_result_recorded` 通用事实需 Core 变更，当前源码没有——凡依赖它的递达保证一律标记为 Runtime/Core 依赖，未实现前不得宣称。

## 1. 目录与文件所有权（互不冲突）

根目录：`.uina/worlds/minecraft/`

| 路径 | 所有者 | 内容 |
| --- | --- | --- |
| `contracts/**` | **lead 独占** | 跨模块公共类型/错误码/入口签名（唯一合同源） |
| `worlddef/**`、`executor/**` | **lead 独占** | Uina 薄接入（façade/急停门/事件递送）+ Executor/运行管理 + 组合根 |
| `driver/**` | Driver AI | Mineflayer 适配（`mineflayer/`）、身体资格、控制、反馈、ClientFactsPort 实现、fake bot 测试替身 |
| `world/**` | World AI | 证据接收/ACK、查询切面、Watch 水位、SQLite 历史、领域记录、保留 |
| `assets/**` | Assets AI | 资产仓库、版本/CAS/请求账本、字节对象、强证据保留 |
| `modules/program.md` | **lead 独占** | Program 执行域、桥接、普通 JS/Body/World/Assets 接缝、取消/退役和验收设计；不实施业务代码 |
| `tests/`（仓库根 `tests/minecraft-*.test.ts`） | 按前缀划属：`minecraft-driver-*` → Driver；`minecraft-world-*` → World；`minecraft-assets-*` → Assets；`minecraft-contracts*` / 其他 minecraft 前缀 → lead | 测试文件名即所有权；禁止跨写他人测试文件 |

规则：

1. **只改自己目录 + 自己前缀的测试文件**。发现他人模块的 bug：在集成报告登记，由 lead 转交，不得越界修复。
2. `package.json`（world 级）、`tsconfig.json`、`biome.json`、`scripts/check-boundaries.mjs`、world-framework 源码：全部归 lead。需要变更先登记。
3. 依赖新 npm 包必须经 lead 批准后由 lead 写入根 `package.json`；推荐优先 `node:sqlite`（Node ≥22 内置，避免新增原生依赖，Node 22.5+ 可用）。已批准：`mineflayer@4.39.0`、`vec3@0.1.7`（Driver 适配）。
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

- **worktree 由各模块 AI 开工时自建**（不预建）：从当前主分支 HEAD 创建，如 `git worktree add <path> -b mc/<module>`；路径用短前缀 `E:/Uina/wt/mc-<module>`（Windows 深路径预算友好；mc-driver/mc-world 两个既有 worktree 仍在 `C:/Users/34150/.codex/worktrees/` 旧路径，不迁移）。开工后先 rebase 到主分支最新（contracts 可能已被 lead 修订）。
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

### Lead — World/Driver 架构重构（2026-10-17，替换式重构四批次，commits fc1cfba / 4e95239 / 批次3 / 批次4）

依据用户批准的重构提案与七点约束执行；全部四批 minecraft 全套测试绿（106 例），biome/boundaries/tsc 绿。**本地提交未推送。**

1. **批次1 World SQLite Worker + 屏障化查询**：删除同步 flush-then-read（原先历史 read/retain 在调用栈内同步跑 node:sqlite，阻塞主事件循环）。新增专用 Worker（`world/internal/sqlite-worker.mjs`，纯 Node 内置，规避 loader/打包问题）；WorldStore 异步化；历史读=固定接收上界屏障→await 提交/明确故障→cursor 先于读取 await 固定→Worker 内原子读取（旧数据绝不携带覆盖新事实的 cursor）。createWorld 异步化（订阅先行+通知缓冲重放+恢复播种）。Worker 崩溃→显式 unavailable，当前读不受影响（集成测试含线程隔离/崩溃降级/屏障无遗漏/历史 watch 无漏）。
2. **批次2 ACK 收敛 durable-only + schema v3**：ClientEvidenceAck 删 receivedThrough+gaps（Driver 端零消费者）；ReceptionEngine 保留内部前缀/缺口/去重，durable 对外唯一；删除 R/recv 持久字段，schema v3 含 v2→v3 一次性 DROP COLUMN 迁移（数据行原样保留，迁移回归测试）。修复：evidence_end 封口闭合已持久缺口后 durable 立即重算（原先只挂在提交上）。
3. **批次3 Driver 状态唯一所有权**：gate=资格与操作唯一权威（删 #active 双指针、#ops 双集合、死 API notifyReleased、死记账 Operation.resources）；原生使用状态归属唯一权威=Body 会话（requireAvailable/claim/release，drive/useItem/feedback 同一路径——修复 feedback hold-use 完全绕过归属核验可与 useItem 双激活的缺口）；按键持有收编 KeyHold；窗口 revision 唯一权威=WindowSession（facts live getter，删拷贝值；setSlot host 单路径路由，删双订阅与第二份快照比较）；say 过 gate.admitEphemeralWrite（停用准入+身份核验+verifier permit=null 裁定，不要求 Body Permit）。核查其余三项记账判定独立必要：continuousRoot/useOwner/gate-permit 是三个不同事实各归其主；stamp 全局序号与流内序号语义空间不同；无隐性第二状态。
4. **批次4 文档反向更新**：world.md（§5.4/§5.6 durable-only、§6.2 提交屏障、§6.3 收缩为拆域条件条款、删 §6.4 tail 并集、§6.6/§11.2/§13.1 对齐、§18 可证伪场景表更新、Observation.history 降级条件条款）；driver.md（重构修订行、§5.4 具体归属机制、FIFO=grant 级澄清）；public-api.md（ACK 形状/语义、read 屏障语义）；contracts.md（对齐段落）；README.md（状态行）。

**真实验证边界（如实登记）**：全部测试基于 FakeClientBot 与 fake facts——不证明真实服务器协议时序、Mineflayer 物理精度、真实断电/WAL kill -9 恢复。未接线：真实 Mineflayer 工厂（M5）、Pathfinder/PVP 插件适配（M5）、Program IPC/Executor（Runtime 依赖）、worlddef 动作（仍 notImplemented 桩）。Body FIFO 与 Runtime 身体调用的关系已登记：FIFO 是 grant 级排队，Runtime 调度位于 acquire 之上，Driver 无第二套仲裁。

### Lead — 二轮收口：cursor 模型 / 身体调度权威 / 故障结算（2026-10-17，接上段，commits 见 git log）

按用户对上一轮的三处质疑做源码级复核并**替换**（不叠加）：minecraft 全套 116 例绿，`pnpm typecheck` 绿，`pnpm verify:mc-worker` 绿。**本地提交未推送。**

1. **cursor 模型替换（旧原则不成立）**：复核确认「cursor 必须先于读取固定」既不是充分也不是必要条件——cursor 取自失效事件计数时有两个真缺陷：(a) 新流水位基线为 0，`ensureStream` 之前发生的失效永远补不回来（读取窗口内到达的证据可被**永久漏唤醒**）；(b) cursor 在屏障之后固定，会提前消费读取未包含的提交。改为：数据与提交版本在**同一 SQLite 读取边界**取得，`cursor.sequence = page.version`；历史水位=已提交版本，只在提交成功后推进。现在「已读到的提交不再通知、读取边界之后的提交一定唤醒、提交前不唤醒」。双量纲（current=事件序 / history=提交版本）不可比，故一条流只允许声明一类依赖，混声明直接拒绝。
2. **durable 物理前提显式化**：Worker 打开时显式 `PRAGMA synchronous = FULL`（原先依赖编译默认值），打开握手回传实际 `journal_mode/synchronous`，存储门面暴露 `durability` 供状态与验证脚本核验。保留关系（retain/release）不再推进提交版本——它不改变查询可观察状态，原先会使分页 token 失效并误唤醒历史 watcher。
3. **身体调度权威**：核查 `acquire` 全部调用点——除测试外无生产消费者（Runtime 未落地），不存在既成双排队。定权威：Runtime 拥有任务调度，Driver 只强制唯一资格 + 按到达序发放租约，不做优先级/抢占；Runtime 对每次身体使用只保持一个在途 `acquire`（已写入 `contracts/body.ts` 与 driver.md §5.1）。
4. **停止完整性缺口（真缺陷，已修）**：`driver.close()` 原先先解除 host 代次撤销回调再 `host.close()`，导致排队中的 `acquire` **永不结算**，且在拆除过程中被 grant 一个指向空化身的会话（反证：移除修复后测试直接拿到 `BodySessionImpl`）。改为关闭前先结算整队（明确 `SOURCE_UNAVAILABLE` + 摘除 abort 监听），并在 grant 前复查连接状态。
5. **新增验证**：`tests/minecraft-world-cursor.test.ts`（3 例，其中 2 例在旧实现下失败：提交前唤醒、已读到仍通知）、`minecraft-world-barrier.test.ts`（多流+缺口+封口、并发交错、cursor 同源）、`minecraft-world-durability.test.ts`（WAL/FULL 实测、回应丢失≠未提交、重开按 ref 去重）、driver body 新增关闭结算例（含 `getEventListeners` 无泄漏断言）、`scripts/verify-mc-worker.mts`（真实 emit 产物启动 Worker：缺资产明确失败 → 复制后写入/读取/关闭 → 进程在 close 前退出后从 WAL 恢复 5 条）。

**仍然未证明的**：真实断电（kill -9 / 拔电）与长时间 WAL 行为、真实 Mineflayer 时序、真实服务器下的 durable 语义；emit 产物验证覆盖了"路径+模块格式+崩溃后 WAL 恢复"，不等于生产打包器（vite/tsup）也保留该资产——当前 mc 模块无打包器构建链，接入时需把 `sqlite-worker.mjs` 复制纳入构建脚本。

### Lead — CRAP/常规代码审查收口（2026-10-17，接二轮）

- **CRAP gate**：`--root=.uina/worlds/minecraft`（world/driver/contracts/executor/worlddef，460 函数）通过——无 comp>=8 且完全未测试的函数。明细债务（部分覆盖、gate 不拦、登记不修）：`feedback.apply` comp23/CRAP167、`body.writeRecord` comp22/116、`validateCursor` comp18/140、`normalizeEvidenceList` comp18/121、`drive` comp16/74——均上轮既有形态，非本轮引入。
- **审查补漏**：(1) `ensureStream` 混声明拒绝与历史流基线此前无测试 → 补 2 例单元（现 118 例）；(2) README 状态行与 world.md §6.6 补「retain/release 不推进提交版本」语义；(3) 复核 `contracts.md`/`public-api.md` 中「固定 cursor」表述均为 current 语境，非旧模型残留。
- **接受不堵的边界**：`driver.close()` 与并发 acquire 的窄窗口（close 进行中 state 仍 ready 时的新 acquire 会被 grant 后立即经 per-session 撤销回调退役）——queue 已先结算清空，无正确性漏洞；retain 屏障后存在性校验对屏障捕获后新接收的证据报 EVIDENCE_UNAVAILABLE，符合 world.md §15「不能保证已提交就拒绝」。

### Lead — 三轮审查落实：两段初始化 / 存储身份核验 / 文档终态（2026-10-17，commits 见 git log）

按 lead 第三轮审查逐条落实（不再整体重构）：

1. **P0 Watch 混合查询/时间阈值**：文档 §9.1 改为「失效只按查询可见边界定义」；混合查询与时间阈值写成**条件条款**（首个消费者立项时激活：Watch 内部关联多水位与独立到期条件，对外单一 Watch；时间到期是一次性失效，不要求写库推进版本）。代码侧 `ensureStream` 混声明的拒绝从"永久错误"改为"临时限制 + 指向条款"。
2. **P1 createWorld 阻塞**：核实成立（原先 await 打开握手+播种）。改为两段初始化：段1 立即建立当前基线并交付句柄；段2 历史独立 opening → ready/unavailable（`WorldStore.availability` 加 opening、接口加 `opened`；`WorldHandle.historySettled` 供确定性等待；status 如实报 opening）。打开失败是终态但**接收继续运转**（证据照常收、提交明确失败、durable 停在真实起点）——修掉了初版实现"无限缓冲导致 ACK 停摆"的退化。
3. **P1 INSERT OR IGNORE 无身份校验**：核实成立（真缺口）。Worker 入库前核验：同 (stream,seq) 必须同 ref、同 gap ref 必须同区间；不一致返回 conflicts → `reception.discardConflicts` 按源协议故障结算（不入库、不记账、不卡屏障、保留诊断）。新增 2 例验证（恢复后同 seq 换载荷 / 同 gap ref 换区间）。
4. **Driver**：FIFO 保留（不删），§5.1 把「Runtime 单在途 acquire」改标为 **Runtime 接线时必须闭合的合同项**（届时定最小形态）；§5.4 明确「Operation 拥有生命周期归属 ≠ 保存通用资源集合」，`Operation.resources` 不得重建。
5. **文档旧包袱全部删改**（不加修订说明堆叠）：§3 数据流图（T→屏障→DB→同一读取边界→切面）、§5.5（删 ACK gap ref/outbox）、§5.6（身份核验替 INSERT OR IGNORE）、§6.1/§6.5（删 R/D/tail/latest tail）、§9.1（失效=可见边界）、§11.1（schema v3 表）、§16（采纳决策更新）、§19（内核已实现、真实游戏未验证）、driver 状态行/§20/§5.1/§5.4；contracts.md/public-api.md 同步。残留 grep 清零。

**验证**：minecraft 全套 120 例绿（+2）；tsc/biome 绿；`pnpm verify:mc-worker` 绿（opened 语义同步进产物验证）。**未推送**。

### Assets AI — S-A1/S-A2/S-A3（2026-10-17，分支 mc/assets）

**交付**：Assets 仓库核心全部落地（`.uina/worlds/minecraft/assets/`：`index.ts` 组合根 + `internal/{canonical,validation,catalog,objects,repository}.ts`），按 LEAD §3 三切片一次性交付：

- **S-A1 仓库核心**：put/revise CAS（BEGIN IMMEDIATE + 条件 UPDATE，创建 expectedVersion=NULL）、名称头、规范 JSON 内容摘要（键序无关；evidence/sources 为出处不入摘要）、ASSET_EXISTS/REVISION_CONFLICT/ASSET_KIND_MISMATCH、三 kind 结构校验（program descriptor 不带 ref/implementation、blueprint source 对象必须已声明、CellTarget 四态、experience 结构）、requiredAssets 存在性（ASSET_DEPENDENCY_UNAVAILABLE）、read 核对包 Manifest 与目录行一致性并重算内容摘要、search（默认 heads/all/kind/query/cursor 分页）、inspect（schemaAvailability=unknown，本仓库无 schema 注册表）。
- **S-A2 字节对象**：stage 接收进本次独占 `tmp/<attemptId>`（fsync，key 不落盘路径，零字节允许，同 key 重新 stage 后写者胜且回收旧 attempt）；提交临界区同步 rename 安装全新 `objects/<objectId>` 禁止覆盖；objects.read 流末尾核对实际长度与摘要（range 读不核验）；发布可见性经修订 objects 映射；payload 篡改 → 流结束 ASSET_CORRUPT；meta.json 与目录声明不符 / 包缺失 → repository.read ASSET_CORRUPT。
- **S-A3 请求账本**：requestId 幂等重放（同 intentDigest 先于 CAS 与源读取返回原结果）、同键不同意图 REQUEST_CONFLICT、账本持久化（跨重启重放返回原结果）、并发 CAS 恰好一个成功、失败不毒化账本（可修后同 requestId 重新提交）。

**存储形态**：node:sqlite `catalog.sqlite`（repository/asset_heads/asset_revisions/operations + kind 索引）+ 普通文件包 `objects/<objectId>/{manifest.json,payload,meta.json}`、暂存 `tmp/<attemptId>/`。目录打不开直接抛错——Assets 无降级形态，由组合根处置。无 Draft 子系统、无内存第二实现、无 GC/引用计数（按 assets.md §1.3 最少持久状态）。

**合同读法登记（无类型改动，请 lead 确认）**：
1. **AssetRevision 无 name 字段**：修订目标名取自 `expectedRef` 的 name 部分（对当前 head 的 CAS 修订唯一自洽读法）；put 仍显式携带 name。
2. **账本键作用域退化为 requestId**：`createAssetRepository` 合同无 principal 注入，operations 以 requestId 为唯一键（assets.md §6.4 的 (ownerId, operation.id) 需接入层注入 ownerId 后才能生效）；跨调用者 requestId 碰撞会互相重放/冲突，建议 M4 接线时由组合根保证 requestId 全局唯一或注入 ownerId。
3. **证据保留 owner=requestId**：注入端口 retain/release 以 requestId 为 owner，幂等；同 requestId 并发重放不重复释放已提交版本的保留。
4. **contentDigest 域**：`sha256(J({domain:"minecraft-asset-content/1", kind, schema, content, objects, requiredAssets}))`；intentDigest 域 `minecraft-asset-request/1`（method/name/kind/expectedRef/reason + 同上内容字段）。合同未固定摘要域，实现自定义，read 侧同函数重算核对。
5. **summary 派生**：program 取 descriptor.summary、blueprint 取 content.summary、experience 取 judgment 首行（≤120 字符）——合同包封强制 summary 而 ExperienceDefinition 无该字段。
6. **设计文档对齐度**：assets.md 的 WriteLibrary/publish/工作区捕获/attachEvidence/publishFromRun 为未采纳的候选 API（lead 固定合同是 put/revise 形状）；实现保留其语义内核（单次捕获、暂存独占、账本重放先于 CAS、orphan 不认领、commit_unknown），workspace/import 来源的路径级沙箱与 ImportedFile 流未实现——合同无此入口。

**未验证边界（不做宣称）**：
- saveFromRun 的 Runtime capture 端（RuntimeAssetSourcePort）归 lead Executor（M4），`sources:[{kind:"run"}]` 仅作出处记录；EvidenceExportPort/attachEvidence 独立关联路径未在合同中，未实现。
- kill -9 / 断电恢复：已测 graceful close + 重开；未测进程崩溃后 WAL 恢复与"对象已安装、数据库未提交"的 orphan 清点（代码路径按 assets.md §7.4 实现：安装后抛错回滚留下未引用 orphan，不隔离不认领）。
- commit_unknown 路径（COMMIT 异常后按修订行存在性结算 STORE_UNAVAILABLE + committedRef）未在测试中强制触发（需注入存储故障），代码评审覆盖。
- 大对象流式发布的性能/内存未测量（assets.md §14 待实测项）；文件句柄 fsync 用 Node FileHandle.sync，目录 fsync Windows 不可用——跨存储断电原子性不承诺（与设计一致）。

**门禁**：biome ✓ / boundaries ✓ / tsc ✓ / `vitest run tests/minecraft-assets-*` 23/23 ✓；minecraft 全套 14 文件 124 例 ✓（未触碰 driver/world/worlddef/contracts 文件）。

**对抗式审查修复（同日第二轮，commit d674d98 + test）**：

1. **证据保留部分失败泄漏（中）**：`retainEvidence` 在 publish 的 try 块外调用——world retain 成功后 runtime retain 失败（或端口缺失）会绕过 catch 直接抛出，world 侧保留悬挂且无提交对应。修复：retainEvidence 内部对部分失败自清理（释放已成功一侧）；新增回归用例（world 成功 → runtime 失败 → 两侧 released 断言）。
2. **stage meta.json 持久性缺口（低-中）**：payload 有 fsync、installManifestSync 的 manifest 有 fsync，唯独 stage 的 meta.json 裸 writeFileSync——崩溃窗口内对象已 rename 安装而 meta 未落盘时，已发布修订被永久判 ASSET_CORRUPT。修复：rename 前对 meta.json 同步 fsync（与 assets.md §7.4 一致）。
3. **completion.verifier 校验缺口（低）**：合同 `CallableDescriptor.completion.verifier?: ExactRef` 提供时未校验格式，补 requireExactRef。
4. **测试盲区**：readObject 的多块（>64KiB）流式哈希与块边界 range 此前无覆盖；新增 70KiB 跨块逐字节一致用例。

**审查过但否决（登记理由）**：objectId 路径穿越防御——manifest 篡改已被"内容摘要重算先于路径使用"拦截（digest gate），而能写 objects/ 的攻击者同样能写 catalog.sqlite，同盘同权下额外路径校验防不了真实威胁模型，不加（no over-defense）；appliesTo.assets 不查存在性——经验可引用尚未导入的资产，弱引用语义留给领域模块；搜索 cursor 空串宽容为 0——无害。

### Lead — 真实 Mineflayer 接入审查（2026-10-18，commit 见 git log）

对 fb94761「接入真实 Mineflayer 客户端」及两个跟进修复（c42a94f 区块角归一、0940813 维度命名空间）做常规代码审查与架构审查。c42a94f/0940813 经上游源码核实正确；fb94761 有三处行为错误，均以真实 mineflayer 实例探针实测确认后修复（不是按源码推断）。

1. **P0 预测被标成 server**：根因是 dig 的本地空气写入（上游 digging.js:158 `_updateBlockState`，唯一本地写入入口）发生在 `await bot.dig()` **内部**并立即 emit blockUpdate，而原实现在 await 之后才 markBlockPredicted——ClientHost 先收到事件、把预测当 server 事实清掉标记（探针：`server:"minecraft:air" | prediction:"minecraft:air"`）。修法不猜时序：`BotEvents.blockUpdate` 增加第三参 `source: "server" | "prediction"`，适配层用 #localBlockWriteDepth 包裹 `bot._updateBlockState` 在窗口内打 prediction 标；`commitBlockChanged(pos, source)` 仅 server 源清预测标记；body.dig 改为**派发前** markBlockPredicted、失败时清标记。fake 的 dig 本地写同样发 prediction 源——此前 fake 用 `setTimeout(0)` 掩盖了真实时序。
2. **P0 耐久语义断层**：预检 matchItemSelector 与窗口期望都读 `components.durability`，而 1.20.5+ 的 item.components 是 `[{type,data}]` 数组、耐久在 `damage` 组件（durabilityUsed getter 读它）；适配层另用 `maxDurability - durabilityUsed`，两层不一致，真实形状下任何 minDurability 永远 TARGET_NOT_MET。修法：接缝 `BotItemStack` 增加唯一耐久语义 `remainingDurability: number | null`，由适配层计算；body/window 只比它，不再解析上游组件形状。
3. **P0 生命周期泄漏与幽灵 ready**：attach() 的 spawn/end/error 监听与 attachTimeoutMs 定时器未登记清理——close 早于 spawn 时定时器吊住进程（探针 1.5s），迟到的 spawn 还能把 disconnected 推回 ready，随后 `say()` 经 `host.bot!` 读 null 抛 TypeError。修法：attach 用 stops 数组 + settle 在全部路径撤销监听与定时器，并把 settle 登记进 #disposers；#onSpawn 在 #bot 为 null 时早退；driver/index.ts 的 say/#grant 判空后抛 SOURCE_UNAVAILABLE；markFaulted 在已 disconnected 时不再改写状态。
4. **结构（§3.1 对齐）**：createDriver 不再静态 import mineflayer，`DriverOptions.botFactory` 改为必填、由组合根注入；原始 bot 只在 driver/mineflayer/ 内被持有。
5. **失败分类**：接缝新增 `BotFailure extends Error`（kind: unavailable/stale/invalid），适配层不再抛裸 Error，body 的 equip 路径按 kind 映射；删除未接线的 `resyncWindow`（window.ts 无消费者）。
6. **门禁**：mineflayer 从 `^4.39.0` 锁成 `4.39.0`（头注释按该版本源码核实并写行号）；check-boundaries.mjs 新增第 9 条规则「mineflayer 与 vec3 只允许出现在 driver/mineflayer」，含违例与白名单两条自测样本；修 biome 格式与 import 排序。

**验证**：`pnpm typecheck` ✓（biome 491 files + 9 条边界规则 + tsc）；minecraft 相关 7 文件 76 例 ✓（mineflayer 10 / facts 12 / body 18 / window 8 / feedback 11 / integration 10 / review 7）。新增真实建连用例直接调用 createMineflayerBot 连 127.0.0.1:1 并如实断言 faulted——证明工厂接线可跑，不证明真实服务器时序。

**边界更新**：本文件上段「未接线：真实 Mineflayer 工厂（M5）」至此不再成立；仍未证明真实服务器协议时序、真实物理精度与耐久组件的服务端行为。
### Lead — 激活/关窗的异步派发真相（2026-10-18 第二轮，commit 见 git log）

审查首轮修复后遗留的 fire-and-forget：`activateBlock`/`activateEntity`/`closeWindow` 在接缝里是同步 `void`，适配层写 `void bot.activateX(...).catch(() => {})`，把上游 rejection 丢掉。上游核实（mineflayer 4.39.0）：`inventory.js:195` 的 `async activateBlock` 先 `await bot.lookAt()`（:200）再写 `block_place`；`:248 activateEntity` 同构（先 lookAt :250 再写 `use_entity` :251）；`:433 closeWindow` 同步写 `close_window` 后返回 Promise（pre-1.17 还要等库存同步 click）。即：async 只为转头，**Promise 完成才代表包已写入**，reject 表示包根本没发。

原后果有三条实际错误：interact 在 await 之前就回 `dispatch:"sent", completion:"met"`（lookAt 失败时是谎报）；openContainer 的激活失败会白等满 `openTimeoutMs` 才报 `EFFECT_UNCERTAIN`；interact 的 catch 未映射 `BotFailure`，方块未加载/实体已移除都被兜底成 `INVALID_ARGUMENT "interact 输入无效"`。

**修法**：接缝三方法改 `Promise<void>`；适配层统一走新增的 `#dispatch(label, run)`，失败转 `BotFailure("unavailable", "<label>派发失败：<message>")`（closeWindow 对不匹配 id 幂等返回）；`body.interact` 两分支 await 后再 `#gate.checkWrite(op)` 并结算，catch 在 invalidArgument 兜底前接 `fromBotFailure`；`openContainer` 先 await 激活（失败即 `cancelWait()` 撤销 windowOpen 监听与定时器）再等 `windowOpenPromise`，外层 catch 同样接 `fromBotFailure`；`window.#retire` 改 `await bot.closeWindow(...)`，等库存同步完成再解除本地绑定。fake 的三个方法同步改 async（行为不变）。

**新增用例（tests/minecraft-driver-body.test.ts）**：① 两个激活入口 reject → `SOURCE_UNAVAILABLE` + `dispatch:"not_sent"`，且 packets 无 `block_place`/`use_entity`；② 上游不 resolve 前不回执（`settled === false`），resolve 后回 `sent/met`；③ openContainer 激活失败立即失败（<300ms，而非等满 400ms 超时的 `EFFECT_UNCERTAIN`）。

**验证**：`pnpm typecheck` ✓（biome + 9 条边界规则 + tsc）；minecraft 相关 7 文件 **79 例** ✓（mineflayer 10 / facts 12 / body 21 / window 8 / feedback 11 / integration 10 / review 7）。

**仍未证明**：服务器是否接受激活（只能靠后续包 windowOpen/entityGone/槽位变化观察，属 M5 证据）；`closeWindow` 在 pre-1.17 的同步 click 失败语义未实测（当前吞掉不阻断退役，理由登记在 window.ts 注释）。
