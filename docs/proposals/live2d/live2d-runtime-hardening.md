# Live2D 运行期加固：已实施修复与后续提案

2026-10-18。范围 `.uina/worlds/live2d`。本文分两部分：本轮已落地的结构修复（附证据与验证方式），以及仍需投入的改进提案。
当前行为合同以 [Live2D World 运行合同](../../live2d/live2d-world-runtime.md) 和源码为准，本文不是合同。

## 一、本轮已实施

| 问题 | 证据（修复前） | 处理 | 验证 |
| --- | --- | --- | --- |
| 空间动作是一个 557 行闭包，17 个可变变量跨阶段共享；`restore`/`restoreEffects` 两套幂等习惯；连着两次 `!sameModel()`（第二次是死检查） | `external-actions.ts` 的 `runSpatial` | 拆成 `SpatialRun` 阶段类：`prepare` → `play` → `driveRelativeRotation`/`dispatch` → `restorePose`/`restoreEffects` → `settleSuccess`/`settleFailure`；跨阶段事实放只读运行上下文，阶段内事实私有 | 假 VTS 空间用例、`live2d-spatial-playback`、`live2d-exclusive-tools` 全通过 |
| 目录/模型/连接三个代次散落各处，`getInjectionStats().generation` 实为连接代次 | `vts-client.ts` 旧 `getInjectionStats` | `environment.ts` 的 `EnvironmentToken { connection, model, catalog, modelID }` + `sameEnvironment`；`VTSClient` 分开 `getConnectionGeneration()`/`getModelGeneration()`；`status(detail)` 报当前令牌 | 定向 370 项；`live2d-vts-client` 连接代次用例 |
| 躯干隐式叠加：`baseline-offset` 的 torso 通道叠加在 head-follow 目标上，忘写 `- head` 得到双倍旋转且不报错 | `director.ts` 旧 head-follow 合成 | `ActionPlan.torso: "head-relative" | "absolute"` 必填声明；director 用 `absoluteTorso` 集合让声明 absolute 的轴独占 | `tests/live2d-torso-articulation.test.ts`（6 项）+ 20 个动作文件补声明后基线与视觉不变 |
| 19 个动作文件各自复制同一段五次多项式 | 各 `motions/*.ts` 的 `smoothstep5` | 上提到 `authoring/curves.ts` 的 `smoothstep(edge0, edge1, x)`，`authoring/index.ts` 导出 | 提取前后定向用例与动作基线一致 |
| 未标定常数散落在 `external-actions.ts` 顶部，无法现场调整 | `MIN_USEFUL_MOVE_MS`、`SETTLE_MARGIN_MS` 等 | `timing.ts` 的 `TimingProfile` + `resolveTiming`（未知键/非有限/越界直接失败）；`UINA_LIVE2D_TIMING` 覆盖；`status(detail).timing` 报告生效值 | `tests/live2d-timing.test.ts`（6 项，含运行时接线） |
| 焦点是 fire-and-forget，失焦可能晚于 `express` 被引擎看到 | `EngineFires["endpoint.onFocus"]` | 改为命令 `EngineCalls["endpoint.setFocus"]`，走与工具调用同一条有序 RPC | proxy/engine 生命周期用例 |
| 动作美学没有自动回归，只能靠肉眼 | 逐条手写 spot check | `tests/live2d-motion-quality.test.ts`：60Hz 采样全部动作/变体/背景，断言越界、单帧跳变、非有限值、结束回中、作者轴位移，并与 `tests/fixtures/live2d-motion-profile.json` 比对 | 变异验证：把 `glance` 的 pitch 幅度 ×1.6，测试立即点名 `head.pitch`/`torso.pitch` |

当次结果：定向 `npx vitest run live2d` 41 文件 / 370 项通过；`npx tsc --noEmit` 通过；`npx biome format .` 434 文件无改动；`pnpm check:boundaries` 8 条规则通过。整仓结果按当次日志记录。

## 二、后续提案

按"证据强度 × 收益"排序。每条都写清判据，避免"改了但不知道有没有用"。

### P1 作者层：声明式节拍 + 弹簧库（收益最大）

**观察**：20 个动作文件约 4,200 行，单个动作 100–350 行以 `(t: number) => number` 手推分段；参数如 `3.2°`、`-9.4°`、`f=1.36Hz`、`ζ=0.28` 没有单位、来源或验收镜头，改一个数无法预测画面。
**提案**：新增三个"段"原语，作者只描述节拍与目标，Bake 时展开成曲线：

