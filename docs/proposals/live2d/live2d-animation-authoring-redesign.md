# Live2D 程序化动画作者层设计

> **状态：设计方向已批准，尚未实现。** 最新决定要求保留 Timeline，覆盖 v4.7 A2 的历史延后决定。当前代码仍使用函数曲线与 <code>MotionPlan</code>；命名 Timeline、<code>ActionPlan</code>、随机流隔离和共同起点调度都未实现。本文是分阶段实施目标，不是当前运行事实。真实 VTS/MO 视觉效果仍须单独验收。参见[审查台账](../../document-audit-register.md)和[当前运行合同](../../live2d/live2d-world-runtime.md)。

## 1. 目标与边界

优先改善最终动作表现，再降低编写和调参成本。作者应能用普通 TypeScript 表达多轴错拍、同轴组合、随机变化和空间效果；简单动作仍保留短写法。

采用纯函数曲线、命名时间点和少量可复用动作形状。ActionPlan 只在作者与编译阶段存在；编译后产出当前身体采样计划和按绝对动作时间排列的空间事件，播放期不解释动作树或图。

保留现有职责：

| 部分 | 职责 |
|---|---|
| Catalog / 作者代码 | 动作定义、变体、时间线、通道和模型专属标定 |
| Director | 身体动作与姿态、表情、注视、语音、自律运动的仲裁和合成 |
| external-actions | VTS 位移与效果、资源占用、取消、归位和结算 |
| Worker / World | 时钟、焦点、暂停、启动与退出生命周期 |

不改模型可见工具、Worker 消息、VTS adapter 或 Subject/Core。有限动作仍与持续状态分开；ambient 继续轮换有限片段，不新增无限循环播放器。

## 2. 作者接口

时间单位统一为毫秒，作者曲线分两种时间坐标：

~~~ts
type LocalCurve = (localMs: number) => number;
type ActionCurve = (actionMs: number) => number;

type Channel<C> =
  | C
  | { space: "absolute" | "baseline-offset"; curve: C; speech?: "allow" | "exclusive" };

type LocalChannels = Readonly<Record<string, Channel<LocalCurve>>>;
type ActionChannels = Readonly<Record<string, Channel<ActionCurve>>>;
type ActionAuthoring = (rng: () => number) => ActionPlan;

interface ActionPlan {
  timeline: Timeline;
  channels: ActionChannels;
  spatial?: readonly SpatialEvent[];
  speed?: number; // 默认 1
}

interface TimeSpan { startMs: number; endMs: number; durationMs: number }
interface Timeline {
  durationMs: number;
  at(name: string): number;
  span(from: string, to: string): TimeSpan;
}

declare function motion(
  durationMs: number,
  channels: LocalChannels | ((rng: () => number) => LocalChannels),
): ActionAuthoring;
~~~

<code>motion(durationMs, localChannels)</code> 是简单动作的快捷写法，返回 ActionAuthoring；Bake 时生成 ActionPlan。局部时间原点就是动作起点。

<code>LocalCurve</code> 从片段起点计时；<code>ActionCurve</code> 从动作起点计时。两者在 TypeScript 中仍是相同函数形状，别名只表达合同，不提供名义类型隔离。数学形状只产生 LocalCurve；<code>during</code> 和 <code>track</code> 负责把它放到 ActionCurve 时间轴上。ActionPlan 通道只接收 ActionCurve；直接传曲线等同于 <code>absolute(curve)</code>。

简单身体动作使用 <code>motion(durationMs, localChannels)</code>。复杂动作直接定义 ActionAuthoring 和命名时间点，例如：

