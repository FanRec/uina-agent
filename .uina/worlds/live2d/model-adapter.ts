import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AXES, AXIS_NAMES, NEUTRAL_AXES, type MotionAxis } from "./motion-axes.js";
import { type CompiledMotion, isCompiledMotion, projectMotionAxes } from "./motion.js";
import type { ModelMapping, ModelParameterRange, ModelProfile } from "./model-profile.js";
import { ALL_CHANNELS, type Live2DChannel } from "./types.js";
import type { VTSParamValue } from "./vts-client.js";

export interface AxisTarget {
	parameter: string;
	input?: string;
	/** Explicitly accepts effects on the other outputs of this input. */
	allowFanout?: boolean;
	direction?: 1 | -1;
	/** Logical value -> Cubism value. Must include the logical neutral point. */
	points?: readonly (readonly [number, number])[];
	/** Generated numerical calibration has not been visually authored. */
	provisional?: boolean;
}
export interface ModelAdapterDefinition {
	version: 1;
	modelID?: string;
	axes: Partial<Record<MotionAxis, readonly AxisTarget[]>>;
}
export interface AxisCapability {
	axis: MotionAxis;
	available: boolean;
	mode: "independent" | "coupled" | "unavailable";
	reasons: readonly string[];
	parameters: readonly string[];
	resources: readonly string[];
	/** Calibration is numerical; no visual verification is implied. */
	calibration: "authored" | "provisional";
}
interface Binding {
	axis: MotionAxis;
	mapping: ModelMapping;
	points: readonly (readonly [number, number])[];
}
export interface MotionAdmission {
	ok: boolean;
	motion: CompiledMotion;
	omittedAxes: readonly MotionAxis[];
	reasons: readonly string[];
}

// Naming conventions suggest a definition; only observed inputs/outputs grant control.
const STANDARD_CANDIDATES: Partial<Record<MotionAxis, readonly string[]>> = {
	"head.yaw": ["ParamAngleX"],
	"head.pitch": ["ParamAngleY"],
	"head.roll": ["ParamAngleZ"],
	"torso.yaw": ["ParamBodyAngleX"],
	"torso.pitch": ["ParamBodyAngleY"],
	"torso.roll": ["ParamBodyAngleZ"],
	"torso.breath": ["ParamBreath"],
	"gaze.x": ["ParamEyeBallX"],
	"gaze.y": ["ParamEyeBallY"],
	"eyes.left.open": ["ParamEyeLOpen"],
	"eyes.right.open": ["ParamEyeROpen"],
	"eyes.left.smile": ["ParamEyeLSmile"],
	"eyes.right.smile": ["ParamEyeRSmile"],
	"brows.left": ["ParamBrowLY"],
	"brows.right": ["ParamBrowRY"],
	"mouth.open": ["ParamMouthOpenY", "ParamMouthOpen"],
	"mouth.form": ["ParamMouthForm"],
	"face.blush": ["ParamCheek"],
};

export function suggestModelAdapter(profile: ModelProfile): ModelAdapterDefinition {
	const axes: ModelAdapterDefinition["axes"] = {};
	for (const axis of AXIS_NAMES) {
		const candidates = STANDARD_CANDIDATES[axis] ?? [];
		const parameter = candidates.find(
			(id) => profile.parameterRanges?.[id] || profile.mappings.some((m) => m.output === id),
		);
		if (parameter) axes[axis] = [{ parameter }];
	}
	return { version: 1, modelID: profile.modelID, axes };
}

export async function loadModelAdapterDefinition(profile: ModelProfile): Promise<ModelAdapterDefinition> {
	const file =
		process.env.UINA_LIVE2D_ADAPTER ??
		fileURLToPath(new URL(`./model-adapters/${encodeURIComponent(profile.modelID)}.json`, import.meta.url));
	try {
		const definition = JSON.parse(await readFile(file, "utf8"));
		// The compiler validates all fields before granting any capability.
		return definition;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.env.UINA_LIVE2D_ADAPTER) throw error;
		return suggestModelAdapter(profile);
	}
}