- `segment(durationMs, { "head.yaw": { from, to, ease } })`：单轴或整组写目标，内部按 ease 生成；
- `springSegment(durationMs, { axis: { from, to, frequencyHz, dampingRatio, overshoot } })`：显式物理参数，替代手写指数衰减；
- `overlap(a, b, ratio)`：两段交叠，替代手工错拍。

保留 `during`/`track`/`absolute`/`offset` 作为放置与空间原语，不推翻现有作者面。
**判据**：改写 `nod`、`glance`、`wink` 三个动作；质量基线幅度差 <5%；代码行数下降 >40%；真机看片确认节奏没变。三个都成立再铺开，避免一次改 20 个动作把回归埋进基线里。

### P2 真机标定：把"未标定"变成数字

**观察**：`minUsefulMoveMs=100`、`settleMarginMs=60`、`settleRetries=2/250ms`、`maxEndpointResidualDeg=2` 全是起始值，注释自己写着需要真机校准。
**步骤**：在预览进程打开 `onSpatialTrace` 落 JSONL → 对 `joy_hop`/`petrify`/`close_up` 各跑 20 次 → 统计 dispatch→ACK 的 p50/p95、位姿窗口命中率、归位尾差 → 用 `UINA_LIVE2D_TIMING` 覆盖复跑对照 → 结论写 `docs/live2d/calibration-2026-10-xx.md`，再改默认值。
**判据**：`p95(ACK) + settleMarginMs < minUsefulMoveMs`；尾差 p95 < `maxEndpointResidualDeg`；窗口命中率 >95%。达不到就改设计（缩短位姿 span 或提前 lead），而不是把阈值调宽到"看起来通过"。

### P3 cue 通道的顺序语义

**观察**：焦点已改为有序命令，但 `endpoint.emitCue` 仍是 fire-and-forget；跨线程没有序号，理论上存在旧 cue 覆盖新 cue 的窗口（账本只在引擎侧按 seq 自保）。
**提案**：proxy 侧给 cue 加单调 `seq`，引擎丢弃小于已处理值的 cue，并在 `lastCue` 记 `dropped_stale`；或直接改 `call` 但不等待结果。
**判据**：新增跨线程乱序投递用例（人为反转两条消息），引擎不执行旧 cue 且账本可见丢弃原因。

### P4 观感回归升级为轨迹特征

**观察**：现有基线锁幅度、峰谷、残留；"幅度对、节奏塌"（例如中间 key 被拉长一倍）不会被抓到。
**提案**：基线增加速度分位（p50/p95）、停顿段数、方向反转次数。
**判据**：人为把某动作中间段时长 ×2，新断言必须失败；正常微调不应失败（用 3 个动作试改验证误报率）。

### P5 MO 内容生产流程（目录仍为空）

**观察**：按用户要求 MO 的动作/姿态/表情/背景内容为空，`express` 返回"目录为空/未知动作"；运行期已经就绪，缺的是内容与验收流程。
**提案**：每条动作一份规格（意图、节拍表、轴预算、参考镜头、禁止动作）；用现有 `mo:preview --sample` 生成关键帧截图集；配一条质量基线；人工看片签字后才进目录。
**边界**：这是内容工作，不改 Runtime 合同；不要让"AI 觉得好看"替代看片。

### P6 诊断落盘（受控）

**观察**：`onSpatialTrace`/`onActionDiagnostics` 只在进程内，事故后无法复盘。
**提案**：worker 侧可选 JSONL 落盘（默认关，路径显式配置），字段限定为时序与结算事实；`status(detail)` 只返回最近 N 条计数。
**边界**：诊断不得进入模型可见工具结果（既有边界），也不得包含模型文本。

## 三、明确不做

- 不恢复 Timeline 编辑器、通用数值轴、即兴节拍：既有决定（A2/A14/A6）未出现能被推翻的证据。
- 不为兼容保留两套躯干语义：本轮已经强制声明，回头再加"缺省推导"会把双倍旋转的坑重新埋回去。
- 不引入"美感自动评分"模型：没有可信判据，比基线比对更容易自欺。

## 四、仍未验证

- 真实 VTS/MO 的观感、ACK 延迟分布、100ms 位姿窗口与 2° 尾差的实际标定。
- 标定前的 `TimingProfile` 默认值只是保守起点，不是设备事实。
- `tests/live2d-motion-quality.test.ts` 锁的是形状与基线，不证明好看；第一次真机看片仍然是必要步骤。
