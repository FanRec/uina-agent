# 批14 实施记录：蓝图与施工（build.plan / build / Raw→Target→Project）

日期：2026-11-01。分支 `codex/phase0-baseline`。施工规格：development-plan §10.3（蓝图与施工 K5）、known-gaps G5、capabilities.md §2.2/§3 build.plan/§4 build、library.md §3。开工 HEAD = 批13 `b2bf9a4` + 构建修复 `f74854c`。

## 交付

### 能力面 +2（14 查询 + 25 动作 = 39/51）

| 能力 | 文件 | 要点 |
|---|---|---|
| `build.plan@1` | `capabilities/queries/build-plan.ts`（声明）、`world/build-plan.ts`（观察成形）、`contracts/world.ts`（`ConstructionPlanner` 端口） | 与 build 共用 `BuildTargetRequest`（`shared/schema.ts: buildTargetSchema`，cells/from 两条分支各自 `additionalProperties:false`，互斥由 schema 保证）。派生结果：`source:"derived"`、`cursor:null`、不可等待。World 只按 ref 分派给组合根注入的窄端口，不依赖 Construction/Library |
| `build@1` | `capabilities/actions/build.ts`、`place-cell.ts` | 开局读一次计划（同一份输入去掉 maxTimeMs），派发前判 CONFLICT/MISSING_MATERIAL；先清后放、按列自下而上、多轮；收尾逐格复读世界复核 `remaining` |

### 新模块 `construction/`（Raw → Target → 差异）

| 文件 | 职责 |
|---|---|
| `target.ts` | Target 四分类、`normalizeTarget`、`applyTransform`（先 mirror 再 rotate 再平移）、`transformBlockState`（facing/axis/rotation/hinge/shape）、`matchesDeclared`、`isReplaceableName`、`resolvePoint/resolveGrid`、`stripNamespace`（全仓唯一定义，`capabilities/shared/targets.ts` 再导出） |
| `nbt.ts` | 最小 NBT 读取（TAG 1–12，gzip 探测，长度/深度显式上限） |
| `schem.ts` | Sponge `.schem` v2/v3 解码：`Version`/`Width·Height·Length`/`Palette`/`BlockData` varint，索引 `(y*Length+z)*Width+x` 与 `region@1` 的 `order:"xzy"` 对齐；空气格按 airPolicy 定性为 clear/preserve；其余格式 `WRONG_STATE` + 支持范围 |
| `target-json.ts` | `minecraft:construction.target@1` 两种写法（密集 palette+cells / 稀疏 cells 列表） |
| `plan.ts` | 唯一差异实现：targets 排序与上限 2048、`blocked`、`unreachable`（结构支撑，只认同层或更低的计划格）、`need`/`missing`、`estTicks` |
| `index.ts` | `createConstructionPort`：`resolve`（`target.json` 优先，否则 `.schem`）、`plan`（`region@1` 按 Y 切块读设计盒 +1 圈、`inventory@1`）。`world` 惰性取值 |

### 共享原语抽取（含既有实现重构）

- 新增 `capabilities/actions/place-cell.ts`：`inspectPlacement`（取身体之前的目标/冲突/材料/支撑面/射程判断）与 `commitPlacement`（装备 + 交互 + 确认窗）。`place@1` 改为薄壳，行为逐字等价（`mc-capability-actions.test.ts` 零改动通过）。
- `PlacementPrecheck` 把 `no-support`（还没有可点面）与 `out-of-reach`（有面但太远）分开：前者延后重试、后者走位一次。合成一个码就只能盲目走位或盲目放弃。
- `supportsFor` 返回**全部**可点支撑面，`commitPlacement` 依次试——服务端会拒绝某些面（真服实测：门顶放不上）。

### 其它接线

- `library/index.ts` 增 `readDesign(name)`（原件 + target 字节与两个摘要）；`contracts/library.ts` 增 `BlueprintBytes`，不进 `LibraryPort` 公共面。
- `companion/side.ts`：Library 上移到 World 之前，`createConstruction({blueprints: library, world: () => world})` 注入 `buildPlanner`。
- `world/index.ts`：`queryRefs` 增 `BUILD_PLAN_REF`，`readPartition` 增分支，缺端口报 `INTERNAL`。
- `scripts/make-mc-schem-fixture.mjs` 生成入库夹具 `tests/mc/fixtures/house.schem` / `house-v2.schem`（5×4×5 木屋，不含地板——真服地面就是地板；见下"踩到的真实行为"）。

