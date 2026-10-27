# Minecraft World 缺陷与欠缺清单

日期：2026-10-27。范围：`.uina/worlds/minecraft` 及其 Host 接缝。

证据口径：**[源码]** = 本次逐行核实；**[记录]** = 来自实施记录，本轮未复跑。本文是只读审查产出，未施工、未改代码、未起服务端、未复跑测试。

## 1. 优先级与依赖

| 顺序 | 条目 | 理由 |
|---|---|---|
| 1 | G1 领域记录 | 下一工作包（地点/探索）的唯一前置；纯确定性、可单测，不依赖真服 |
| 2 | G6 节流推送 | 同时修掉"模型不 read 就瞎"和"轮询成本"，是面向观众这条线的前置 |
| 3 | G8 按调用的短窗 | 演出节奏的唯一硬阻塞，改动面最小 |
| 4 | G5 剩余 26 项能力 | 按 §4 的 7 个工作包推进，不平铺 |
| 5 | G12 认证 / G13 平台 | 与玩法并行，不阻塞 |

## 2. P0 阻断项

### G1 · World 领域记录未实现

- **现象**：`readRecord` / `writeRecord` 直接抛错，领域记录完全不存在。
- **证据**：`world/index.ts:249-255`（`throw unimplementedRecords(...)`）；`contracts/world.ts:28,41,53` 只定义了类型。
- **影响**：`places` / `remember` / `forget` 无法开工；"记住基地、重开读回"这条路为零。
- **修法**：`world/sqlite-worker.ts` 增领域记录表（record ref、revision、world/worldRevision/dimension 分区、schema、author、evidence 引用）；`world/index.ts` 实现 read/write + revision CAS；`capabilities/queries/places.ts`、`capabilities/actions/{remember,forget}.ts` 走现有 `capabilities/index.ts` 装配。
- **验收**：临时 SQLite Worker 关闭重开读回一致；同名覆盖只作用于对应世界记录；真服记住点 → 重启 → 读回并使用。

### G2 · Driver 窗口只有 4 类

- **现象**：布局表只有玩家窗口、工作台、熔炉、普通容器（`generic_9x1-6`、`generic_3x3`、`hopper`、`shulker_box`）。
- **证据**：`driver/window/layout.ts:31-54`；`crafting`/`furnace` 之外的 `blast_furnace`、`smoker`、`brewing_stand`、`enchanting_table`、`anvil`、`grindstone` 均无条目。
- **影响**：K7 五项（`brew` `enchant` `anvil` `grindstone` `trade`）全部卡死在这里，能力层无法绕开。
- **修法**：`window/layout.ts` 扩表，`protocol.ts` 的玩家快照继续复用同一张表；每个新窗口先只接"开窗 + 快照 + 关窗"，专用选择协议留给各自能力包。
- **验收**：各工作站开窗后 `slots[].region` 与真实客户端一致；不支持的类型仍明确失败。

### G3 · goto 缺站姿/可站立判据

- **现象**：完成判据是 GoalNear 的整数格 nodeGap，没有"站得住"这一层。
- **证据**：`development-plan §10.6` 登记为未做；`driver/goto.ts` 无 `standable` 之类判定。
- **影响**：`surface`（洞穴/水下脱困）、`tunnel`、`excavate`、`build`、`transit` 共同前置缺失。
- **修法**：在 `driver/goto.ts` 落判据（脚下实心 + 上方两格非固体 + `onGround`），只作为**完成判据**，不改 GoalNear 的节点语义。
- **验收**：真服从洞穴与水下分别回到满足判据的位置；不可达/超时如实报。

### G4 · `ctx.verify` 注册表为空

- **现象**：门已存在，任何 verifier 调用都失败。
- **证据**：`runtime/engine.ts:1685-1691`（未注册即 `verifier ... is not registered`，hint 指向"随能力工作包到达"）。
- **影响**：`unknown` 效果无法显式复查；空间/施工包承诺的复查没有落点。
- **修法**：不预建注册框架。第一个真实需要复查的能力（空间/施工）在同一批里加注册入口与实现。
- **验收**：一次真实 `unknown` 被复查并追加到原 Effect，不改写历史报告。

## 3. 能力面缺口（G5）

实到 **10 查询 + 15 动作 = 25/51**。`grep` 确认下列名字在 `capabilities/`、`world/` 零命中。

| 工作包 | 前置 | 缺的条目 |
|---|---|---|
| 地点与探索 | G1 | `places` `remember` `forget` `route.plan` `explore` |
| 移动鲁棒性 | G3 | `follow` `flee` `surface` |
| 完整战斗 | 无 | `fight` |
| 地形与空间作业 | Section 采样 + G3 + G4 | `region` `tunnel` `excavate` |
| 蓝图与施工 | Library 蓝图解释 + G4 | `build.plan` `build` |
| 社交与地图 | G11 + 地图包读取 | `players` `map` |
| 工作站与载具 | G2 + 载具/拴绳/鱼漂/床交互 | `brew` `enchant` `anvil` `grindstone` `trade` `ride` `lead` `fish` `sleep` `transit` |

