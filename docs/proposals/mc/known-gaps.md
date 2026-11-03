# Minecraft World 缺陷与欠缺清单

日期：2026-11-03（批20 更新）。范围：`.uina/worlds/minecraft` 及其 Host 接缝。

本文由审查轮产初版、施工批次持续更新：关闭条目在关闭时写入"关闭事实"（含证据口径），开放条目保留现象/证据/修法要点三段；取舍（§8）登记后不修。历史措辞（如早期"未施工、未复跑"）只描述登记当轮，不代表当前状态。

## 1. 优先级与依赖

| 顺序 | 条目 | 理由 |
|---|---|---|
| 1 | G1 领域记录 | ~~下一工作包的唯一前置~~（已关闭） |
| 2 | ~~G6 节流推送~~ | **批20 已关闭**——同时修掉"模型不 read 就瞎"和"轮询成本"，面向观众线的前置已就位 |
| 3 | ~~G8 按调用的短窗~~ | **批20 已关闭**（同批含 G7 增量游标） |
| 4 | ~~G5 剩余能力~~ | 批19 收口 51/51 |
| 5 | G12 认证 / G13 平台 | 与玩法并行，不阻塞；剩余横向缺口还有 G14（30 分钟真模型窗口——i2.ts 预算/观察/扰动已就绪待跑）、G16 的负载/增长子项（随 G14 窗口）、G25（lane 侧隙绕柱残余）、G17（终态报告，待 G14）。G15/G16 断电子项已于批22 关闭 |

## 2. P0 阻断项

### G1 · World 领域记录未实现（✅ 已于 2026-10-30 批11 关闭）

- **现象**：`readRecord` / `writeRecord` 直接抛错，领域记录完全不存在。
- **证据**：`world/index.ts:249-255`（`throw unimplementedRecords(...)`）；`contracts/world.ts:28,41,53` 只定义了类型。
- **影响**：`places` / `remember` / `forget` 无法开工；"记住基地、重开读回"这条路为零。
- **修法**：`world/sqlite-worker.ts` 增领域记录表（record ref、revision、world/worldRevision/dimension 分区、schema、author、evidence 引用）；`world/index.ts` 实现 read/write + revision CAS；`capabilities/queries/places.ts`、`capabilities/actions/{remember,forget}.ts` 走现有 `capabilities/index.ts` 装配。
- **验收**：临时 SQLite Worker 关闭重开读回一致；同名覆盖只作用于对应世界记录；真服记住点 → 重启 → 读回并使用。
- **关闭事实**：records 表落地（SCHEMA v3→v4，`meta.record_version` 独立推进）、`removeRecord` 增补进 WorldPort 合同；`mc-world-records.test.ts` 覆盖 CAS/分区/悬空证据/重开/旧库拒绝；真服 `pnpm dev:mc:places` 源码与产物各 9/9（含"记住基地 → 关闭重开 → 读回 → goto 使用"，落点 gap 0.71）。author 列未建（合同无 author 字段，不预建）。

### G2 · Driver 窗口只有 4 类（✅ 已于 2026-11-01 批15 关闭）

- **现象**：布局表只有玩家窗口、工作台、熔炉、普通容器（`generic_9x1-6`、`generic_3x3`、`hopper`、`shulker_box`）。
- **证据**：`driver/window/layout.ts:31-54`；`crafting`/`furnace` 之外的 `blast_furnace`、`smoker`、`brewing_stand`、`enchanting_table`、`anvil`、`grindstone` 均无条目。
- **影响**：K7 五项（`brew` `enchant` `anvil` `grindstone` `trade`）全部卡死在这里，能力层无法绕开。
- **修法**：`window/layout.ts` 扩表，`protocol.ts` 的玩家快照继续复用同一张表；每个新窗口先只接"开窗 + 快照 + 关窗"，专用选择协议留给各自能力包。
- **验收**：各工作站开窗后 `slots[].region` 与真实客户端一致；不支持的类型仍明确失败。
- **关闭事实**：布局表增 5 条（brewing_stand 41 / enchantment 38 / anvil·grindstone·merchant 39，槽号真服实测核对），同文件新增 `opensWindow()` 替换 `body/session.ts` 里那份把附魔台/铁砧全拒掉的硬编码正则——那才是比布局表更早的卡点。K7 五项真服验收 14/14（源码与构建产物各一次），见 [实施记录](archive/stations-implementation.md)。`blast_furnace`/`smoker` 未加（`smelt@1` 的烹饪刻数与站别检索都要跟着改，没有消费者时不制造"看起来支持"的假象）。

