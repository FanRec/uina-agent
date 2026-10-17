# Live2D 曲线函数创作框架设计（Curve Authoring）

状态：核心作者机制已实施（批次 1-3）。2026-10-14 的 MO 动作内容重写正在当前工作区；`tests/live2d-mo-catalog.test.ts` 本轮 6 项通过，但不覆盖新曲线的节奏/画面自然度，也没有真实 VTS/MO 视觉验收。
日期：2026-10-14。
前置审读：`.uina/worlds/live2d/` 全量源码（2026-10-14），`docs/proposals/live2d-motion-authoring.md`、`docs/proposals/live2d/live2d-world-boundary-spec.md`。

---

## 0. 裁决

动作创作 primitive 从「keyframe 定义树」换成「时间的函数」。TS 原生表达力（函数、数学、闭包、bake 期随机）就是创作语言，不引入动画中间件、格式解析器或插件机制。本设计是**净删除**：树 kinds、key 校验、bezier 求解器、sequence hold/entryTracks 混合数学全部坍缩为一行式函数助手。

三条守门线（自由的边界，不可谈判）：

1. **采样合同不变**：`sampleMotion(compiled, atMs, baseline) → Record<axis, number>` 保持纯函数、可 seek、时钟外部注入（A9）。`durationMs` 与每轴 `{axis, space}` 声明保留显式——这是 director 仲裁合同（override/additive 派生、生命周期、atomic 抢占），不是表达力限制。
2. **随机性在 bake 时结清**：动作定义为工厂 `(rng) => MotionPlan`，rng 在每次播放 bake 时注入闭包。采样期随机（真过程化）破坏 seek/确定性/暂停恢复，其领地是 autonomic 发生器，不得混入 authored clip。
3. **函数必须纯**：闭包捕获的环境在 bake 后不可变；函数体内禁止 `Date.now()` / 裸 `Math.random()`（一切随机经注入 rng）。约定 + bake 探测守门，不加机制。

## 1. 动机（对照现状的根因）

现状 `authoring/motion.ts` 把「创作格式」和「运行时表示」混为一谈：`MotionDefinition` 树既是作者语言，又是 `CompiledMotion` 的内容。由此产生：

- 组合算子（sequence/parallel/transform/delay/repeat/pose）是 ~150 行零消费者投机复杂度（源码级核实：`models/mo/catalog.ts` 24 个动作全为平铺 clip）；其中 sequence hold 语义、`entryTracks/entryWeight`、并行冲突检测是全仓库最难审的代码。
- keys 全覆盖规则（首键 0 / 末键 duration）强制 `mo/catalog.ts` 一半篇幅是 `[0,0]`/`[duration,0]` 边界样板。
- 树结构挡住了 TS 原生组合：`sequence(a, b)` 本质是 `t => t < a.dur ? a(t) : b(t - a.dur)`，`parallel` 本质是加法。树是 TS 已原生提供能力的手工解释器。

真正的 seam 从来不是 keyframe 树，是采样合同。keyframe 只是它的一种实现。

## 2. 核心模型

```ts
// authoring/motion.ts（全量重写）
export type MotionSpace = "absolute" | "baseline-offset";   // 字符串值不变，director 判断零改动
export type SpeechPolicy = "allow" | "exclusive";
export type Curve = (t: number) => number;                  // 轴单位，定义域 [0, durationMs]

/** 每轴至多一个通道：absolute = Override 目标；baseline-offset = 相对基准的增量。 */
export interface Channel {
	readonly space: MotionSpace;
	readonly curve: Curve;
	readonly speech?: SpeechPolicy;   // 仅 mouth.open 轴合法，其余轴声明即编译拒绝
}
/** 裸函数简写 = absolute。 */
export type ChannelInput = Curve | Channel;
export type Channels = Readonly<Record<string, ChannelInput>>;

export interface MotionPlan {
	readonly durationMs: number;
	readonly channels: Channels;
}
/** 动作定义 = 工厂。bake 时注入 rng，随机量在工厂内结清进闭包。 */
export type MotionAuthoring = (rng: () => number) => MotionPlan;
```

