# Live2D 动画引擎框架重构方案（提案，待裁决）

状态：提案。基于 2026-10-14 全源码深审（8191 行框架 + 24 个测试文件）。
本文件是唯一施工规格；批准前不动任何源码。

## 0. 第一性审视

**这个引擎的价值单元**：作者标定的命名动作 + 槽位状态 + 自律生命，在 60Hz 下仲裁合成为 VTS 输入帧。其余一切都是机制。

**四条不可动不变量**（任何批次不得破坏）：

1. 时钟注入（A9）：director/pipelines/autonomic 保持纯 `step(dt)` + 注入 rng，无真实定时器。
2. 单一仲裁点：逐轴 (类别优先级, 激活序) 仲裁语义不变。
3. 编译期拦截：非法定义在绑定期失败，不进运行时。
4. 结果词汇诚实：effectStatus / verification 两级，不出现"画面已确认"级声称。

**裁决原则**：框架代码看**领域词汇完备性与实现质量**——框架先于内容存在，内容侧使用率不构成删除理由；应用代码才适用 YAGNI。实现质量缺陷（难验证、隐式约定、魔数）照修不误。个人项目，无兼容层义务。

## 1. 删除清单（对抗性审查的结论）

### 1.1 组合语言：保留词表，加固实现

`sequence / parallel / transform / delay / repeat` 是动画语言的核心词汇（对位
Web Animations / Spine / Godot 同类原语），予以保留。保留依据有二：

1. **领域词汇**：框架先于内容存在，MO catalog 未使用是内容侧事实，不是框架缺陷；
2. **树形 Definition 是承载性数据**：runtime.pickMotionClip 的 speech 覆写按原始
   definition 重编译（runtime.ts:261-266，withSpeech 外层包裹 + 变体重编译），
   要求定义保持可重编译的数据形态；eager 编译期组合函数会切断该路径。

实现的已知弱点（本批要修的正是这些）：

1. **sequence hold/entryTracks 逻辑与树遍历交织**（motion.ts:236-287）：在编译
   递归中按索引回改已产出轨道（`tracks[i] = {...}`），正确性靠局部推理。抽为
   独立纯函数（输入：分支轨道表与组起点；输出：hold 区间与 entry 绑定），配
   专项单元测试。
2. **sampleMotion 入场混合表达式**（motion.ts:389-404）：全仓库最难读的表达式；
   entryTracks 缺省时回退 resting 的语义靠隐式约定。重构为命名步骤，语义逐字节
   等价（现有测试为回归网）。
3. **性质测试补齐**：组合路径当前无内容消费者，全靠测试兜底——恰因如此不变量
   必须显式锁住：段边界时间连续性（带 blendMs 处无跳变）、间隙保持语义
   （hold = 前段末值）、同轴重叠拒绝的完备性、transform 缩放下值域守恒。

### 1.2 保留但明确不加冕的

- 双槽位硬编码（posture/expression）：真实需求就两个，泛化是自加复杂度。
- external-actions 的长函数：复杂度是问题域固有的（前瞻校验/归位守护/身份探活），不拆。
- worker seam（protocol/proxy/engine）：干净，不动。

## 2. 轴域单源化（最大的"知识无单源"点）

现状：`head./torso./gaze./eyes./mouth.open` 前缀语义散布 director 11 处 +
pipelines 分桶 + compileMotion 硬编码 `axis === "mouth.open"`（motion.ts:294）。
validateRig 不校验命名，SomaticPipelines 对未知轴域静默穿透——拼错的轴一路绿灯。

改造：

- adapter/rig.ts 新增唯一词表：`type AxisDomain = "bone" | "face" | "gaze" | "eyelid" | "mouth"`
  与 `axisDomain(axis): AxisDomain | undefined` 单一派生函数；
- validateRig 增加校验：每个 control 必须落在已知域，未知域绑定期拒绝（fail-fast，
  符合"rig 是可验证的数据"哲学）；mouth 域仅允许 mouth.open；
- 全部 startsWith 消费方（director/pipelines/autonomic/compileMotion）改调该函数；
- SomaticPipelines 构造改为穷尽分桶 + 对未覆盖轴显式断言。

## 3. 热路径性能（60Hz，行为等价改造）

1. **逐轴全量重采样**（director.ts:733）：仲裁循环每个 override 轴各调一次
   `sampleMotion(p.clip, ...)[axis]`，MO 规模 clip 约 10 轴 → 同一播放每帧被完整采样
   10 次。改为 step 内按 playback 记忆化（仲裁与 Additive 阶段共享一次采样）。
