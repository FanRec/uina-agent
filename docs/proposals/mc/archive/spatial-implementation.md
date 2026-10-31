# 批13 实施记录：地形切片与空间作业（region / tunnel / excavate + G4 关闭）

日期：2026-10-31。分支 `codex/phase0-baseline`。施工规格：development-plan §10.3（地形切片 K4 + 空间作业 K4）、known-gaps G4/G5、capabilities.md §3 region / §4 tunnel·excavate。开工前无未提交改动（HEAD = 批12 537a560）。

## 交付

### 能力面 +3（13 查询 + 24 动作 = 37/51）

| 能力 | 文件 | 要点 |
|---|---|---|
| `region@1` | `capabilities/queries/region.ts` | `{from,to}` 闭区间（归一化 min/max）或 `{at,size}`；palette 第 0 项恒 `{name:"air",properties:{}}`，order 固定 xzy（`i=(y-oy)*nx*nz+(z-oz)*nx+(x-ox)`）；未加载格索引 -1 计 `missing`；`scanned.chunksLoaded` 按含加载格的列区块去重；>8192 体素 INVALID_INPUT 带切片建议；跨维度按未覆盖返回。逐格走同一提交边界的事实视图（block@1 同源数据），有界同步采样；watchable:true（cursor observed）、feedback:false |
| `tunnel@1` | `capabilities/actions/tunnel.ts` + `shared/spatial.ts` | 规划纯函数：L 形两轴水平段（长轴优先）、台阶 1:1（auto 把 |dy| 分摊到前 |dy| 个水平步）、段尾竖井衔接；**下坡列挖檐块**（本列 ceiling，头部过檐）、**上坡列在前一位列挖跳跃净空**（2 高空间跳不上 1 格台阶）；support 探测檐上 sand/gravel/red_sand 先挖（上限 4 格）再挖 profile。执行节拍：withBody 挖 reach 内数列（ceiling 格 3D 距离 ≤4.2）↔ goto 走到最远已挖列（digThrough:true 兜底 + 实际落点复核——空路径假成功/NoPath 不当作到达），失败回退 `stepTo`（capabilities/actions/dig-cycle.ts：容差到位 + 悬空松键落定 + 上坡退一步助跑跳）。流体 → UNREACHABLE；库存无法采收 → `stopped:"unbreakable"`；not_met → TARGET_NOT_MET 带效果 |
| `excavate@1` | `capabilities/actions/excavate.ts` | region 闭区间 ≤4096 体素；层自上而下、层内按当前位置就近序；keep（默认 bedrock/chest/furnace/spawner）保留；**容器格先 `transfer@1 {from,all:true}` 收内容再挖**（单次调用）；每格挖后短窗观察背包正增量累计 `drops`；not_met 与收尾 remaining 都以世界读数复核（空气即计入 dug）；走位失败后按实际站位复核射程；uncleared → TARGET_NOT_MET 带 progress.remaining |

### G4 关闭（ctx.verify 注册表）

- `contracts/runtime.ts`：`EffectVerifier`（check(effect facts, world, input) → met/not_met/unknown，不派发动作）。
- `runtime/engine.ts`：`EngineOptions.verifiers` 注册表；`ctx.verify` 效果记录存在性 → 注册表查找 → 核验 → append-only 追加 `EffectVerification`（新 record ref），原 completion 不改写；返回 receipt = 原事实 dispatch + 核验结论 completion。
- `runtime/records.ts`：`appendVerification`（新截面入队）+ `restoreEffect`（既往会话效果行恢复，跨重启可复查）；`runtime-db-worker.ts` 增 `effect_verification` 突变（effects.verifications 追加 + record 推进）；`storage-queries.ts`/`rows.ts` 的 effect 快照携带 verifications。
- `capabilities/shared/verify.ts`：`verify/dig@1`——从 body.dig@1 事实 detail 取 BlockTarget（runMining 的 dispatch/receipt detail 自批13 起携带 `target`），读当前方块：air→met、原方块→not_met、未加载→unknown；非 dig 效果 INVALID_INPUT。组合根 `companion/side.ts` 注册。
- 程序桥：`mc.verify(effect, verifier, input)`（shim + contracts/program.ts ProgramHostApi + program/index.ts allowed + runtime/program-host.ts）。
- `runtime/index.ts`：`MinecraftRuntimeOptions.verifiers` 透传。

## 验证

