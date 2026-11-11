# Minecraft World 缺陷与欠缺清单

日期：2026-11-07（批35 更新）。范围：`.uina/worlds/minecraft` 及其 Host 接缝。

本文由审查轮产初版、施工批次持续更新：关闭条目在关闭时写入"关闭事实"（含证据口径），开放条目保留现象/证据/修法要点三段；取舍（§8）登记后不修。历史措辞（如早期"未施工、未复跑"）只描述登记当轮，不代表当前状态。批26 的施工范围（RuntimeArchiveReader、profile 查询参数、离线 saveFromRun、交付 envelope、完整 M4）属设计合同剩余项，见 [multi-world-v3.md](multi-world-v3.md) §7/§10 与 development-plan §10.3 批25 条，不在本清单重复登记。

Minecraft World V2 已将公开任务入口统一为 `tasks`，并验证限定坐标施工的跨进程恢复和指定组合的 Fabric 支持。当前范围和复验证据见 [V2 验收记录](archive/world-refactor-v2.md)。

## 1. 优先级与依赖

| 顺序 | 条目 | 理由 |
|---|---|---|
| 1 | G1 领域记录 | ~~下一工作包的唯一前置~~（已关闭） |
| 2 | ~~G6 节流推送~~ | **批20 已关闭**——同时修掉"模型不 read 就瞎"和"轮询成本"，面向观众线的前置已就位 |
| 3 | ~~G8 按调用的短窗~~ | **批20 已关闭，批41 换成纯异步受理**（同批含 G7 增量游标） |
| 4 | ~~G5 剩余能力~~ | 批19 收口 51/51 |
| 5 | G12 认证 / G13 平台 | 与玩法并行，不阻塞；剩余横向缺口还有 G14（30 分钟真模型窗口——i2.ts 预算/观察/扰动已就绪待跑）、G16 的负载/增长子项（随 G14 窗口）、G17（终态报告，待 G14）；G25 已于批26 关闭，其 A* think budget 搜索加速残余已于批28 关闭（启发式加权，见 G25 关闭事实残余段），S3 水中爬岸耗时方差仍在——归水节点出发的控制/规划不稳，不再归属搜索预算；G26/G27 已于批27 关闭（§4.1） | |

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

### G25 · lane 侧隙绕柱执行器零推进（批22 登记，✅ 已于 2026-11-06 批26 关闭）

- **现象**：受控车道（3 宽石面、上方 4 格净空、中置 3 高柱、两侧各 1 格净宽）上，目标在柱后时 goto 零位移：goal 已设、`route.plan` 只读试算 **5 步可达**，`gotoNear` 实时 A* 却静默空转——isMoving 永假、无 NoPath、promise 不结算（批22 看门狗修复前烧满墙钟，修复后 10–12s 诚实 UNREACHABLE）。平原/水边地形同几何 **7.1s 绕行到达**，山腰地形稳定失败——地形依赖。
- **证据**：`dev:mc:terrain-nav` 批22 多轮（trace 采样 spread=0.0、对照实验隔离：A placeToReach true/false 双失败、B lane 内无柱点 2s 到达、C 抬目标失败——卡点精确在"绕入 1 宽侧隙"）。
- **影响**：山地等复杂地形上，需要从 1 宽缝隙绕过直立障碍的导航不可用（诚实快速失败，不挂死）；树绕行/开放地形穿越/explore 不受影响（均实测通过）。
- **关闭事实**：批22 的"planPath 与实时 A* 配置不一致"假设**不成立**——两处 Movements 字段值逐项相同（事件级 trace：实时 A* 同样给出完整 7 节点 success 路径，前 1s 正常走出 3 节点）。真根因是两层叠加：**搜索层**上游 `getMoveDiagonal` 只校验两条正交角线中便宜的一条，柱角实体格在未校验侧被放过 → A* 产出贴角对角线；**物理层**prismarine-physics 把移动钳到与实体面"恰好贴上"（gap=0），而 Paper 1.21.11 静默拒绝恰好贴面的位置（无 moved wrongly 日志，1.21.10 及更早版本接受）→ 服务端回弹，挤压净位移≈0（无 pathfinder 自由探针实证 ±0.02 振荡），每 3.5s `resetPath('stuck')` 重搜同一路径无限循环。修复 = 最终补丁集（`patches/mineflayer-pathfinder@2.4.5.patch` 589 行 + `prismarine-physics@1.11.1.patch` + `prismarine-item@1.18.0.patch`，审查轮已逐文件验证 pristine+patch 与安装包零分歧）：pathfinder 补丁含 G21 执行器层（stepAt/shouldJump/后退助跑）、G25 搜索合法性 hunk（对角线两侧角线脚/头格必须 safe，计划/执行合法性不再依赖贴边滑移）、以及此前散落 node_modules 未入库的规划器强化包（astar/movements 搜索分块缓存且未加载列不入缓存、门/水语义——开门验证+上半门不可站+斜切不进门+深水放置/起跳守卫、显式拒绝放置黑名单根治 refuse→re-plan→refuse 循环、goto noPath 诚实拒绝、附魔组件经 `tool?.enchants` 兼容），全部描述见 patches/README.md；physics 补丁 `WALL_GAP=1e-5` 消除恰好贴面回弹；item 补丁归一化 1.20.5+ 附魔组件（digTime/getEnchantmentLevel 消费者）。`driver/mineflayer/pathfinder.ts` 的三处 Movements 赋值收敛为 `applyMovementsConfig` 单一口径（S2 接缝卫生）。验收（全部在完整补丁集上）：真服 `dev:mc:terrain-nav` 源码 **6/6**，lane 绕柱三次独立 **2015/2100/2010ms 实际到达**（原 12.1s 零位移失败），树绕行 7.1→4.5s、digThrough 9.6→5.1s；`dev:mc:climb` **6/6**（1 格台阶 1078ms、三级阶梯 4606ms 较基线 7318ms 提升、G24 走廊与竖井快败不变）；全仓 vitest **3231 项通过**（其中 tests/mc 94 文件 832 项；2 项失败为 tts httpx 环境缺失与 map EPERM 竞争抖动，隔离跑均绿，与本改动无关）；`pnpm typecheck` 通过。**残余（原登记 M2 搜索预算项，其搜索半部已于批28 关闭）**：24 格自然穿越在目标位于山头时，A* 5s think budget 内搜不完（5.8 万节点），5–10s 后 Timeout 诚实拒绝——此前 bot 已实际走完 ~26 格山地地形。批28 根因定性为启发式引导缺失：欧氏启发式在爬升地形严重低估真实代价，无偏置搜索沿等值线泛洪（真服画像：gain-16 山头 w=1 → 10,974 节点/428ms）。修复 = pathfinder 补丁 `heuristicWeight` hunk（加权启发式，只改扩展顺序：合法性/g 代价/isEnd/maxCost raw 口径不动）+ `applyMovementsConfig` 统一设 3——同一山头 w=3 → 556 节点/11ms（÷20）、路径代价 +6.7%、跨次完全确定；真 goto 山头目标 28.5s 实际到达（原 5–10s Timeout 零到达）。验收：T0 `mc-pathfinder-heuristic-weight`（默认原序/÷3 节点/代价有界/maxCost raw 口径）+ `dev:mc:upstream-nav` 连续三轮 7/7（gate/dig 步因路径略长慢 1–3s，属代价换搜索的正常反映）+ climb 6/6 + terrain-nav 6/6。**S3 水中爬岸耗时方差（批27 审查轮登记的第二形态）不随本修复关闭**：批28 当日 w=1（与本补丁严格等价）也两次 TIMEOUT，加权后 4536–5041ms 到达两轮——方差主体在水节点出发的移动控制与规划交互，与搜索规模无关；`dev:mc:upstream-nav` S3 断言保持 20s 不放宽，另立开放项跟踪。诊断基建：`dev/nav-perf-probe.ts`（山头目标 A* 画像 + 端到端 goto，`dev:mc:nav-perf`）；upstream-nav 的 nav() 增位置轨迹与搜索指标失败输出。**遗留草稿已接线（批26 依赖审查轮收尾）**：`patches/mineflayer@4.39.0.patch`（挖方服务端确认 + 放置拒绝标记）已入 `pnpm-workspace.yaml` 并应用；挖生命周期单终态化（成功=服务端改类型/取消/预算 max(8s, digTime×3)，`targetDigBlock` 保持到终态，迟到事件 terminated 守卫忽略），`err.refused` 标记供执行器拒放黑名单。T0：`mc-upstream-dig` 5 项；登记进 `dev:mc:upstream-nav` 真服门。同期收尾：顶层 `vec3@0.1.7` 依赖删除（adapter 改走 mineflayer 解析链，生态统一 0.2.0）；`registry` 工具等级材料修正（`driver/mineflayer/upstream-fixes.ts`——minecraft-data 3.117.0 的 1.21.11 数据 108 种方块 material 错标 `incorrect_for_*`，铁镐挖铁矿 4.55s→0.75s）与组件附魔规范化（`prismarine-item` 补丁 + pathfinder `tool?.enchants` 断链补全）落地，手持附魔工具的 `bot.digTime` TypeError 风险消除。新增真服门 `dev:mc:upstream-nav`（7 步：闭门/栅栏门穿越、1 深水游上岸、邻水墙挖穿、拒放避让、无料诚实失败），本批 **5/7**——S3（游上岸）与 S4（挖穿）两项登记为 G26/G27 开放项，见 §4.1。

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| ~~G26~~ | **goto 运行 ~3.3s 被无因中止（✅ 已于 2026-11-07 批27 关闭——登记的"运行时无因中止"不成立）** | 中止者实证（signal abort 堆栈 + survival 触发事实 dump）：`survival.ts` → `runtime.intervene` → `safety` 主动打断——**真实溺水**。探针对拍（g26-probe）：S3 的"1 深水洞"水洞正下方 198 层是虚空（平台只铺 GY 一层），bot 掉穿平台从 y=199 落到 y=99 的真实自然水域；服务端 Air 与客户端 oxygenLevel 读数一致递减（112→81→…ticks ↔ 7→5→…），头部浸水 ~16s 后氧到 4 → 溺水触发完全正当；`control:"none"`、无 stop_intent 是 safety 介入后 run 的正常结算路径，非运行时缺陷 | 场景几何修复：S3/S4 水洞下方铺底（`GY-1` 层 stone）+ setup 校验 server Pos 稳定在洞位（掉穿即失败，不再把落水当"站在水洞"）。真服 `dev:mc:upstream-nav` S3 转绿（3472ms 游出到达）。批26 记录的"独立诊断 REACHED、前置门/栅栏门是唯一差异"归因有误：差异不在前置步骤，而在该诊断几何是否有底 |
| ~~G27~~ | **实机 goto 挖穿 dug=0（✅ 已于 2026-11-07 批27 关闭——登记的"计划/执行代价分歧"不成立）** | 事件级对拍（g27-probe）：route.plan 与实机 A* 在同一 Movements 口径下给出**同一条解**（2 高墙下"挖头层 1 格+跳半墙+跳水洞"，needs.dig=1，合法且比挖 2 格平穿便宜——"挖是唯一近路"的场景几何前提错误）。真缺陷是**挖掘完成计数丢失**：`dig() @(-732,201)` 后 413ms，服务端确认 blockUpdate(stone→air) 与 `diggingAborted` 同毫秒——pathfinder 全局 `blockUpdate` 监听（先注册）触发 `resetPath('block_updated')` → `stopDigging`，abort 抢在 digging.js 确认回调前，terminated 守卫吞掉 `diggingCompleted` → dug=0；resetPath 清掉含 toBreak 的路径后 A* 看到"头层已开"重规划，脚层永不挖 | 两处修复：(1) pathfinder 补丁新 hunk——`digging` 期间跳过 `block_updated`（自己挖掘的确认是计划内进展，不是世界变化；dig 完成照常结算，挖掘窗口内的世界变化由下次重规划吸收）；(2) S4 场景几何改为 17 宽墙身+GY+3/GY+4 封顶两层（"挖上两层爬墙"需 3 格挖掘且无净空，挖穿 2 格平穿明确最廉）+ 断言按目标行附近 3 列核对（A* 按对角启发式在等价列中选列，单列断言会误报）。真服 S4：route.plan 与实机同解 needs.dig=2、dug=2、脚层通、7.1s 到达 |

