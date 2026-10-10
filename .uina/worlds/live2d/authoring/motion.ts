import type { RigControlDef } from "../adapter/rig.js";

/**
 * 运动定义语言与纯采样器（P2-1 基座，行为基准 = legacy motion.ts 移植）。
 *
 * 每个小语言节点既描述原子也描述整场表演；compileMotion 把树折叠为平铺轨道表，
 * sampleMotion 是无时钟的纯采样（A9：时钟由 director/companion 驱动）。
 *
 * 相对 legacy 的显式差异（其余字节级行为一致）：
 * 1. 元数据来自 rig.controls（RigControlDef），无全局 AXES 默认值；
 * 2. 剥离 channel / angular（全仓库零消费方）；
 * 3. 剥离 sampleLoop（零调用方；自律循环在 P2-2 按需引入）；
 * 4. speech 策略词汇对齐 §2.3："allow" | "exclusive"（legacy 为 "blend" | "exclusive"）。
 */

export type MotionCurve = "smooth" | "linear" | "hold" | readonly [number, number, number, number];
export type MotionSpace = "absolute" | "baseline-offset";
/** absolute 轨道 = Override 写入（构成抢占）；baseline-offset 轨道 = Additive 增量（永不抢占，A17.1）。 */
export type SpeechPolicy = "allow" | "exclusive";
export interface MotionKey {
	readonly atMs: number;
	readonly value: number;
	readonly curve?: MotionCurve;
}
export interface MotionTrack {
	readonly axis: string;
	readonly space?: MotionSpace;
	readonly keys: readonly MotionKey[];
	/** Blend a held pose from the preceding segment; explicit trajectories need no implicit ramp. */
	readonly blendMs?: number;
}
export type MotionDefinition =
	| { readonly kind: "clip"; readonly durationMs: number; readonly tracks: readonly MotionTrack[] }
	| { readonly kind: "sequence" | "parallel"; readonly motions: readonly MotionDefinition[] }
	| {
			readonly kind: "transform";
			readonly motion: MotionDefinition;
			readonly durationScale: number;
			readonly intensity: number;
	  }
	| { readonly kind: "delay"; readonly motion: MotionDefinition; readonly delayMs: number }
	| { readonly kind: "speech"; readonly motion: MotionDefinition; readonly policy: SpeechPolicy };