每轴单通道是有意收紧：同轴多 offset 轨道的求和，作者直接写 `t => sway(t) + nod(t)`——这正是原生组合的价值所在；绝对+增量混合同轴也合并为一个 absolute 函数，数学等价。冲突规则从「区间重叠检测」退化为「Record 键天然唯一」，检测代码整段删除。

### 2.1 创作面（助手函数，最小集）

```ts
export const motion = (
	durationMs: number,
	channels: Channels | ((rng: () => number) => Channels),
): MotionAuthoring;
export const absolute = (curve: Curve, speech?: SpeechPolicy): Channel;
export const offset = (curve: Curve): Channel;
export const withSpeech = (authoring: MotionAuthoring, policy: SpeechPolicy): MotionAuthoring;
export const keys = (
	points: readonly (readonly [number, number])[],
	curve: "smooth" | "linear" | "hold" = "smooth",
): Curve;
export const smooth = (phase: number): number;   // 保留现有五次 smootherstep，手感不变
```

- `keys` 是测量/标定型曲线的创作形态保留（MO sway 那种实测关键帧天然是这个形状）：分段插值、域外 clamp、默认 smootherstep，~15 行实现。它**不是**格式解析器，只是一个产生曲线函数的普通助手。
- 新助手准入规则：rule of three——第三个手写重复出现时才提取。不预置 pulse/envelope/mix 之类。

### 2.1.1 链式编程：现在不加，约束先行登记

裁决：**不作为本批机制**。裸函数下链式是纯糖（`f.scale(2)` ≡ `(t) => 2 * f(t)`），而曲线是普通函数意味着链式包装**任何时候都能作为纯库增量加入，模型零改动**——推迟的代价为零，先加则违背 rule of three（当前全目录零次变换使用）。

未来若引入，必须遵守三条预登记约束（防止链式把模型污染回"第二表示"）：

1. **包装即函数**：链式入口是一个 callable wrapper（带方法的函数），自身满足 `Curve` 类型；每个方法返回新的包装函数，不 mutate。核心类型永远是 `(t) => number`，不出现 Curve 接口/类。
2. **值域可链，时域不链**：值域变换（scale/add/clamp/invert）域无关，可在曲线层安全链式；时域变换（shift/speed/delay）需要知道 duration 才能定义 clamp/wrap——duration 属于 motion 层的显式声明，**不得走私进曲线合同**。时域操作若未来需要助手，落在 motion/plan 层（那里 durationMs 已知），不在 curve 层。
3. **不建 builder**：链式只做既有数学的读法优化，不得长出状态机、求值延迟或"构建-执行"两阶段——那是刚拆掉的树语言借尸还魂。

触发条件：MO 内容重写批次（§6 批次 4）中同类变换第三次手写重复时，按上述约束以 ~20 行库代码落地。

创作示例：

```ts
const nod = motion(950, {
	"head.pitch": offset(t => -9.8 * Math.sin(Math.PI * Math.min(t / 950, 1)) ** 2),
});

const sway = motion(2600, (rng) => ({
	"torso.roll": offset(keys([[0, 0], [450, 3.6 + rng() * 0.8], [1200, 4.2], [2600, 0]])),
	"gaze.x": offset(t => 0.5 * Math.sin((t / 2600) * Math.PI)),
	"eyes.left.open": t => t < 1670 ? 1 : t < 1780 ? 1 - smooth((t - 1670) / 110) : ...,
}));
```

### 2.2 编译与采样

```ts
export interface CompiledChannel {
	readonly axis: string;
	readonly space: MotionSpace;
	readonly curve: Curve;
	readonly speech?: SpeechPolicy;
}
export interface CompiledMotion {
	readonly durationMs: number;
	readonly controls: Readonly<Record<string, RigControlDef>>;
	readonly axes: readonly string[];
	readonly channels: readonly CompiledChannel[];   // 每轴恰一条
}
export function compileMotion(
	authoring: MotionAuthoring,
	metadata: Readonly<Record<string, RigControlDef>>,
	rng?: () => number,
): CompiledMotion;
export function sampleMotion(
	compiled: CompiledMotion, atMs: number,
	baseline?: Readonly<Record<string, number>>,
): Record<string, number>;
export function sampleSpeechGain(compiled: CompiledMotion, atMs: number): number;
```

