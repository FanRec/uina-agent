# 设计变更记录

## 2026-11-01 · 批17 K6 地图（map@1，G11 关闭）

- 能力面 +1：`map@1`（不可等待、非 feedback）——输入 `{id?, image?=true}`，缺省按主手→副手→热键栏→背包选一张携带的 filled_map；返回像素计数（receivedPixels/paintedPixels/totalPixels:16384）+ 图标 + 可选 ImageFileRef；center/dimension 协议不下发恒 null，不读服务器存档推断。无已开地图 NOT_FOUND，不自动开图或装备。
- **Driver**：协议窄口捕获 1.21.11 的 `map` 包（线上包名 `map`，类型 packet_map；像素矩形列主序，icons 字段缺席=保留旧值、空数组=清空）；`driver/facts/map-cache.ts` per-connection 缓存（错误包整包丢弃不污染其他图，重连清空当前覆盖）；`view.map(id)` 从占位改为真实投影（null=未收到，0=收到的透明色）。
- **色板**：`world/map-colors.ts` 256 项常量表，从 dev-env 的 Paper 1.21.11 运行时 jar（Mojang 映射）`MapColor` 静态初始化提取（62 材质×4 明暗=248 项 + 8 项服务端不产出；byte=materialId*4+brightnessId，亮度 180/220/255/135，每通道 trunc(channel*modifier/255)）。
- **World**：`world/map.ts` 一次纯当前 sample 同时固定库存选择与切面；`world/png.ts` 纯函数 PNG 编码器（512×512=128×128 的 4× 最近邻；未收到=品红棋盘、已收到的透明=地图纸底色）；PNG 原子写 `<worldDataDir>/exports/images/<sha256>.png`（临时文件 rename）；全未收到或编码失败 image=null+unknown。
- **G11 关闭**：`companion/side.ts` 增 `read_image` rpc（realpath 授权校验在 exports/images 内 + bytes/sha256 对账）；`executor/facade.ts` observe 值带 ImageFileRef 时经 read_image 产 `ToolExecutionResult.images`（读取失败给 imageDelivery 原因，元数据不冒充图片）；world-tool 本就 `...result` 透传，零改动。
- 真服协议事实：`/give filled_map[map_id=N]` 引用从未渲染过的 map N 时不推任何包（map 包只在数据更新时下发）；真玩法路径是空白地图（minecraft:map）手持 use 展开→服务端分配 id 并立即推全量 128×128；`map_scale_direction` 组件使 give 静默失败。
- 能力 **46/51**（16 查询 + 30 动作），K6 收口；下一包按 §10.3 为 sleep（K8 起步）。验收：MC 73 文件全绿、`dev:mc:map` 源码/产物各 10/10、受控 wire 5/5、真模型 deepseek-flash 4/4（模型真实描述了地图画面：水面深蓝/灰色地块/棕米色方格）。

## 2026-11-01 · 批16 K6 玩家名单（players@1）

- 能力面 +1：`players@1`（可等待、非 feedback）——名单=服务器 player_info 花名册（`bot.players` 采样时刻同步投影，`rosterSeen` 区分"名单未到"与"收到但为空"）；`tracked:{ref,position,distance}` 由能力层与 entities 事实按跟踪代次 join，离开跟踪范围名单仍在、tracked=null；输入 `{name?, limit?:1..256=64}`，listedCount 不受 limit 截断。
- **entities@1 玩家名覆写**：玩家实体 kind 先按底层 type 判定，name 从名单 join 出用户名（修掉 follow/explore 按玩家名目标 NOT_FOUND）；名单不可用回退 `"player"`，不加 unknown。
- driver facts：`playerJoined/playerUpdated/playerLeft` 推进事实版本；关联实体按采样时刻重新解析，不信任 mineflayer 的 `player.entity` 缓存；`entityRefOf` 收敛实体引用方案一份；displayName 纯文本化排除 `Object.prototype.toString` 继承。
- Runtime/Host/历史持久格式不变，public-api.md 零改动（合同早已定型）。能力 **45/51**（15 查询 + 30 动作）；下一包按 §10.3 为 map（K6 收口，需 G11 图片出口 + `map_item_data` 捕获/色板）。真服验收（Paper 1.21.11：`dev:mc:players` 源码/构建产物各 11/11，第二玩家 ClientHost 真连接）与踩坑见 dev/MC-WORLD.md 批16 节。

## 2026-11-01 · 批15 K7 专用工作站（G2 关闭）

