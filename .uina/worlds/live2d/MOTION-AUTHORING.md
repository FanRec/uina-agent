# 动作创作

完整操作流程、模型接入与排查见 [Live2D 动画与模型适配手册](./README.md)。本文是动作语言的简短参考。

动作内容集中在 `motion-library.ts`，语言与编译器在 `motion.ts`，逻辑轴在 `motion-axes.ts`。新增命名动作只需修改目录，cue 声明、工具枚举和播放入口随目录生成。播放器无需识别新名称。

## 从组合开始

复用头部、视线和表情定义即可快速编排：

```ts
import { FACE_MOTIONS, GAZE_MOTIONS, HEAD_MOTIONS } from "./motion-library.js";
import { parallel, repeat, sequence } from "./motion.js";

const greeting = sequence(
  parallel(repeat(2, HEAD_MOTIONS.nod), FACE_MOTIONS.tender_smile, GAZE_MOTIONS.user),
  parallel(HEAD_MOTIONS.tilt_left, FACE_MOTIONS.winking),
);
```

将定义与描述加入 `MOTION_LIBRARY` 后，可用 `<cue id="greeting"/>`，也可调用 express 的 `{ motion: "greeting", atomic: true }`。即时编排仍支持 `head/gaze/face` 或 `beats`，均编译成同一种动作。

## 自己写轨迹

```ts
import {
  compileMotion, delay, motion, parallel, pose, repeat, sequence, track,
  transform, type MotionCurve,
} from "./motion.js";

const soft: MotionCurve = [0.25, 0.1, 0.75, 0.9];
const nod = motion(800,
  track("head.pitch", [[0, 0], [300, -8], [800, 0]], "baseline-offset", soft),
);
const performance = sequence(
  parallel(
    repeat(2, nod),
    delay(150, pose(1000, { "mouth.form": 0.5, "eyes.left.smile": 0.3 })),
  ),
  transform(pose(600, { "head.roll": 6 }, "baseline-offset"), { intensity: 0.6 }),
);
const compiled = compileMotion(performance);
// 底层播放可用 director.play；产品 cue/express 须先经过 runtime 的模型准入。
```

`motion(ms, ...tracks)` 是任意多轴关键帧片段。时间使用毫秒，关键帧必须严格递增、完整覆盖 0 到片段时长。`track` 的曲线用于每个右端关键帧的入段；需要逐段不同曲线时直接提供 `{ axis, space, keys: [{ atMs, value, curve }, ...] }`。

`pose(ms, values, space)` 是带自动入场过渡的保持目标。`sequence` 顺序排列，`parallel` 同时开始并以最长分支为总时长，较短分支保持终值。`delay` 延后整个定义，`repeat` 展开有限次重复。`transform` 按 `durationScale` 缩放时间、按 `intensity` 缩放幅度，支持嵌套。

曲线可用 `smooth`（五次缓入缓出）、`linear`、`hold` 或四个 0..1 的三次 Bezier 控制点。曲线对象、片段和整个组合都可直接复用；编译结果冻结且与创作源对象分离。

## 数值与衔接

头部、躯干角度使用度；视线、眉毛、嘴形使用 -1..1，眼睑与其余面部轴使用 0..1。眼睑 1 是正常睁眼、0 是闭眼。具体范围见 `AXES`。

`absolute` 写轴的绝对目标；`baseline-offset` 写相对于本次播放启动基准的增量。绝对强度围绕轴中性值缩放，例如闭眼强度 0.2 得到开放度 0.8。偏移强度围绕零缩放。

不同轴可直接并行。同轴并行仅允许明确的偏移相加；重叠绝对目标编译失败。偏移相加或叠加基准可能越界，动力学按轴范围裁剪；作者应在多个基准姿态上采样检查饱和。姿态过渡从所在顺序分支的前值进入，并行分支排列不改变结果。没有写某个轴的中间或末尾片段会保持该分支的前值；从未写过的轴采用基准。明确关键帧轨迹按作者指定的首值衔接，作者负责使拼接端点连续。

编译器校验轴名、有限数值、范围、时间、曲线、循环引用和组合冲突，并推导最小通道集合；非法动作在申请通道前失败。`sampleMotion(compiled, atMs, baseline)` 是生产播放器使用的纯采样器，可任意跳转检查目标。`sampleLoop` 仅用于从零开始的独立周期轨道；延时与多段表演使用普通采样器。

## 原子与完成

片段是可组合的创作单元；所有播放启动时都必须获得全部请求通道。完整组合在播放时可以声明 `atomic: true`：任一通道被抢占就取消整场。产品层命名表演默认原子，即兴片段默认按通道让位，可显式覆盖；底层 `director.play` 使用调用方的资源选择，不通过动作名字判断。外部租约须在申请时声明 atomic，非原子租约不能在播放时升级。原子取消不撤销已经呈现的画面。

播放器绑定启动基准，统一执行入场、退出、取消和留存。最新旧动作在交接期间继续采样，与新动作交叉混合；更早的交接合并为残余贡献。`latch: true` 保留最终目标；默认收势到当前运行的底层合成结果后释放通道。渲染时钟推进时间线，墙钟等待不会使未渲染的动作自行完成。目标采样可确定地跳转，动力学在不同步长下允许小量数值差异。

## 姿态、反射与说话

`BASE_POSES` 保存完整基准目标；`compilePoseTransition` 用当前呈现基准绑定新轨道，再由普通采样器播放。`POSE_TIMING`/`POSE_ENTRY_TIMING` 规定分部位进入时序：一般先视线与表情，再头部，最后躯干；自信与兴奋姿态身体较早展开。时长决定目标时间轴终点，身体动力学仍有收敛延迟。中途改向从当前基准轨迹值重新绑定，不先回中性。

`STATE_MOTIONS.thinking.entry` 是反射入场，终值持续保持；清除状态用声明的退出时长释放。状态事件不申请租约、不因遮挡丢失；动作覆盖时反射仍推进，动作退出自然显现当前状态。一次性的注意、重音反应在遮挡下会过期，不在释放后补演过时反应。失焦遮住反射，但保存用户姿态选择。

普通表情允许说话。需要保护嘴部表演时：

```ts
import { compileMotion, pose, sequence, withSpeech } from "./motion.js";

const performance = compileMotion(sequence(
  withSpeech(pose(900, { "mouth.open": 0.6 }), "exclusive"),
  pose(700, { "mouth.open": 0, "mouth.form": 0.3 }),
));
```

`withSpeech` 策略绑定到 `mouth.open` 轨道，顺序保持和下一步姿态缓入同时作用于嘴型权重；移除可选轴时不会移植到其他轴。`sampleSpeechGain` 可离线检查权重。整体播放 `speech` 可覆盖编排策略。默认开放度为 `authored + (1-authored) * audio * speechGain`，进入动力学后再做模型适配。临时物理独占冻结嘴部，语音不能从输出旁路抢写。

完整设计、取舍、验收边界见 [COMPOSITION.md](./COMPOSITION.md)。

当前目录覆盖原有 18 个命名表演的全部内容，加上 celebrate 共 19 个动作。改名与表现见 [迁移对照](./README.md#原程序动作迁移对照)。单/双眨眼也在动作库声明并由生产采样器播放；触发时机与通道准入属于运行机制。

模型绑定与物理最终决定能否独立显示每个轴；当前动作语言没有手部或肩部轴。shrug 用轻抬下巴、微后仰表达无奈，thinking_deep 没有托腮，sparkle 没有发光特效。整模型翻转仍由 `model-motion.ts` 通过 VTS 确认与归位执行。编译通过、时间线完成或设备接受请求均不能证明视觉自然度。