### G3 · goto 缺站姿/可站立判据（✅ 已于 2026-10-31 批12 关闭）

- **现象**：完成判据是 GoalNear 的整数格 nodeGap，没有"站得住"这一层。
- **证据**：`development-plan §10.6` 登记为未做；`driver/goto.ts` 无 `standable` 之类判定。
- **影响**：`surface`（洞穴/水下脱困）、`tunnel`、`excavate`、`build`、`transit` 共同前置缺失。
- **关闭事实**：`SurfaceProbe` 窄端口（contracts/world.ts，public-api §5）+ `driver/mineflayer/world-scan.ts`：`standableAt`（脚下实心 + 上两格非固体非液体）、`skyOpenAt`（头顶之上无实体块，液体不遮天）、`findSkyAccess`（螺旋早退 + 限高列扫描 + 候选 skyOpen 复核）。goto@1 的 GoalNear 节点语义未改（§10.6 要求），判据经端口供 surface/fight 消费；未加载区块 null 不猜。真服：石箱挖出/水井游出均回露天可站（源码/产物 7/7）。tunnel/excavate/build/transit 沿用此端口，无需再建。

### G4 · `ctx.verify` 注册表为空（✅ 已于 2026-10-31 批13 关闭，本表补标）

- **现象**：门已存在，任何 verifier 调用都失败。
- **证据**：`runtime/engine.ts:1685-1691`（未注册即 `verifier ... is not registered`，hint 指向"随能力工作包到达"）。
- **影响**：`unknown` 效果无法显式复查；空间/施工包承诺的复查没有落点。
- **修法**：不预建注册框架。第一个真实需要复查的能力（空间/施工）在同一批里加注册入口与实现。
- **验收**：一次真实 `unknown` 被复查并追加到原 Effect，不改写历史报告。
- **关闭事实**：`EffectVerifier` 合同 + `EngineOptions.verifiers` 注册表 + 首个消费者 `verify/dig@1`（读 effect facts 的目标格：air→met/原方块→not_met/未加载→unknown）；`ctx.verify` append-only 追加 EffectVerification，效果行跨重启恢复后仍可复查；程序桥 `mc.verify`。真服 G4 复查 4 态（met/not_met/NOT_FOUND/不改写）随 `dev:mc:spatial` 8/8 通过（批13）。

## 3. 能力面缺口（G5）

实到 **15 查询 + 30 动作 = 45/51**（2026-10-31 批13 落地 `region` `tunnel` `excavate` 并关闭 G4；2026-11-01 批14 落地 `build.plan` `build`，K5 关闭；2026-11-01 批15 落地 `brew` `enchant` `anvil` `grindstone` `trade` 并关闭 G2；2026-11-01 批16 落地 `players`）。

| 工作包 | 前置 | 缺的条目 |
|---|---|---|
| ~~蓝图与施工~~ | — | **批14 已实现** `build.plan` `build` |
| ~~专用工作站~~ | G2 | **批15 已实现** `brew` `enchant` `anvil` `grindstone` `trade` |
| ~~玩家名单~~ | — | **批16 已实现** `players`（名单/跟踪实体分别投影；entities@1 玩家名覆写） |
| ~~地图~~ | G11 + 地图包读取 | **批17 已实现** `map`（协议捕获/色板/PNG 缓存/图片出口，G11 同批关闭） |
| ~~载具与活动~~ | 载具/拴绳/鱼漂/床交互 | **批18 已实现** `ride` `lead` `fish` `sleep`（真服 K8 验收 16/16）；`transit` 剩余，受 G21/G23 牵制 |

### ~~G21 · 上坡台阶行走楔死~~（批13 登记，批14 补充实测，**批19 关闭**）