2. **rig 编码预计算**（rig.ts:201-243）：`input→writers` 映射与 inputs 集合改为
   validateRig 后一次性构建（rig 是冻结数据，可安全预计算）；encodeFrame 从每帧线性
   扫描降为查表。附等价性测试：新旧实现输出逐帧一致。
3. **headroomScale 预计算**（director.ts:468）：每帧重扫 clip 轨道 → 编译期缓存。

## 4. 正确性修复

| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| 1 | autonomic.ts:114 | `phase = yawPhase * 0.7 + amplitude`：amplitude（度）混入弧度相位，默认轴表恰好只有 head.yaw/pitch（走专门分支）掩盖 | 每轴显式相位偏移常量表，与幅值解耦 |
| 2 | director.ts:506 | 独占声明幂等判定靠 `id.endsWith(":${reason}")` 字符串嵌入 | InternalClaim 显式存 reason，直接比较 |
| 3 | director.ts:842 | handoff Map.set 同轴覆盖丢失前一个淡出的进度 | 覆盖前把旧 handoff 已衰减到的当前值作为新 from，保持连续性 |
| 4 | pipelines.ts:363 | gazeReturns 回归 120ms 魔数 | 提为 PipelineOptions 参数（默认 120） |

## 5. 创作体验

1. `track()` 支持 per-key curve：keys 接受 `[atMs, value] | [atMs, value, curve]`。
2. 新增 authoring helper `trackHeld(axis, keys)`：显式在作者侧补首尾 hold 书挡，
   消除 MO catalog 每条轨道手写 `[0,0]...[dur,0]` 的样板。编译器保持严格校验
   （静默扩展会掩盖 atMs 笔误，不采用）。
3. 错误信息统一中文（当前中英混杂：`"Repeat count must be a positive integer"` vs `"命名冲突"`）。
4. `MotionHandle.currentTime/duration` 秒 → ms，全库单位统一为 ms（消费方 grep 为准，
   初查仅测试引用）。破坏性变更，个人项目无兼容义务。

## 6. director.step() 分解

230 行 god method 拆为私有阶段方法：`advanceSlots` / `advancePlaybacks` / `arbitrate` /
`applyAdditives` / `applyAutonomic`，语义逐字节等价（现有测试为回归网）。放在性能改造
之后做，避免两次触碰同一段代码。

## 7. 批次规划（每批全门禁：biome → boundaries → tsc → pnpm test → crap --gate）

| 批 | 内容 | 性质 | 风险 |
|----|------|------|------|
| B1 | §4 全部四项正确性修复 | 纯修复，小 diff | 低 |
| B2 | §3 热路径性能（含编码器等价性测试） | 行为等价 | 低 |
| B3 | §2 轴域单源化 | 契约收紧（仅拒绝笔误轴） | 中 |
| B4 | §1.1 组合语言实现加固（逻辑抽取 + 混合表达式重构 + 性质测试） | 实现重构，语义等价 | 中 |
| B5 | §5 创作体验四项 | API 变更 | 低 |
| B6 | §6 step() 分解 | 结构等价 | 低 |
| B7 | 文档收口：docs/live2d-world-runtime.md 与引擎规格中组合语言、单位、轴域表述同步修订 | 文档 | — |

B4 与 B5 可并；其余顺序执行。沙箱约束照旧：vitest 仅 vmThreads；失败时 coverage
静默丢弃需注意 crap gate 读数；harness 级测试须本机终端执行。

## 8. 明确不做（防自加复杂度）

- 不泛化槽位系统；不引入通用插件式管道注册；不建可视化时间轴工具；
- 不为已删组合语言留过渡 shim 或 deprecation 警告；
- 不动 worker seam、external-actions 结构、目录快照机制；
- 不在本轮引入任何新能力（事件节拍通道等），待真实用例。

## 9. 需要用户裁决的决定

1. **MotionHandle 单位改 ms**（§5.4）——破坏性，B5 前须确认。
2. **轴域强校验**（§2）——MO rig 当前轴名均合规，但今后新模型 rig 受此约束，B3 前确认。

## 10. 未验证项

- `pose()` 在 tests/ 与内容侧的引用面（B5 执行期 grep 为准，作为 helper 属框架 API 面，默认保留）；
- MotionHandle 时间字段的全部消费方（初查仅测试，B5 执行时再核）；
- 轴域校验对 MO rig 全部轴名的逐枚举通过（B3 执行时以测试证明）。