~~~ts
const doubleTake: ActionAuthoring = (rng) => {
  const gain = 0.9 + rng() * 0.2;
  const t = timeline(1000, {
    eyeTarget: 90,
    headTarget: 230,
    holdEnd: 550,
    headHome: 720,
    torsoHome: 840,
    eyesHome: 950,
  });
  const eyeLead = t.span("start", "eyeTarget");
  const headFollow = t.span("eyeTarget", "headTarget");
  const headReturn = t.span("holdEnd", "headHome");
  const torsoFollow = t.span("headTarget", "torsoHome");
  const eyesReturn = t.span("headHome", "eyesHome");

  return {
    timeline: t,
    channels: {
      "gaze.x": offset(track([
        { span: eyeLead, curve: spring(eyeLead, { from: 0, to: -0.85 * gain, peak: 0, bounces: 1 }) },
        { span: eyesReturn, curve: spring(eyesReturn, { from: -0.85 * gain, to: 0, peak: 0.08 * gain, bounces: 1 }) },
      ], { before: 0, gap: "hold", after: 0 })),
      "head.yaw": offset(track([
        { span: headFollow, curve: spring(headFollow, { from: 0, to: 8 * gain, peak: 1.4 * gain, bounces: 1 }) },
        { span: headReturn, curve: spring(headReturn, { from: 8 * gain, to: 0, peak: -1.4 * gain, bounces: 1 }) },
      ], { before: 0, gap: "hold", after: 0 })),
      "torso.yaw": offset(during(
        torsoFollow,
        poseWindow(torsoFollow, { from: 0, pose: 3 * gain, to: 0, enterMs: 130, exitMs: 150 }),
        { before: 0, after: 0 },
      )),
    },
  };
};
~~~

动作专属组合（如 eye lead、head snap、torso follow）仍是返回通道的普通 TypeScript 函数，不是运行时节点。

### 时间线和区间

<code>timeline(durationMs, markers)</code> 要求总时长为正有限数，提供总时长、<code>at(name)</code> 和 <code>span(from, to)</code>。<code>start</code> 固定为 0，<code>end</code> 固定为总时长；二者不能作为自定义标记。自定义标记可同刻；Span 必须为正时长。所有时间点必须有限且位于动作范围内。

<code>TimeSpan</code> 只包含数值时间，不保存 Timeline 身份。编译时检查 Span 位于当前 ActionPlan 范围内且时长合法；不增加来源 ID。只有未来出现嵌套时间线的真实需求时，才重新考虑身份检查。

### 曲线和组合工具

| 工具 | 时间域与用途 |
|---|---|
| <code>keys(points)</code> | LocalCurve；局部毫秒上的精确标定，时间点严格递增，域外夹紧到端点。用于眨眼、眼神路线和明确落点。 |
| <code>poseWindow(spanOrDurationMs, options)</code> | LocalCurve；从 from 进入 pose、保持、再到 to。可传 TimeSpan，进出时长非负，之和不得超过总时长。 |
| <code>spring(spanOrDurationMs, options)</code> | LocalCurve；从 from 到 to，叠加有界回弹；传 TimeSpan 可与 Track 共用时长。 |
| <code>oscillate(spanOrDurationMs, options)</code> | LocalCurve；有限周期律动，可设幅度、周期、相位和淡入淡出。 |
| <code>during(span, curve, { before, after })</code> | 将一个 LocalCurve 放到动作区间，返回 ActionCurve。 |
| <code>track(parts, options)</code> | 将多个不重叠的局部片段拼成一个 ActionCurve。 |
| <code>absolute(curve)</code> / <code>offset(curve)</code> | 声明单轴通道是绝对目标，或相对基准的增量。 |
| <code>sumOffsets(...channels)</code> | 只合并相同时间域的 baseline-offset 通道。 |
| <code>mergeChannels(...parts)</code> | 合并通道映射；同一动作内重复声明同轴时报错。 |

当 helper 收到 <code>TimeSpan</code> 时，只读取 <code>durationMs</code>，忽略 <code>startMs</code>/<code>endMs</code>，返回的仍是从局部 0 开始采样的 LocalCurve。用于 <code>track</code> 时，把同一个 Span 同时传给 CurvePart 和 helper；这样作者只定义一次片段时长。传数字只用于独立曲线或简单 <code>motion()</code> 写法。<code>keys(points)</code> 没有总时长参数，关键点的 x 坐标本身就是局部时间。

<code>spring</code> 的首版候选是确定性闭式曲线，不逐帧积分物理状态。令 <code>u = clamp(localMs / durationMs, 0, 1)</code>，曲线为 <code>from + (to - from) * smooth(u) + peak * sin(πu) * sin((2 * bounces + 1)πu)</code>。<code>peak</code> 是带符号的轴单位幅度，<code>bounces</code> 为正整数，默认 2；该公式精确满足首尾位置和零速度，但只是平滑插值叠加周期扰动，不保证相对目标有清晰过冲，也不保证逐次回弹自然衰减。它不是物理弹簧模型，视觉表现尚未验证。