- 能力面 +5：`brew@1`（一批 ≤3 瓶，完成只认瓶子 `potion_contents` 变号）、`enchant@1`（三档等级要求来自 `properties[0..2]`，缺省取最高可负担档，完成后读物品 `enchantments` 组件）、`anvil@1`（rename 走 `name_item` 包，费用读属性 0；原版只在"真的有变化"时给结果）、`grindstone@1`（`xp` 恒 null：经验球无法归因）、`trade@1`（`trade_list` 报价 + `select_trade`，付款先收敛成"正好一份"再取货）。
- **G2 关闭**：`driver/window/layout.ts` 增 5 条布局（brewing_stand 41 / enchantment 38 / anvil·grindstone·merchant 39），同文件新增 `opensWindow()` 替换 `body/session.ts` 的硬编码正则——它原本把附魔台/铁砧全拒在门外，是比布局表更早的卡点。`container@1` 的容器策略不变（工作站仍拒绝）。
- `WindowSession` 增 4 个受控操作（`selectEnchant`/`renameItem`/`selectTrade`/`offers`，public-api §4.3 已先行登记）：只派发、不改 revision、不做槽位预测、不置 uncertain，完成合同与 chat 同口径；`trade_list` 在协议窄口捕获，`itemId` 经 registry 解名（未知报 `unknown` 不编名）。
- 共享件收口：`shared/workstation.ts`（`resolveStation`=原 smelt 的 `resolveFurnace`、`withStation`/`withEntity`、`moveExact` 按具体槽搬、`trimPayment`、组件读取族）；`checkBudget`/`waitFor`/`countInRegion`/`stackLimit` 自 smelt 上移，smelt 行为不变（既有 smelting 测试零改动通过）。
- 真服协议事实（决定实现，详见实施记录）：附魔三档是服务端随机算的、**已附魔物品三档全 0**；`minecraft:potion` 注册表不下发，药水名只能按入参报、编号进 `observedPotionIds`；`select_trade` 会把整摞付款搬进槽里，余量不清则取货后立刻补货 → 回执 unknown → 整个 run 被 `callHasUnknownEffects` 结算成 unknown；mineflayer 的 `clickWindow` 在商人窗口上会崩（驱动自写包是对的）。
- 顺带修复：`entityKind` 补 `type==="passive"` 分支——村民的 `category` 是 `UNKNOWN`，漏掉这一支 `entities@1 {kind:"passive"}` 看不见村民。
- Runtime/Host/历史持久格式不变。能力 **44/51**（14 查询 + 30 动作）；下一包按 §10.3 为玩家名单与地图（K6，`map` 另需 G11 图片出口）。真服验收（Paper 1.21.11：`dev:mc:stations` 源码/构建产物各 14/14）与协议事实见 dev/MC-WORLD.md 批15 节、[实施记录](archive/stations-implementation.md)。

## 2026-11-01 · 批14 蓝图与施工（K5 关闭）

- 能力面 +2：`build.plan@1`（派生只读：规范化 targets + need/missing/blocked/unreachable/estTicks；不可等待，组合根注入 `ConstructionPlanner` 窄端口，World 不依赖 Construction/Library）、`build@1`（开局读一次计划 → 派发前判 CONFLICT/MISSING_MATERIAL → 先清后放、按列自下而上、多轮 → 收尾逐格复读世界复核 remaining）。`build` 的 progress 必须总量守恒：`placed + cleared + skipped + remainingCount` 恒等于设计格数，超时或中断时队列里没轮到的格以 `reason: "not attempted yet"` 补进 `remaining`（真服先报出 `remainingCount: 0` 而实际还剩 67 格）。
- 新模块 `construction/`：Target 四分类与规范化/镜像/旋转（`target.ts`）、最小 NBT 读取（`nbt.ts`）、Sponge `.schem` v2/v3 解码（`schem.ts`）、`target.json` 两种写法（`target-json.ts`）、唯一差异实现（`plan.ts`）、组合端口（`index.ts`）。
- Library 增 `readDesign(name)`（原件 + target 字节与两个摘要，不进 `LibraryPort` 公共面）；`companion/side.ts` 把 Library 上移到 World 之前并用惰性 getter 注入施工端口。
- 共享原语抽取：`place-cell.ts` 的 `inspectPlacement`/`commitPlacement` 由 `place@1` 与 `build@1` 共用（`place@1` 行为逐字等价，原测试零改动通过）；`no-support` 与 `out-of-reach` 分开（前者延后重试，后者走位一次）；支撑面按候选轮换（服务端会拒绝门顶这类面）。
- 裁决登记（capabilities.md §3/§4 已写回）：`target.json` schema = `minecraft:construction.target@1`（密集 palette+cells / 稀疏 cells 列表）；`blueprint.digest` = **实际被解释来源**的 sha256（与 `library.get` 的原件摘要分开）；`.schem` 只支持 Sponge v2/v3，其余 `WRONG_STATE`；mirror 在包围盒内翻转、rotate 绕 Y 顺时针，状态只变换 facing/axis/rotation/hinge/shape；`targets` 上限 2048、`cells` 512；`blocked.by` = 现场方块名；`unreachable` = 结构支撑缺失（非寻路判决）；`estTicks` 常量模型；`scaffoldsUsed` 恒 0。
- Runtime/Host/历史持久格式不变。能力 **39/51**（14 查询 + 25 动作）；下一包按 §10.3 为玩家名单与地图（K6）。
- 已知缺口：G20 关闭（`build.plan` 落地）；新增 G22（施工不搭脚手架、不绕行）；G21 补批14 实测（平坦地面 goto 5 格 0.6s vs 跨 1 格石台 40s 超时，直接决定了按列自下而上的施工顺序）。真服验收（Paper 1.21.11：`dev:mc:build` 源码/产物各 12/12）与踩到的真实行为见 dev/MC-WORLD.md 批14 节、[实施记录](archive/construction-implementation.md)。