### G26/G27 · 批26 依赖审查轮新登记（✅ 批27 全部关闭）

- **mineflayer@4.39.0 补丁接线**：挖生命周期单终态化（见 G25 关闭事实的遗留草稿段）——T0 `mc-upstream-dig` 5 项（成功=类型变化含留水/纯状态变化与 null 不完成/预算拒绝/确认窗内可取消/迟到事件不双结算），真服门 `dev:mc:upstream-nav` S4 挖穿（其 dug=0 残余归 G27，✅ 批27 关闭）。
- **`dev:mc:upstream-nav` 真服门（7 步）**：闭木门穿越、闭栅栏门穿越、1 深水游上岸（G26）、邻水墙挖穿（G27）、拒放避让、全宽沟槽无料诚实失败、性能采样。**批27 修复后 7/7 全绿**（门穿越 2449/3336ms 且 open=true、S3 游出到达、S4 挖穿 dug=2 脚层通 7.1s、拒放邻位 2442ms、无料 UNREACHABLE 5104ms 不进坑）；climb 6/6、terrain-nav 6/6 回归保持。
- **vec3 单一化**：顶层 `vec3@0.1.7` 依赖删除，adapter 经 mineflayer 解析链取生态 0.2.0（双 Vec3 类并存的隐患消除）。
- **工具等级材料修正**：`driver/mineflayer/upstream-fixes.ts` `fixToolTierMaterials(registry)`——minecraft-data 3.117.0 的 1.21.11 数据 108 种方块 material 错标 `incorrect_for_*`（铁镐挖铁矿 4.55s，实际 0.75s），按 harvestTools 推回 `mineable/<kind>`，等级约束保留；client-host login 时装配。T0 `mc-upstream-materials`。

### G28 · 水中爬岸导航不稳（批28 登记，✅ 已于 2026-11-09 关闭——登记归因不成立）

- **现象**：1 深水洞游上岸（`dev:mc:upstream-nav` S3）耗时方差大且偶发不可达——同几何历史五轮 3472/20950/5663/13210/25194ms（末次 TIMEOUT）；批28 当日 w=1 连续两轮 TIMEOUT。
- **证据（批28）**：该几何的 A* 搜索本身极小（毫秒级、双位数节点），搜索加速不改变成败。失败形态两种：规划侧（"could not plan a path within its think budget"）与执行侧（有路径但物理不达标）。
- **关闭事实（一次性探针 + 三轮真服复跑）**：
  1. **爬岸本身没有缺陷**。干净几何上从水洞中心到岸上目标 A* 只用 **4 个节点 / 3–7ms**（w=3 与 w=1 都是 4 节点），goto 端到端 **2008/2015/2009ms**，三轮无方差。批28 的"执行侧物理不达标"没有复现。
  2. **规划侧超时的真因是目标不可达**：`upstream-nav` 的 prepare 只重铺 y=199 一层，而 S5b 的沟槽挖到 GY+2；上一轮留下的空洞让 S3 的目标格悬空。目标不可达时 A* 搜了 **70,916 个节点、烧满 5s think budget** 才超时。
  3. **上游默认让"落水"成为廉价的越界一步**：`Movements.infiniteLiquidDropdownDistance` 默认 true = 落水不受 maxDropDown 约束。平台架在 y≈199、正下方 y≈62 是海面，"从平台边缘落进海里"因此是 cost 1 的合法移动，A* 把整片海面搜完。同一不可达几何关掉该策略后 **1,922 节点 / 1352ms 诚实 noPath**。
- **修法（已落地）**：
  - `driver/mineflayer/pathfinder.ts` 的 `MOVEMENTS_POLICY` 显式 `infiniteLiquidDropdownDistance=false`（与 allowParkour/canOpenDoors/heuristicWeight 同一处策略）；规划出 100+ 格落水本来也不是这台机器能执行的动作。
  - 场景自洽：prepare 重铺 9 层（GY-8..GY，20,367 格在 /fill 上限内），S5b 沟槽相应挖穿 11 格（深到不能"跳下去再爬上来"），S3 在派发前核验目标格下方是实心方块。
