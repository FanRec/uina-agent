import type { TimeSpan } from "./curves.js";

export interface SpatialDelta {
	readonly x?: number;
	readonly y?: number;
	readonly rotation?: number;
	readonly size?: number;
}

export interface SpatialTransform {
	readonly delta?: SpatialDelta;
	readonly relativeRotation?: number;
}

export interface SpatialEffects {
	readonly tint?: { readonly r: number; readonly g: number; readonly b: number; readonly a?: number };
	readonly postProcessing?: {
		readonly on: boolean;
		readonly values?: readonly { readonly id: string; readonly value: number | string }[];
		readonly preset?: string;
		readonly fadeTime?: number;
	};
}

export type SpatialEvent =
	| { readonly at: number; readonly effects: SpatialEffects }
	| { readonly during: TimeSpan; readonly transform: SpatialTransform; readonly effects?: SpatialEffects };

export interface CompiledSpatialEvent {
	readonly atMs: number;
	readonly order: number;
	readonly span?: TimeSpan;
	readonly transform?: SpatialTransform;
	readonly effects?: SpatialEffects;
}

export const MAX_VTS_MOVE_MS = 2000;
const DELTA_LIMITS = { x: 1000, y: 1000, rotation: 360, size: 100 } as const;

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function validateSpan(span: TimeSpan, durationMs: number, label: string): TimeSpan {
	if (
		!span ||
		![span.startMs, span.endMs, span.durationMs].every(Number.isFinite) ||
		span.startMs < 0 ||
		span.endMs <= span.startMs ||
		span.durationMs <= 0
	)
		throw new Error(`${label} span 必须是有效正时长区间`);
	const expectedDurationMs = span.endMs - span.startMs;
	const precisionToleranceMs = Math.max(
		Number.MIN_VALUE,
		Number.EPSILON * Math.max(Math.abs(expectedDurationMs), Math.abs(span.durationMs)),
	);
	if (Math.abs(expectedDurationMs - span.durationMs) > precisionToleranceMs)
		throw new Error(`${label} span 必须是有效正时长区间`);
	if (span.endMs > durationMs) throw new Error(`${label} span 超出 ActionPlan 时间线`);
	return Object.freeze({ startMs: span.startMs, endMs: span.endMs, durationMs: span.durationMs });
}