## 2026-10-31 · 批13 地形切片与空间作业

- 能力面 +3：`region@1`（闭区间/at+size 双形态，palette 第 0 项恒 air、order 固定 xzy、未加载格 -1 计 missing、体素 ≤8192 否则 INVALID_INPUT 带切片建议；逐格事实视图有界同步采样，48 格实测 ~3ms）、`tunnel@1`（L 形两轴走廊 + 台阶 1:1 + 段尾竖井；下坡列挖檐块、上坡列在前一位列挖跳跃净空；support 探测檐上重力方块先挖后挖 profile）、`excavate@1`（层自上而下、层内就近序、keep 保留、容器先 transfer@1 收内容再挖、drops 聚合背包正增量、收尾以世界读数复核 remaining）。
- G4 关闭：`ctx.verify` 注册表落地——`EffectVerifier` 合同（contracts/runtime.ts）+ `EngineOptions.verifiers` + `verify/dig@1`（capabilities/shared/verify.ts：按 effect facts 的 BlockTarget 读当前方块，air→met、原方块→not_met、未加载→unknown）；`ctx.verify` append-only 追加 `EffectVerification`（原 completion 不改写），`effect_verification` 突变落库为新的不可变截面，效果行跨重启恢复后仍可复查。程序桥补 `mc.verify(effect, verifier)`（shim + ProgramHostApi + program-host），runMining 的 dispatch/receipt 事实 detail 补 `target`。
- 能力纯函数收敛到 `capabilities/shared/spatial.ts`（planCorridor/expandProfile/planExcavation/orderNear/normalizeBox/方块分类，确定性可测）；tunnel 用"挖 reach 内数列 ↔ goto 走到最远已挖列"的挖走节拍（digThrough:true 兜底 + 实际落点复核 + stepTo 近距步进），excavate 用"goto 腿（失败按实际站位复核射程）+ withBody digCell"。
- 裁决登记：tunnel 走廊遇流体 → UNREACHABLE；当前库存无法采收（基岩/缺工具）→ 返回 `stopped:"unbreakable"` 保留已挖前缀；`path` = 已挖格 + 原方块名；stairs:"never" = 水平段恒高、高差段尾竖井衔接；excavate drops = 挖后短窗背包正增量（不承诺拾取完整）；excavate not_met 以世界读数复核（回执确认窗边界竞态时方块其实已开）；region watchable:true / feedback:false。
- Runtime/Host/历史持久格式不变（effects.verifications 列批 6 已预留）。能力 **37/51**（13 查询 + 24 动作）；下一包按 §10.3 为蓝图与施工（build.plan/build）。真服验收（Paper 1.21.11：`dev:mc:spatial` 8/8——region 对拍/未加载 missing、下坡隧道 ×2 连通可走、砾石支撑、excavate 保留+收集+清空、G4 met/not_met/未注册 NOT_FOUND）与已知缺口（上坡行走楔死，G21）见 dev/MC-WORLD.md 批13 节。

## 2026-10-31 · 批12 移动鲁棒性与完整战斗

- 能力面 +4：`follow@1`（跟踪跟随，ended=target_lost/timeout 如实）、`flee@1`（背向威胁 8 向轮换，威胁失联按最后已知差距结算）、`surface@1`（两相水中脱困 + 竖井上升，`escapeToSurface` 供 fight 复用）、`fight@1`（stance 决策表、武器/盾装备、击杀只认死亡观察、撤退线与 no_progress、ranged=useItem hold/release + awaitEvidence）。
- G3 关闭：`SurfaceProbe` 窄端口（contracts/world.ts + public-api §5）与 `driver/mineflayer/world-scan.ts`——站立/露天判据与螺旋露天出口查找；goto@1 的 GoalNear 节点语义不变。
- Driver 证据窗口扩为 `{hit, dead}`（dead 只由 entityDead 置位），新增 `BodyOps.awaitEvidence`（纯证据窗口，不派发动作）；public-api §4 更新。击杀掉落=死亡位置附近新出现 item 实体差集，目标失踪不算击杀。
- 能力层纯决策收敛到 `capabilities/shared/mobility.ts`（matchFollowTarget/fleeLegTarget/stanceParams/effectiveRetreatHealth/MELEE_DAMAGE 等，确定性可测）；fight 用 withBody↔navigate 顶层交替拍，不嵌套租赁。
- Runtime/Host/历史持久格式不变。能力 **34/51**（12 查询 + 22 动作）；下一包按 §10.3 为空间作业与施工（region 先行）。真服验收（Paper 1.21.11：mobility 源码/产物 7/7、combat 5/5）、版本事实（1.21.11 gamerule 拆分为 spawn_mobs 等）与证据边界见 dev/MC-WORLD.md 批12 节。

## 2026-10-30 · 批11 领域记录与地点、路径探索