- **现象**：`tunnel@1` 的上行走廊几何正确（规划器挖出踏步块与跳跃净空、挖除全部服务端确认），但机器人无法走上去：goto 的寻路与 drive 的 stepTo 都在台阶面楔死——贴面起跳的横向速度被面碰撞清零，起跳后原地升落（y 恒定），寻路则在 GoalNear 邻域（含"目标正下方一格"）满足后不爬台阶。
- **证据**：`dev:mc:spatial` 批13 真服记录——同一场景两条下行 1:1 隧道 8/8 通过，上行版本 stuck path 全程 y=200.00 恒定；探针（tp 后 drive{forward,jump} 对 1 格台阶）final y 仅 +0.26。批14 另测：同一次会话里平坦地面 `goto@1` 5 格 0.6s 到达，而跨 1 格高石台的 `goto@1` 40s 超时。这条直接决定了 `build@1` 必须按列自下而上施工（按层铺会让 1 格高的成品面连片，寻路去爬就整批 TIMEOUT）。
- **根因（批19 定位）**：`mineflayer-pathfinder` 的 `canStraightLine` 把"延迟起跳才能过"的节点算成"直线可走"，执行器因此**永不按 jump**；随后 `resetPath('stuck')` 不 emit `path_stop`，promise 不 settle，只能等 40s 墙钟。真服实测：起跳点距台阶面 ≥0.89 格才过得去；贴面起跳的横向速度被面碰撞吃掉，空中控制 0.02/拍补不回来，只能原地弹跳。
- **修法（已落地）**：`patches/mineflayer-pathfinder@2.4.5.patch`——`physics.stepAt(bot, nextPoint, d)` 沿行进方向 d 格处探测"脚下一格实心 + 头上一格空"，`shouldJump` 判定"1.2/1.8 处有台阶且 0.6 处还没贴上"才起跳（贴上了就**后退助跑**：`stuckSince`/`backUntil`，退让 200ms 起、上限 900ms）；`allowParkour` 显式关掉（执行器做不稳跑酷节点）。配套 `driver/goto.ts` 的**无进展看门狗**：上膛（见过一次移动）+ 挖掘豁免（换目标算进展、同块 12s 算卡死）+ 3s 窗口 0.25 格位移，命中即 `UNREACHABLE`，不再烧满墙钟。
- **验收**：`dev:mc:climb` 真服 **5/5 PASS**——1 格台阶 1090ms、三级 1:1 阶梯 7318ms、密封竖井 68ms 快速失败（原 40s 墙钟）、平地 30 格 5472ms。
- **残余**：见 G24（1:1 上行走廊的净空本身不够，不是导航问题）。

### G24 · 上行 1:1 走廊 2 高净空物理不可通行（批19 登记，✅ 已于 2026-11-03 批21 关闭）

- **现象**：`tunnel@1` 默认 `size:"1x2"` 挖出的上行走廊，机器人走不进去；换成 `1x3` 仍只到 dug=10。
- **证据**：`dev:mc:climb` 批19 的隧道步骤（已从场景移除）——stuck 在 9824/9825 米、want 9827,203；同一补丁下 1 格台阶与三级阶梯都秒过。
- **原因**：不是导航 bug。玩家高 1.8，跳跃抬升 ~1.25 格；踏步上方只有 1 格空间（2 高走廊）时，身体在起跳瞬间被天花板削顶，从静止起跳翻不上 1 格。原版玩家同样做不到——要上 1 格必须有 3 高净空（或半砖级差）。
- **修法方向**：`tunnel@1` 上行段把踏步上方留到 3 格净空（`size` 语义或自动加高），或改挖半砖台阶；这是 `tunnel` 的规划问题，不动导航。
- **验收**：`1x2` 上行 1:1 走廊在自动加高后能走到终点，或 `tunnel@1` 对上行请求明确要求 3 高净空。
- **关闭事实**：`planCorridor` 上坡过渡在 height<3 的 profile 下把升坡列自身 ceiling 一并挖除（踏步上方成 3 高净空；height≥3 物理已够不多挖），`digCeiling` 使支撑探测自动上移一格；合同句落 capabilities.md §4 tunnel。真服 `dev:mc:climb` 源码与产物各 6/6：1x2 上行 1:1 走廊 10 格全挖（与规划器逐格一致）并走到终点（服务端 Pos y=202.0），升坡列顶 (9821,203)/(9822,204) 世界复读为 air、平地段顶 (9824,204) 保持 stone；既有 1 格台阶/三级阶梯/密封竖井 100ms 快速失败/平地 30 格全部保持通过。另注：本批首轮竖井步骤曾从 UNREACHABLE 变成 75 ticks 到达——成因是前置隧道步骤挖通的走廊把掉落物全部收进背包，goto 的 placeToReach（默认 true，垫柱合法）用圆石垫柱翻出 2 高石壁（`placed` 恒 null 无法归属）；场景步骤现以 `/clear` 固定其"无材料"前提。批19 的 1x3 dug=10 楔死记录不在本批重审范围（该轮步骤已移除） |

