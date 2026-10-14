import type { RigControlDef } from "../adapter/rig.js";

/**
 * 曲线函数创作模型（2026-10-14 重写，替代 keyframe 定义树）。
 *
 * 动作定义 = 工厂 `(rng) => MotionPlan`；每轴至多一个通道：
 * absolute（Override 目标）或 baseline-offset（相对基准的增量，永不抢占，A17.1）。
 * 曲线是普通函数 `(t) => number`，TS 原生表达力即创作语言——函数、数学、闭包、
 * bake 期随机；不引入中间件、格式解析器或插件机制。
 *
 * 随机性在 bake 时经注入 rng 结清进闭包；采样期无随机（A9：可 seek、可复现、
 * 暂停恢复不漂移）。过程化随机（呼吸/眨眼/微晃）属 autonomic 发生器的领地。
 *
 * 编译（bake）= 结构校验 + 曲线域探测 + 冻结；非法定义在进入播放前失败。
 * sampleMotion 是无时钟的纯采样：absolute 通道返回目标值，offset 通道返回
 * `(baseline[axis] ?? neutral) + curve(t)`——director 的 `delta = sampled - baseline`
 * 公式不感知变化。
 */

export type MotionSpace = "absolute" | "baseline-offset";
export type SpeechPolicy = "allow" | "exclusive";
export type Curve = (t: number) => number;

/** 每轴至多一个通道。同轴多增量求和、绝对+增量混同，都由作者直接写成单个函数。 */
export interface Channel {
	readonly space: MotionSpace;
	readonly curve: Curve;
	/** 仅 mouth.open 轴合法，其余轴声明即编译拒绝。 */
	readonly speech?: SpeechPolicy;
}
/** 裸函数简写 = absolute。 */
export type ChannelInput = Curve | Channel;
export type Channels = Readonly<Record<string, ChannelInput>>;

export interface MotionPlan {
	readonly durationMs: number;
	readonly channels: Channels;
}
/** 动作定义 = 工厂。bake 时注入 rng，随机量在工厂内结清进闭包；非随机动作忽略 rng。 */
export type MotionAuthoring = (rng: () => number) => MotionPlan;

export const motion = (durationMs: number, channels: Channels | ((rng: () => number) => Channels)): MotionAuthoring =>
	typeof channels === "function"
		? (rng) => ({ durationMs, channels: channels(rng) })
		: () => ({ durationMs, channels });

export const absolute = (curve: Curve, speech?: SpeechPolicy): Channel => ({ space: "absolute", curve, speech });
export const offset = (curve: Curve): Channel => ({ space: "baseline-offset", curve });

/** express 的 speech 覆写：对 plan 中 mouth.open 通道统一改写策略（无该通道则不生效）。 */
export function withSpeech(authoring: MotionAuthoring, policy: SpeechPolicy): MotionAuthoring {
	if (policy !== "allow" && policy !== "exclusive") throw new Error(`Unknown speech policy: ${policy}`);
	return (rng) => {
		const plan = authoring(rng);
		const channels: Record<string, ChannelInput> = {};
		for (const [axis, input] of Object.entries(plan.channels)) {
			if (axis !== "mouth.open") {
				channels[axis] = input;
				continue;
			}
			const channel: Channel = typeof input === "function" ? { space: "absolute", curve: input } : input;
			channels[axis] = { ...channel, speech: policy };
		}
		return { ...plan, channels };
	};
}

export function smooth(phase: number): number {
	const t = Math.max(0, Math.min(1, phase));
	return t * t * t * (10 + t * (-15 + 6 * t));
}

export type KeyCurve = "smooth" | "linear" | "hold";

/**
 * Q 弹振荡曲线生成器：冲出 peak 后衰减振荡、首尾无条件归零（窗函数 sin(πu) 保证，
 * 无 exp 拖尾不归零的陷阱）。bounces=1 即单次过冲（冲过头再回来）。
 *
 * 形状是对称的：主峰在动作中点，两端柔。需要"前偏单主峰"等不对称形状时用 keys 手绘
 * ——两种工具各司其职：elastic 管参数化的对称振荡，keys 管手绘的任意标定形状。
 */
export function elastic(ms: number, peak: number, bounces = 2): Curve {
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`elastic 时长必须为正有限数: ${String(ms)}`);
	if (!Number.isFinite(peak)) throw new Error(`elastic 峰值必须有限: ${String(peak)}`);
	if (!Number.isSafeInteger(bounces) || bounces < 1)
		throw new Error(`elastic 振荡次数必须是正整数: ${String(bounces)}`);
	const cycles = 2 * bounces + 1;
	return (t) => {
		const u = Math.max(0, Math.min(1, t / ms));
		if (u <= 0 || u >= 1) return 0;
		return peak * Math.sin(Math.PI * u) * Math.sin(cycles * Math.PI * u);
	};
}