- World 领域记录（known-gaps G1）落地：world-history.db 增 records 表，SCHEMA v3→v4（旧库明确拒绝、不迁移）；`WorldPort` 增 `removeRecord`，CAS/分区校验在存储 Worker 单事务内，非空 evidence 同事务核验存在性；`meta.record_version` 只随记录写推进，驱动 places 观察，不复用提交版本。
- 能力面 +5：`places@1`（watchable，kind/near 过滤，near 只作用于当前维度、原点不可得显式 DISCONNECTED）、`remember@1`（CAS 同名覆盖、显式维度照存、名字 1..32 可见字符）、`forget@1`（removeRecord + NOT_FOUND）、`route.plan@1`（只读试算：组合根注入 `WorldRoutePlanner` 窄端口，World 不依赖 Driver；steps/needs 从上游 Move 的 toBreak/toPlace 导出，estTimeSec 由 a* 代价折算，不占控制不产生效果）、`explore@1`（单次 navigate 作用域包多段 goto+扫描，TIMEOUT/NOT_FOUND 带 traveled/scanned）。
- 合同先行：public-api §5（removeRecord、route.plan 分派）、world.md §11（records 表）、capabilities.md 五节冻结细节（near/维度、探索失败映射与常量、试算推导、名字规则、删除语义）。
- Runtime v6/history v4/ledger v3/Host journal v4。能力 **30/51**（12 查询 + 18 动作）；下一包按 §10.3 为移动鲁棒性（follow/flee/surface）与完整战斗。验证与证据见 dev/MC-WORLD.md 批11 节。

## 2026-10-27 · 批10反馈与默认自保

- ClientHost 生命周期监听与化身退役修正；self 氧气、最大生命值和效果寿命沿实际客户端数据读取。
- Driver 在既有物理模拟前安装/核验反馈输入，模拟实际完成后采样并确认；Program 接 body.feedback/loop，流采用单在算帧/latest-only 待交付、250ms有效期与所属输入撤销。
- Runtime 在同一身体队列中退役旧作用域、授予 safety；默认岩浆/缺氧/低血新伤害反射不另建 Run，不自动吃、挖、放或反击。记录归 safety，旧程序可在外层捕获中断并重新观察。
- Runtime schema v6，旧v5拒绝自动迁移；history v3、ledger v3、Host journal v4保持。状态与重要提示可查实际介入记录；完整证据见 [批10实施记录](archive/feedback-implementation.md)。能力仍25/51，下一包地点与路径探索。

## 2026-10-25 · 批 8 Library 文件与发现复用

- 三类普通文件 CRUD、统一扫描/头诊断、compile-only、确切 Call 来源保存、四类统一发现和正式工具/IPC 已接通；Program 只消费注入的只读材料。
- 工作文件摘要和执行来源摘要分开，metadata 补丁不改正文；在途段固定源码，新段重读，删库文件不删运行快照。
- 蓝图本批只管理 Raw 与元数据；Target 只报告 schema/digest 和 validation:unavailable，语义验证及施工仍归 Construction。原件可读不代表格式有效。
- Runtime/Host 持久格式不变，能力数量仍为 25/51；下一批等待/决策与 I2。验证、裁决与未验证范围见 [实施记录](archive/library-implementation.md)。

## 2026-10-25 · 批 6 正式原生主脑入口

- WorldDef、六 action 原生 façade、同源目录、请求凭证与显式重试、固定报告和 Host receipt 可靠交付已接通；Program/Library 保持明确不可用。
- Runtime schema v3 保存不可变截面和交付处置；Executor ledger v2 保存原请求与尝试，旧数据拒绝自动迁移。
- BodyEndpoint、abort/stop、源/产物 manifest 与开发入口同步；首次真实模型完成采集生产、缺料纠错和显式停止。证据、校准修正及剩余范围见 [实施记录](archive/native-host-implementation.md)。

## 2026-10-25 · 批 5 Host 通用持久回执

- journal 同批升级 v4，旧 v3 明确拒绝，不迁移真实日志；SessionStore 暴露真实会话身份与 durable/volatile。
- 工具/输入携带 receipt；Broker 验证后同步登记尝试，canonical append 才确认。提交索引由既有 reducer 增量维护，回溯不删除历史交付事实。
- Mailbox 按来源/key 去重，render 后重验提交资格，retire 对 attempt 做 CAS；工具退役不删除协议消息，输入退役与原队列撤回共用持久路径。
- Host、Extension 与 World 共享来源绑定的 inspect/retire 端口。批 6 继续正式 MC 模型入口与可靠通知，本批未接真实模型或改变玩法数量。
- 实际进程中断、Host 重开与最终验证见 [实施记录](archive/host-delivery-implementation.md)。

## 2026-10-25 · 批 4 Executor 平台底座

- 新增 Windows x64 私有 Node-API 双 Job、精确进程句柄/异步退役、受管 bootstrap、Companion 静态装配、固定 IPC、身份/launch/本地门意图账本。没有添加模型工具或临时通知桥。
- Runtime 增加 Owner/心跳/独立三门及 CAS；受理与开始先提交，关闭停止控制再结算。库 schema v2 固定 worldOwner/storageId，旧库拒绝，不迁移真实数据。
- 开发 harness 复用执行侧装配，`submit` 的直接消费者改为 await；新入口 `pnpm dev:mc:executor`。实际 OS、故障、SQLite 与源码/产物真服证据见 [实施记录](archive/executor-platform-implementation.md)。
- 下一任务为批 5 通用 Host 回执；Host journal 仍为 v3，WorldDef/模型入口与可靠通知留批 6。