/** The same small language describes a primitive and a complete authored performance. */
export const motion = (durationMs: number, ...tracks: MotionTrack[]): MotionDefinition => ({
	kind: "clip",
	durationMs,
	tracks,
});
export const track = (
	axis: string,
	keys: readonly (readonly [number, number])[],
	space: MotionSpace = "absolute",
	curve: MotionCurve = "smooth",
): MotionTrack => ({ axis, space, keys: keys.map(([atMs, value]) => ({ atMs, value, curve })) });
export const sequence = (...motions: MotionDefinition[]): MotionDefinition => ({ kind: "sequence", motions });
export const parallel = (...motions: MotionDefinition[]): MotionDefinition => ({ kind: "parallel", motions });
export const transform = (
	definition: MotionDefinition,
	options: { durationScale?: number; intensity?: number },
): MotionDefinition => ({
	kind: "transform",
	motion: definition,
	durationScale: options.durationScale ?? 1,
	intensity: options.intensity ?? 1,
});
export const delay = (delayMs: number, definition: MotionDefinition): MotionDefinition => ({
	kind: "delay",
	delayMs,
	motion: definition,
});
/** Speech behavior travels with authored mouth tracks, including sequence timing and model projection. */
export function withSpeech(definition: MotionDefinition, policy: SpeechPolicy): MotionDefinition {
	return { kind: "speech", motion: definition, policy };
}
export const repeat = (count: number, definition: MotionDefinition): MotionDefinition => {
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("Repeat count must be a positive integer");
	return sequence(...Array.from({ length: count }, () => definition));
};
export function pose(durationMs: number, values: Readonly<Record<string, number>>, space: MotionSpace = "absolute"): MotionDefinition {
	return motion(
		durationMs,
		...Object.entries(values).map(([axis, value]) => ({
			...track(axis, [
				[0, value!],
				[durationMs, value!],
			], space),
			blendMs: Math.min(180, durationMs * 0.4),
		})),
	);
}
interface CompiledTrack {
	readonly axis: string;
	readonly space: MotionSpace;
	readonly startMs: number;
	readonly endMs: number;
	readonly holdUntilMs: number;
	readonly keys: readonly MotionKey[];
	readonly blendMs: number;
	readonly entryTracks?: readonly number[];
	readonly entryWeight?: number;
	readonly speech?: SpeechPolicy;
}
export interface CompiledMotion {
	readonly durationMs: number;
	readonly controls: Readonly<Record<string, RigControlDef>>;
	readonly axes: readonly string[];
	readonly tracks: readonly CompiledTrack[];
}
const compiledMotions = new WeakSet<object>();
export function isCompiledMotion(value: CompiledMotion): boolean {
	return compiledMotions.has(value);
}
const finite = (value: number, label: string) => {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
};
export function smooth(phase: number): number {
	const t = Math.max(0, Math.min(1, phase));
	return t * t * t * (10 + t * (-15 + 6 * t));
}
function validateCurve(curve: MotionCurve): void {
	if (typeof curve === "string") {
		if (!["smooth", "linear", "hold"].includes(curve)) throw new Error(`Unknown curve: ${curve}`);
		return;
	}
	if (!Array.isArray(curve) || curve.length !== 4 || curve.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
		throw new Error("Bezier control points must be four finite values in [0,1]");
}
function curveAt(curve: MotionCurve, t: number): number {
	if (curve === "smooth") return smooth(t);
	if (curve === "linear") return t;
	if (curve === "hold") return t >= 1 ? 1 : 0;
	const [x1, y1, x2, y2] = curve;
	const bezier = (p: number, a: number, b: number) => 3 * (1 - p) ** 2 * p * a + 3 * (1 - p) * p ** 2 * b + p ** 3;
	let lo = 0,
		hi = 1;
	for (let i = 0; i < 32; i++) {
		const mid = (lo + hi) / 2;
		if (bezier(mid, x1, x2) < t) lo = mid;
		else hi = mid;
	}
	return bezier((lo + hi) / 2, y1, y2);
}

/** Compiles without a body, lease, clock or connection. Invalid input never reaches playback. */
export function compileMotion(
	definition: MotionDefinition,
	metadata: Readonly<Record<string, RigControlDef>>,
): CompiledMotion {
	const controls: Readonly<Record<string, RigControlDef>> = Object.freeze(
		Object.fromEntries(
			Object.entries(metadata).map(([id, m]) => {
				if (![m.min, m.max, m.neutral].every(Number.isFinite) || m.min >= m.max || m.neutral < m.min || m.neutral > m.max)
					throw new Error(`Invalid control metadata: ${id}`);
				return [id, Object.freeze({ ...m })];
			}),
		),
	);
	const tracks: CompiledTrack[] = [];
	const visiting = new Set<MotionDefinition>();
	function compile(node: MotionDefinition, startMs: number, timeScale: number, strength: number, path: string): number {
		if (!node || visiting.has(node)) throw new Error(`${path}: missing or cyclic motion definition`);
		visiting.add(node);
		try {
			if (node.kind === "clip") {
				finite(node.durationMs, `${path}.durationMs`);
				if (node.durationMs <= 0 || !node.tracks?.length)
					throw new Error(`${path}: duration must be positive and tracks nonempty`);
				const duration = node.durationMs * timeScale;
				finite(duration, `${path}.scaledDuration`);
				if (duration <= 0) throw new Error(`${path}: scaled duration must be positive`);
				for (const [index, source] of node.tracks.entries()) {
					const label = `${path}.tracks[${index}]`;
					if (!Object.hasOwn(controls, source.axis)) throw new Error(`${label}: unknown axis ${source.axis}`);
					const space = source.space ?? "absolute";
					if (space !== "absolute" && space !== "baseline-offset") throw new Error(`${label}: unknown space ${space}`);
					if (!source.keys?.length) throw new Error(`${label}: keys must be nonempty`);
					let previous = -1;
					const keys = source.keys.map((key, keyIndex) => {
						finite(key.atMs, `${label}.keys[${keyIndex}].atMs`);
						finite(key.value, `${label}.keys[${keyIndex}].value`);
						if (key.atMs <= previous || key.atMs < 0 || key.atMs > node.durationMs)
							throw new Error(`${label}: key times must increase within the clip`);
						previous = key.atMs;
						const metadata = controls[source.axis]!;
						const neutral = space === "absolute" ? metadata.neutral : 0;
						const value = neutral + (key.value - neutral) * strength;
						finite(value, `${label}.scaledValue`);
						const min = space === "absolute" ? metadata.min : metadata.min - metadata.max;
						const max = space === "absolute" ? metadata.max : metadata.max - metadata.min;
						if (value < min || value > max) throw new Error(`${label}: value ${value} outside [${min},${max}]`);
						const curve = key.curve ?? "smooth";
						validateCurve(curve);
						return Object.freeze({
							atMs: key.atMs * timeScale,
							value,
							curve: typeof curve === "string" ? curve : (Object.freeze([...curve]) as MotionCurve),
						});
					});
					if (keys[0]!.atMs !== 0 || keys.at(-1)!.atMs !== duration)
						throw new Error(`${label}: keys must cover 0 through durationMs`);
					if (keys.some((key, i) => i > 0 && key.atMs <= keys[i - 1]!.atMs))
						throw new Error(`${label}: scaled key times must remain distinct`);
					const blendMs = (source.blendMs ?? 0) * timeScale;
					finite(blendMs, `${label}.blendMs`);
					if (blendMs < 0 || blendMs > duration) throw new Error(`${label}: blend must fit the clip`);
					if (!Number.isFinite(startMs + duration) || startMs + duration <= startMs)
						throw new Error(`${label}: segment times must remain finite and distinct`);
					tracks.push(
						Object.freeze({
							axis: source.axis,
							space,
							startMs,
							endMs: startMs + duration,
							holdUntilMs: startMs + duration,
							keys: Object.freeze(keys),
							blendMs,
						}),
					);
				}
				return duration;
			}
			if (node.kind === "sequence" || node.kind === "parallel") {
				if (!node.motions?.length) throw new Error(`${path}: empty composition`);
				let duration = 0;
				const children: { from: number; to: number }[] = [];
				const groupFrom = tracks.length;
				for (const [i, child] of node.motions.entries()) {
					const from = tracks.length;
					const childDuration = compile(
						child,
						startMs + (node.kind === "sequence" ? duration : 0),
						timeScale,
						strength,
						`${path}.${node.kind}[${i}]`,
					);
					children.push({ from, to: tracks.length });
					if (node.kind === "sequence" && from > groupFrom) {
						for (const axis of new Set(tracks.slice(from).map((t) => t.axis))) {
							const firstStart = Math.min(
								...tracks.slice(from).filter((t) => t.axis === axis).map((t) => t.startMs),
							);
							const first = tracks
								.slice(from)
								.map((t, i) => ({ t, i: i + from }))
								.filter(({ t }) => t.axis === axis && t.startMs === firstStart);
							const prior = tracks
								.slice(groupFrom, from)
								.map((t, i) => ({ t, i: i + groupFrom }))
								.filter(({ t }) => t.axis === axis);
							const last = Math.max(...prior.map(({ t }) => t.holdUntilMs));
							const entryTracks = prior.filter(({ t }) => t.holdUntilMs === last).map(({ i }) => i);
							// Hold this sequence branch through segments that do not author this axis.
							for (const i of entryTracks) tracks[i] = Object.freeze({ ...tracks[i]!, holdUntilMs: firstStart });
							if (entryTracks.length)
								for (const { t, i } of first)
									tracks[i] = Object.freeze({
										...t,
										entryTracks: Object.freeze(entryTracks),
										entryWeight: 1 / first.length,
									});
						}
					}
					duration = node.kind === "sequence" ? duration + childDuration : Math.max(duration, childDuration);
				}
				// Every branch explicitly holds each axis through trailing gaps.
				for (const child of node.kind === "parallel" ? children : [{ from: groupFrom, to: tracks.length }]) {
					const branch = tracks.slice(child.from, child.to);
					for (let i = child.from; i < child.to; i++) {
						const current = tracks[i]!;
						const lastEnd = Math.max(...branch.filter((t) => t.axis === current.axis).map((t) => t.holdUntilMs));
						if (current.holdUntilMs === lastEnd)
							tracks[i] = Object.freeze({ ...current, holdUntilMs: startMs + duration });
					}
				}
				return duration;
			}
			if (node.kind === "speech") {
				if (node.policy !== "allow" && node.policy !== "exclusive") throw new Error(`${path}: unknown speech policy`);
				const from = tracks.length;
				const duration = compile(node.motion, startMs, timeScale, strength, `${path}.speech`);
				for (let i = from; i < tracks.length; i++) {
					if (tracks[i]!.axis === "mouth.open") tracks[i] = Object.freeze({ ...tracks[i]!, speech: node.policy });
				}
				return duration;
			}
			if (node.kind === "transform") {
				finite(node.durationScale, `${path}.durationScale`);
				finite(node.intensity, `${path}.intensity`);
				if (node.durationScale <= 0 || node.intensity < 0)
					throw new Error(`${path}: invalid duration scale or intensity`);
				return compile(node.motion, startMs, timeScale * node.durationScale, strength * node.intensity, `${path}.transform`);
			}
			if (node.kind === "delay") {
				finite(node.delayMs, `${path}.delayMs`);
				if (node.delayMs < 0) throw new Error(`${path}: delay must be nonnegative`);
				return (
					node.delayMs * timeScale +
					compile(node.motion, startMs + node.delayMs * timeScale, timeScale, strength, `${path}.delay`)
				);
			}
			throw new Error(`${path}: unknown motion definition kind`);
		} finally {
			visiting.delete(node);
		}
	}
	const durationMs = compile(definition, 0, 1, 1, "motion");
	finite(durationMs, "motion.durationMs");
	for (let i = 0; i < tracks.length; i++)
		for (let j = i + 1; j < tracks.length; j++) {
			const a = tracks[i]!,
				b = tracks[j]!;
			if (
				a.axis === b.axis &&
				Math.max(a.startMs, b.startMs) < Math.min(a.holdUntilMs, b.holdUntilMs) &&
				(a.space === "absolute" || b.space === "absolute")
			)
				throw new Error(`Conflicting parallel targets on ${a.axis}; only explicit offsets may overlap`);
		}
	const axes = Object.freeze([...new Set(tracks.map((t) => t.axis))]);
	const result = Object.freeze({ durationMs, controls, axes, tracks: Object.freeze(tracks) });
	compiledMotions.add(result);
	return result;
}
function sampleTrack(track: CompiledTrack, atMs: number): number {
	const local = Math.max(0, Math.min(track.endMs - track.startMs, atMs - track.startMs));
	const keys = track.keys;
	for (let i = 1; i < keys.length; i++) {
		const right = keys[i]!,
			left = keys[i - 1]!;
		if (local <= right.atMs)
			return (
				left.value +
				(right.value - left.value) * curveAt(right.curve ?? "smooth", (local - left.atMs) / (right.atMs - left.atMs))
			);
	}
	return keys.at(-1)!.value;
}
function selectedTracks(compiled: CompiledMotion, axis: string, time: number): readonly CompiledTrack[] {
	const authored = compiled.tracks.filter((track) => track.axis === axis && track.startMs <= time);
	const active = authored.filter((track) => time < track.holdUntilMs);
	const latestEnd = Math.max(...authored.map((track) => track.holdUntilMs));
	return active.length ? active : authored.filter((track) => track.holdUntilMs === latestEnd);
}

export function sampleSpeechGain(compiled: CompiledMotion, atMs: number): number {
	if (!isCompiledMotion(compiled)) throw new Error("Motion must be compiled by compileMotion");
	finite(atMs, "speech sample time");
	const time = Math.max(0, Math.min(compiled.durationMs, atMs));
	const gains = selectedTracks(compiled, "mouth.open", time).map((track) => {
		const target = track.speech === "exclusive" ? 0 : 1;
		if (!track.blendMs || track.startMs === 0 || time >= track.startMs + track.blendMs) return target;
		const prior = (track.entryTracks ?? []).map((i) => compiled.tracks[i]!);
		const previous = prior.some((track) => track.speech === "exclusive") ? 0 : 1;
		return previous + (target - previous) * smooth((time - track.startMs) / track.blendMs);
	});
	return Math.min(1, ...gains);
}

/** Pure, seekable production sampler. Baseline binding belongs to a playback instance. */
export function sampleMotion(
	compiled: CompiledMotion,
	atMs: number,
	baseline: Readonly<Record<string, number>> = {},
): Record<string, number> {
	if (!isCompiledMotion(compiled)) throw new Error("Motion must be compiled by compileMotion");
	finite(atMs, "sample time");
	const time = Math.max(0, Math.min(compiled.durationMs, atMs));
	const values: Record<string, number> = {};
	for (const axis of compiled.axes) {
		const resting = baseline[axis] ?? compiled.controls[axis]!.neutral;
		const sampleAxis = (time: number): number => {
			const selected = selectedTracks(compiled, axis, time);
			const value = (t: CompiledTrack): number => {
				const target = sampleTrack(t, time);
				if (!t.blendMs || t.startMs === 0 || time >= t.startMs + t.blendMs) return target;
				const prior = (t.entryTracks ?? []).map((i) => compiled.tracks[i]!);
				const priorAbsolute = prior.find((p) => p.space === "absolute");
				const previous =
					((priorAbsolute ? sampleTrack(priorAbsolute, t.startMs) : resting) +
						prior.filter((p) => p.space === "baseline-offset").reduce((sum, p) => sum + sampleTrack(p, t.startMs), 0) -
						(t.space === "baseline-offset" ? resting : 0)) *
					(t.entryWeight ?? 1);
				return previous + (target - previous) * smooth((time - t.startMs) / t.blendMs);
			};
			const absolute = selected.find((t) => t.space === "absolute");
			return (
				(absolute ? value(absolute) : resting) +
				selected.filter((t) => t.space === "baseline-offset").reduce((sum, t) => sum + value(t), 0)
			);
		};
		values[axis] = sampleAxis(time);
	}
	return values;
}
