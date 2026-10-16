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