阶段 A 用 nod 和 shake 检验它能否快速到达目标、产生可读过冲、逐次衰减并自然停下。若不满足，替换 <code>spring</code> 内部数学并保留作者接口；不因此增加逐帧物理模拟器或改变 Timeline 架构。现有 <code>elastic(ms, peak, bounces)</code> 在该候选公式下可由 <code>spring(ms, { from: 0, to: 0, peak, bounces })</code> 表达；只有迁移并通过视觉对照后才删除旧入口，不保留别名。

<code>poseWindow</code> 在 0 时刻取 from，在 enterMs 内到达 pose，保持到 <code>durationMs - exitMs</code> 后开始退出，并在总时长结束时到达 to。<code>ease</code> 只取 <code>smooth</code> 或 <code>linear</code>；零时长进出表示瞬时跳变，smooth 在非零段端点速度为零，linear 不承诺速度连续。<code>oscillate</code> 的幅度使用轴单位，周期数为正有限数，phase 为有限弧度；淡入淡出时长非负，且两者之和不得超过总时长，使用 <code>smooth</code> 包络。淡入或淡出大于零时，振荡分量在对应端点的位置与速度归零；淡入淡出为零的一端不保证连续。所有参数及采样结果必须有限；<code>poseWindow</code>、<code>spring</code>、<code>oscillate</code> 的总时长必须为正。

<code>during</code> 默认在区间前取曲线起值、区间后取曲线终值；<code>track</code> 非空，默认在首段前取起值、间隙保持上一段终值、末段后取终值。作者可显式指定常数；offset 轨迹不活动时通常设为 0。片段区间必须位于动作范围内，按起点排序且不得重叠。

分段边界不自动交叉淡化：位置可能跳变，端值相同也不保证速度连续。预览报告位置跳变和有限差分速度变化，不自动改写曲线。每个轴在一个 ActionPlan 中最终只有一个通道：绝对目标用 <code>track</code>，同轴 baseline-offset 叠加用 <code>sumOffsets</code>，重叠绝对目标由作者写成一个函数。合并多张通道表统一使用 <code>mergeChannels</code>，避免对象展开静默覆盖；不同 ActionPlan 之间仍由 Director 合成，不在作者层增加优先级或权重系统。

## 3. 身体与空间计划

空间事件与身体通道引用同一 Timeline：

~~~ts
type SpatialEvent =
  | { at: number; effects: SpatialEffects }
  | { during: TimeSpan; transform: SpatialTransform; effects?: SpatialEffects };
~~~

Marker 的 <code>at</code> 使用 <code>Timeline.at()</code> 返回的动作毫秒；它用于定时效果。Span 表示位姿移动的计划窗口，可同时带效果。Span 上的效果在窗口起点触发，先派发效果，再开始位姿；效果 ACK 延迟会消耗该位姿窗口。编译结果保留事件的绝对动作时间，不能只保存依次排列的段长。事件按计划时间排序，同刻按作者声明顺序执行。