/**
 * 测量/标定型关键帧的创作形态保留：分段插值曲线，域外强制端点值（Clamp，严禁外推），
 * 每段默认五次 smootherstep（与旧轨道默认曲线手感一致）。
 * 这是产生曲线函数的普通助手，不是格式解析器。
 */
export function keys(points: readonly (readonly [number, number])[], curve: KeyCurve = "smooth"): Curve {
	if (!Array.isArray(points) || points.length < 2) throw new Error("keys 需要至少两个关键点");
	const stablePoints: (readonly [number, number])[] = [];
	for (const [index, point] of points.entries()) {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
			throw new Error(`非法关键点: keys[${index}]`);
		if (index > 0 && point[0]! <= stablePoints[index - 1]![0]) throw new Error(`关键点 x 必须严格递增: keys[${index}]`);
		stablePoints.push([point[0]!, point[1]!]);
	}
	return (t) => {
		if (t <= stablePoints[0]![0]) return stablePoints[0]![1];
		const last = stablePoints.at(-1)!;
		if (t >= last[0]!) return last[1]!;
		for (let index = 1; index < stablePoints.length; index++) {
			const [x1, y1] = stablePoints[index - 1]!;
			const [x2, y2] = stablePoints[index]!;
			if (t <= x2) {
				const phase = (t - x1) / (x2 - x1);
				const weight = curve === "linear" ? phase : curve === "hold" ? 0 : smooth(phase);
				return y1 + (y2 - y1) * weight;
			}
		}
		return last[1]!;
	};
}

export interface CompiledChannel {
	readonly axis: string;
	readonly space: MotionSpace;
	readonly curve: Curve;
	readonly speech?: SpeechPolicy;
	/**
	 * 仅 baseline-offset 通道：bake 期值域探针（网格与校验探测一致，单次求值两用），
	 * 供 director 头部余量压缩在合成帧内直接取用——值域是编译产物的不变量，
	 * 严禁在逐帧路径上重新探测（60fps 下每帧 O(durationMs/16) 次曲线调用）。
	 */
	readonly extents?: { readonly min: number; readonly max: number };
}
export interface CompiledMotion {
	readonly durationMs: number;
	readonly controls: Readonly<Record<string, RigControlDef>>;
	readonly axes: readonly string[];
	/** 每轴恰一条，与 channels 的 Record 键一一对应。 */
	readonly channels: readonly CompiledChannel[];
}
const compiledMotions = new WeakSet<object>();
export function isCompiledMotion(value: CompiledMotion): boolean {
	return compiledMotions.has(value);
}

const PROBE_STEP_MS = 16;
const PROBE_MAX_POINTS = 512;