### G25 · lane 侧隙绕柱执行器零推进（批22 登记）

- **现象**：受控车道（3 宽石面、上方 4 格净空、中置 3 高柱、两侧各 1 格净宽）上，目标在柱后时 goto 零位移：goal 已设、`route.plan` 只读试算 **5 步可达**，`gotoNear` 实时 A* 却静默空转——isMoving 永假、无 NoPath、promise 不结算（批22 看门狗修复前烧满墙钟，修复后 10–12s 诚实 UNREACHABLE）。平原/水边地形同几何 **7.1s 绕行到达**，山腰地形稳定失败——地形依赖。
- **证据**：`dev:mc:terrain-nav` 批22 多轮（trace 采样 spread=0.0、对照实验隔离：A placeToReach true/false 双失败、B lane 内无柱点 2s 到达、C 抬目标失败——卡点精确在"绕入 1 宽侧隙"）。
- **影响**：山地等复杂地形上，需要从 1 宽缝隙绕过直立障碍的导航不可用（诚实快速失败，不挂死）；树绕行/开放地形穿越/explore 不受影响（均实测通过）。
- **修法方向**：上游 `mineflayer-pathfinder` 的 Movements 差异（planPath 只读试算与 gotoNear 实时 A* 的配置/代价不一致）或 1 宽通道代价判定；属依赖执行器层，不改导航合同。看门狗已保证此类失败快速诚实。

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| ~~G6~~ | **无周期性推送**（✅ 已于 2026-11-03 批20 关闭） | 关闭方式：`world/digest.ts` 按查询依赖采样（self@1/inventory@1/world@1 三个现有读取器，同一 `facts.sample` 提交边界，与 observe 同口径）、前缘节流 10s（`DIGEST_INTERVAL_MS` 集中策略值）、规范化 JSON 哈希去重、facts reset 后补发；`companion/side.ts` 经 `onGameEvent` 上行，`executor/delivery.ts` 以独立事件类型 **minecraft_digest** 交付（不指向 events@1），主脑忙碌（`isBusy`）时只保留最新一份、空闲即补发。时间只取粗粒度相位与天数（ticks 连续变化会让去重失效），位置取整数格 | 真服 `dev:mc:digest` 7/7：baseline 三段齐全、空闲 15s 零 digest（去重）、/give 后 digest 反映变化、节流 gap 10015ms、events@1 无污染；泵层事件分类/忙时合并由 mc-delivery-pump 单测覆盖 |
| ~~G7~~ | **查询无增量**（✅ 已于 2026-11-03 批20 关闭，inventory@1 先行） | 关闭方式：`protocol.ts` 增每槽位最后变更 revision 标记（`playerSlotMarks`，全量重同步只标内容真变的槽位，光标只推 revision 不算槽位）；`view.inventoryChanges(since)` 暴露差量（标记不可用回 null 不猜）；`inventory@1` 输入 `{since}` 回 `{revision, changes:[{slot,item|null}], counts, usedSlots, freeSlots}`（差量 + 变化后总数，不含全量 slots）；`since` 超前（含跨重启 revision 归零）如实 INVALID_INPUT。其余查询仍全量，按真实消费者逐个补 | 真服：rev 10→11 差量恰含 emerald +2；单测覆盖同游标/差量/标记不可用回退全量/超前报错四态 |
| ~~G8~~ | **`run` 短窗全局固定 3000ms**（✅ 已于 2026-11-03 批20 关闭） | 关闭方式：`worlddef/schema.ts` 的 `run` 增 `wait`（ms，≥0），`executor/facade.ts` 按调用覆盖短窗，`wait:0` 只受理不等（完成走 minecraft_completion 通知）；指南同步 | mc-native-facade 单测：默认 3000 / 覆盖 1200 / 0 跳过等待 三态 |
| ~~G9~~ | **普通 Run 之间无优先级**（✅ 已于 2026-11-03 批21 关闭） | 关闭方式：`Schedule` 的 enqueue 变体增 `priority?: boolean`（contracts/runtime.ts，public-api §7 同步）；engine 在独立身体申请与导航申请两处入队前按 `state.request.schedule` 重设队列既有的一次性 `prioritize` 旗标（`runtime/engine.ts` `prioritizeIfRequested`），队列无常驻优先级栈的不变量不破坏 | 插队/一次性消费/safety 仍最前由 `mc-body-queue` 覆盖；engine 接线（priority 先于 FIFO 等待者取得身体 + 无 priority 的 FIFO 控制组）由 `mc-decision-runtime` 真 SQLite 引擎覆盖；facade 透传由 `mc-continue-facade` 覆盖。priority 只作用于本次受理的段，continue 新段不带（worlddef 指南同步） |
| ~~G10~~ | **两个计算预算不统一**（✅ 已于 2026-11-03 批21 关闭） | 关闭方式：两处 `FRAME_EXPIRED` 统一携带 hint（"inputs must apply within the 250ms feedback frame; chunk long synchronous computation with await mc.sleep(0)…"），数字语义不同（250ms 帧窗 vs 20ms burst）不做常量合并；baseGuide 把"过期帧拒绝"与"mc.sleep(0) 分片"接成因果句 | `mc-feedback` 过期用例断言 hint 含 mc.sleep(0)；engine 侧 failureData 本就透传 hint，零改动 |
| ~~G11~~ | **Host 无图片出口**（✅ 已于 2026-11-01 批17 关闭） | 关闭方式：`world/map.ts` 产 ImageFileRef + `companion/side.ts` read_image rpc + `executor/facade.ts` observe 产 `ToolExecutionResult.images`；world-tool 本就透传 | 真实 wire：受控 5/5 + 真模型 4/4（模型实际描述画面） |