function linear(points: readonly (readonly [number, number])[], value: number): number {
	const bounded = Math.max(points[0]![0], Math.min(points.at(-1)![0], value));
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!,
			b = points[i]!;
		if (bounded <= b[0]) return a[1] + ((b[1] - a[1]) * (bounded - a[0])) / (b[0] - a[0]);
	}
	return points.at(-1)![1];
}
function invert(m: ModelMapping, value: number): number {
	return m.inputMin + ((value - m.outputMin) * (m.inputMax - m.inputMin)) / (m.outputMax - m.outputMin);
}

export function calibrationPoints(
	axis: MotionAxis,
	target: AxisTarget,
	range: ModelParameterRange,
): readonly (readonly [number, number])[] {
	const metadata = AXES[axis];
	if (target.points) {
		if (target.points.length < 2) throw new Error("校准至少需要两个点");
		const copy = target.points.map((p) => Object.freeze([...p]) as readonly [number, number]);
		const direction = Math.sign(copy.at(-1)![1] - copy[0]![1]);
		if (!direction || !copy.some((p) => p[0] === metadata.neutral)) throw new Error("校准必须单调并包含中性点");
		for (let i = 0; i < copy.length; i++) {
			const p = copy[i]!;
			if (
				p.length !== 2 ||
				!p.every(Number.isFinite) ||
				p[0] < metadata.min ||
				p[0] > metadata.max ||
				p[1] < range.min ||
				p[1] > range.max ||
				(i && (p[0] <= copy[i - 1]![0] || direction * (p[1] - copy[i - 1]![1]) <= 0))
			)
				throw new Error("非法校准点或方向");
		}
		return Object.freeze(copy);
	}
	const direction = target.direction ?? 1;
	const low = direction === 1 ? range.min : range.max;
	// Normal openness is the real default, not an exaggerated configured endpoint.
	let high = direction === 1 ? range.max : range.min;
	if (axis.endsWith(".open") && axis.startsWith("eyes.")) high = range.defaultValue;
	const neutralOutput = axis === "torso.breath" ? (range.min + range.max) / 2 : range.defaultValue;
	if (
		metadata.neutral > metadata.min &&
		metadata.neutral < metadata.max &&
		(neutralOutput === range.min || neutralOutput === range.max)
	)
		throw new Error("模型中性位于端点，需要显式校准支持范围");
	const points: [number, number][] = [[metadata.min, low]];
	if (metadata.neutral > metadata.min && metadata.neutral < metadata.max)
		points.push([metadata.neutral, neutralOutput]);
	points.push([metadata.max, high]);
	return Object.freeze(points.map((p) => Object.freeze(p)));
}

export class AdapterProgram {
	constructor(
		readonly capabilities: Readonly<Record<MotionAxis, AxisCapability>>,
		readonly controlGroups: readonly (readonly Live2DChannel[])[],
		private readonly bindings: readonly Binding[],
	) {
		Object.freeze(this);
	}

	encode(frame: Readonly<Record<string, number>>): {
		values: readonly VTSParamValue[];
		saturation: readonly MotionAxis[];
	} {
		const inputs = new Map<string, number>();
		const saturation = new Set<MotionAxis>();
		for (const b of this.bindings) {
			const value = frame[b.axis] ?? NEUTRAL_AXES[b.axis];
			if (!Number.isFinite(value)) throw new Error(`非有限动作帧: ${b.axis}`);
			const output = linear(b.points, value);
			if (value < b.points[0]![0] || value > b.points.at(-1)![0]) saturation.add(b.axis);
			const previous = inputs.get(b.mapping.input);
			const input = invert(b.mapping, output);
			if (!Number.isFinite(input)) throw new Error(`非法输入转换: ${b.axis}`);
			if (previous !== undefined && Math.abs(previous - input) > 1e-6)
				throw new Error(`模型输入目标冲突: ${b.mapping.input}`);
			inputs.set(b.mapping.input, input);
		}
		return { values: [...inputs].map(([id, value]) => ({ id, value, weight: 1 })), saturation: [...saturation] };
	}