/** 域探测：曲线在 [0, durationMs] 网格上逐点求值，非有限值或抛错即拒绝。 */
function probeCurve(curve: Curve, durationMs: number, label: string): void {
	const steps = Math.max(8, Math.min(PROBE_MAX_POINTS, Math.ceil(durationMs / PROBE_STEP_MS)));
	for (let index = 0; index <= steps; index++) {
		const t = (durationMs * index) / steps;
		let value: number;
		try {
			value = curve(t);
		} catch (cause) {
			throw new Error(`${label}: 曲线在 t=${t} 抛错: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		if (!Number.isFinite(value)) throw new Error(`${label}: 曲线在 t=${t} 产生非有限值`);
	}
}

/**
 * offset 通道的校验+值域合并探测：[0, durationMs] 网格逐点求值，
 * 非有限值或抛错即拒绝；有限值同时聚合成 min/max（bake 一次，合成期零成本取用）。
 */
function probeExtents(curve: Curve, durationMs: number, label: string): { min: number; max: number } {
	const steps = Math.max(8, Math.min(PROBE_MAX_POINTS, Math.ceil(durationMs / PROBE_STEP_MS)));
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let index = 0; index <= steps; index++) {
		const t = (durationMs * index) / steps;
		let value: number;
		try {
			value = curve(t);
		} catch (cause) {
			throw new Error(`${label}: 曲线在 t=${t} 抛错: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		if (!Number.isFinite(value)) throw new Error(`${label}: 曲线在 t=${t} 产生非有限值`);
		if (value < min) min = value;
		if (value > max) max = value;
	}
	return { min, max };
}

function normalizeChannel(axis: string, input: ChannelInput): Channel {
	const channel: Channel = typeof input === "function" ? { space: "absolute", curve: input } : input;
	if (typeof channel.curve !== "function") throw new Error(`${axis}: 通道缺少曲线函数`);
	if (channel.space !== "absolute" && channel.space !== "baseline-offset")
		throw new Error(`${axis}: 未知空间 ${String(channel.space)}`);
	if (channel.speech !== undefined && channel.speech !== "allow" && channel.speech !== "exclusive")
		throw new Error(`${axis}: 未知 speech 策略 ${String(channel.speech)}`);
	if (channel.speech !== undefined && axis !== "mouth.open")
		throw new Error(`${axis}: speech 策略仅 mouth.open 轴合法`);
	return channel;
}

/** 编译（bake）动作定义：校验 + 域探测 + 冻结。非法定义在此失败，绝不进入播放。 */
export function compileMotion(
	authoring: MotionAuthoring,
	metadata: Readonly<Record<string, RigControlDef>>,
	rng: () => number = Math.random,
): CompiledMotion {
	const controls: Readonly<Record<string, RigControlDef>> = Object.freeze(
		Object.fromEntries(
			Object.entries(metadata).map(([id, m]) => {
				if (
					![m.min, m.max, m.neutral].every(Number.isFinite) ||
					m.min >= m.max ||
					m.neutral < m.min ||
					m.neutral > m.max
				)
					throw new Error(`Invalid control metadata: ${id}`);
				return [id, Object.freeze({ ...m })];
			}),
		),
	);
	const plan = authoring(rng);
	if (!plan || typeof plan !== "object") throw new Error("动作定义必须返回 MotionPlan");
	const { durationMs, channels } = plan;
	if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`动作时长必须为正有限数: ${String(durationMs)}`);
	if (!channels || typeof channels !== "object" || Object.keys(channels).length === 0)
		throw new Error("动作至少需要一个通道");
	const compiled: CompiledChannel[] = [];
	for (const [axis, input] of Object.entries(channels)) {
		const control = controls[axis];
		if (!control) throw new Error(`未知轴: ${axis}（rig.controls 未声明）`);
		const channel = normalizeChannel(axis, input);
		if (channel.space === "baseline-offset") {
			const extents = probeExtents(channel.curve, durationMs, `通道 ${axis}`);
			compiled.push(
				Object.freeze({ axis, space: channel.space, curve: channel.curve, speech: channel.speech, extents }),
			);
		} else {
			probeCurve(channel.curve, durationMs, `通道 ${axis}`);
			compiled.push(Object.freeze({ axis, space: channel.space, curve: channel.curve, speech: channel.speech }));
		}
	}
	const axes = Object.freeze(compiled.map((channel) => channel.axis));
	const result = Object.freeze({ durationMs, controls, axes, channels: Object.freeze(compiled) });
	compiledMotions.add(result);
	return result;
}

/** 纯、可 seek 的生产采样器。absolute = 目标值；offset = (baseline ?? neutral) + 增量。 */
export function sampleMotion(
	compiled: CompiledMotion,
	atMs: number,
	baseline: Readonly<Record<string, number>> = {},
): Record<string, number> {
	if (!isCompiledMotion(compiled)) throw new Error("Motion must be compiled by compileMotion");
	if (!Number.isFinite(atMs)) throw new Error("sample time must be finite");
	const t = Math.max(0, Math.min(compiled.durationMs, atMs));
	const values: Record<string, number> = {};
	for (const channel of compiled.channels) {
		const value = channel.curve(t);
		if (!Number.isFinite(value)) throw new Error(`${channel.axis}: 采样产生非有限值 (t=${t})`);
		values[channel.axis] =
			channel.space === "absolute"
				? value
				: (baseline[channel.axis] ?? compiled.controls[channel.axis]!.neutral) + value;
	}
	return values;
}

/** 口型通道的语音增益：任何 exclusive 的 mouth.open 通道压制为 0，否则 1。 */
export function sampleSpeechGain(compiled: CompiledMotion, atMs: number): number {
	if (!isCompiledMotion(compiled)) throw new Error("Motion must be compiled by compileMotion");
	if (!Number.isFinite(atMs)) throw new Error("sample time must be finite");
	for (const channel of compiled.channels)
		if (channel.axis === "mouth.open" && channel.speech === "exclusive") return 0;
	return 1;
}