## 4. P1 已实现部分的缺口

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| G6 | **无周期性推送**，模型不主动 `read` 就不知道世界在变 | `emitEvent` 全仓仅 `executor/delivery.ts:34`、`:230`，都是交付通知 | 新增节流快照：按查询依赖生成 digest，有变化才生成、同一份不重复、默认 10s，走独立事件类型（不污染 `events@1`） |
| G7 | **查询无增量**，每次回全量 | `capabilities/queries/*.ts` 中 `since`/`diff`/`delta` 零命中 | 先给 `inventory@1` 加 `since` 游标，回差量 + 变化后总数 |
| G8 | **`run` 短窗全局固定 3000ms**，不能按调用选择不等 | `executor/facade.ts:200-215`；`worlddef/index.ts:15` 只有世界级 `deliveryPolicy` | `worlddef/schema.ts` 的 `run` 增 `wait` 或 `shortWindowMs` 覆盖，落到 `facade.ts:204` |
| G9 | **普通 Run 之间无优先级**，长任务可挡紧急任务 | `runtime/engine.ts` 单槽队列 + `preempt_current` 需 `expectedRun` | 先只做"显式插入"一档，不建多级调度；safety 已独立 |
| G10 | **两个计算预算不统一** | `driver/body/feedback.ts:84,205`（`FRAME_EXPIRED`, 250ms）vs `program/worker.ts:107`（`PROGRAM_TIMEOUT`, burst + `mc.sleep(0)`） | 最小改动：`FRAME_EXPIRED` 的 hint 指向 burst 预算；能力面与 Program 指南各补一句 |
| G11 | **Host 无图片出口**，`map@1` 缺最后一跳 | `src/extensions/world-framework/world-tool.ts` 不产 `images`；`src/core/types.ts:104` 契约已有 `ImageContent` | 依赖 `map@1` 本身；接线时让 WorldDef 的 action 返回 `images` |

## 5. P1 兼容与认证

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| G12 | Microsoft 认证未实现，正式入口硬锁 offline + 1.21.11 | `worlddef/index.ts:77` | 独立工作包；版本锁降为配置项，认证走 `driver/client-host.ts` 连接参数 |
| G13 | Windows 10、ARM 未验收；其他协议版本未接 | `archive/executor-platform-implementation.md` 证据边界 | 按实际使用平台补 OS 验证；版本差异只在 `DriverProtocol` 窄口处理 |

## 6. P2 只通过一次、未复验

| ID | 项 | 状态 |
|---|---|---|
| G14 | 30 分钟真实模型自主游玩 | 9B 暴露**重复死亡 + OwnerLost 门关闭后不恢复**；批10 补了自保与恢复但**未重跑同一窗口**，"自主生存"仍为空 |
| G15 | 复杂避障 | 导航交接首次因残留树干超时，验收改用空走廊绕开，**算法未修** |
| G16 | 断电、长期负载、历史库增长成本 | 均未验证 |
| G17 | 51 项终态报告 | 不存在；需按 `buildCapabilities()` 实际目录与 `capabilities.md` 的 16+35 逐项对照出状态表 |

## 7. P2 文档漂移

| 位置 | 现文 | 实际 |
|---|---|---|
| `modules/executor.md:566` | "当前没有 Minecraft World 入口" | WorldDef 已接线并有真服记录 |
| `modules/runtime.md:339` | "schema v5" | v6（批10） |
| `modules/runtime.md:340` | "feedback 尚缺" | 批10 已交付并真服验证 |
| `modules/world.md:632` | "终态设计尚未重写或验收" | 三路读取/历史/Watch 均在运行 |
| `contracts.md:3` | "等待/决策与完整 I2 仍待实现" | 9A/9B 均已实现 |

`README.md`、`development-plan §10`、`dev/MC-WORLD.md` 三处状态表准确，不必改。

## 8. 设计取舍（登记，不修）

| ID | 取舍 | 代价 |
|---|---|---|
| G18 | 无 policy 层（`development-guide §3.5` 明确反对） | 偏好每次调用都要重传（如 `mine@1` 的 `tool`） |
| G19 | 无断言器 | 模型要自己 `read` 拼判断，没有"只回不成立条款"的入口 |
| G20 | 无 dry-run | `route.plan`/`build.plan` 落地前，验证"能不能建"只能真跑 |

## 附：不要照抄的部分

对照 Cortico 后确认**不采用**：常驻 policy 层（G18 已裁决）、作弊传送脱困、把观测渲染成散文塞进 World。理由：分别违反"不堆隐藏配置"、"正常生存验收不靠传送"、"World 只给事实不给台词"。台词属表达侧。

## 附：证据边界

本轮仅源码阅读 + 实施记录交叉核对。未复跑 `tests/mc` 51 文件 / 378 项，未起 Paper，未调用真实模型。G14–G17 的"未验证"指记录里最后一次结论的状态，不是本轮新测。