	admit(motion: CompiledMotion): MotionAdmission {
		if (!isCompiledMotion(motion)) throw new Error("动作必须经过生产编译器");
		const omittedAxes: MotionAxis[] = [];
		const reasons: string[] = [];
		for (const axis of motion.axes) {
			const capability = this.capabilities[axis];
			const tracks = motion.tracks.filter((t) => t.axis === axis);
			const optional = tracks.every((t) => t.optional);
			let problem = !capability.available ? capability.reasons.join("；") : "";
			if (!problem)
				for (const b of this.bindings.filter((b) => b.axis === axis)) {
					const metadata = AXES[axis];
					// Offset tracks may bind to any legal baseline; verify the full reachable interval.
					const absolute = tracks.filter((t) => t.space === "absolute").flatMap((t) => t.keys.map((k) => k.value));
					const offsets = tracks.filter((t) => t.space === "baseline-offset");
					let min = absolute.length ? Math.min(...absolute) : metadata.neutral;
					let max = absolute.length ? Math.max(...absolute) : metadata.neutral;
					if (offsets.some((t) => t.keys.some((k) => k.value !== 0))) {
						min = metadata.min;
						max = metadata.max;
					}
					if (min < b.points[0]![0] || max > b.points.at(-1)![0]) problem = "动作超出校准范围";
				}
			if (problem) {
				if (optional) omittedAxes.push(axis);
				else reasons.push(`${axis}: ${problem}`);
			}
		}
		if (!motion.axes.some((a) => !omittedAxes.includes(a))) reasons.push("没有可执行的动作轴");
		return {
			ok: !reasons.length,
			motion: omittedAxes.length
				? projectMotionAxes(
						motion,
						motion.axes.filter((a) => !omittedAxes.includes(a)),
					)
				: motion,
			omittedAxes,
			reasons,
		};
	}
}