### 必须先定的裁决（文档留白处，已写回 capabilities.md）

| 裁决 | 结论 |
|---|---|
| `target.json` schema | `minecraft:construction.target@1`，复用 `region@1` 的 palette+order 词汇 |
| `blueprint.digest` | **实际被解释来源**的 sha256（有 target.json 就是它）；`library.get` 的 digest 仍是原件摘要 |
| `.schem` 支持范围 | 只支持 Sponge v2/v3、root `Schematic`；`.litematic`/`.snbt` 明确 `WRONG_STATE` |
| mirror/rotate 语义 | mirror 在自身包围盒内翻转（`x→nx-1-x`）；rotate 绕 Y 顺时针（东→南，`(x,z)→(-z,x)`）；状态只变换 facing/axis/rotation/hinge/shape |
| 上限 | `targets` 2048 格、`cells` 512 格；`schem` 解码 8192 体素；超限 INVALID_INPUT 带建议 |
| `blocked.by` | 现场方块名（string） |
| `unreachable` | 结构支撑缺失，不是寻路判决 |
| `estTicks` | `ceil((place+clear)/8)*40 + clear*15 + place*8` |
| build 与 plan 的关系 | build 开局读一次 `build.plan@1`，不再读盘；`expectDigest` 在计划处判 CONFLICT |
| `scaffoldsUsed` | 恒 0（不搭脚手架），无支撑面的格进 remaining；登记为 G22 |

## 验证

### 确定性（`--pool=vmThreads` 显式列表）

| 文件 | 覆盖 |
|---|---|
| `mc-construction-target.test.ts`（19 项） | 规范化/包围盒/重复格、rotate 90/180/270 与 mirror 的坐标、facing/axis/rotation/hinge/shape 变换、越界拒绝、排序、声明匹配与可替换性 |
| `mc-construction-schem.test.ts`（13 项） | 真夹具解码（尺寸/100 格/74 set + 26 preserve、门 half、火把、xzy 索引环）、set_air → clear、缺 airPolicy → INVALID_INPUT、改版夹具、坏字节/坏 root/Version 1/截断 BlockData、palette 属性解析 |
| `mc-construction-plan.test.ts`（17 项） | need/missing、已匹配不计材料、冲突与 replace、clear 计数、preserve/unknown 不计、结构支撑（含同计划支撑传导）、2048 上限、排序、blueprint 身份 |
| `mc-capability-build.test.ts`（12 项） | 派发前 CONFLICT/MISSING_MATERIAL、自下而上两格、先清后放（dig 在 interact 之前）、已匹配跳过不取身体、preserve/unknown 不动、逐格冲突收尾 remaining、多轮补支撑、无支撑不反复走位、预算耗尽时 `remaining` 覆盖没轮到的格（总量守恒）、取消 INTERRUPTED |
| `mc-capability-queries.test.ts` | 目录计数 14 查询 / 25 动作，`build.plan@1` 无 reader |
| `mc-library.test.ts` | `readDesign` 的两个摘要、缺件/多件诊断 |

MC 全量 **67 文件 / 537 项**全部通过（`--pool=vmThreads` 显式列表）。`pnpm typecheck`（biome + 10 条边界 + tsconfig）与 `tsc -p tsconfig.build.json` 通过。

> 跑全量要用本机 node 24.13.1（`E:\Work\NodeJs\node.exe`）。`mc-executor-platform.test.ts` 在 `beforeAll` 里用 g++ 编译一个 Windows Job 的 `.node` 辅助件，头文件取自 `%LOCALAPPDATA%\node-gyp\Cache\<node 版本>`；PATH 上若先命中 WorkBuddy 自带的 node 22.22.2，缓存里只有 24.13.1 的头，编译报 `node_api.h: No such file or directory`，整文件 13 项变成失败。这是环境版本错配，不是回归（换 24.13.1 单跑 13/13 通过）。

### 真服（Paper 1.21.11 build132、offline UinaDev、9600 高空自建平台，未重置世界）

`pnpm dev:mc:build` 源码与 `node dist/.uina/worlds/minecraft/dev/build.js` 产物各 **12/12 PASS**：