- **验收**：`dev:mc:upstream-nav` **7/7 连续三轮全绿**（S3 2008/2015/2009ms）；S5b 的诚实失败从 6647ms 降到 2008ms（不再烧搜索预算）；`dev:mc:climb` 6/6、`dev:mc:terrain-nav` 6/6 回归不变；T0 `mc-pathfinder-water-drop`（策略常量 + 真实 Movements：137 格落水不生成候选、3 格浅水照常）。

### G31 · 下行阶梯走廊的第一段走位失败（2026-11-09 登记，同日关闭）

- **现象**：`dev:mc:spatial` 的两条 tunnel 步（"digs a staircased corridor down through stone and walks it" 与 "descends a second 1:1 staircase from an elevated box"）失败——前者 `UNREACHABLE: could not advance: stuck at 9517.32,199.00, want 9517,198,9500 (dug=8)`，后者"bot did not reach the corridor end"（服务端 y=198）。
- **基线对拍**：把 `.uina/worlds/minecraft` 回退到 `mc-refactor-baseline` 后跑同一场景，同样两步失败、同一坐标、同样 dug=8，所以不是目标对账改动的回归（先登记，后归因）。
- **归因（探针 `dev:mc:corridor-probe` 实测，不是猜）**：卡住那一格的**客户端与服务端读数一致**（client=gravel、server=solid），所以"客户端缓存滞后"这个假设**不成立**。真正的因果是走廊被自己挖塌的沙砾堵住：场景在檐格与檐上各放一块砾石，挖檐块把上面那块带下来，掉落滞后于挖拍，等走位到跟前时脚位已经被填住。`opened` 记的是"这一格我开过"，代码把它当成了"这一格现在是空气"。
- **修法（已落地，`capabilities/actions/tunnel.ts`）**：
  - 每段腿走之前重新观察脚位与头位（`clearStation`）：非空气就重挖。这两格都在本次走廊计划内（profile 高度最小 2），动的都是这次授权过的范围，不越权改世界。
  - 清过东西就等落定再看一轮，直到某轮什么都不用清（`STATION_CLEAR_LIMIT = 支撑探测上限 + 1`）——上方整摞重力方块会一块接一块往下掉，一轮不够。
  - 清不掉时如实报出哪一格、为什么（未加载 / 流体 / 够不着 / 挖不动），不再统一记成"走位卡住"。
  - 末列到位判据收紧：中间列允许差一格（下一拍继续往前挖），末列必须真的站进去。旧判据下"走廊末列差一格"会被当成"走到尽头"，完成描述与实际不符。
- **验收**：`dev:mc:spatial` **8/8 连续两轮全绿**——`dug=24 (gravel 4), walked to (9523.0, 196.0)`、`descended 4 (dug=20), server pos (9535.8, 198.0)`。T0 新增两条：重力方块回填后重挖（dug 8→9、砾石出现在 path、通道仍走通）、脚位被水灌满时 UNREACHABLE 报出具体格（`14,64,10 holds water/lava`）。
- **没改的**：`excavate` 不走这条路径。它按层自上而下清空（头顶先开，本身减少坠落掩埋），收尾对新现场再读一次，被回填的格如实进 `remaining`。没有真服证据说明它需要同样的重挖轮次，不预防性加复杂度。

### G32 · 无料跨沟与爬岸导航的两个未定问题（2026-11-09 登记，**未解决**）

两个都在 `dev:mc:upstream-nav` 里暴露，都还停在"证据充分但机制未定"，不冒充已解释。

**一、无料也能跨过沟（场景假设不成立，不是产品缺陷）**

- **现象**：S5b 原本断言"背包清空后过不了全宽沟槽"，2026-11-09 连续 4 轮全部失败——机器人 6.3–8.5s 就到了对岸。
- **已排除"凭空搭桥"**：沿它实际走的那一行只扫沟格（`gx..gx+1`，y=199/200），**全是空气**；背包 `/clear` 过，`placeToReach:true` 没有变出方块。所以"不许伪造材料"这条不变量是成立的。
- **仍成立的是物理能力**：2 格宽、4 格宽、6 格宽、11 格深的沟它都过去了。玩家助跑跳本来就能跨 ~4 格，所以"无料必须失败"的前提（这条沟过不去）从一开始就不成立——只是早期几何下没被触发。
- **断言已改成它真正想测的东西**：跨过去了就核"沟格里没有方块"（有就报"a bridge was fabricated without material"），没跨过去就核失败码是 UNREACHABLE/TIMEOUT 且停在近岸。步名改成 "nothing is fabricated (a jump across is not a bridge)"。
- **机制未定**：是助跑跳、是物理动量推过去的、还是别的，没有确认。`nav()` 的轨迹采样（每 2s 一次 `/data get entity Pos`）在这个场景给出过落在平台外的样本（z=-342，平台北界 -343），说明采样本身不可靠（`serverPos` 取"最近一条像坐标的消息"，并发回执会串），不能拿它下结论。下一步要用独立事件窗逐次取 Pos 的探针，再判定是否需要限制跨越。

**二、水洞爬岸偶发 noPath（1/9，未复现）**

- **现象**：2026-11-09 九轮 `dev:mc:upstream-nav` 里 1 轮 S3（1 深水洞游上岸）失败：`UNREACHABLE: pathfinder found no path to the goal`，2011ms，机器人停在 (-709.39, 199.29) —— 位置在洞里，比 setup 的 199.9 沉了 0.6。其余八轮 2008–2011ms 通过。
- **隔离探针 8/8 复现不了**：新增 `dev/swim-probe.ts`（`pnpm dev:mc:swim-probe [轮数]`）按同构几何（1 深水洞 + 198 铺底 + 目标脚下实心）连跑 8 轮，**8/8 通过、1470–1498ms、A* 4 节点 / 20 生成、零方差**。
- **未定**：差异只在"进入导航时机器人沉到 199.29 还是 199.9"。两次都在同一个水方块里，按 block 判定没有区别，所以还解释不了。不排除是探针与场景在 `reset()` 之后等待时长上的差别（探针多等了 500ms）。
- **下一步**：让探针把"进入导航那一刻的 y"打出来并强制沉底再走，跑 20 轮看是否与 y 相关；仍复现不了就按环境噪声登记，不再投入。

### G29 · 苦力怕残余爆炸擦伤与近身拍占空比（批29 登记；批33 主体关闭，击杀路径残余）

- **现象**：`dev:mc:combat` B04（批29 新增）：近身拍对苦力怕的结局是"接触→引燃→转身冲刺拉开→残余爆炸擦伤"——批29 干净场地 13.4–20 血（探针实测最好 19.2），从未无伤击杀（kills 为空，苦力怕总是自己炸掉）。
- **批33 关闭事实（feedback 流迁移 + fuse 状态感知）**：近身段改为一次 withBody 持有 + feedback 流连续物理拍（键位每拍重装，扫描/决策不再造成键位空档，占空比 ~100%，原 ~50%）；`entities@1` 新增苦力怕 `ignited` 事实（driver 捕获 metadata[16]，creeper-probe 真服实证引燃信号），三处消费——引燃目标不进攻击节奏、近身段硬危险立即拉开并持续续锁、**外层追击分支拒绝回追引燃/锁定中的苦力怕**（探针实证批33 初版的核心缺陷：近身段在出手圈外退出后，不认识 fuse 状态的追击把 bot 送回爆炸半径，逃离/追击振荡净拉开 ≈0）。验收：B04 五轮 18.83–19.47（擦伤 ≤1.2，验收线收紧到 ≥18）；三僵尸步 20/6.5/13.25/16.63（方差同旧，围攻爆伤越过 safety 阈值时如实 INTERRUPTED）。
- **残余（击杀路径）**：B04 仍全部 `target_lost`——1.21 引燃期苦力怕继续逼近，冲刺逃逸净速度 ~1.3 m/s × 1.5s 只够拉开 ~2m，20 血需 4 个"接触→引燃→拉开→等 swell 衰减"周期，当前策略下苦力怕总在周期内完成引爆。修法方向：按探针时间线调 contact/lock/flee 的节拍（lock 3s 固定值 vs swell 实际衰减），或引燃前抢在 swell 建立前完成更多次出手。探针 `dev:mc:creeper-probe` 已具备完整时间线输出。

### G30 · 自挖走廊逆行与自由导航爬阶不可靠（✅ 已于 2026-11-07 批35+批36 全部关闭：批35 关 (a)(c)，批36 关 (b)）

