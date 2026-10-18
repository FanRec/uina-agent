# Live2D Action 作者合同

动画从分类到设备验收的完整工作流见 [动画开发最佳实践](ANIMATION-AUTHORING-GUIDE.md)。本文是 ActionAuthoring API 合同：作者入口位于 `authoring/index.ts`。动作是普通 TypeScript 工厂：Bake 时读取一次 RNG，生成纯函数身体通道与有序空间事件；播放时只读取冻结后的 `CompiledAction`。MO 当前动作、姿态、表情和背景内容均为空；没有迁移旧定义。

## 作者类型

    type LocalCurve = (localMs: number) => number;
    type ActionCurve = (actionMs: number) => number;
    type ActionAuthoring = (rng: () => number) => ActionPlan;

    interface ActionPlan {
      timeline: Timeline;
      channels: ActionChannels;
      spatial?: readonly SpatialEvent[];
      speed?: number;
    }

两种曲线在 TypeScript 中保持相同函数形状。形状 helper 返回 `LocalCurve`；`during` 和 `track` 将其放到 ActionPlan 的绝对动作时间轴。`ActionPlan.channels` 接受 `ActionCurve`，裸函数表示 `absolute(curve)`。

    const greet: ActionAuthoring = (rng) => {
      const time = timeline(900, { look: 120, head: 260, returnStart: 560 });
      const lookSpan = time.span("start", "look");
      const headSpan = time.span("look", "head");
      const returnSpan = time.span("returnStart", "end");
      const gain = 0.9 + rng() * 0.2;

      return {
        timeline: time,
        channels: {
          "gaze.x": offset(track([
            { span: lookSpan, curve: spring(lookSpan, { from: 0, to: -0.8 * gain, peak: 0.1, bounces: 1 }) },
            { span: returnSpan, curve: spring(returnSpan, { from: -0.8 * gain, to: 0, peak: 0, bounces: 1 }) },
          ], { before: 0, gap: "hold", after: 0 })),
          "head.yaw": offset(during(
            headSpan,
            poseWindow(headSpan, { from: 0, pose: 7 * gain, to: 0, enterMs: 70, exitMs: 90 }),
          )),
        },
      };
    };

`motion(durationMs, localChannels)` 是单段快捷方式；它把局部曲线铺满整个 ActionPlan 时间线。复杂动作使用 `timeline()`、`during()`、`track()` 直接表达错拍阶段。

## 时间线与通道组合

- `timeline(durationMs, markers)` 要求正有限总时长。`start=0`、`end=durationMs` 为保留 marker；`at(name)` 读取 marker，`span(from,to)` 生成正时长区间。marker 可同刻。
- `keys(points, curve?)` 返回 `LocalCurve`；插值类型为 `smooth`、`linear`、`hold`，点必须有限且时间严格递增，区间外夹紧到端点。
- `poseWindow(spanOrDuration, options)` 构造进场、停留、退场曲线；`spring()` 构造有阻尼回弹；`oscillate()` 构造有限周期振荡。三者都返回 `LocalCurve`，调用时夹紧到本地时长。
- `during(span, curve, {before, after})` 按 `span.startMs` 放置一条曲线。`during` 和 `track` 在创建时复制 span 坐标；之后修改调用方对象不会改变曲线或编译校验。省略首尾值时取曲线端点。
- `track(parts, {before, gap, after})` 接受按开始时间排序且互不重叠的 span；声明时长必须与起止时间差相符，gap 可为 `"hold"` 或有限常数，不自动交叉淡化。
- `absolute(curve, speech?)` 表示覆盖目标；`offset(curve)` 表示相对播放时基线的增量。每个 ActionPlan 每轴恰有一个通道。
- `torso` 声明躯干语义，只在动作写 `torso.*` 通道时相关：`"head-relative"` 表示通道值叠加在头部跟随合成值之上（作者必须自己减 head，`nod` 的 `torso.yaw: offset(... - head)` 就是这种写法）；`"absolute"` 表示数值即相对 rig 中性的目标角，director 不再叠加头部跟随，该轴由本动作独占。存在 `baseline-offset` 的 `torso.*` 通道却没有声明时 `compileAction` 直接失败：漏写 `- head` 的后果是双倍旋转，不会自己报错，所以把语义变成必填声明。
- `sumOffsets(...)` 是同轴增量显式求和入口；`mergeChannels(...)` 合并通道表并对重复轴报错。不要用对象展开静默覆盖通道。
- `speech: "exclusive"` 仅允许 `mouth.open`，播放时将该轴的语音 gain 置零；其它轴保持语音策略不变。`withSpeech()` 可为目录动作覆盖此策略。

