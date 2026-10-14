# Live2D 动作创作说明（曲线函数模型）

状态：已实施（2026-10-14 重写，替代 keyframe 定义树）。设计依据与裁决记录见
`docs/proposals/live2d-curve-authoring-design.md`；旧目录的数值与命名参考见
`models/mo/catalog-bak.ts.txt`。

## 核心心智模型

**动作 = 时间的函数。** 一条曲线就是一个普通的 TypeScript 函数 `(t) => number`，
`t` 是动作内的毫秒（定义域 `[0, durationMs]`，域外自动夹紧到端点时刻的值）。
数学、缓动、闭包、随机——全部 TS 原生写法，没有中间件、没有格式解析器、没有插件机制。相关轴可以共享同一组 bake 参数，再用相位差表达头身跟随与动作层次。

一条动作声明两件事：

1. **合同（显式声明，不可省略）**：`durationMs` 与每个轴的通道 `{axis, space, curve}`。
   - `absolute`（可省略包装 = 裸函数）：Override 目标值，构成抢占轴；
   - `baseline-offset`：相对当前基准的增量，永不抢占（Additive，A17.1）。
2. **表达（完全自由）**：曲线函数体。随机量只能来自 bake 时注入的 `rng`（闭包结清），
   函数体内禁止 `Date.now()` / 裸 `Math.random()` / 任何外部可变状态——
   这是可 seek、可复现、暂停恢复不漂移的代价，也是唯一的纪律。

## 创作面 API（authoring/motion.ts）

| 助手 | 签名 | 用途 |
| --- | --- | --- |
| `motion` | `(durationMs, channels \| ((rng) => Channels)) => MotionAuthoring` | 定义一条动作；channels 为 `Record<axis, curve \| channel>` |
| `absolute` | `(curve, speech?) => Channel` | Override 通道；`speech` 仅 `mouth.open` 轴合法 |
| `offset` | `(curve) => Channel` | baseline-offset 增量通道 |
| `withSpeech` | `(authoring, policy) => MotionAuthoring` | express 的 speech 覆写（mouth.open 通道策略改写） |
| `keys` | `(points, curve? = "smooth") => Curve` | 测量/标定型关键帧 → 分段插值曲线（域外 clamp，不外推） |
| `elastic` | `(ms, peak, bounces? = 2) => Curve` | Q 弹振荡：冲出 peak 后对称衰减回零（首尾无条件归零）。中点幅度恰为 peak，符号随 bounces 奇偶；需要前偏单主峰等不对称形状时用 keys 手绘 |
| `smooth` | `(phase) => number` | 五次 smootherstep（0..1 → 0..1），与旧默认曲线手感一致 |

新助手准入：rule of three——第三个手写重复出现时才提取。

## 语义要点

- **每轴至多一个通道**。同轴多增量求和、绝对+增量混同，直接写成单个函数：
  `offset(t => sway(t) + breath(t))`。冲突检测因此不存在——Record 键天然唯一。
- **采样合同**：`sampleMotion(compiled, atMs, baseline)` 纯函数。absolute 通道返回目标值；
  offset 通道返回 `(baseline[axis] ?? neutral) + curve(t)`。director 的增量公式不感知变化。
- **bake（编译）**：`compileMotion(authoring, controls, rng?)` = 结构校验 + 曲线域探测
  （[0, durationMs] 上 ~16ms 网格逐点求值）+ 冻结。非法定义（NaN、未知轴、speech 轴非法、
  非正时长）在此失败，绝不进入播放。**目录不持有编译产物，runtime 是唯一 bake 点，
  每次播放重新编译**——随机纹理因此每次播放重新结清。
- **循环**：`loop: true` 的背景曲线（idle/thinking/ambient）作者自备首尾衔接
  （f(durationMs) = f(0)），不加检测机制。
- **语音**：`mouth.open` 通道的 `speech: "exclusive"` 压制 TTS 口型包络（gain=0）；
  段间平滑由作者曲线本身负责。
- **采样期 NaN = 故障停车**：bake 探测网格（16ms，≤512 点）可能漏掉网格间隙内的病态分支；
  运行期采样异常在 composeTick 捕获——fault 登记、时钟停止、口型中性单帧注入、播放结算
  cancelled、工具以 `fault` 拒绝（恢复 = 重载 world）。**不**静默跳帧：失败必须可见；
  也**不**让异常杀死 worker——线程死亡会连带摧毁在途 spatial 清理能力。
  dev 阶段的动作测试负责在故障停车之前拦截病态曲线。

## 示例

```ts
import { absolute, elastic, keys, motion, offset, smooth } from "./authoring/motion.js";

// 数学直写：Q 弹点头（head.pitch 为增量空间，相对当前姿态）
const nod = motion(950, {
	"head.pitch": offset((t) => -9.8 * Math.sin((Math.PI * Math.min(t / 950, 1)) ** 2)),
});

// 程序化头身摆动：共享强度和相位，头部延迟躯干；眨眼仍按明确表演节奏标定
const sway = motion(2600, (rng) => {
	const strength = 0.94 + rng() * 0.12;
	const phase = (rng() - 0.5) * 0.14;
	const travel = (t: number, lag: number) => {
		const u = Math.max(0, Math.min(1, t / 2600));
		const window = smooth(u / 0.08) * (1 - smooth((u - 0.78) / 0.22));
		return window * Math.sin(2 * Math.PI * 1.15 * u + phase + lag) * Math.exp(-0.45 * u);
	};
	return {
		"torso.roll": offset((t) => 4.2 * strength * travel(t, 0)),
		"head.roll": offset((t) => -2.1 * strength * travel(t, 0.8)),
		"gaze.x": absolute((t) => 0.5 * travel(t, 1.8)),
		"eyes.left.open": keys([
			[0, 1],
			[1670, 1],
			[1780, 0.08],
			[1900, 0.08],
			[2020, 1],
			[2600, 1],
		]),
	};
});

// elastic 生成器：弹跳/回弹可直接用参数描述
const hop = motion(1100, { "head.pitch": offset(elastic(640, 9.8, 1)) });

// 语义变体（手写互异短语，轮换池）仍是目录层的 variants 字段，与函数内随机正交
```

## 与目录的关系

目录（`authoring/catalog.ts`）只负责三件事：**词表**（六类命名字空间 + 别名，全局唯一）、
**绑定期校验**（校验性 bake 后丢弃产物 + spatial/effects 轴值校验）、**变体池**
（池成员是 `MotionAuthoring`，轮换状态机不变）。变体解决"手写互异短语"；
函数内随机解决"纹理级微变"——两者正交。

## 明确不做

插件注册、沙箱、函数运行时、keyframe 解析器、采样期随机（clips）、采样期 NaN 兜底、
旧树格式兼容层。链式编程：不预置；未来若引入须遵守设计文档 §2.1.1 三约束
（包装即函数 / 值域可链时域不链 / 不建 builder）。