## 5. P1 兼容与认证

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| G12 | Microsoft 认证未实现，正式入口硬锁 offline + 1.21.11 | `worlddef/index.ts:77` | 独立工作包；版本锁降为配置项，认证走 `driver/client-host.ts` 连接参数 |
| G13 | Windows 10、ARM 未验收；其他协议版本未接 | `archive/executor-platform-implementation.md` 证据边界 | 按实际使用平台补 OS 验证；版本差异只在 `DriverProtocol` 窄口处理 |

## 6. P2 只通过一次、未复验

| ID | 项 | 状态 |
|---|---|---|
| G14 | 30 分钟真实模型自主游玩 | 9B 暴露**重复死亡 + OwnerLost 门关闭后不恢复**；批10 补了自保与恢复但**未重跑同一窗口**，"自主生存"仍为空。批22 已把窗口就绪：`dev/i2.ts` 增请求预算（`--max-requests` 默认 500，达限即 interrupt）、观察扩展（self 健康与氧气、death 事件游标计数、runs 门状态与 safety 介入）、扰动演练（`--chaos`：窗口 60% 处 SIGKILL 伴生 → owner_lost → 模型须 `runs recover` 自开门，批9B 断链的直接复验开关）；真模型窗口待执行 |
| ~~G15~~ | **复杂避障**（✅ 已于 2026-11-04 批22 关闭，残余见 G25） | 关闭方式：批9B 的静默挂死根治——`driver/goto.ts` 看门狗三形态收束（上膛后 3s 位移停滞 / 上膛后 goal 被上游清空 2.5s 宽限仍不结算 / 非挖掘 10s 零位移总兜底，均 Stalled → UNREACHABLE，墙钟不再烧尽）；新增自然地形验收场景 `dev:mc:terrain-nav`（自寻真树、水候选拒绝、批9B 复刻 lane 柱、树绕行/digThrough、24 格穿越、explore） | 真服源码/产物各 6/6：树绕行 4.5–7s 到达、digThrough 对照到达、穿越 19.7s 到达或 9.9s 诚实失败、explore 25–40 格、批9B 复刻到达（平原 7.1s）或 12s 诚实失败（山地）；climb 回归 6/6（密封竖井 100ms 快速失败不受影响）；执行器残余登记 G25 |
| G16 | 断电、长期负载、历史库增长成本 | **断电子项批22 已闭**：`tests/mc/mc-executor-kill-write.test.ts`——伴生在 runtime.db 写活动窗口被 SIGKILL → autoRecover 托管重建回 ready → 取证（独立进程）证 meta 身份不变、恢复只增不删、无半行损坏、owner_lost 如实关闭、探针 DISCONNECTED 诚实结算（3 次稳定）；`dev:mc:history --stats` 体量观测手段就绪。长期负载与历史库增长两项随 G14 窗口（i2.ts 预算/观察/扰动已就绪，真模型窗口待执行） |
| G17 | 51 项终态报告 | 不存在；需按 `buildCapabilities()` 实际目录与 `capabilities.md` 的 16+35 逐项对照出状态表 |