## Bake 与随机性

`compileAction(authoring, rig.controls, rng?)` 只调用作者工厂一次，检查时间线、speed、轴声明、躯干语义声明、通道域、曲线有限值、helper span 与空间事件，并冻结编译产物。曲线以最多 512 点的采样网格探测；网格间的病态分支由运行期故障停车兜底。`sampleAction(compiled, actionMs, baseline)` 是纯函数，输入时间会夹紧到动作范围。

- 根 seed 缺省由 `node:crypto` 生成 uint32。Runtime 按稳定动作名、用途与零起始播放序号派生 `selection`、`performance` 随机流；自律运动使用独立 `autonomic` 流。
- 每次播放重新 Bake。变体选择和作者幅度采样使用不同流，一个作者改变 RNG 消耗次数不会改写其它动作或自律序列。
- Catalog 用固定 0 探测流做绑定期验证并丢弃编译结果。独立调用 `compileAction()` 若不传 RNG，使用固定 0.5 中点流；Runtime 和预览显式传入派生流。
- 作者曲线只在 Bake 时消费 RNG。采样函数不得读 `Date.now()`、调用裸 `Math.random()` 或依赖外部可变状态。

## 空间事件与时钟

空间效果 marker 写为 `{ at: time.at("marker"), effects }`；位姿事件写为 `{ during: time.span(...), transform, effects? }`。效果 payload 会复制并冻结。marker 必须早于动作结束；位姿 span 必须在时间线内、互不重叠，并且按 speed 缩放后不超过 VTS 单请求 2 秒上限。

Director 和 ExternalActions 消费同一个编译动作。资源声明与基线读取在共同 `t0` 前完成；之后身体采样和空间调度都读取 Director 的单调有效时钟。`speed` 只在采样时钟与空间 wall-time 换算中应用一次，动作本身的时间坐标不变。暂停或失焦冻结 Director 时钟。编译会拒绝换算后非有限或为零的 wall duration；不限制有限动作的最大时长。

空间事件按绝对 `atMs` 排序，同刻保留作者声明顺序。纯效果 marker 到时即可发送；含位姿 span 的事件先确认位姿窗口仍有至少 100ms，再发送效果并等待 ACK，ACK 后重查位姿窗口和模型位姿，然后才移动。ACK 耗用动作窗口，不会把后续时间重新归零；100ms 是未连接真实 VTS 的初始内部阈值。逐帧相对旋转每个请求不超过 90°，结束时最多补发 2° 的小尾差；更大的尾差按 `spatial_window_missed` 取消并清理。相对旋转只在事件边界和归位前读回位姿；不为每帧请求轮询 VTS。发现同模型位姿已被手动改变时，中止后续空间事件，不写回旧基线，位姿清理记为 `unknown`；仍可安全恢复本动作修改的效果。

正常播放中，空间计划跑完后仍等待整个 ActionPlan 的身体播放结束，再归位位姿和恢复效果。效果值保持到下一个对应效果事件或 ActionPlan 结束。动作取消、位姿失败或错过位姿窗口会立即清理；单次效果派发失败则记录为 `unknown`，继续身体播放和剩余计划，最终再结算。

## 预览

    pnpm mo:preview -- --list
    pnpm mo:preview -- --sample <动作名> <actionMs> [--seed <seed>]
    pnpm mo:preview -- --once <动作名> [--seed <seed>]
    pnpm mo:preview -- --repeat <次数> <动作名> [--seed <seed>]
    pnpm mo:preview -- [--seed <seed>] <动作名...>

`--sample` 不构造 VTS 客户端、不连接设备、不产生外部副作用。它报告编译计划、精确作者目标、按 rig 范围裁剪后的值，以及用生产 `MotionDirector` 在中性状态下计算的合成帧、贡献来源与 clamp。Director 合成按虚拟 60Hz 步进；动作终点使用最靠近终点且仍处于播放态的一帧，并单列精确终点作者值。点采样会按请求时间逐帧重放，耗时随时长线性增长；没有人为工作量上限，无法表示的时间换算会在编译时拒绝。