- **现象**：mine 任务级基线（`dev:mc:task`）回程腿失败——bot 挖到矿后走不回地面起点。任务级服务端判决（serverPos）修复前 11 轮回程全挂（returned ×10、shaft ×1：06-07/06-10/06-14 三轮 + baseline-b34 ×4 + mine-fix1..4）；场地修复（矿石移出阶梯动线，见备注）后 3 轮 2 绿 1 红，`returned` 沦为跳跃彩票。
- **证据链**（探针 v1–v10，日志在 tmp/probe-mine-return-v*.log，探针用后即弃，结论固化于此）：
  1. **几何排除**：`planCorridor` 挖除集满足双向净空不变量——每踏步低位列覆盖 floor..floor+2（3 格净空），与 G24 已证可行的几何等价；不变量已锁死为 T0（`mc-spatial-planner`）。
  2. **规划排除**：`route.plan@1` 干跑（goto 同配置 digThrough/placeToReach）整路与逐踏步二分全部 ok——带塔 place×3（重建被斩首的踏步）、禁塔 dig×9（另走挖掘路线），A* 两条配置都有路线。
  3. **执行器定罪**：`bot.pathfinder.debugState()`（补丁新增只读诊断口）显示执行器 12s 持有合理路径却原地徘徊——y 恒 191 不上台阶、z 恒 12000.5 不进到达窗、x ±1.4 振荡（step-assist 退避循环）；全程仅 1 次放置、18+ 次无效 equip（lockPlaceBlock 被 1s placeBlock 等待占满）。
  4. **三个具体缺陷形态**：(a) `shouldJump` 沿"bot 实际位置→节点角点"方向探测，±0.5 格亚格漂移让探测落进邻格（墙/空气），跳跃键不按；(b) 塔升放置成功后（placeBlock OK、服务端确认），重规划的新路径头是另一个悬浮节点（落点格无支撑），执行器不重试放置、不到达也不放弃，磨满预算；(c) GoalNear range≥1 早停（bot 在邻节点即判到达）使"精确回到阶梯底节点"不可保证，任何 ±1 起点偏差都让回程 tunnel 计划与既有阶梯错位（v8/v9 实证：起坡点错一格 → 新挖走廊的踏步块落在既有走廊空气上 → 又回到 (b)）。
  5. **修复尝试记录**：`shouldJump` 探测改对齐节点中心（v10）未打通回程，且扰动批19 实测的 run-up 窗口（0.6 贴脸判定更早拦截跳跃）——已撤销；批19 探测距离是 Paper 1.21.11 实测值，不应顺手重调。
- **✅ 批35（2026-11-07）关闭 (a) 与 (c)**，三轮迭代各由 200ms 真服探针（`dev:mc:tower-probe`）驱动：
  1. 第一轮（面距离+落地模拟+<0.6 死区）：mine 3 轮 1 绿 2 红——r1 卡在井道中部 y195。探针实拍循环：跳跃踏上台阶（落点 x+0.3 贴下一踏面）→ 死区拒绝链式跳 → 推墙降速 <0.12 → 退避触发 → 退下 1 格深的台阶沿跌回下层 → 无限震荡。**批19 的死区/退避在"1 格深台阶"上结构性失效——退避必有空间的前提不成立。**
  2. 第二轮（死区改动量门控 speed<0.12）：仍 1 绿 2 红——着陆后 1–2 个物理拍内地面摩擦把 ~0.2/tick 的着陆动量吃到 0.06–0.11，门槛时刻动量已低于 0.12；且落地模拟对贴面态结构性乐观（reached 判据被起跳瞬间自身满足），而 Paper 1.21.11 对精确贴面位置静默回弹（prismarine-physics WALL_GAP 补丁所证）——模拟批准的贴面跳现实必失败，**模拟在贴面态不可信**。
  3. 最终形态（**纯节点规则**）：下一路径节点是"1 格上步且有支撑"（`stepBlockOf`）即按跳，无距离带、无模拟；按跳后撞面弹回由既有退避接管（touching + speed<0.12 独立触发，平地场景有退避空间），阶梯由"落地即再跳"的链式爬升通过。真服：无坑 1:1 走廊爬升从"永不完成"变 13.7s 端到端；**mine 4/4 连续全绿**（returned+haul+ore_gone 全部服务端判决，returned 精确回到 12040.5,201,12000.5）；回归 climb 6/6、terrain-nav 6/6、upstream-nav 7/7（S3 首轮 think-budget 失败为 G28 已登记抖动，复跑即过）、shelter/night 抽查各 1 轮全绿；tests/mc 109 文件 897 项全绿、`pnpm typecheck` 过。T0：`mc-pathfinder-jump-decision`（含旧探测对照的漂移形态与贴面态断言）；补丁描述见 `patches/README.md` G30 段。
  4. (c) 的收口分两半：tunnel 侧——走拍前核验目标脚位支撑（`capabilities/actions/tunnel.ts`，规划地板落在既有挖空上时带归因快速失败，T0 `mc-spatial-actions` +1）；程序侧——被测程序回程 goto 从 tolerance 2 收紧到 1（GoalNear 半径 2 会把"井口内一格低一格"判到达，批35 c1 批次 3 轮全部差最后一级实证）。
- **✅ 批36（2026-11-07）关闭残余 (b)（逐级爬升彩票）**——批35 审查轮先改判现象：塔升放置链路完整工作（批34 原形态"放置后不接续"已随纯节点规则消失），残余为缺口跨越后连续 1 级台阶的弹跳彩票（探针 4 轮 3 绿 1 红）。批36 以 100ms 分辨率探针（`dev:mc:tower-probe`，增 onGround/vel.y 采样）逐帧钉住两个叠加机制：
  1. **退避残留键抵消跳跃弧线**：批19 退避（touching + speed<0.12 → back 200–900ms）在阶梯上的触发时刻与纯节点规则的落地跳重合——落地瞬间速度恰为 0，退避同拍接管把 f/j 换成 b；bot 离地后 `back=true` 残留在空中与移动分支的 `forward=true` 并存，互相抵消成垂直起落（探针帧：f:1 b:1 同按、y 起 193→194.2 但 x 被推回 0.37），落点恰差到达窗 0.29，退避再触发——循环。基线 10 轮 8 绿 2 红（红率 ~20%）。
  2. 第一版修复（空中不覆盖键位）暴露残留键缺陷（探针 6/10，红轮全是 f:1 b:1 同按的垂直空转）——退避中途离地必须**立即释放 back 键**（backOff/backUntil 计时保留，落地后窗口内继续退避）；批19 平地退避从不离地，不受影响。
  - 最终：退避只拥有地面——地面触发/覆盖原样，离地即释放残留键。验收：探针 **10/10 连绿**（11.6–14.4s，基线 8/10 且绿轮 12.4s+）、mine **4/4** ALL PASS、climb/terrain-nav PASS、upstream-nav 7/7（S3 首轮失败为 G28 已登记抖动，复跑即过）、tests/mc 897 项全绿、`pnpm typecheck` 过。修复在 index.js 执行器主循环（与批19 step assist 同一验证口径：真服门 + 探针，无 T0 夹具）。
- **备注**：场地自毁缺陷已随批34 修复——矿石格 (12049,191,12000) 恰是阶梯最后一级踏步块，collect 把它挖掉等于回程楼梯口被自己斩首（已移至 (12054,191)），vein 格改回石头消除 collect 计数干扰；`goto.ts` 圈禁看门狗（NoCloser→UNREACHABLE，12s）为批34 新增，把该形态从烧满 90s 墙钟变成带归因的快速失败（T0：`mc-goto-loiter`）。批34 审查轮记录的"collect 东壁矿石格系统性漏采与其计数矛盾"经批35 探针判定为**旧场地伪影**：mine-b34-final 跑在批34 场地修复提交（4d8be9cc）之前的 e65086aa，旧矿石列表与阶梯动线重叠使 mined 计数与断言集合错位；当前场地客户端/服务端对拍仅 4 格种植矿、无幽灵铁（探针实测），collect 唯一实际改进是 NOT_FOUND 失败消息补带最后跳过原因（`capabilities/actions/carrying.ts`，兑现其注释承诺）。