compileMotion 职责（比旧编译器少一个数量级）：

1. 调用工厂取得 plan；校验 durationMs 有限为正、channels 非空、轴在 rig.controls 中声明、space/speech 合法。
2. **域探测**：每条曲线在 [0, durationMs] 上以 ~16ms 步长（8~512 点封顶）+ 两端点采样，非有限值或曲线抛错即拒绝——bake 期失败，动作不进入播放。
3. 冻结产物（WeakSet 身份守卫保留，`isCompiledMotion` 不变）。

sampleMotion 语义（与旧实现逐点对齐，director 公式不感知变化）：

- absolute 通道：`curve(t)` 即 Override 目标。
- baseline-offset 通道：`(baseline[axis] ?? neutral) + curve(t)`——director 现行 `delta = sampled - baseline` 公式照旧得到曲线增量。
- 采样结果非有限 → 抛错（响亮失败，见 §5 风险）。

sampleSpeechGain 简化：对 mouth.open 通道取 `exclusive → 0 : 1` 的最小值；段间增益渐变原先服务于 keyframe 硬边界，函数化后由作者曲线本身负责连续性。

## 3. bake 时机：目录只存词表与定义，runtime 独占 bake

统一规则，一条不变式：**目录（catalog snapshot）不持有任何 CompiledMotion；runtime 是唯一 bake 点，每次播放重新编译。**

- `compileMotion` 成本已塌缩（无 key 展开，工厂调用 + 几次闭包构造 + 探测），per-play bake 开销可忽略。
- `pickMotionClip`：选变体 → `compileMotion(definition, controls, rng)`；`withSpeech` 覆写与普通路径统一（现行的 speech 覆写 per-play 重编译先例直接推广为唯一路径）。
- `syncBackgrounds`（idle/thinking/ambient）同样 per-play bake，不再有 bind 编译与 play 编译两条路。
- compileCatalog 保留的职责：词表全局唯一、槽位轴值范围、spatial/effects 校验（不变），外加对每条 authoring 用桩 rng 做一次**校验性探测后丢弃产物**——「非法定义不进运行时」的门保持在绑定期。

变体池裁决：**保留**，池成员改存 `MotionAuthoring`，轮换状态机（`pickVariantIndex` / WeakMap）不动。理由：MO sway 短语是手写的互异短语（「连播不重样」是短语级保证），随机 bake 无法替代；而函数内随机解决的是纹理级微变。两者正交，机制零新增。

## 4. 消费面影响矩阵（源码级核实）

| 文件 | 改动 | 性质 |
|---|---|---|
| `authoring/motion.ts` | 全量重写，407 → 约 140 行 | 核心 |
| `authoring/catalog.ts` | entry/ambient/background 定义改 `MotionAuthoring`；删除 bind 编译产物存储（`CatalogMotionEntry.motion`、`MotionVariant.motion`、`CompiledMotion` 字段全下线）；compileCatalog 改为校验性探测 | ~60 行 |
| `runtime.ts` | `pickMotionClip` / `pickAmbientPhrase` / `syncBackgrounds` 改 per-play bake；变体轮换状态机不变 | ~30 行 |
| `director/director.ts` | `clip.tracks` → `clip.channels` 派生 overrideAxes/additiveAxes（play + headroomScale 两处）；仲裁/管道/生命周期逻辑**零改动** | ~10 行机械 |
| `external-actions.ts` / `results.ts` | 只读 `durationMs/axes`，类型不变 | ≈0 |
| `models/mo/catalog.ts` | 机械转换：`motion(ms, ...tracks)` → `motion(ms, {...channels})`，`track(axis, pts, space)` → `absolute/off + keys`；边界样板消失后预计缩 40%+ | 编译耦合，必须随批 |
| `worker/*`、`endpoint.ts`、`adapter/*` | **零改动**（已核实：worker 只收 op 码，catalog 在 worker 进程内 import 构造，定义不跨 postMessage 序列化） | — |