空间位姿只有一个写入者，移动 Span 不得重叠；VTS 允许后续请求打断正在执行的移动，因此计划不把请求替换当作组合手段。时间轴定义语义，执行事件不限定为一次 API 调用：普通位姿沿用 VTS 定时移动请求，相对旋转沿用现有逐帧驱动路径。定时移动请求的 <code>timeInSeconds</code> 须在 0–2 秒内，过长动作显式拆段。[VTube Studio API](https://github.com/DenchiSoft/VTubeStudio/blob/master/README.md?plain=1)

空间事件必须位于动作总时长内；效果 Marker 必须早于动作结束，移动 Span 必须合法且不能超出时间线。空间字段复用当前 <code>SpatialStuntDef</code> 的变换和效果定义，执行、资源占用与清理由 external-actions 继续拥有。

## 4. Bake、随机性与启动

一次播放按以下次序执行：

1. 选定动作和变体；按用途和动作实例派生确定性随机流。
2. 调用作者工厂一次，生成完整 ActionPlan；编译并验证曲线、通道、Timeline、空间范围和 VTS 限制。
3. 若有空间或效果事件，先取得现有资源 claim；持有期间读取模型基线并检查效果预设。失败则释放 claim，不启动身体动作或发送外部请求。
4. 预检通过后建立共同的本地 <code>t0</code>，从此刻启动 Director 和空间事件调度。
5. 完成、取消或失败时按现有所有权清理外部效果与位姿，最后释放 claim，并如实结算。

当前 <code>ExternalActions.runSpatial</code> 已先取得 claim，再读取位姿/效果基线和预检空间范围；设计复用这条资源边界，不新增事务框架。claim 只互斥 Uina 内部动作，不能锁住用户手动操作 VTS，因此仍须保留模型身份重核和清理守卫。

随机源以固定 seed 为根，分为三种用途：

- <code>selection</code>：选择动作变体。
- <code>performance</code>：为一次动作 Bake 力度、方向、相位等共享参数。
- <code>autonomic</code>：眨眼和自律微动等后台行为。

动作实例由稳定动作名和该动作播放序号标识。动作参数在 Bake 时一次采样，身体与空间共用；修改某动作的随机调用次数不改变其他动作或自律运动。暂不按轴拆 RNG。作者函数只使用注入的 RNG，不读取时间、调用 <code>Math.random()</code> 或依赖外部可变状态。类型不能保证纯度，以固定 seed 重复 Bake 的回归检查和代码审查约束。

Catalog 校验用固定探测 seed 编译后丢弃结果；实际播放重新 Bake，并按当前 Rig 和空间基线做动态校验。一次随机样本不能证明所有可能结果安全，也不缓存带随机结果的编译产物。

## 5. 时间、ACK 与取消合同

动作时间只有一个缩放点：

~~~text
elapsedMs = 当前有效单调时间 - t0
actionMs = elapsedMs * speed
value = authoredCurve(actionMs)
~~~

Director 按 <code>actionMs</code> 采样；<code>timeline.durationMs</code> 仍是作者时间，实际动作时长为 <code>durationMs / speed</code>。不得再把 <code>speed</code> 包进曲线。纯身体动作暂停时，有效时间不累计暂停区间。

<code>speed</code> 必须为有限正数。空间事件按同一 <code>t0</code> 排期：Marker 的计划时刻为 <code>t0 + atMs / speed</code>；正常移动时长为 <code>span.durationMs / speed</code>。t0 是本地计划起点，不是 VTS 的物理动画起点，不能承诺帧级同步。

ACK 不重置动作时间，也不代表位移完成。记录计划时刻、派发时刻、ACK 时刻、估计结束时刻和迟到量。迟到按以下固定规则结算，不增加策略枚举：

- 尚未到计划起点时等待；在位姿窗口内迟到且剩余时间不少于 <code>minUsefulMoveMs</code> 时，才按剩余时间执行，计划结束时刻为 <code>t0 + span.endMs / speed</code>。
- 位姿事件尚未派发且窗口已过期，或剩余时间小于 <code>minUsefulMoveMs</code> 时，不再尝试赶完位移；中止关联身体动作和剩余空间事件，执行归位清理，结果为 unknown，原因 <code>spatial_window_missed</code>。<code>minUsefulMoveMs</code> 是一个内部固定阈值，在真实 VTS 验收中确定，不暴露给动作作者，不提供可选跳过策略。
- 效果 Marker 没有持续窗口：动作仍有效时，依赖满足后立即派发并记录迟到；动作结束后不再派发，不能报告完整成功。
- 请求已经派发但 ACK 迟到时不重发。该请求的估计结束时间从派发时刻计算；不在 ACK 后再等完整段长。等 ACK 和当前段估计结束后，再检查下一必要事件的窗口；若已过期或剩余时间低于阈值，则按位姿窗口规则中止。

若效果 ACK 延迟了同段位姿，该位姿仍受自己的 Span 窗口约束。效果请求失败继续记录并执行后续动作，最终结算为 unknown。位姿请求失败、超时或取消时，不重发，也不发送依赖它的后续位姿；明确未派发记 failed/not_started，派发后未确认记 unknown，取消仍记 cancelled，并执行清理。模型/目录代次失效时沿用现有中止语义。

VTS 服务端接收与插值起点不可精确观测，剩余时长只能按本地单调时钟估计。新合同以派发、ACK 和估计结束三个时间事实为准，取代当前运行文档“ACK 后再完整等待段时长”的旧口径。

生命周期沿用当前行为：

- 失焦或 World 暂停时，Director 冻结；VTS 已接受的移动无法暂停，因此空间动作取消并归位，回焦或恢复时不续播旧有限动作。
- <code>safeStop</code> 取消有限播放和外部动作，等待清理结算；必要清理未确认时返回 <code>cleanup_unconfirmed</code>。
- <code>resume</code> 不重播被取消的有限动作，只恢复持续状态语义。

## 6. Director 与预览

Director 继续处理姿态、表情、注视、语音、自律运动和并行动作。作者曲线不是最终画面。模型专属幅度、方向、Neutral 和控制范围留在模型 Catalog/Rig；最终 clamp 是安全网，诊断须同时呈现作者目标、合成输出和 clamp 命中。编译网格探测不能证明任意时刻安全，采样异常沿用现有故障停车，不能静默跳帧或跳过外部清理。

预览区分三种结果：

1. **计划预览：** 固定动作名和 seed 可重现变体与 Bake 参数，并可按阶段或任意动作时间离线采样；不执行 VTS 副作用。
2. **合成预览：** 复用生产 Director。复现最终输出还需固定 Rig/范围、基线、姿态、表情、注视、语音、自律状态和并行动作时间；记录每轴作者目标、最终输出、贡献来源与 clamp。
3. **真实 VTS 观察：** 支持单次播放和固定 seed 重播，显示计划/派发/ACK/迟到/结算并记录模型基线。不能承诺真实设备精确重播、暂停或 Seek。

当前 <code>mo:preview</code> 的连续轮播可保留，并补单次播放、重复播放和离线取样。预览诊断只在开发入口采集，不改变生产工具结果协议。

## 7. 验收与落地顺序

代表动作先验证作者体验与画面：

| 动作 | 验收重点 |
|---|---|
| nod / shake | 快速到达目标；过冲清晰可读，回弹逐次衰减并自然停下；力度变化不掩盖动作重点 |
| double-take | 眼神先行并保持，头部跟随，躯干滞后，头部先回、视线再回；各通道使用不同 Span |
| joy-hop | 身体与空间共用时间线；空间偏移、ACK 迟到和取消清理可诊断 |
| sway | 周期、相位、阻尼和头身协调；有限片段继续由现有 ambient 轮换 |

测试覆盖时间域转换、Span 与 helper 共用时长、speed 只缩放一次、Timeline 边界、track 重叠/间隙/端点、同轴规则、随机隔离、共同 t0、严重迟到阈值、ACK 延迟、位姿失败、效果失败、失焦/safeStop 清理、模型切换和 clamp。测试验证合同；固定 seed 的真实 MO/VTS 对照才判断幅度、节奏和自然度。代表动作通过前不迁移整个目录。

按已批准的 Timeline 方向，分三阶段实施：

1. **作者层：** 实现时间线与曲线组合器；以 nod、shake、double-take 等代表动作验证接口、Span 时长复用、spring 形状、固定 seed Bake 和离线预览。
2. **播放合同：** 接入 ActionPlan、随机流隔离、共同 t0、原子 claim/preflight、空间迟到结算和 Director 诊断；同步运行合同。
3. **视觉验收：** 在真实 MO/VTS 调整代表动作并确定 <code>minUsefulMoveMs</code>；通过后再迁移其余动作，关键帧与函数曲线按内容选择并存。

主要改动限于 Live2D authoring/catalog、runtime、Director、external-actions、preview、相关测试和作者/运行合同文档。不改 Worker 消息、endpoint、工具 schema、Subject/Core 或 VTS 协议。

## 8. 不做与参考

不引入运行时动作树/图、GUI 时间轴、通用物理仿真器、动作 DSL、脚本沙箱、逐轴 RNG、真实 VTS 暂停/Seek、第二套 Director 混合器或仅为减少代码行数而增加的 helper。

参考成熟框架的表达方式，不引入其依赖或播放器：

- [GSAP Timeline](https://gsap.com/docs/v3/GSAP/Timeline/)：命名标记、片段对齐与整体 timeScale。
- [Motion sequences 与 spring](https://motion.dev/docs/animate)、[spring 文档](https://motion.dev/docs/spring)：时间段组合和按时间采样的动力曲线。
- [Three.js AnimationClip / AnimationMixer](https://threejs.org/docs/pages/AnimationClip.html)：属性曲线与混合职责分离；Uina 仍由现有 Director 合成。

相关设计：[已实施的纯函数曲线基础](live2d-curve-authoring-design.md)、[程序化动作表现规格](live2d-intuitive-animation-spec.md)、[修订稿](live2d-intuitive-animation-spec-amendments.md)、[当前运行合同](../../live2d/live2d-world-runtime.md)。