| ID | 缺口 | 证据 | 修法要点 |
|---|---|---|---|
| ~~G6~~ | **无周期性推送**（✅ 已于 2026-11-03 批20 关闭；批37 换掉关闭方式） | 关闭方式（批20）：`world/digest.ts` 按查询依赖采样（self@1/inventory@1/world@1 三个现有读取器，同一 `facts.sample` 提交边界，与 observe 同口径）、前缘节流 10s（`DIGEST_INTERVAL_MS` 集中策略值）、规范化 JSON 哈希去重、facts reset 后补发；`companion/side.ts` 经 `onGameEvent` 上行，`executor/delivery.ts` 以独立事件类型 **minecraft_digest** 交付（不指向 events@1），主脑忙碌（`isBusy`）时只保留最新一份、空闲即补发。时间只取粗粒度相位与天数（ticks 连续变化会让去重失效），位置取整数格。**批37 改写**：推送这个方向本身是错的——旧坐标排队等模型处理没有价值，只有当前值有意义，于是 digest 整条链路（定时器、节流、去重、事件类型、忙时合并）删除，改为 `world/state-frame.ts` 采样 + `state.snapshot` 只读 RPC，由 `WorldDef.requestContext` 在每次模型请求前通过 `turn.transformContext`（`tail` 相位）注入一份当前快照；宿主侧 250ms 超时即本轮不注入 | 真服 `dev:mc:state-frame` 7/7：三段齐全无未知、空闲 15s 零事件、`/give` 后下一次采样立即可见、走路 20s 零事件且每帧都是身体当前所在格、events@1 无状态帧泄漏；注入接缝由 world-request-context（每请求后尾都是那一刻的新值、不落 history）与 qq-world-framework-seams 覆盖 | **批46**：每请求注入已整体删除，当前事实改为按需查询与新 visit 入场回执；G6 的关闭方式再次替换。
| ~~G7~~ | **查询无增量**（✅ 已于 2026-11-03 批20 关闭，inventory@1 先行） | 关闭方式：`protocol.ts` 增每槽位最后变更 revision 标记（`playerSlotMarks`，全量重同步只标内容真变的槽位，光标只推 revision 不算槽位）；`view.inventoryChanges(since)` 暴露差量（标记不可用回 null 不猜）；`inventory@1` 输入 `{since}` 回 `{revision, changes:[{slot,item|null}], counts, usedSlots, freeSlots}`（差量 + 变化后总数，不含全量 slots）；`since` 超前（含跨重启 revision 归零）如实 INVALID_INPUT。其余查询仍全量，按真实消费者逐个补 | 真服：rev 10→11 差量恰含 emerald +2；单测覆盖同游标/差量/标记不可用回退全量/超前报错四态 |
| ~~G8~~ | **`run` 短窗全局固定 3000ms**（✅ 2026-11-03 批20 关闭；2026-11-08 批41 换成纯异步受理） | 批20 的关闭方式是 `run` 增 `wait`（ms，≥0，`wait:0` 只受理不等）；**批41 整体删除默认 3 秒窗与公开 `wait`**：`run`/`chat`/`runs.continue` 一律只回 `accepted`/`not_accepted`/`unknown`，终态只经 `minecraft_completion` 投递。缺口仍关闭，模型不必再猜服务器时间 | 批20 的三态单测由批41 改写：`mc-native-facade` 覆盖瞬间完成仍只回受理、拒绝保留凭据、unknown 按原 requestId 查证；`mc-continue-facade` 覆盖 continue 新段只回受理 |
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
| G14 | 30 分钟真实模型自主游玩 | 9B 暴露**重复死亡 + OwnerLost 门关闭后不恢复**；批10 补了自保与恢复但**未重跑同一窗口**，"自主生存"仍为空。批22 已把窗口就绪：`dev/i2.ts` 增请求预算（`--max-requests` 默认 500，达限即 interrupt）、观察扩展（self 健康与氧气、death 事件游标计数、runs 门状态与 safety 介入）、扰动演练（`--chaos`：窗口 60% 处 SIGKILL 伴生 → owner_lost → 模型须 `runs recover` 自开门，批9B 断链的直接复验开关）；真模型窗口待执行。批41 的顶层纯异步受理与完成通知集中交付同样待该窗口复验——本轮只有自动化回归，真服与真实模型对照未跑 |
| ~~G15~~ | **复杂避障**（✅ 已于 2026-11-04 批22 关闭，残余见 G25） | 关闭方式：批9B 的静默挂死根治——`driver/goto.ts` 看门狗三形态收束（上膛后 3s 位移停滞 / 上膛后 goal 被上游清空 2.5s 宽限仍不结算 / 非挖掘 10s 零位移总兜底，均 Stalled → UNREACHABLE，墙钟不再烧尽）；新增自然地形验收场景 `dev:mc:terrain-nav`（自寻真树、水候选拒绝、批9B 复刻 lane 柱、树绕行/digThrough、24 格穿越、explore） | 真服源码/产物各 6/6：树绕行 4.5–7s 到达、digThrough 对照到达、穿越 19.7s 到达或 9.9s 诚实失败、explore 25–40 格、批9B 复刻到达（平原 7.1s）或 12s 诚实失败（山地）；climb 回归 6/6（密封竖井 100ms 快速失败不受影响）；执行器残余登记 G25 |
| G16 | 断电、长期负载、历史库增长成本 | **断电子项批22 已闭**：`tests/mc/mc-executor-kill-write.test.ts`——伴生在 runtime.db 写活动窗口被 SIGKILL → autoRecover 托管重建回 ready → 取证（独立进程）证 meta 身份不变、恢复只增不删、无半行损坏、owner_lost 如实关闭、探针 DISCONNECTED 诚实结算（3 次稳定）；`dev:mc:history --stats` 体量观测手段就绪。长期负载与历史库增长两项随 G14 窗口（i2.ts 预算/观察/扰动已就绪，真模型窗口待执行） |
| G17 | 51 项终态报告 | 不存在；需按 `capabilities/index.ts` 的 `createCapabilityCatalog()`（批43 起唯一装配入口，`builtinCatalog`/`buildCapabilities` 已删）实际模块与 `capabilities.md` 的 16+35 逐项对照出状态表 |

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

## 批42（2026-11-08）：v2 闭环改造关闭事实

- **教学接缝**：`WorldDef.environmentGuide` + `turn.prepare` 注入静态 ENV（只在活动 MC 会话、多世界可组合、停用摘除、不写历史）；`describe {kind:'guide'}` 提供六份官方只读 Guide，`nativeGuide` 压到入口描述；`copy-assets` 打包 ENV/Guide/示例，Guide 代码块与 `examples/safe_mining.js` 由真实 Program validator 编译校验。证据：`tests/world-environment-guide.test.ts`、`mc-guide-directory.test.ts`、`mc-guide-examples.test.ts`。
- **Window 因果**：真服探针 `dev:mc:window-probe` 钉住两条协议事实——`stateId:-1` 必回带单调 stateId 的权威 full；工作台会先回"仅同步"的 full。因此保留 `window_items.stateId` 做迟到包防护，回执增加 `outcome/diagnostics`，但**内容未变不判拒绝**（保持 unknown）。证据：`mc-driver-window.test.ts`、SHELTER 真服回归（曾因误判 rejected 失败，回退后 PASS）。
- **Body 撤销因果**：stop/safety/disconnect 在真实发起点写不可变 `retiredBy`；`interruptible()` 从 Effect 账本现算 `dispatch/effects`，不再硬编码 `not_sent`/`[]`；`user_stop` 不自动续跑。证据：`mc-control-retirement.test.ts` 三类故障注入。
- **excavate 计划集合守恒**：`remainingCount` 包含从未轮到的格，`reasons` 汇总，`remaining` 为 64 条有界样本；读取方块抛错时该格仍算未访问。证据：`mc-spatial-actions.test.ts` C11（64−5=59）。
- **collect 候选安全**：`tried` 记录 `permanent/transient/unknown`；已派发/有 effect 的 mine TIMEOUT 不换候选；候选耗尽但"挖除数>入包数"时先有界清扫地面掉落（SHELTER 由 `NOT_FOUND` 转 PASS）。证据：`mc-capability-carrying.test.ts` C10 与真服 SHELTER。
- **MINE 任务级终验**：返程与背包以最新 `self@1`/`inventory@1` 核验，任一不满足 `mc.decide`；宿主把 `awaiting_decision` 记 `NEEDS_DECISION`，不再打印 returned 后正常结束。证据：`dev:mc:task --task mine` 服务端 Oracle 四项全绿。

## Addon（2026-11-08）：已知缺口