function validateEffects(input: SpatialEffects, label: string): SpatialEffects {
	requireRecord(input, `${label} effects`);
	const effectNames = Object.keys(input);
	if (effectNames.length === 0) throw new Error(`${label} effect 不得为空`);
	if (effectNames.some((name) => name !== "tint" && name !== "postProcessing"))
		throw new Error(`${label} effect 包含未知字段`);
	const output: { tint?: SpatialEffects["tint"]; postProcessing?: SpatialEffects["postProcessing"] } = {};
	if (input.tint !== undefined) {
		requireRecord(input.tint, `${label} tint`);
		const { r, g, b, a } = input.tint;
		for (const [channel, value] of [
			["r", r],
			["g", g],
			["b", b],
			["a", a ?? 255],
		] as const)
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)
				throw new Error(`${label} 染色通道 ${channel} 必须是 0-255 整数: ${String(value)}`);
		output.tint = Object.freeze({
			r: r as number,
			g: g as number,
			b: b as number,
			...(a === undefined ? {} : { a: a as number }),
		});
	}
	if (input.postProcessing !== undefined) {
		requireRecord(input.postProcessing, `${label} postProcessing`);
		const { on, fadeTime, values, preset } = input.postProcessing;
		if (typeof on !== "boolean") throw new Error(`${label} 后处理 on 必须是布尔值`);
		if (fadeTime !== undefined && (!Number.isFinite(fadeTime) || (fadeTime as number) < 0 || (fadeTime as number) > 2))
			throw new Error(`${label} 后处理渐变时间必须在 0-2 秒`);
		if (values !== undefined && preset !== undefined) throw new Error(`${label} 后处理 values 与 preset 互斥`);
		let copiedValues: readonly { readonly id: string; readonly value: number | string }[] | undefined;
		if (values !== undefined) {
			if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} 后处理 values 必须是非空数组`);
			copiedValues = Object.freeze(
				values.map((item, index) => {
					requireRecord(item, `${label} 后处理 values[${index}]`);
					const valueItem = item as Record<string, unknown>;
					if (typeof valueItem.id !== "string" || valueItem.id.length === 0)
						throw new Error(`${label} 后处理 configID 不能为空`);
					if (
						typeof valueItem.value !== "string" &&
						(typeof valueItem.value !== "number" || !Number.isFinite(valueItem.value))
					)
						throw new Error(`${label} 后处理值必须是有限 number 或 string`);
					return Object.freeze({ id: valueItem.id, value: valueItem.value });
				}),
			);
		}
		if (preset !== undefined && (typeof preset !== "string" || preset.length === 0))
			throw new Error(`${label} 后处理 preset 不能为空`);
		output.postProcessing = Object.freeze({
			on,
			...(copiedValues === undefined ? {} : { values: copiedValues }),
			...(preset === undefined ? {} : { preset: preset as string }),
			...(fadeTime === undefined ? {} : { fadeTime: fadeTime as number }),
		});
	}
	return Object.freeze(output);
}

function validateTransform(input: SpatialTransform, label: string): SpatialTransform {
	requireRecord(input, `${label} transform`);
	const transform = input as SpatialTransform;
	const { delta, relativeRotation } = transform;
	if (delta !== undefined && relativeRotation !== undefined) throw new Error(`${label} relativeRotation 与 delta 互斥`);
	if (delta === undefined && relativeRotation === undefined)
		throw new Error(`${label} transform 必须声明 delta 或 relativeRotation`);
	if (relativeRotation !== undefined) {
		if (
			typeof relativeRotation !== "number" ||
			!Number.isFinite(relativeRotation) ||
			relativeRotation <= 0 ||
			relativeRotation > 359
		)
			throw new Error(`${label} relativeRotation 必须在 (0,359]`);
		return Object.freeze({ relativeRotation });
	}
	requireRecord(delta, `${label} delta`);
	const axes = Object.keys(delta);
	if (axes.length === 0) throw new Error(`${label} delta 至少需要一个轴`);
	const copied: Record<string, number> = Object.create(null);
	for (const [axis, value] of Object.entries(delta)) {
		if (!Object.hasOwn(DELTA_LIMITS, axis) || !Number.isFinite(value))
			throw new Error(`${label} 空间偏移非法: ${axis}`);
		const limit = DELTA_LIMITS[axis as keyof typeof DELTA_LIMITS];
		if (Math.abs(value as number) > limit) throw new Error(`${label} 空间偏移超出 VTS 值域: ${axis}=${String(value)}`);
		copied[axis] = value as number;
	}
	return Object.freeze({ delta: Object.freeze(copied) });
}

/** Bake and validate spatial events. Playback receives only absolute plan times and copied payloads. */
export function compileSpatialEvents(
	events: readonly SpatialEvent[] | undefined,
	durationMs: number,
	speed: number,
): readonly CompiledSpatialEvent[] {
	if (events === undefined) return Object.freeze([]);
	if (!Array.isArray(events)) throw new Error("ActionPlan spatial 必须是数组");
	const compiled: CompiledSpatialEvent[] = events.map((event, order) => {
		requireRecord(event, `spatial[${order}]`);
		if (Object.hasOwn(event, "at")) {
			if (Object.hasOwn(event, "during") || Object.hasOwn(event, "transform"))
				throw new Error(`spatial[${order}] marker 不能同时声明位姿 span/transform`);
			const atMs = event.at;
			if (!Number.isFinite(atMs) || (atMs as number) < 0 || (atMs as number) >= durationMs)
				throw new Error(`spatial[${order}] marker 必须早于动作结束并位于时间线范围内`);
			return Object.freeze({
				atMs: atMs as number,
				order,
				effects: validateEffects(event.effects as SpatialEffects, `spatial[${order}]`),
			});
		}
		if (!Object.hasOwn(event, "during") || !Object.hasOwn(event, "transform"))
			throw new Error(`spatial[${order}] 必须声明 at/effects 或 during/transform`);
		const span = validateSpan(event.during as TimeSpan, durationMs, `spatial[${order}]`);
		const wallDurationMs = span.durationMs / speed;
		if (!Number.isFinite(wallDurationMs) || wallDurationMs <= 0)
			throw new Error(`spatial[${order}] wall duration must be positive and finite`);
		if (wallDurationMs > MAX_VTS_MOVE_MS) throw new Error(`spatial[${order}] VTS 位姿请求超过 2 秒；请显式拆分 span`);
		return Object.freeze({
			atMs: span.startMs,
			order,
			span,
			transform: validateTransform(event.transform as SpatialTransform, `spatial[${order}]`),
			...(event.effects === undefined
				? {}
				: { effects: validateEffects(event.effects as SpatialEffects, `spatial[${order}]`) }),
		});
	});
	const transforms = compiled.filter(
		(event): event is CompiledSpatialEvent & { span: TimeSpan; transform: SpatialTransform } =>
			event.span !== undefined && event.transform !== undefined,
	);
	transforms.sort((a, b) => a.span.startMs - b.span.startMs || a.order - b.order);
	for (let index = 1; index < transforms.length; index++)
		if (transforms[index]!.span.startMs < transforms[index - 1]!.span.endMs)
			throw new Error("spatial 位姿 span 不得重叠");
	compiled.sort((a, b) => a.atMs - b.atMs || a.order - b.order);
	return Object.freeze(compiled);
}