真实模式走 `Live2DRuntime.express` 同一路径。计划、作者/合成诊断、读取的模型基线、作者空间请求 dispatch/ACK/调度迟到和最终 settlement 只写预览进程输出，不改变模型可见工具结果。清理请求与 ACK 汇总在结构化 settlement 中；空间追踪不重复建立清理审计流。固定 seed 用于重现派生序列，不承诺真实设备的精确时序重放、暂停或 seek。当前 MO 已登记动作、变体、姿态、表情和背景短句；`--list` 返回当前目录。

机制回归使用合成作者与隔离假 VTS；它们不证明 MO 动作观感、VTS ACK 延迟分布或 100ms 阈值已在设备校准。

`tests/live2d-motion-quality.test.ts` 是观感的通用网：它对目录里每个动作（含变体、背景 idle/thinking、sway）按 60Hz 采样生产 `MotionDirector` 输出，检查越界、单帧跳变、非有限值、结束残留与"作者驱动的轴动得起来"，并与 `tests/fixtures/live2d-motion-profile.json` 的幅度/峰谷基线比对（±25%）。动作改了形状就用 `UINA_UPDATE_MOTION_PROFILE=1` 重建基线，并把差异当作一次观感审查。基线只锁形状，不替代真机看效果。


## 自然表演（2026-10-19）

MO 的持续 idle/thinking 使用 `background.phrases`。每项声明池内唯一 `id`、正权重、`motion` 工厂，可选 `join { durationMs, delays }`。目录冻结并验证内容；Runtime 每段重新 Bake，按角色保存最近两次选择及上一段绝对通道终点。`join` 从上一终点连接新目标，头部/躯干先后由模型数据声明，通用引擎不定义人类时序。短句允许保留非零终点，不能套用所有短句必须回中的测试。传统单工厂背景仍按有限片段重新 Bake；显式单动作预览和持续场景预览分别使用相应入口。

MO 待机有 quiet/look/weight/tilt/smile 五类，4～10 秒；quiet 原始权重占 40%，应用最近两类排除后重新归一化，因此不保证长期实际占比仍为 40%。这一限制避免同时承诺互相冲突的概率与历史排除。选择、作者变化、自律/讲话检测使用分离的派生随机流。

绝对前景通道逐轴接管；增量前景叠加在当前背景上，不能先去掉背景造成回正。显式槽位和 attention 优先于自动背景。骨骼延续已有弹簧的位置和速度，不重复在新会话中建立滤波器；新增日常变体采用关键姿态与停留，不额外内嵌骨骼回弹方程。头发/衣物仍由 VTS 模型物理计算，呼吸和眨眼按 rig 来源声明各保持一个主要来源。

`background.accent` 只允许头与躯干通道，不能带空间副作用。它由实际播放电平触发：有效语音超过 500ms，能量变化或每 1200ms 的稳定语音机会，每个合格候选以 35% 概率触发；候选消耗后等待至少 2500ms。语义、表情、装扮和大动作继续由播放 cue/显式工具决定。闭眼、非中性姿态、前景、thinking、选定 ambient 会抑制自动强调，失焦、暂停、reset、interrupt、断连和模型换代清除候选。

固定场景（默认 seed=42）：

```text
pnpm mo:preview -- --scenario idle --offline
pnpm mo:preview -- --scenario speech --offline
pnpm mo:preview -- --scenario mixed --offline
pnpm mo:preview -- --scenario idle
```

idle 为 5 分钟、speech 为 3 分钟、mixed 为 2 分钟。省略 `--offline` 连接真实 VTS；speech/mixed 始终是明确标记的模拟电平，无真实音频，不能代替实际 TTS 同步验收。mixed 穿插参数动作、闭眼/正常表情，并在动作开始后 700ms 执行 interrupt；当前目录无装扮条目时明确跳过，空间动作和真实 TTS 另行验收。离线传输不连接设备，动作回执保留 `unknown/input_unconfirmed`，不伪造物理 ACK。场景输出短句、强调、抑制原因、交还与 clamp，固定 seed 不承诺操作系统实时调度逐帧一致。

当前 MO rig 没有手臂逻辑轴，未新增模型源文件或手势绑定。完成真人 VTuber 质感验收仍需同构图连续录像与实际 TTS 播放；静帧和数值检查均不能代替。