合同见 [addons.md](addons.md)；以下是明确登记、当前不修的边界：

- **无热重载**：Profile 的 `addons.json` 在 connect 时冻结；安装/启停/卸载都不影响活动连接，
  必须 disconnect→connect 才生效。这是设计选择（避免执行中途替换能力目录），不是遗漏。
- **真实模组服纵向验证未做**：仓库里只有 Paper 1.21.11（不能装模组），没有 Fabric / Forge /
  NeoForge 服务端或 mod artifact，因此 `install` 的 Configuration 协商、注册表同步与真实
  Mod 方块/物品操作都没有真服证据。`dev/probe-first-packet.mjs` 只证明"全部协议贡献挂载后
  才放行连接"没有首包竞态，正式 `ClientHost` 的真服连接回归也尚未重跑，两者都不能当模组兼容证据。
- **Wire Registry 未接入解码链**：`bot.registry` 由 `prismarine-registry(<版本>)` 一次性构造，
  Mineflayer 各插件在装载时就把该对象闭包进 `prismarine-block` / `prismarine-item` /
  `prismarine-chunk`；Driver 的 `registry_data` 只消费 `minecraft:dialog` 用于界面投影，
  不进入物品/方块/区块解码。因此服务端新增的 stateId / item id 目前无法被正确解释，
  换服后也不能复用数字 ID——这条必须等真实 Fabric 服取证后再补窄接缝，不能先造空抽象。
- **`serverRequirement` 只是声明**：不做服务端探测；`Compatible` 必须由具体能力在调用时证明
  （例如 `example.press@1` 以服务端计数前进为准）。目录里的 `note` 已明确这一点。
- **SpectatorPlus 集成（2026-11-08）**：两个同名项目容易混淆——Nahu 的 Spigot 插件提供
  `/spectate`；yzxoi 的 `SpectatorPlus`（1.21.11 分支，<https://github.com/yzxoi/SpectatorPlus>）
  是 **Fabric 客户端 mod + 服务端 Mod/插件**，只做观战数据同步，**没有 `/spectate` 命令**。
  按 `/spectate` 实现的原包已删除（真服脚本同步移除该步，9 步 → 8 步）。
- **`packages/spectatorplus` 只做被观察方向的界面桥**：箱子/工作台等**服务端窗口**由
  SpectatorPlus 自己镜像，Uina 不重发；只有**个人背包**（window 0，纯客户端视图）服务端不知道
  开关，才需要 Uina 在窗口事务起止各发一个字节（`spectatorplus:opened_inventory_sync`，
  `01`/`00`）。这依赖 `withInventoryScope` 的真实边界，不靠物品数量变化推断。
- **Paper 端不支持**：同一通道在 Paper 插件里读 0 字节、只当作"打开"，没有关闭分支；
  Uina 发 `00` 会被它再当成一次打开。要支持必须改服务端插件（上游范围），本仓库不改。
- **观察者画面未做真实验收**：没有可用的真实 Fabric 观察者客户端，自动化只覆盖到
  "事件成对 + 字节正确 + 身份不串台"，**"观察者真的看到界面"没有证据**。
- **个人背包镜像依赖观察者装客户端 Mod**：上游 `SyncedPlayerInventory.requiresClientMod()` 为 true，
  没装 Mod 的观察者看不到这个界面（这是上游行为，不是本包引入的限制）。
- **没有服务端 ACK**：`emitLocalScreen` 返回 true 只代表字节已写入连接，不代表对方已渲染；
  极短的背包事务可能来不及渲染就被关闭，未加人为最短展示时长。
- **协议窄口 1.21.11**：`custom_payload` 编解码与 `minecraft:register` 注册按该版本实现；
  其它版本会 `UNSUPPORTED_PROTOCOL`，没有多版本适配。
- **Addon 事实不持久化**：连接绑定，断线清空、重连不继承；跨会话的模组状态必须由服务端重新发布。
- **`minecraft:register` 是 1.13+ 传统机制**：真服（Paper 1.21.11）实测必需——不注册则服务端
  收到上行 payload 但不回包；若未来服务端移除该机制，需要按版本替换注册方式。
- **未做**：包签名/来源校验、依赖自动安装（依赖交给 npm/pnpm）、运行时资源配额（CPU/内存隔离）。

## 服务器交互（2026-11-08）：已知缺口

本轮把菜单 / Dialog / 聊天动作 / HUD 接到同一条连接级观察面上，真服场景 `pnpm dev:mc:ui` 已跑通（详见 [changelog](changelog.md) 同名条目）。下面这些是**明确没做**的部分，不要当成"顺手就能加"：

- **Dialog 只能被取代，不能被关闭**：1.21.11 没有 serverbound 的关对话框包，`ui.act {kind:"close"}` 对 Dialog 报 `UNSUPPORTED_WINDOW`。要离开对话框只能点它自己的按钮，或让容器/另一个界面取代它。同理 `book_page` 与 `open_url`/`copy_to_clipboard`/`change_page` 都没有服务端编码。
- **`submit_dialog` 的输入校验只看类型不看语义**：`number_range` 只要求是数字，不校验 min/max/step；`text` 不校验 maxLength。越界值会原样送给服务端，由服务器自己决定接受还是忽略——客户端不替服务器做业务校验。
- **Dialog 注册表（`registry_data` 的 `dialog` 注册表）没有真服证据**：代码支持按 `registryId` 解析配置阶段下发的 Dialog 条目，但本地 Paper 1.21.11 没有在配置阶段真的下发过这张表。当前能实证的是**内联 Dialog**（聊天 `show_dialog` 的 inline NBT）。`registryEntryHolder` 形态的按钮也走同一段未实证代码。
- **HUD 只是显示观察**：`hud@1` 报告"服务器把这些显示出来了"，不证明背后的业务事实（分数、余额、任务进度）。计分板的 1.20.3+ 显示名、BossBar 的颜色/叠加层都按协议原样透传，不做语义解释。
- **菜单按钮的"业务成功"永远不在 `ui.act` 里**：`outcome` 只有界面转移语义。要证明"买到了"，得另读 `inventory@1` / `events@1` / 方块事实——真服场景就是这么交叉核对的（聊天回执的 N 与侧边栏的 N 必须一致）。
- **未知布局的窗口只读**：`layout.status !== "known"` 时 `ui@1` 仍可读（区域标 `unknown`），但 `ui.act` 不会按未验证区域点击。这是有意的：猜区域等于把"看起来像按钮"当成"按钮"。
- **`custom_click_action` 的编码是绕过 minecraft-data 的**：数据包定义少了外层 VarInt 长度前缀，Driver 自己拼包体（`encodeAnonymousNbt`）。如果上游修正了定义，这段需要复查，否则会多写一层前缀。
- **没有 NPC 实体交互的专用能力**：NPC 对话目前只能通过"右键实体 → 服务器推界面 → `ui@1` 读 + `ui.act` 点"这条通用路径走，没有 `npc.talk@1` 之类的高层动作。本地插件夹具里也没有 NPC（没有 Citizens 依赖）。

## 持久等待与写端意图（2026-11-09 关闭）

### G33 · 持久等待与 `smelt(wait="durable")` 跨进程恢复（✅ 已于 2026-11-09 关闭）