关于 MO 转换的说明：框架设计不受迁移约束，但树删除与 MO 转换经编译耦合，须同一批次落地。`keys` 助手保证该转换近似逐行机械翻译，不改变任何数值与手感；画面级重写留待后续按新表达力自由进行。

## 5. 删除清单与风险

**删除**（约 270 行 + 对应测试）：`MotionDefinition` 全部树 kinds、`MotionTrack/MotionKey`、`validateCurve/curveAt`（含 bezier 二分求解）、sequence hold / entryTracks / entryWeight 混合数学（motion.ts:236-287, 389-404）、并行冲突区间检测、`pose/repeat/transform/delay/sequence/parallel/track`、`CompiledMotion` 的 bind 期存储链。

**风险与对策**：

| 风险 | 对策 | 接受度 |
|---|---|---|
| 静态校验弱化（key 值域/顺序检查消失） | bake 域探测 + 采样边界非有限抛错 + 帧级 clamp（已在） | 校验保护的本是作者笔误；函数式作者的第一道防线在自己的测试里 |
| 采样期 NaN（探测网格漏掉病态分支） | **故障停车（2026-10-14 审查裁决）**：composeTick 捕获 → fault 登记 + 时钟停止 + 口型中性单帧注入 + 播放结算 cancelled + 工具 `fault` 拒绝。原"线程死亡即 containment"方案被否——线程死亡连带摧毁在途 spatial 清理能力，违背"外部副作用未确认时不得推断成功"边界 | 失败 world 级可见，清理能力存活；恢复 = 重载 world |
| 函数不可序列化 | 已核实无序列化边界 | — |
| 循环背景曲线端点不连续 | 约定：loop 曲线自备首尾衔接（f(t)=f(t−duration)）；不加 loop 检测机制 | 作者职责，一处约定 |
| 助手蔓延 | rule of three 准入 | — |

**明确不做**：插件注册、沙箱、函数运行时、keyframe 解析器、采样期随机（clips）、采样期基线改写、为旧树格式保留兼容层。

## 6. 实施批次（每批全门禁：biome → boundaries → tsc → vitest → crap gate）

1. **核心换血**：重写 `authoring/motion.ts`（类型 + 助手 + compileMotion/probe + 采样 + 增益）；`catalog.ts`、`runtime.ts`、`director.ts`、`results.ts`、`external-actions.ts`、`models/mo/catalog.ts` 同批适配。原子换血，批次内 tsc 不绿不收。
2. **测试**：重写 motion 单测（曲线域、clamp、offset 求和、speech 增益、loop wrap、probe 拒绝：NaN 曲线/未知轴/speech 轴非法/时长非法）；director/pipelines 测试改用新助手构造 clip，**行为断言不变**——这是「语义逐点对齐」的验收证据。
3. **文档**：重写 `docs/proposals/live2d-motion-authoring.md` 与 `.uina/worlds/live2d/MOTION-AUTHORING.md`；边界规范 §8 布局注释一行校正。
4. **（后续，另案）**：按新表达力重写 MO 动作内容 + 真机画面验收。本设计不预设其形态。

## 7. 验收标准

- 全门禁绿；`motion.ts` 不含任何树 kinds 残留；目录快照不含 `CompiledMotion`。
- director/pipelines 现有行为断言在测试批次原样通过（仲裁、抢占、handoff、additive、autonomic 语义不变）。
- 同一 authoring 在固定 rng 下 bake 两次，`sampleMotion` 逐轴逐点相等（bake 确定性）。
- 探测拒绝用例：NaN 曲线、未知轴、mouth.open 之外的 speech 声明、非正时长——全部在 bake/bind 期失败，无运行时泄漏。