- 单测（vitest vmThreads）：`mc-spatial-planner.test.ts`（走廊形状/台阶 1:1/檐块/跳跃净空/竖井/清空枚举/就近序/方块分类）、`mc-region-query.test.ts`（palette 去重/xzy/missing/跨区块/上下限）、`mc-verify-runtime.test.ts`（真引擎+真 records 的追加语义、未注册/无记录/非 dig 效果、SQLite 子进程重启复查）、`mc-spatial-actions.test.ts`（tunnel 走廊/流体/未加载/unbreakable/INTERRUPTED、excavate 清空+keep+drops+remaining+上限）。
- 全量：MC 66 文件/486 项全绿（含目录计数测试更新为 13 查询 + 24 动作）；`pnpm typecheck`（biome + 10 条边界 + 双 tsconfig）通过。
- 真服（Paper 1.21.11 build132、offline UinaDev、9500 高空平台）：`pnpm dev:mc:spatial` **8/8 PASS**——
  1. region 跨区块结构对拍（48 格 ~3ms，chunksLoaded=4，oak_planks/glass/air 逐格核对）；
  2. region 远区 8/8 missing 带 unknown + 8704 格 INVALID_INPUT；
  3. 下行阶梯隧道 dug=22（砾石帽 2 格支撑先挖），serverPos 终点复核，走廊头顶无残留砾石；
  4. 高架箱第二条下行阶梯 dug=20，serverPos 终点复核；
  5. excavate 保留箱子：区域 47 格全空气（逐格世界核验）+ 箱子原位，dug=47，drops.cobblestone=15；
  6. excavate 容器收集：chest peek iron_ingot×16/bread×5 → dug=17 含箱子 → iron_ingot +16 / bread +5；
  7. G4 复查：已挖格 met、/setblock 填回 not_met、未注册 NOT_FOUND（原记录未被改写）；
  8. 收尾 stop-server.mjs exit0、25565 无监听。

## 裁决登记（capabilities.md 合同的实现口径）

1. tunnel 走廊遇水/岩浆/气泡柱 → UNREACHABLE（hint 指明含水，不冒进）。
2. 当前库存无法采收（基岩/知识缺失外的无法采收）→ 返回 `stopped:"unbreakable"` 保留已挖前缀；缺工具与基岩在该口径下等价（合同未区分）。
3. `path` = 服务端确认挖开的格 + 原方块名（已开口的走廊格不入 path）。
4. stairs:"never" = 水平段恒地板高，高差在段尾竖井衔接（竖直段不可攀爬时如实 UNREACHABLE）。
5. excavate drops = 每格挖后 800ms 窗内的背包正增量（不承诺拾取完整；掉落散落不计入）。
6. excavate not_met 与收尾 remaining 以世界读数复核——空气即计入 dug（确认窗边界竞态、路径挖掘兜底 digThrough 的顺带开挖都会造成假 remaining）。
7. region watchable:true（观察游标）/ feedback:false（采样成本高于单格）。
8. tunnel 上坡列在**前一位列**挖跳跃净空、下坡列在**本列**挖檐块——都是规划器的形状义务（见经验 26/27），不是行走参数。

## 真服调参轮记录（重要失败与修正）

- **测试台假故障（10 轮）**：`/fill` 超 32768 上限静默失败，平台下方是天然地形——所有"楔死/悬空/坠洞"先在坏测试台上复现了一轮。修复：分块填充 + 抽样复读（经验 24）。
- **楔死的真实成分**：2 高空间跳跃削顶（经验 26）+ 贴面起跳横向速度被清零（经验 27）+ GoalNear 邻域含正下方格（1 列上坡腿在正下方被判到达）。修正：檐块/净空进规划器、腿目标至少跨 2 列、到位判据"水平 ≤1 且脚在目标层"、stepTo 悬空松键落定/退步助跑。
- **容器收集**：`container@1 + transfer@1` 连续开合同一窗口在真服搬不动（0 moved）；改单次 `transfer@1`（自带开箱/搬运/关窗）后 16+5 全量入包。箱子 NBT 需 1.20.5+ 新格式 `count`（经验 25）。
- **假 remaining**：确认窗边界竞态（not_met 但方块已开）与 digThrough 兜底腿的顺带开挖——世界读数收尾复核（经验 28）。

## 边界与未验证

- **上坡台阶行走楔死 → G21 登记**（known-gaps §3）：上行走廊能挖成（规划器形状正确、挖除全部服务端确认）但走不进去，UNREACHABLE 如实上报；修法方向（助跑时序/pathfinder 运动参数/placeToReach 垫块）需要专门调参轮。
- region 大区域切片体验（§11.8 的矿洞实测）按合同分片；整栋建筑物料/占位场景属 K5（build.plan/build），不在本批。
- `stopped:"unbreakable"` 覆盖"基岩"与"缺工具"两类；不含液体（液体走 UNREACHABLE）。
- tunnel 竖井上行段（水平步数不足时）按不可攀爬如实 UNREACHABLE；下行竖井靠重力沉降可行。
- excavate drops 是诚实观察值；真服 15/47 的拾取率反映掉落散落，不是收集缺陷。
- `pnpm build` 未在本轮复跑（批12 记录的 web-client DOM lib 阻断仍在 HEAD，非本批文件）。