- **关闭方式**：走附件 §5.9 允许的"复用受信任 decision 机制的挂起分支"，没有第二套任务表、没有 `CallRecord.execution: "suspended"`、没有 `mc.suspend`，`SCHEMA_VERSION` 保持 `"6"`（`runtime-db-worker.ts` 没有 migration 分支，bump 会让所有现存库打不开）。
- **持久形状**：根原生能力抛挂起请求后，Run 停在 `awaiting_decision`，`runs.decision` 里多出 `wait`（`attempts / earliestCheckAt / lastProgressAt / deadlineAt / resume / checkpoint`）。`resume` 是"同一能力 ref + 原输入"，检查点经 `CallContext.checkpoint` 交回；换能力的续段被拒（`CHECKPOINT_INVALID`），子调用挂起被拒（`SUSPEND_NOT_ROOT`）——父帧已经不在，静默续会把检查点喂给错误的调用栈。
- **唤醒**：`MinecraftRuntime.open` 在 `recover()` 之后、ready 之前起扫描；定时器 `unref`，随 `engine.shutdown()` 清理。扫描只做"到点再看一眼"，单次认领仍走 `continue()`，因此"stop 优先 / 并发只认领一次 / 没有合法 Owner 绑定就不唤醒"三件事由既有受理 CAS 承担，不是扫描器自己保证的。`OwnerState` 因此增 `activation`：重启后 Host 用新 activation，扫描器必须取当前 binding。
- **消费者**：`smelt@1` 增 `wait: "durable"`（旧 `true`/`false` 语义一字不动）。装料确认后抛挂起把这一炉交给世界，恢复段整段跳过装料、只观察与取产物——重跑整函数会清空结果槽并多生产一份。
- **收口**：能力反复 wake→check→wait 时按 16 次预算终成 `unknown`（`WAIT_BUDGET_EXHAUSTED`）；`DurableSuspendRequest.progressed` 只在世界真的推进时前移静默预算的起点，`earliestCheckAt` 夹在 `deadlineAt` 之内；明确拒绝的唤醒只记一次并停止重试（资格类瞬时拒绝除外），不会一秒一次空转。
- **证据**：`tests/mc/mc-durable-wait.test.ts` 11 项（挂起/重开续段/无绑定不唤醒/stop 优先/并发唯一认领/预算收口/嵌套拒绝/running|waiting 仍保守终结/复查夹在预算内/推进才刷新预算/被拒唤醒不重试）、`tests/mc/mc-smelt-durable.test.ts` 4 项；`mc-capability-smelt-repair` 26 项仍绿；`tests/mc` 全量 128 文件 1037 项通过。
- **未验证**：真服 durable smelt 端到端（没有专门的炉子场景，`dev:mc:*` 未覆盖这一模式）；"两个 Run 不因同一份旧库存预算重复支付"随 G37 一起挂着。

### G34 · 写前意图逐写端接入（✅ 已于 2026-11-09 关闭，Addon 除外）

- **已接入**：`body.window.click@1`（既有）、`body.window.selectEnchant@1` / `renameItem@1` / `selectTrade@1`（`commit()` 由同步改异步，意图落盘后重新取窗口前态）、`body.toss@1`（原来那条 `dispatch: sent` 记在点击循环之前，现在意图先落盘、没点过不记 sent）、`body.uiAct@1`（事实前移到发包之前）、`body.interact@1` 的方块分支、`body.attack@1`、`body.useItem@1`、`body.dig@1`（原来的 `dispatch = "unknown"` 只是内存标记）。
- **不需要 intent**：纯本地可撤销输入（`drive` 键位、`lookAt`、feedback steering）与"只承诺派发"的 `chat` / `endSleep` / 实体 `interact`；`equip` 只在同一背包内换槽位，不增不减材料。
- **证据**：`tests/mc/mc-driver-window.test.ts` 增 5 条（五处写端的顺序与拒收）、`tests/mc/mc-effect-intent-dig.test.ts` 2 条；真服 `dev:mc:stations` 14/14 全绿，其中附魔/命名/选交易正是 `commit()` 三处。
- **仍未接**：Addon 写端 `driver/protocol-dispatch.ts` 的 `send()` 先发包再记录，附件明确本轮不重构，保持登记；`ui.act@1` 的业务成功口径仍由另一次观察判定。

### G35 · 结算路径的两处语义缺口（✅ 已于 2026-11-09 关闭）

- `driver/goto.ts`：新增"本次是否真派发过路径"标记，`settle()` 的 cleanup 事实按它决定 `not_sent` 还是 `sent/unknown`。原实现按 `bot == null` 判断，于是"规划前就失败"和"已经在 GoalNear 邻域、无需导航"这两种确定没派发的情况都会留下 `sent/unknown`，被 `unknownEffectsFor()` 判成未决，整个 Run 结算成 `unknown`。
- `driver/window/session.ts`：包已发出后 `check()` / `view()` 抛 `CONTROL_INVALID` / `BODY_SUSPENDED` / `INTERRUPTED` 时，照旧留 `unknown` 事实，但把失败原样透传并标成已派发，调用方才知道身体已经不在。
- **证据**：`tests/mc/mc-goto-settle-not-sent.test.ts` 2 项。

### G36 · 任务级场景的窗口确认竞态（✅ 已于 2026-11-09 关闭）

- **现象**：真服复跑 `dev:mc:task --task shelter` 与 `--task night`、`dev:mc:build` 的房屋两步时，稳定出现 `CONFLICT: window revision changed before dispatch`。`dev:mc:stations` 14/14、`dev:mc:build` 的 11-wall vantage 步骤、`dev:mc:spatial` 7/8 都通过——所以不是窗口整体不可用。
- **已排除**：这是既有行为，不是本轮改动引入。同一台服务器、同一世界状态下，把 `.uina/worlds/minecraft` 整体回退到会话基线 `cba81d5f` 复跑，`task shelter` 同样在第一批 craft 的第二次点击就撞 `CONFLICT`；`dev:mc:build` 的失败步骤也与 HEAD 一致。写端意图（探针实测 `beforeWrite` 2ms）、唤醒扫描定时器、executor 各自回退后都能复现，逐个排除。
- **根因**：`click()` 的派发准入拿 `expectedRevision === view.revision` 当条件，而两个窗口族的 revision 语义根本不同。工作台/容器窗口的 `ConnectionWindowState.contentRevision` 只在内容真变时 +1；**玩家自带窗口（windowId=0）每次收到 `window_items` 全量同步都 `revision = previous + 1`**（`driver/mineflayer/protocol.ts:478`），而服务端对上一击的回执本身就会再推一次全量。于是一次 `equip`/`toss`/`craft` 由多次点击组成时，第二击起必然"版本过期"——那是自己的回执还没到齐，不是别人动过窗口。窗口不是不可用，是这个判据把时序当成了冲突。
- **关闭方式**：准入判据改成**内容**——调用方在点击里声明的 `expectedSlots`（覆盖点击槽、槽号在范围内、计数非负）与 `expectedCursor` 与当前窗口逐格比对（`describeDrift`）。`INVALID_INPUT` 的形状校验与内容比对分开：形状不对是调用方写错，内容不对才是冲突。`expectedRevision` 保留，但只进冲突消息，用来区分"自己的回执晚到（差一版）"和"别人真动过窗口（且内容必然也对不上）"。合同注释（`contracts/body.ts`）与 `modules/driver.md` / `public-api.md` 同步改成同一口径。
- **证据**：`tests/mc/mc-driver-window.test.ts` 新增 4 条——容器窗口"只涨版本、点击依赖的那格与光标都没动"必须放行；点击槽内容变了 → `CONFLICT` 且消息指出槽号与两个 revision；光标变了 → `CONFLICT` 且指出 cursor；玩家库存窗口（每次全量同步都 +1 版本）同款放行。形状类拒绝（`expectedSlots` 未覆盖点击槽、计数非负、光标形状）由既有用例覆盖，不重复造。真服：`dev:mc:task --task night` 与 `--task shelter` 由红转绿（shelter 24/24 格），`dev:mc:build` 13/13 步全过。
- **同族遗留**：`dev:mc:stations` 的 `anvil 合并` 步骤偶发 `TARGET_NOT_MET ... cost -1`，见 G38——那是服务端真没给结果，与本条无关，修复前后都出现过。

### G37 · §5.11 effect footprint 与 §8.5 跨任务物料预留（本轮不做）

- 两条互为消费者：footprint（`read/writeFootprint` 与未决集相交判定）唯一的真实用途是让"另一个 Run 尚未对账的库存写"进入候选预算；没有 §8.5 的预留记录，footprint 就只是一张没人读的表。按"不造无消费者框架"处理，两条一起留到有真实消费场景时再做。

### G38 · `anvil@1 combine` 的"两把附魔剑必有变化"假设不成立（✅ 已于 2026-11-09 关闭：不是竞态，是互斥附魔）

