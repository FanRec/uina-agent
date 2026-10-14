import type { RigControlDef } from "../adapter/rig.js";
import {
	type ActionChannels,
	type ActionCurve,
	absolute,
	type Channel,
	during,
	getActionCurveSpans,
	isLocalCurve,
	type LocalChannels,
	type SpeechPolicy,
	timeline,
} from "./curves.js";
import { type CompiledSpatialEvent, compileSpatialEvents, type SpatialEvent } from "./spatial.js";

export type {
	ActionChannels,
	ActionCurve,
	Channel,
	LocalChannels,
	LocalCurve,
	SpeechPolicy,
	Timeline,
	TimeSpan,
} from "./curves.js";
export type { CompiledSpatialEvent, SpatialEffects, SpatialEvent, SpatialTransform } from "./spatial.js";

export interface ActionPlan {
	readonly timeline: import("./curves.js").Timeline;
	readonly channels: ActionChannels;
	readonly spatial?: readonly SpatialEvent[];
	readonly speed?: number;
}

export type ActionAuthoring = (rng: () => number) => ActionPlan;
export type ActionSample = Readonly<Record<string, number>>;

export interface CompiledChannel {
	readonly axis: string;
	readonly space: "absolute" | "baseline-offset";
	readonly curve: ActionCurve;
	readonly speech?: SpeechPolicy;
	readonly extents?: { readonly min: number; readonly max: number };
}

export interface CompiledAction {
	readonly durationMs: number;
	readonly speed: number;
	readonly controls: Readonly<Record<string, RigControlDef>>;
	readonly axes: readonly string[];
	readonly channels: readonly CompiledChannel[];
	readonly spatial: readonly CompiledSpatialEvent[];
}

const compiledActions = new WeakSet<object>();
const PROBE_STEP_MS = 16;
const PROBE_MAX_POINTS = 512;
const MIDPOINT_RNG = (): number => 0.5;

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function copyControls(metadata: Readonly<Record<string, RigControlDef>>): Readonly<Record<string, RigControlDef>> {
	requireRecord(metadata, "rig.controls");
	const copied: Record<string, RigControlDef> = Object.create(null);
	for (const [axis, control] of Object.entries(metadata)) {
		if (
			!control ||
			![control.min, control.max, control.neutral].every(Number.isFinite) ||
			control.min >= control.max ||
			control.neutral < control.min ||
			control.neutral > control.max
		)
			throw new Error(`Invalid control metadata: ${axis}`);
		copied[axis] = Object.freeze({ ...control });
	}
	return Object.freeze(copied);
}

