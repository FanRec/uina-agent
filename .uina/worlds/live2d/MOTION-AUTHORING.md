# Live2D Action 作者合同

动作作者入口位于 `authoring/index.ts`。动作是普通 TypeScript 工厂：Bake 时读取一次 RNG，生成纯函数身体通道与有序空间事件；播放时只读取冻结后的 `CompiledAction`。本轮没有迁移旧 MO 动作、ambient 或 idle/thinking 曲线，MO 当前动作目录为空。

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
- `sumOffsets(...)` 是同轴增量显式求和入口；`mergeChannels(...)` 合并通道表并对重复轴报错。不要用对象展开静默覆盖通道。
- `speech: "exclusive"` 仅允许 `mouth.open`，播放时将该轴的语音 gain 置零；其它轴保持语音策略不变。`withSpeech()` 可为目录动作覆盖此策略。

## Bake 与随机性

`compileAction(authoring, rig.controls, rng?)` 只调用作者工厂一次，检查时间线、speed、轴声明、通道域、曲线有限值、helper span 与空间事件，并冻结编译产物。曲线以最多 512 点的采样网格探测；网格间的病态分支由运行期故障停车兜底。`sampleAction(compiled, actionMs, baseline)` 是纯函数，输入时间会夹紧到动作范围。

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

真实模式走 `Live2DRuntime.express` 同一路径。计划、作者/合成诊断、读取的模型基线、作者空间请求 dispatch/ACK/调度迟到和最终 settlement 只写预览进程输出，不改变模型可见工具结果。清理请求与 ACK 汇总在结构化 settlement 中；空间追踪不重复建立清理审计流。固定 seed 用于重现派生序列，不承诺真实设备的精确时序重放、暂停或 seek。当前 MO 动作目录为空；`--list` 会如实显示空数组，动作名无效时提示“当前模型没有可用动作”。

机制回归使用合成作者与隔离假 VTS；它们不证明 MO 动作观感、VTS ACK 延迟分布或 100ms 阈值已在设备校准。