- **现象**：`dev:mc:stations` 的 `anvil 合并` 步骤偶发 `TARGET_NOT_MET: the anvil produced no result for this combination (inputs 0=diamond_sword, 1=diamond_sword, cost -1, levels 30)`。当天 9 轮真服样本里 2 次，G36 修复前后都出现过。
- **已排除**：不是窗口点击被拒（失败记录 `unknownEffectCount: 0`，两个输入槽都确认有货）；不是等级不足（30 级，实际成本个位数）；不是 G36 同族竞态（本条在 G36 修复后又复现过一次，且失败步骤的前一步没有 `unknown` 收尾）。
- **根因**：验收步骤原来"附魔台附两次、再合并"。真服抓到现场的两把剑**都带附魔**，分别是注册表 id 35 与 id 1——按 1.21.11 附魔注册表顺序即 `smite`（亡灵杀手）与 `bane_of_arthropods`（节肢杀手），两者与 `sharpness` 同属**互斥组**。原版铁砧把互斥附魔叠在一起等于"没有任何变化"，结果槽为空、成本回 `-1`；步骤注释里"两把各带附魔必有变化"的假设从一开始就是错的，附魔台出什么是随机的。
- **关闭方式**：合并步骤的材料改成 `/give` 指名组件的两把 `sharpness I`（同等级同附魔在原版必升一级），断言结果为 `sharpness 2`、背包只剩一把；互斥情形单独做成**负例步骤**（`smite I` + `bane_of_arthropods I` → 必须 `TARGET_NOT_MET`，且两把都退回背包），每轮真服都验一次，规则退化会被立刻发现。`anvil@1` 没结果时的诊断补 `hint`：负成本 = 服务端直接拒绝（互斥附魔或无变化），与"花费太高"分开。
- **证据**：`pnpm dev:mc:stations` 连续 3 轮 15/15；失败现场样本（两把剑的逐槽组件、`cost -1`、`unknownEffectCount: 0`）留在本机 `dev/stations-run-5.log`。
- **顺带登记**：1.21.11 的 `/give` 附魔组件是**扁平映射** `[enchantments={"minecraft:sharpness":1}]`；写成 1.20.5～1.21.4 的 `[enchantments={levels:{...}}]` 会被服务端判 `Malformed 'minecraft:enchantments' component`，而且**指令静默失败**（steering 回执只在聊天里，服务端日志只留 `issued server command` 没有 `Gave`）。五种写法实测记录见 `dev/FACTS.md`。

### G39 · `mc-executor-kill-write` 间歇悬挂：测试侧无界同步 WMI 查询（2026-11-10 登记，✅ 2026-11-12 关闭）

- **现象**：`tests/mc/mc-executor-kill-write.test.ts` 在全量并行跑时约 1/3 概率 `Test timed out`；把测试 timeout 从 120s 提到 240s 后仍耗尽——是真实悬挂，不是机器慢。单跑该文件全绿。
- **旧归因被推翻**：生产侧 `RpcPeer.call()` 默认 5s 超时、hello 有 handshakeMs 上限、close 走 closeGraceMs 竞速与有界 waitRetired——IPC/spawn 都有界，旧"IPC 无超时"归因不成立。
- **真实根因（2026-11-12 逐段插桩复现）**：测试用 `spawnSync("powershell", Get-CimInstance ...)`（**无 timeout 参数**）按父 PID+命令行模式找伴生 pid。全量并行时逐段计时显示：插桩副本全程 14s（PowerShell 3.5s），**同场景并发跑的原版在同一次运行里 120s 超时**——两个并发的 WMI/CIM 查询在满载下一个 3.5s、一个无限阻塞。其余每段（open/seeds/storm/rebuild/forensic×2/gates/probe）在满载下全部 <5s。
- **修复**：`MinecraftExecutor.companionPid()` 直接暴露 `connection.process.identity.pid`（所有权层已持有的精确身份），测试改为按该 pid 击杀——删除 PowerShell 查询，无界边界不复存在；击杀目标从"命令行像伴生的进程"变成"执行域自己登记的那个进程"，并行下也不会认错。
- **证据**：修复前 1198 测试全量那次复现 120s 超时（插桩副本同场景 14s 完成）；修复后单跑 3.8s 全绿，全量并行（139 文件 / 1203 测试，含两个 executor 进程类测试并发）无悬挂，伴生进程无泄漏（close 幂等复用既有退役路径）。

### G40 · 下行阶梯隧道回归：支撑段不是自上而下，砾石帽坠进走位目标（✅ 已于 2026-11-10 关闭）

- **现象**：批37 关闭 G31 时 `dev:mc:spatial` 曾 8/8 两轮，批38 起真服回到 7/8，`tunnel digs a staircased corridor` 步稳定卡在 `9517.32,199.00, want 9517,198,9500`，20 个采样点全程同一坐标。
- **排障**（探针 `dev:mc:stair-probe`，setup 前后各读一遍 client/server 方块）：pre-flight 两端一致（(9517,198) stone、砾石帽在 201/202）；失败后 post-mortem (9517,198) = **gravel**——上层砾石（202）在跑的过程中坠进了走位目标脚位，机器人站在它头顶。
- **根因**：`columnDigList` 把支撑探测段按 `ceiling+1` **升序** push，再接上降序的 profile 格——整列的挖序是 `201 → 202 → 200 → 199 → 198`：先挖**下层**砾石恰好放跑上层砾石，坠落实体与挖拍赛跑。时序好，落地的砾石被走位前的站位清理重挖（G31 关闭时的 `gravel 4`、`dug=24` 就是这个舞蹈的痕迹）；时序差，它落在"最后一读"之后，机器人站上头顶，`GoalNear tolerance=1` 谎报到位，`stepTo` 推不动，烧满预算报无归因的卡住。批37 的关闭是"症状修复 + 幸运时序"，不是根因修复。
- **关闭方式**：挖除序列整列按 y 降序（帽顶先挖，挖下层时上层已经不在）；走位腿未站进目标层时，按同一口径重跑一轮站位清理再步进一次，仍不到位才报卡住。
- **证据**：`tests/mc/mc-spatial-actions.test.ts` 新增 2 条（砾石帽帽顶先挖的顺序钉子；走拍中途回填 → 重清再步进，旧实现两先红）；真服探针 4/4（挖序 `202→201→200→199→198`，`dug=22` 恒定，不再有 `gravel 4`/`dug=24` 的回填抖动）、`dev:mc:spatial` **8/8 ×2**（`dug=22 (gravel 2)`）。
- **证据**：修复前全套多次复现、单跑全绿、240s 超时一轮复现；诊断期间的试改已全部 revert，工作树无残留。

## 附：不要照抄的部分

对照 Cortico 后确认**不采用**：常驻 policy 层（G18 已裁决）、作弊传送脱困、把观测渲染成散文塞进 World。理由：分别违反"不堆隐藏配置"、"正常生存验收不靠传送"、"World 只给事实不给台词"。台词属表达侧。

## 附：证据边界

本轮（2026-11-09 重构收尾 + G36 关闭）跑了 `pnpm typecheck`、`tests/mc` 全量 138 文件 1168 项，并起了 Paper 1.21.11 build132 真服跑过 `dev:mc:task --task mine|shelter|night`、`dev:mc:build`、`dev:mc:stations`（多轮）、`dev:mc:spatial`、连接冒烟。真服结果逐条在下面；G36 修复前的失败项都做过基线对拍（`cba81d5f` 同样失败），修复后重跑：

| 场景 | 结果 | 说明 |
|---|---|---|
| 连接冒烟 | PASS | 1.21.11 / protocol 774 / 出生点在地面 |
| `dev:mc:task --task mine` | **ALL PASS**（48.8s） | 服务端返回坐标精确、`raw_iron=4`/`cobblestone=22`、4 格矿全成空气、no_death |
| `dev:mc:task --task shelter` | **PASS** | G36 修复前第一批 craft 的第二次点击撞 `CONFLICT`（基线 `cba81d5f` 同样失败）；修复后 24/24 格 |
| `dev:mc:task --task night` | **PASS** | 修复前 setup 阶段 `equip` 同款 `CONFLICT`；修复后全绿 |
| `dev:mc:build` | **13/13** | 修复前 5/13（房屋两步与预算超时步撞 `CONFLICT`）；修复后 13 步全过 |
| `dev:mc:stations` | **15/15 ×3** | 附魔/命名/选交易/酿造/交易 + 新增的 anvil 互斥负例；`commit()` 三处写端也在这里 |
| `dev:mc:spatial` | **8/8 ×2** | 批38 起曾 7/8（G40：砾石帽坠进走位目标，见 G40 条目）；帽顶先挖后确定性全绿 |

未跑：durable smelt 真服端到端（无专用炉子场景）、30 分钟真模型窗口（T3，用户决定暂缓）、`dev:mc:ui|combat|climb|terrain-nav|upstream-nav|window-probe`。