1. 备平台/清空体积/落蓝图（夹具 271B）；
2. `build.plan`：targets `{set:74, preserve:26}`、need `{oak_planks:71, oak_door:2, torch:1}`、missing `{planks:31, door:1, torch:1}`、**digest == sha256(design.schem)**；
3. 缺料时 `build` 在动任何方块前 `MISSING_MATERIAL`（原点仍是空气）；
4. 补料后 plan 无缺口无冲突；
5. `build` 建成：`placed 73 + skipped 27 = 100`，并用 `region@1` 独立复核世界 `{oak_planks:71, oak_door:2, torch:1, air:26}`、门的 half=lower/upper、室内是空气；
6. `build.plan` 用 `target.json`：6 格 `{set:3, clear:1, preserve:1, unknown:1}`，digest == target.json 的 sha256（证明 Target 优先且摘要口径正确）；
7. `build` 尊重三类语义：`placed 3 / cleared 1 / skipped 2`，`preserve` 的箱子原样、`clear` 的石头被清掉；
8. 改图后用旧 digest 施工 → `CONFLICT`，现场无新增方块；
9. 新版重 plan → 差额只有那块圆石，`build` 建成（`placed 74`）；
10. 同目标再跑 → `placed 0 / cleared 0 / skipped 100`（幂等）；
11. 513 格 → `build.plan@1` 与 `build@1` 都 `INVALID_INPUT`；
12. 1s 预算 → `TIMEOUT`，progress 数字自洽：`6 已放 + 0 已清 + 27 跳过 + 67 剩余 = 100`（这一条先验出了下面的经验 9）。

收尾：开发服经 `stop-server.mjs` 正式端口 `/stop` 保存退出，25565 无监听；专用平台与 Temp 数据根保留。

### 未验证

- `.litematic` / `.snbt` 解码（本批明确不支持，报 `WRONG_STATE`）。
- 方块实体内容（箱子内容、告示牌文字）不进 Target；原件 `Offset` 不自动生效。
- 大型结构（一次调用建不完）的分段施工、脚手架/垫柱、登高（G21/G22）。
- mirror/rotate 只覆盖 facing/axis/rotation/hinge/shape 五个属性；其余定向属性（如红石线的四向布尔）原样复制。
- 未接真实模型（能力批按 §10.5 用真服场景验收）。

## 踩到的真实行为（已进 dev/MC-WORLD.md 经验）

1. **1 格上坡走不上去（G21）决定了施工顺序**：平坦地面 `goto@1` 5 格 0.6s 到达，跨 1 格高石台 40s 超时。按层铺 → 1 格高的成品面连片 → 寻路去爬 → 整批 TIMEOUT。改成按列自下而上后才建得完。
2. **按"离玩家远近"排序会把建造者关在外面**：外墙先立起来，随后盒中心再也走不进去。改成"到盒中心距离升序"，先把身体送进空盒再向外建。
3. **站位的责任在调用方**：5×5×4 小屋站在盒中心时全部 74 格都在 4.5 射程内（最远角 4.76，靠一格 `stepTo` 补上）；站在盒外只有同侧够得着。这也是 §4「可达性归调用方」在施工上的具体形态。
4. **门顶放不上**：门不是完整方块，服务端拒绝该支撑面。只认第一个可点面会把"有支撑但被拒"变成假失败——必须按候选轮换。
5. **门的上下半是两格**：放好下半时服务端自动补上半，所以上半被正确计入 `skipped`。断言不能用 `placed === set 数`，要用 `placed + skipped === 目标总数`。
6. **`/fill` 之后再 `/tp`，且先开创造模式**：生存模式落进未加载区块会摔死（批13 经验 24 的变体），人一死所有后续步骤都在出生点跑。
7. **query 不能提交成调用**：`build.plan@1` 走 `world.read`；Runtime 对 query 的 `mc.read` 拒绝码是 `USE_MC_READ`。真服场景第一版把 plan 当 call 发，直接被拒。
8. **RunSummary 的 error 只带 code/message**：要看 `progress.remaining` 的逐格原因必须读**调用记录**（`listCalls` → `readRecord`）。
9. **`remaining` 只收"试过没成"的格会漏报**：1s 预算建了 6 格就超时，进度却报 `remainingCount: 0`——队列里 67 格从没轮到过，一条都没进清单。"按事实交代还剩多少"这句合同要求的是**全量对账**，不是"记录失败清单"。判据改成总量守恒：`placed + cleared + skipped + remainingCount` 等于设计格数，任何时候都成立；未轮到的格以 `reason: "not attempted yet"` 补进去。