## 7. P2 文档漂移（✅ 已于 2026-11-03 批21 全部修复）

| 位置 | 原漂移 | 修复 |
|---|---|---|
| `modules/executor.md` | "当前没有 Minecraft World 入口" | 改为批 4–6 已接通 WorldDef/回执、批 7–9 接通 Program/Library 与 I2 |
| `modules/runtime.md` | "schema v5" | v6（批10 起） |
| `modules/runtime.md` | "feedback 尚缺" | 批10 已交付并真服验证 |
| `modules/world.md` | "终态设计尚未重写或验收" | 现行实现运行中并经真服验收；断电/长期负载归 G16 |
| `contracts.md` | "等待/决策与完整 I2 仍待实现" | 9A/9B 均已实现，能力面 51/51 |

`README.md`、`development-plan §10`、`dev/MC-WORLD.md` 三处状态表准确，不必改。

## 8. 设计取舍（登记，不修）

| ID | 取舍 | 代价 |
|---|---|---|
| G18 | 无 policy 层（`development-guide §3.5` 明确反对） | 偏好每次调用都要重传（如 `mine@1` 的 `tool`） |
| G19 | 无断言器 | 模型要自己 `read` 拼判断，没有"只回不成立条款"的入口 |
| G20 | 无 dry-run | `route.plan`（2026-10-30 批11）与 `build.plan`（2026-11-01 批14）均已落地，移动目标与施工目标都可试算；剩余能力仍只能真跑 |

### G22 · 施工不搭脚手架、不绕行（批14 登记）

- **现象**：`scaffoldsUsed` 占位结果字段已于批23 删除（恒 0、无能力支撑，schema/返回值/文档不再暴露该承诺；"不搭脚手架"的取舍本身不变）；够不着的格只做一次朝向设计盒的走位（盒中心 → 盒外同侧地面），不做绕行寻路、不垫柱登高。走不过去或站在封闭结构里时，对应格进 `remaining`（`reason` 写清是没支撑、够不着还是走不到）。
- **依据**：§4 总则"可达性归调用方"——站位是调用方的责任，动作内部寻路会与 `goto@1` 重复实现一套路径逻辑。真服验收里也是场景先把身体放到盒内中心再施工（`/tp` 属场景准备，不是被测行为）。
- **影响**：一次调用能建的规模受"从当前位置的 4.5 格射程"限制。5×5×4 小屋在盒中心可以一站建完（最远角 4.76，靠一格 `stepTo` 补上）；更大的结构要调用方分段站位。
- **未做**：垫柱/脚手架、绕行、按可达性重排的大型工程分段。

### G23 · 有鞍马驾驶不可达（批18 登记，真服探针实证）

- **现象**：1.21.2+ 骑乘位移协议上是客户端权威（`vehicle_move` 位置申报），船的申报 100% 被接受（服务端 Pos 对拍差 0.05 格）；但 Paper 1.21.11 对**有鞍马**忽略 `vehicle_move`（同一匹马 A/B 对比：申报流期间服务端 Pos 零位移），**无鞍马**会追踪申报点但方向不受申报 yaw 控制（AI 漂移，2.7 格级随机偏离）。马驾驶因此不可达——这是服务器侧行为，不是客户端实现缺口。
- **证据**：批18 探针 T/V/W/X 系列（真服 Paper 1.21.11 build132）：有鞍马申报 40 拍服务端 Pos 恒定；卸鞍后服务端 Pos 追踪申报终点但落点偏移 ≥2.7 格；同场对照船申报精确到达。验收口径按此收窄：`ride@1` 对马如实 `UNREACHABLE`（缺 G23），矿车不可转向如实 `WRONG_STATE`，船驾驶全绿（到达断言走服务端 Pos）。
- **影响**：`ride@1` 的 `to` 对马系坐骑是空话；远距离马背交通与 `transit` 的 horse 阶段在 Paper 上不成立，只能依赖步行 goto 或船/矿车。
- **修法方向**：协议层无马驾驶确认包，怀疑 Paper 的载具反作弊按"有鞍=玩家控制=客户端位置申报不可信"处理；无上游修复前不做绕行（伪造包属于作弊面）。上游版本升级时用同探针复测。