## 2026-10-25 · 开发规划按正式接入与模型反馈重排

- 保留已完成批 0–3；替换旧批 4–12 的剩余排期。当前 [总规划 §10](development-plan.md#10-剩余施工总纲2026-10-25-重排) 是施工顺序唯一来源：批 4 E 平台、批 5 H 回执可独立施工，批 6 正式原生主脑与首次校准，批 7 Program 执行、批 8 文件复用、批 9 等待/决策与完整 I2。P/H/E 不再等待蓝图施工。
- 校正真实目录为 **10 查询 + 15 动作（25/51）**；旧 12 查询/27 项是计数错误，不是本轮删除能力。同步 README、LEAD、能力验收状态、当前运行事实和开发索引。
- 地点/探索、跟随逃离、脱困、反馈自保、战斗、地形/空间作业、施工及各高级玩法按直接依赖分别排队；剩余 6 查询 + 20 动作全部有归属，Microsoft、历史保留、核验器等未完合同显式收口。
- Executor 正文明确同一正式 World 的分阶段交付：原生阶段不装配 Program 时容量为 null，未交付 API 明确失败；实际需要的 Job/Owner/Host 回执不降级，已声明模块/资产损坏仍启动失败。不是新增临时接入或第二套模式。
- 验证按 OS、Host/Session、引擎/文件、真服、真实模型分别选择，不统一要求每批真服；规划修改只做文档一致性、链接和差异检查，复用本会话已获得的源码/测试证据。规划文档单独提交，既有生产链源码、测试与修复记录保留；未修改运行数据或认证。

## 2026-10-25 · 生产链审查修复与收敛

- 合成/熔炼拆为独立动作，删除旧混合实现；取货共用组件匹配、多槽分装及实际堆叠上限。合成移除错误容量预测，消耗/入包分开累计。
- 熔炼在世界等待前关窗并释放自有身体，复查重新核验身份与炉子；批量同时受燃料与槽位约束，失败/取消保留累计装料、取货与剩余量。
- 点击回执直接携带确认时的服务端快照，删除已确认回执与记账之间再次读取的取消竞争；所有消费者直接替换，不留兼容入口。
- Paper 字节码核实最小燃料表，删除四种下界木材，干海带块修正4001刻。当前类型/9条边界、MC28文件236项、构建通过；真服最终证据见 [生产链修复实施](archive/production-repair-implementation.md)。


## 2026-10-25 · 批 3 生产链落地（craft@1 / smelt@1）

- 新能力 **`craft@1`**：手持 2×2 与工作台 3×3 两条路径同一套摆格算法，配方按"缺料种类→总量→手持优先"选择，`station:"crafting_table"` 允许把 2×2 配方放到工作台做；3×3 先找 8 格内的工作台、没有就把背包里的放到相邻格并回读确认，**用完不拆走**。产物最初按库存净差结算，现由上节的确认入包累计替换。
- 新能力 **`smelt@1`**：`wait:true`（装料→等待→取回）与 `wait:false`（下料即返回，取货走 `transfer@1`）两种模式；原料由熔炼表反查，燃料量按烹饪刻数算，燃料刻数未知直接 `MISSING_MATERIAL`；等待与复查现按上节分段执行。
- **结果槽无需新协议面**：每批只摆"恰好一批"料，结果槽点击就是纯交换，沿用现有 `expectedClick` 推演。**mode-1（shift/quickMove）本批不开**，§10.7 的待裁决项由此关闭。
- 窗口层：`driver/window/layout.ts` 成为布局唯一真源（玩家窗口/工作台/熔炉/普通容器），工作站窗口**不产出 `container` 区域**；`openContainer` 白名单加入 `crafting_table`/`furnace`；`BodyOps.withInventory` 交出玩家窗口作用域。
- `WindowSnapshot.revision` 收窄为"只随槽位与光标推进"：炉子进度每秒数次，否则燃烧期间每次点击都撞 `CONFLICT`。
- `container@1` 支持熔炉读数（`slots[].region` + `properties`），`container.last` 历史按"除玩家区外的全部区域"聚合；`transfer@1` 对熔炉只支持 `from`（取产物），`to` 明确拒绝。
- 知识层：`KnowledgeRecipe` 增加 `pattern`（摆格图案）与 `cookTicks`，删除从未赋值的 `fuel`；`station` 判据改为实际非空格数（修掉 27 条同种材料 shapeless 的误判）；熔炼配方来自新表 `driver/facts/smelting.ts`（Paper 1.21.11 jar 抽取 73 条，`scripts/extract-mc-smelting.mjs` 可复现）；燃料刻数手工最小集，未收录保持 null。
- 验证：MC 确定性回归 **26 files / 201 tests**；真服 `pnpm dev:mc:k3` **14/14 PASS**（原木→木板→工作台→木棍→木镐→熔炉→石镐→熔炼两种模式→铁镐，另含三条拒绝面与两条知识面）。当时目录应计 **25/51（10 查询 + 15 动作）**，原记 27 项已更正；当时的“下一批校准点”已由上节重排替换。

## 2026-10-25 · 状态校正与批 3 前置登记

- 提交归属校正：K1 收口、真服复验、批 1 采集、批 2 窗口容器四轮均已在 **d77d20f** 入库（84 files）；2026-10-25 修复与 Driver 收敛在 **6157834**。`dev/MC-WORLD.md`、[窗口容器实施记录](archive/window-container-implementation.md) 与 [Driver 修复实施](archive/driver-repair-implementation.md) 此前记作"未提交"，已更正。
- 新增 [development-plan §10.7](development-plan.md)：批 3 的三处底层前置按源码登记——`WindowSession.layout()` 只接受普通容器窗口（`crafting`/`furnace` 报 `UNSUPPORTED_WINDOW`，`container@1` 白名单同样不含这两种方块）；`KnowledgeRecipe` 拍平 `inShape`，摆格图案丢失；该数据版本无熔炼配方与燃料刻数。批 3 的前置列改为引用该节。
- 测试基线校正：MC 确定性回归实际为 **24 files / 176 tests**（入口文档此前仍写 16/125）。
- 未改动任何行为合同与源码。

## 2026-10-25 · 审查修复与 Driver 写入路径收敛

- 按连接的 DriverProtocol 集中物品编码、同步协议写入与服务端通知；先实现 Java 1.21.11，其他版本的相关操作明确拒绝，后续版本沿窄端口接入。
- 玩家库存和容器共用服务端快照/槽位期望/串行点击确认；装备、丢弃移除原生异步库存链。BodySession 收口资格与停止，库存、采矿、牌面各自持有局部操作资源。
- ItemValue 与选择器统一；采集工具由实际 harvestTools 集合判断，移除材质排序猜测。toss 改为 `{receipt,removed,remaining}`，drop 分别保留确认离包与地面观察进度。
- 采矿不再把客户端预测空气当服务端破坏；牌面取消后不再提交。查询恢复统一 schema 入口，导航禁放置覆盖全部耗材移动，Runtime 修复直接/嵌套未知效果的成功误报。
- 真服首轮暴露 Goto 欧氏完成复查与 GoalNear 节点判据不一致；先增加真实依赖失败回归，再统一 nodeGap，修正容器动作及继发历史读取失败。
- 本轮工程：`pnpm typecheck`（9 条边界）、MC 显式 **24 文件 / 176 项**、`pnpm build` 通过。最终 Paper 1.21.11 上 `pnpm dev:mc:repair` 与构建产物各 **15/15 PASS**，独立 Temp 数据根，含真实 max_damage/max_stack_size 覆盖、取消与完整关闭重开历史。取舍、独立审查五项修复和日志归属见 [Driver 修复实施](archive/driver-repair-implementation.md)。

## 2026-10-24 · 批 2 窗口与容器落地

- 能力面 **9 查询 + 11 动作 → 10 查询 + 13 动作**：新增 container/transfer/container.last；支持双向精确量、固定 all 清单、nearest 三候选、实体容器、部分 moved/remaining。下一批为 craft/smelt。
- Driver 增加独立 WindowSession 与窄线形适配：每次 mode-0 点击仅发一个 stateId=-1 的真实业务包，接完整服务端槽位/光标并比对本次前态，避免本地预测冒充完成。没有可归属变化则 unknown，不自动重发。期望必须覆盖直接点击槽，旧 revision 返回 CONFLICT；普通 close 要求空光标，失败清理显式 force。
- 独立复查修正双完整回包串到后次点击、取消未打开窗口却假称屏障已过两处缺陷；后一种情况复用既有连接封闭机制，要求重连。真实 Paper 的 block-use 突发丢包通过看向目标后等待一个实际物理步解决，不另建限流框架。
- World 复用 client.window@1/evidence 表保存观察，只聚合容器区域；同世界/存档代次/维度按位置查最后观察，不受临时 binding 变化阻断。实体容器观察不伪装成方块历史。补混合 schema、订阅前重放、reset 保留未确认材料、关闭前 flush。
- 真服场景 `pnpm dev:mc:containers`：独立测试区、实际区块/平台/落脚核验，13 项；构建产物同场景也通过。MC 确定性回归 16 files / 125 tests；pnpm typecheck、pnpm build 通过。准备和游戏动作分开，工具等待超时的显式停止只发生在验收脚本。
- 详细设计、替代方案与实施裁决见 [窗口容器实施记录](archive/window-container-implementation.md)。本轮没有实现 Program/Library、Host 回执或正式 WorldDef。

## 2026-10-24 · 批 1 采集闭环（collect / pickup / drop）落地

- **能力面 9+8 → 9+11**：新增 `collect@1`（知识反查方块 → 前沿搜索 → goto/mine/pickup 组合）、`pickup@1`（候选实体 → 走到 → 库存增量结算）、`drop@1`（库存核对 → 可选走近/朝向 → toss → 地面实体复核）。
- **Driver 补两块**：`BodyOps.toss(name, count)`（窗口外转移，可丢域只到主背包+快捷栏 9..44，回执只到 `unknown`）；`ClientEntityValue.item`（掉落物身份，走 `entity.getDroppedItem()`，不手写元数据索引）。
- **两个真服暴露的底层缺陷顺手修掉**：①`searchBlocks` 按段**中心**排序，玩家站在段边界时脚下这段会排到后面，命中上限就把最近的方块漏掉——改成按段"最近点"排序，并在上限后只继续扫"仍可能更近"的段；②`goto` 目标已在 GoalNear 邻域内时上游不发 `goal_reached`，表现是 `tolerance=1` 且隔一格就永久挂住——改成先在驱动层按节点距离判定并在邻域内直接结算。
- **`pickup` 的最后两格不用路径规划**：GoalNear 的 1 格容差在近距离经常 resolve 空路径（驱动层按 UNREACHABLE 结算），改成 `lookAt` + `drive` 步进，`goto` 只在 4 格外使用。
- **`collect` 不持身体、不挖脚下那一格**：Body 槽与 goto 槽互斥，逐步取放；脚下那格留到没有别的可选时才挖（一格竖井会让后续每次 goto 都失败）。
- 契约口径补齐：`mine@1` 的 `errors[]` 补 `WRONG_STATE`、`goto@1` 补 `WRONG_STATE`、`equip@1` 补 `TARGET_NOT_MET`；`pickup@1` 从两行补成完整的完成条件与失败码。
- 真服：K2 场景 11 步 PASS（新世界）；K1 回归 19 步 PASS、I1 PASS。`tests/mc` 13 files / 93 tests。

## 2026-10-24 · 剩余施工总纲（development-plan §10）

- **把"能力分组"和"施工批次"分开**：K1–K8 是能力范围标签，不是批次。新增 §10 给 12 个批次，每批的交付物必须是"一条能在真服跑完的玩家任务 + 一个场景脚本"，批 0 = 已完成的 K1。
- **显式登记六处与原 K 顺序的偏差**：①K2 拆成"采集闭环 / 窗口容器 / 生产链"三批（组合动作、窗口协议、生产逻辑三类风险不同量级）；②`drop@1` 需要新增 `BodyOps.toss`（Driver 目前明确不丢物品，原规划把它当纯能力层组合）；③K3 拆两批，`fight` 依赖 driver §8 反馈时序；④K4 内部改序，`tunnel/excavate` 先于 `region/places`；⑤新增批 4"自主游玩校准点"，用真实游玩重排后续批次（原规划没有使用驱动节点）；⑥K5 与 Library 的"只读蓝图"子集同批，不等整块 Library。
- **待裁决四项**：熔炼数据自建最小表 vs 等上游（建议自建）；H 回执是否插队（建议不插，保持批 10）；K6 `players/map` 暂缓；Program guest 边界按 QuickJS。是否为 P1/P2 扩面推迟到批 4 的评估结果。
- **技术债按触发条件挂起**（不提前还）：world 无保留/清理、事件 Watch、`ItemSelector.components`、`world.difficulty` 常 null、`vitest tests/mc` 过滤器误匹配。

## 2026-10-23 · 真服复验：可达性归调用方、eat 归因、K1 场景全过

- **"可达性归调用方"写进 §4 总则**：除移动类动作外，破坏/放置/右键/攻击只作用于当前姿态够得着的目标（方块交互自眼位 4.5 格，实体交互 4 格），够不着返回 `UNREACHABLE` 并提示先 `goto@1`，动作内部不寻路；`collect`/`tunnel`/`excavate` 这类本身含行走的组合动作不受此限。据此校正 mine/attack/use 三处"走近"表述——原文读起来像每个动作都要自己走过去，与实现（以及"导航只此一个入口"的取向）相反。
- **射程判定收成一份实现**（`capabilities/shared/reach.ts`）：`BLOCK_REACH=4.5`（自眼位）、`ENTITY_REACH=4`、`blockReach/eyeOf`。mine/place/use(方块/牌子)/attack 全部改用它；此前 use 用"feet 到方块角 6 格"、place 根本没查、attack 自带 `ATTACK_RANGE=4`——同一件事三套口径，超射程的交互只会以 `TARGET_NOT_MET` 的形式晚到。place 量的是真正被点的支撑面，不是目标格。
- **mine@1 补射程判定**：此前能在 4.5 格外派发挖掘，服务端要么拒绝、要么掉落不在拾取半径内而 `dropped` 恒缺省；现在派发前拒绝，`hint` 带实测距离。`dropped` 的可观察条件因此明确：**先站到被挖格上，再谈掉落**。
- **eat@1 归因顺序**：点名的物品不在包里 → `NOT_FOUND`；在包里但不是食物 → `WRONG_STATE`；两者都排在"已经吃饱"之前。此前吃饱时传 `dirt` 会得到"food is already full"，状态掩盖了输入错误。
- **真服结果（Paper 1.21.11 / 端口 25565 / UinaDev op）**：I1 复验 PASS；K1 场景 19 步 PASS——world/item/recipe/inventory/self、equip→place(dirt/sign/lever)→use(写牌/拉杆)、mine(掉落入包)、mine 越界拒绝、blocks/entities、attack(命中证据)、eat 非食物拒绝、eat 饥饿进食(food 0→5、面包 -1)、events 尾窗+after 正向分页+空增量页。
- 分页口径澄清（不是代码缺陷）：**无 `after` 的读只给"最近 limit 条"+ `after`，不给 `next`**；`next` 只出现在 `after` 之后的正向分页。按"首读给 next"写场景会误判成 bug，改用 `after` 起步后 3 条消息稳定得到 page1(2)+`next` → page2(1)。

## 2026-10-23 · K1 能力面收口（9 查询 + 8 动作）

- **能力层重写为"一族一文件 + 共享工具"**：`capabilities/{queries,actions}/` 取代原来的两个大文件；`shared/` 收敛 schema 片段、目标换算、观察窗口、事实组装、实体解析、查询声明。重复 ref 在装配时显式失败。
- **查询分三路读取**：`current`（同步采样）/ `static`（版本知识，不需要连接）/ `history`（events@1，提交屏障后读存储）。`Observation.cursor` 允许 null：静态与派生查询（recipe 的 plan）没有观察水位；events 的增量位置是页内不透明 `after` 令牌。
- **blocks@1 名实对齐**：`blocks@1` 回到"按名搜方块"（World 负责排除/计数/截断，Driver 负责按 section palette 跳过扫描），`regions` 式的段读取不再占用这个名字；`block@1` 支持 `{at}` 与 `{below}`；`self@1` 从同一次库存采样补 held/armor；`inventory@1` 补 counts/usedSlots/freeSlots；`entities@1` 支持 radius/kind/limit 并排除自身（`ClientEntitiesValue.selfRef`）。
- **Driver 新增事实与操作**：`world()` 环境读数（时间/天气/维度/群系/难度/模式，读不到为 null）、`searchBlocks()`（palette 跳过 + 近段优先 + 上限 capped）、`Static 知识`（registry-knowledge：物品/食物/工具/掉落/配方/实体分类）、damage/death/connection 事件捕获；`equip` 扩到护甲槽（EquipSlot）；`attack` 增加受击证据窗口（`AttackOutcome.hit: boolean|null`）；`writeSign` 真实路径（open_sign_entity 匹配 + update_sign + blockEntityData 确认，文本不可读时如实 unknown）。
- **World 事件历史**：复用 evidence 表与 rowid 顺序（不建第二份聊天队列），新增事件读取消息与提交屏障；游标编码分区/过滤/位置/上界/页大小，分页固定上界，空页推进 after，分区不符报 SNAPSHOT_EXPIRED。
- **完成口径如实**：mine 只认客户端空气（未加载不算 air），掉落只在短窗口内报观察到的增量；place 先查冲突/材料/支撑面再取身体；eat/attack/use 的可预判失败都在 `withBody` 之前；use 明确拒绝窗口类方块并指向 container/craft/smelt；attack 的 hit 不把"没看到"写成"打中"。
- **构建接线**：`tsconfig.build.json` 纳入 `.uina/worlds/minecraft`，worker 路径按产物/源码双态解析；`dist` 内两个 worker 均有 .js 产物。
- 数据版本事实：1.21.11 的 minecraft-data 只有合成/方块/实体三类来源，没有熔炼与交易数据，因此 item.sourcesComplete 恒为 false、fuel 恒为 null、recipe 只有合成配方；`sourcesComplete=false` 是数据覆盖说明，不是"无法获得"。
- 验收：`tsc --noEmit`、`check:boundaries`（9 规则）、`tests/mc` 12 files / 76 tests 全绿；`tsc -p tsconfig.build.json` 全绿。**真服未复验**，本轮全部新路径只有确定性单测覆盖。

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

六份编号讨论稿合并为本目录的概要（`design.md`）、行为契约（`contracts.md`）、公开接口（`public-api.md`）、研究记录（`archive/research.md`）与各模块详细设计；原稿快照存 `../../../.artifacts/minecraft-design-originals-20261015-144602.zip`。

## 2026-10-15 ~ 10-17 · 各模块定稿与重构（原先写在正文首屏，已移到这里）

- **Driver（10-15 定稿，10-17 修订）**：PHY-STEP 物理窄接缝降为条件条款（同进程事件计数已满足 drive/feedback 合同，接缝只在安装异步化或插件归属取证时实现）。10-17 架构重构：Gate 成为资格与操作记录的唯一权威（无第二份 active 指针/操作集合）；原生使用状态唯一权威 = Body 会话；按键持有收编为 KeyHold（撤销只清本根）；窗口 revision 唯一权威 = WindowSession；`say` 经 gate 停用准入（不要求 Body Permit）；删除 Operation 的资源标签字段，资源归属改由 KeyHold/useControl/会话登记等具体机制承载。
- **World（10-16 定稿，10-17 三轮修订）**：SQLite 专用 Worker + 提交屏障化历史查询 + ACK 收敛为 durable-only；历史 cursor 改取读取视图版本、双量纲水位、durable 物理前提核验；§9.1 失效只按查询可见边界定义（混合查询与时间阈值为条件条款）；§13.1 两段初始化（当前基线先行、历史独立 opening）；存储身份冲突核验；schema v3 对齐。
- **Runtime**：§9/§10 的 Program 执行合同、等待原语在 10-18 由 `program.md` 取代，正文已改为指针与 Runtime 侧硬保证。