function probeCurve(
	curve: ActionCurve,
	durationMs: number,
	label: string,
): { readonly min: number; readonly max: number } {
	const steps = Math.max(8, Math.min(PROBE_MAX_POINTS, Math.ceil(durationMs / PROBE_STEP_MS)));
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let index = 0; index <= steps; index++) {
		const actionMs = durationMs * (index / steps);
		let value: number;
		try {
			value = curve(actionMs);
		} catch (cause) {
			throw new Error(`${label}: 曲线在 t=${actionMs} 抛错: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		if (!Number.isFinite(value)) throw new Error(`${label}: 曲线在 t=${actionMs} 产生非有限值`);
		min = Math.min(min, value);
		max = Math.max(max, value);
	}
	return { min, max };
}

interface NormalizedChannel {
	readonly space: "absolute" | "baseline-offset";
	readonly curve: ActionCurve;
	readonly speech?: SpeechPolicy;
}

function normalizeChannel(axis: string, input: Channel<ActionCurve>): NormalizedChannel {
	const channel = typeof input === "function" ? { space: "absolute" as const, curve: input } : input;
	requireRecord(channel, `通道 ${axis}`);
	if (typeof channel.curve !== "function") throw new Error(`${axis}: 通道缺少曲线函数`);
	if (isLocalCurve(channel.curve))
		throw new Error(`${axis}: ActionPlan 通道需要 ActionCurve；请用 during/track 放置 LocalCurve`);
	if (channel.space !== "absolute" && channel.space !== "baseline-offset")
		throw new Error(`${axis}: 未知通道空间 ${String(channel.space)}`);
	if (channel.speech !== undefined && channel.speech !== "allow" && channel.speech !== "exclusive")
		throw new Error(`${axis}: 未知 speech 策略 ${String(channel.speech)}`);
	if (channel.speech !== undefined && axis !== "mouth.open")
		throw new Error(`${axis}: speech 策略仅 mouth.open 轴合法`);
	return channel as NormalizedChannel;
}

function isActionPlan(value: unknown): value is ActionPlan {
	if (!value || typeof value !== "object") return false;
	const plan = value as Partial<ActionPlan>;
	return Boolean(
		plan.timeline &&
			Number.isFinite(plan.timeline.durationMs) &&
			typeof plan.timeline.at === "function" &&
			typeof plan.timeline.span === "function" &&
			plan.channels &&
			typeof plan.channels === "object" &&
			!Array.isArray(plan.channels),
	);
}

/** Compile one authoring factory exactly once. Sampling consumes only frozen body channels and spatial events. */
export function compileAction(
	authoring: ActionAuthoring,
	metadata: Readonly<Record<string, RigControlDef>>,
	rng: () => number = MIDPOINT_RNG,
): CompiledAction {
	if (typeof authoring !== "function") throw new Error("ActionAuthoring 必须是函数");
	if (typeof rng !== "function") throw new Error("Bake 必须使用确定性 RNG");
	const controls = copyControls(metadata);
	const plan = authoring(rng);
	if (!isActionPlan(plan)) throw new Error("动作定义必须返回 ActionPlan 与 Timeline");
	const { durationMs } = plan.timeline;
	if (!Number.isFinite(durationMs) || durationMs <= 0)
		throw new Error(`ActionPlan 时长必须为正有限数: ${String(durationMs)}`);
	const speed = plan.speed ?? 1;
	if (!Number.isFinite(speed) || speed <= 0) throw new Error(`ActionPlan speed 必须为正有限数: ${String(speed)}`);
	const wallDurationMs = durationMs / speed;
	if (!Number.isFinite(wallDurationMs) || wallDurationMs <= 0)
		throw new Error(`ActionPlan wall duration 必须为正有限数: ${String(wallDurationMs)}`);
	const entries = Object.entries(plan.channels);
	if (entries.length === 0) throw new Error("ActionPlan 至少需要一个通道");
	const channels: CompiledChannel[] = [];
	for (const [axis, input] of entries) {
		if (!controls[axis]) throw new Error(`未知轴: ${axis}（rig.controls 未声明）`);
		const channel = normalizeChannel(axis, input);
		for (const span of getActionCurveSpans(channel.curve))
			if (span.startMs < 0 || span.endMs > durationMs) throw new Error(`${axis}: helper span 超出 ActionPlan 时间线`);
		const extents = probeCurve(channel.curve, durationMs, `通道 ${axis}`);
		channels.push(
			Object.freeze({
				axis,
				space: channel.space,
				curve: channel.curve,
				...(channel.speech === undefined ? {} : { speech: channel.speech }),
				...(channel.space === "baseline-offset" ? { extents: Object.freeze(extents) } : {}),
			}),
		);
	}
	const axes = Object.freeze(channels.map(({ axis }) => axis));
	const spatial = compileSpatialEvents(plan.spatial, durationMs, speed);
	const compiled: CompiledAction = Object.freeze({
		durationMs,
		speed,
		controls,
		axes,
		channels: Object.freeze(channels),
		spatial,
	});
	compiledActions.add(compiled);
	return compiled;
}

export function isCompiledAction(value: CompiledAction): boolean {
	return Boolean(value && typeof value === "object" && compiledActions.has(value));
}

export function sampleAction(
	compiled: CompiledAction,
	actionMs: number,
	baseline: Readonly<Record<string, number>> = {},
): ActionSample {
	if (!isCompiledAction(compiled)) throw new Error("Action must be compiled by compileAction");
	if (!Number.isFinite(actionMs)) throw new Error("sample time must be finite");
	const at = Math.max(0, Math.min(compiled.durationMs, actionMs));
	const values: Record<string, number> = {};
	for (const channel of compiled.channels) {
		const sampled = channel.curve(at);
		if (!Number.isFinite(sampled)) throw new Error(`${channel.axis}: 采样产生非有限值 (t=${at})`);
		const value =
			channel.space === "absolute"
				? sampled
				: (baseline[channel.axis] ?? compiled.controls[channel.axis]!.neutral) + sampled;
		if (!Number.isFinite(value)) throw new Error(`${channel.axis}: 合成采样产生非有限值 (t=${at})`);
		values[channel.axis] = value;
	}
	return values;
}

export function sampleSpeechGain(compiled: CompiledAction, actionMs: number): number {
	if (!isCompiledAction(compiled)) throw new Error("Action must be compiled by compileAction");
	if (!Number.isFinite(actionMs)) throw new Error("sample time must be finite");
	return compiled.channels.some((channel) => channel.axis === "mouth.open" && channel.speech === "exclusive") ? 0 : 1;
}

export function motion(
	durationMs: number,
	channels: LocalChannels | ((rng: () => number) => LocalChannels),
): ActionAuthoring {
	return (rng) => {
		const localChannels = typeof channels === "function" ? channels(rng) : channels;
		requireRecord(localChannels, "motion localChannels");
		const time = timeline(durationMs);
		const wholeAction = time.span("start", "end");
		const actionChannels: Record<string, Channel<ActionCurve>> = Object.create(null);
		for (const [axis, input] of Object.entries(localChannels)) {
			const normalized = typeof input === "function" ? { curve: input } : input;
			requireRecord(normalized, `motion ${axis} channel`);
			if (typeof normalized.curve !== "function") throw new Error(`${axis}: motion local 通道缺少曲线函数`);
			const placed = during(wholeAction, normalized.curve);
			actionChannels[axis] =
				typeof input === "function" ? placed : ({ ...normalized, curve: placed } as Channel<ActionCurve>);
		}
		return { timeline: time, channels: actionChannels };
	};
}

export function withSpeech(authoring: ActionAuthoring, policy: SpeechPolicy): ActionAuthoring {
	if (typeof authoring !== "function") throw new Error("withSpeech 需要 ActionAuthoring");
	if (policy !== "allow" && policy !== "exclusive") throw new Error(`Unknown speech policy: ${String(policy)}`);
	return (rng) => {
		const plan = authoring(rng);
		if (!isActionPlan(plan)) return plan;
		const channels: Record<string, Channel<ActionCurve>> = Object.create(null);
		for (const [axis, input] of Object.entries(plan.channels)) {
			if (axis !== "mouth.open") {
				channels[axis] = input;
				continue;
			}
			const channel = typeof input === "function" ? absolute(input) : input;
			channels[axis] = { ...channel, speech: policy };
		}
		return { ...plan, channels };
	};
}