## 9. 批23 审查修复轮关闭记录（2026-11-04）

外部审查（11 项定位缺陷 + 5 项简化）经三路源码核实后分五个 PR 修复。核实结论：10 项确认、1 项部分成立（事件交付——G6 digest 削峰与证据持久化已存在，真实缺口是断线/私聊两个死分支）、3 项过时（本清单并不漂移、G21/G24 已关闭）。

- **断线证据链**：FactsSource 在 host disconnected/faulted 时先 capture 断线证据再封源（旧实现的 end 监听因 attachedBot 已清空而空转，断线从不入库、importantEvents 推送死路）；主动关闭记 reason=closed。
- **聊天 channel 对齐合同**：whisper/chat 事件按 mineflayer 内建模式分流 private/public，messagestr 按原始消息对象身份去重（同一入包只记一条），未匹配格式如实 unknown（playerChat 路径 sender 记 uuid 不冒充 name）——public-api §events 的 channel 枚举自始如此，实现此前一直违反。
- **事件投递**：minecraft_event/digest 投递失败 1s 补发一次（幂等 id）；完成回执路径未动。
- **生存介入重试**：锁存改 {key, retryAt}——确认安全锁存到危险事实消失，失败/抛错只冷却 1s 后允许重试；新伤害证据换 key 立即重试；faults 诊断加 32 条上限。
- **游戏断线恢复**：recover() 在执行侧进程健康但 side.connection disconnected/faulted 时退役重建执行域（复用 retireSide+startLaunch 与现有锁；旧 Run 不重放，connecting/syncing 不重复连接）。
- **扫描预算**：findSkyAccess 按时间预算（4ms）在候选列间让出（检查在列探测前）+ AbortSignal 停止屏障中途生效；下界跳过无意义的天空出口大扫描。
- **地图导出**：唯一 tmp + link 容忍 EEXIST（与 LibraryFiles.write 同家法），同摘要并发导出互不冲突；启动清理上一会话派生图片（磁盘有界，运行中不删已交付 ref）。
- **Watch 类别化失效**：见 [world §9.2](modules/world.md) 批23 注——inventory@1 等待不再被物理拍 20Hz 唤醒；公开合同不变。
- **简化批**：nativeGuide 4.3KB→1.75KB（无其他可发现来源的 mc API 要点保留，其余移交 describe）；删 `scaffoldsUsed` 占位字段（G22 已更新）；删 `PROGRAM_POLICY.workerCount` 零消费字段；未绑定世界启动警告；慢读诊断（>100ms 警告、10s 抑制，为 P1-9 测量取证）。
- **不做**：P1-9 大查询异步快照（先测量再定修法）；engine.ts/body-session.ts 拆分（文件长度不是重构理由）；Library 缓存；MapCache 内存上限；reconnect 热替换 Bot。

验收：tests/mc 89 文件 / 806 项全绿 + `pnpm typecheck`（biome + 10 边界 + 双 tsc），五个 PR 独立提交；断线入库、私聊推送、recover 重连、慢读测量的真服回归随 G14 窗口执行。

## 附：不要照抄的部分

对照 Cortico 后确认**不采用**：常驻 policy 层（G18 已裁决）、作弊传送脱困、把观测渲染成散文塞进 World。理由：分别违反"不堆隐藏配置"、"正常生存验收不靠传送"、"World 只给事实不给台词"。台词属表达侧。

## 附：证据边界

本轮仅源码阅读 + 实施记录交叉核对。未复跑 `tests/mc` 51 文件 / 378 项，未起 Paper，未调用真实模型。G14–G17 的"未验证"指记录里最后一次结论的状态，不是本轮新测。