/** No parameter-name whitelist and no silent choice of a shared-input authority. */
export function compileModelAdapter(
	profile: ModelProfile,
	definition: ModelAdapterDefinition = profile.adapterDefinition ?? suggestModelAdapter(profile),
): AdapterProgram {
	if (definition?.version !== 1 || !definition.axes || (definition.modelID && definition.modelID !== profile.modelID))
		throw new Error("模型适配定义版本或身份不匹配");
	for (const key of Object.keys(definition.axes)) if (!Object.hasOwn(AXES, key)) throw new Error(`未知逻辑轴: ${key}`);
	const capabilities = {} as Record<MotionAxis, AxisCapability>;
	const bindings: Binding[] = [];
	const channelResources = new Map<string, Set<Live2DChannel>>();
	const outputAxes = new Map<string, MotionAxis[]>();
	for (const axis of AXIS_NAMES)
		for (const target of definition.axes[axis] ?? [])
			outputAxes.set(target.parameter, [...(outputAxes.get(target.parameter) ?? []), axis]);
	const inputAxes = new Map<string, Set<MotionAxis>>();
	for (const m of profile.mappings)
		for (const axis of outputAxes.get(m.output) ?? []) {
			const set = inputAxes.get(m.input) ?? new Set();
			set.add(axis);
			inputAxes.set(m.input, set);
		}
	for (const axis of AXIS_NAMES) {
		const targets = definition.axes[axis] ?? [];
		const reasons: string[] = [];
		const local: Binding[] = [];
		const resources = new Set<string>();
		let coupled = false;
		if (!targets.length) reasons.push("未定义模型语义");
		if (!Array.isArray(targets)) throw new Error(`${axis}: 目标必须为数组`);
		for (const target of targets) {
			if (
				!target ||
				typeof target.parameter !== "string" ||
				(target.direction !== undefined && ![1, -1].includes(target.direction))
			)
				throw new Error(`${axis}: 非法模型目标`);
			const range = profile.parameterRanges?.[target.parameter];
			const maps = profile.mappings.filter((m) => m.output === target.parameter);
			const selected = target.input ? maps.filter((m) => m.input === target.input) : maps;
			if (maps.length !== 1 || selected.length !== 1) {
				reasons.push(`${target.parameter}: ${maps.length ? "重复输出绑定或指定输入不匹配" : "未绑定"}`);
				continue;
			}
			const m = selected[0]!;
			if (
				!range ||
				![range.min, range.max, range.defaultValue].every(Number.isFinite) ||
				range.min >= range.max ||
				range.defaultValue < range.min ||
				range.defaultValue > range.max
			) {
				reasons.push(`${target.parameter}: 真实参数范围未核验`);
				continue;
			}
			if (m.useBreathing || m.useBlinking) {
				reasons.push(`${target.parameter}: VTS 内置来源拥有`);
				continue;
			}
			if (!m.input || !profile.inputs?.some((i) => i.name === m.input)) {
				reasons.push(`${target.parameter}: 输入不存在或未核验`);
				continue;
			}
			if (
				![m.inputMin, m.inputMax, m.outputMin, m.outputMax].every(Number.isFinite) ||
				m.inputMin === m.inputMax ||
				m.outputMin === m.outputMax
			) {
				reasons.push(`${target.parameter}: 非法或零宽绑定`);
				continue;
			}
			if (profile.physicsOutputs.includes(target.parameter)) {
				reasons.push(`${target.parameter}: 物理输出拥有`);
				continue;
			}
			if (profile.sources?.some((s) => s.kind === "motion" && s.parameters.includes(target.parameter))) {
				reasons.push(`${target.parameter}: 未协调模型动画来源`);
				continue;
			}
			if (
				profile.sources?.some(
					(s) =>
						s.kind === "expression" &&
						(profile.activeExpressions === undefined || profile.activeExpressions.includes(s.file)) &&
						s.parameters.includes(target.parameter),
				)
			) {
				reasons.push(`${target.parameter}: 活动表情拥有`);
				continue;
			}
			const fanout = profile.mappings.filter(
				(other) => other.input === m.input && !other.useBreathing && !other.useBlinking,
			);
			if (fanout.some((other) => !targets.some((t) => t.parameter === other.output))) {
				coupled = true;
				if (!target.allowFanout) {
					reasons.push(`${target.parameter}: 共用 ${m.input}，需要解除绑定或明确接受耦合`);
					continue;
				}
			}
			if (
				(outputAxes.get(target.parameter)?.length ?? 0) > 1 ||
				((inputAxes.get(m.input)?.size ?? 0) > 1 && target.allowFanout)
			) {
				reasons.push(`${target.parameter}: 多轴共用目标，不能同时独立控制`);
				continue;
			}
			let points: readonly (readonly [number, number])[];
			try {
				points = calibrationPoints(axis, target, range);
			} catch (e) {
				reasons.push(`${target.parameter}: ${e instanceof Error ? e.message : e}`);
				continue;
			}
			const mappedMin = Math.min(m.outputMin, m.outputMax),
				mappedMax = Math.max(m.outputMin, m.outputMax);
			// Hard-clamped mappings cannot reach outside their configured endpoints.
			if (points.some((p) => p[1] < mappedMin || p[1] > mappedMax)) {
				reasons.push(`${target.parameter}: 校准超出保存绑定，需调整范围`);
				continue;
			}
			resources.add(`input:${m.input}`);
			if (points.some((p) => Math.abs(invert(m, p[1])) > 1_000_000)) {
				reasons.push(`${target.parameter}: 输入超出 VTS 协议范围`);
				continue;
			}
			resources.add(`output:${target.parameter}`);
			for (const resource of resources) {
				const channels = channelResources.get(resource) ?? new Set();
				channels.add(AXES[axis].channel);
				for (const other of fanout) {
					const affected =
						outputAxes.get(other.output) ?? AXIS_NAMES.filter((a) => STANDARD_CANDIDATES[a]?.includes(other.output));
					// Unknown fanout was explicitly accepted, but its independence is unproved.
					if (!affected.length && target.allowFanout) for (const ch of ALL_CHANNELS) channels.add(ch);
					for (const a of affected) channels.add(AXES[a].channel);
				}
				channelResources.set(resource, channels);
			}
			local.push({ axis, mapping: Object.freeze({ ...m }), points });
		}
		const available = targets.length > 0 && reasons.length === 0;
		if (available) bindings.push(...local);
		capabilities[axis] = Object.freeze({
			axis,
			available,
			mode: available ? (coupled ? "coupled" : "independent") : "unavailable",
			reasons: Object.freeze(reasons),
			parameters: Object.freeze(targets.map((t) => t.parameter)),
			resources: Object.freeze([...resources]),
			calibration: targets.length && targets.every((t) => t.points && !t.provisional) ? "authored" : "provisional",
		});
	}
	return new AdapterProgram(
		Object.freeze(capabilities),
		Object.freeze([...channelResources.values()].filter((s) => s.size > 1).map((s) => Object.freeze([...s]))),
		Object.freeze(bindings.map((b) => Object.freeze(b))),
	);
}
