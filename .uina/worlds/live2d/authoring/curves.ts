export type LocalCurve = (localMs: number) => number;
export type ActionCurve = (actionMs: number) => number;
type AnyCurve = (timeMs: number) => number;

export type SpeechPolicy = "allow" | "exclusive";
export interface AbsoluteChannel<C extends AnyCurve> {
	readonly space: "absolute";
	readonly curve: C;
	readonly speech?: SpeechPolicy;
}
export interface OffsetChannel<C extends AnyCurve> {
	readonly space: "baseline-offset";
	readonly curve: C;
	readonly speech?: SpeechPolicy;
}
export type Channel<C extends AnyCurve> = C | AbsoluteChannel<C> | OffsetChannel<C>;
export type LocalChannels = Readonly<Record<string, Channel<LocalCurve>>>;
export type ActionChannels = Readonly<Record<string, Channel<ActionCurve>>>;

type CurveDomain = "local" | "action";
const curveDomains = new WeakMap<Function, CurveDomain>();
const actionCurveSpans = new WeakMap<Function, readonly TimeSpan[]>();

function withDomain<C extends AnyCurve>(curve: C, domain: CurveDomain): C {
	curveDomains.set(curve, domain);
	return curve;
}

function assertLocalCurve(curve: unknown, label: string): asserts curve is LocalCurve {
	if (typeof curve !== "function") throw new Error(`${label} 必须是曲线函数`);
	if (curveDomains.get(curve) === "action") throw new Error(`${label} 需要 LocalCurve，收到 ActionCurve`);
}

/** Internal compiler guard; the function types remain structurally identical to authors. */
export function isLocalCurve(curve: unknown): curve is LocalCurve {
	return typeof curve === "function" && curveDomains.get(curve) === "local";
}

/** Numeric span metadata used by the ActionPlan compiler; no Timeline identity is retained. */
export function getActionCurveSpans(curve: unknown): readonly TimeSpan[] {
	return typeof curve === "function" ? (actionCurveSpans.get(curve) ?? []) : [];
}

function copySpan(span: TimeSpan): TimeSpan {
	return Object.freeze({ startMs: span.startMs, endMs: span.endMs, durationMs: span.durationMs });
}

export interface TimeSpan {
	readonly startMs: number;
	readonly endMs: number;
	readonly durationMs: number;
}

export interface Timeline {
	readonly durationMs: number;
	at(name: string): number;
	span(from: string, to: string): TimeSpan;
}

export function timeline(durationMs: number, markers: Readonly<Record<string, number>> = {}): Timeline {
	if (!Number.isFinite(durationMs) || durationMs <= 0)
		throw new Error(`时间线时长必须为正有限数: ${String(durationMs)}`);
	if (!markers || typeof markers !== "object" || Array.isArray(markers)) throw new Error("时间线 marker 必须是对象");

	const times = new Map<string, number>([
		["start", 0],
		["end", durationMs],
	]);
	for (const [name, at] of Object.entries(markers)) {
		if (name === "start" || name === "end") throw new Error(`时间线 marker 名称为保留名: ${name}`);
		if (!Number.isFinite(at) || at < 0 || at > durationMs)
			throw new Error(`时间线 marker "${name}" 超出 [0, ${durationMs}] 范围: ${String(at)}`);
		times.set(name, at);
	}
	const read = (name: string): number => {
		const value = times.get(name);
		if (value === undefined) throw new Error(`未知时间线 marker: ${name}`);
		return value;
	};
	return Object.freeze({
		durationMs,
		at: read,
		span(from: string, to: string): TimeSpan {
			const startMs = read(from);
			const endMs = read(to);
			if (endMs <= startMs) throw new Error(`Timeline span 必须为正时长: ${from} -> ${to}`);
			return Object.freeze({ startMs, endMs, durationMs: endMs - startMs });
		},
	});
}

export type KeyCurve = "smooth" | "linear" | "hold";

export function smooth(phase: number): number {
	const t = Math.max(0, Math.min(1, phase));
	return t * t * t * (10 + t * (-15 + 6 * t));
}

/**
 * 五次光滑阶跃（Hermite Quintic）：C2 连续，端点速度与加速度均为零。
 * 区间外夹紧到 0/1；`edge0 === edge1` 时退化为阶跃（与历史本地实现一致）。
 * 动作文件一律使用此实现，不再各自复制。
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
	return smooth((x - edge0) / (edge1 - edge0));
}

export function keys(points: readonly (readonly [number, number])[], curve: KeyCurve = "smooth"): LocalCurve {
	if (!Array.isArray(points) || points.length < 2) throw new Error("keys 需要至少两个关键点");
	if (curve !== "smooth" && curve !== "linear" && curve !== "hold") throw new Error(`未知 keys 曲线: ${String(curve)}`);
	const stablePoints: (readonly [number, number])[] = [];
	for (const [index, point] of points.entries()) {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
			throw new Error(`keys[${index}] 坐标必须是有限数`);
		if (index > 0 && point[0]! <= stablePoints[index - 1]![0]) throw new Error(`关键点 x 必须严格递增: keys[${index}]`);
		stablePoints.push([point[0]!, point[1]!]);
	}
	return withDomain((localMs) => {
		if (!Number.isFinite(localMs)) throw new Error(`keys 采样时间必须有限: ${String(localMs)}`);
		if (localMs <= stablePoints[0]![0]) return stablePoints[0]![1];
		const last = stablePoints.at(-1)!;
		if (localMs >= last[0]!) return last[1]!;
		for (let index = 1; index < stablePoints.length; index++) {
			const [x1, y1] = stablePoints[index - 1]!;
			const [x2, y2] = stablePoints[index]!;
			if (localMs <= x2) {
				const phase = (localMs - x1) / (x2 - x1);
				const weight = curve === "linear" ? phase : curve === "hold" ? 0 : smooth(phase);
				return y1 + (y2 - y1) * weight;
			}
		}
		return last[1]!;
	}, "local");
}

type SpanOrDuration = number | Pick<TimeSpan, "durationMs">;

function positiveDuration(value: SpanOrDuration, label: string): number {
	const durationMs = typeof value === "number" ? value : value?.durationMs;
	if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`${label} 时长必须为正有限数`);
	return durationMs;
}

function clampTime(localMs: number, durationMs: number, label: string): number {
	if (!Number.isFinite(localMs)) throw new Error(`${label} 采样时间必须有限: ${String(localMs)}`);
	return Math.max(0, Math.min(durationMs, localMs));
}

export type Ease = "smooth" | "linear";

export interface PoseWindowOptions {
	readonly from: number;
	readonly pose: number;
	readonly to: number;
	readonly enterMs: number;
	readonly exitMs: number;
	readonly ease?: Ease;
}

export function poseWindow(spanOrDurationMs: SpanOrDuration, options: PoseWindowOptions): LocalCurve {
	const durationMs = positiveDuration(spanOrDurationMs, "poseWindow");
	const { from, pose, to, enterMs, exitMs, ease = "smooth" } = options;
	if (![from, pose, to].every(Number.isFinite)) throw new Error("poseWindow from/pose/to 必须有限");
	if (![enterMs, exitMs].every((value) => Number.isFinite(value) && value >= 0))
		throw new Error("poseWindow enterMs/exitMs 必须为非负有限数");
	if (enterMs + exitMs > durationMs) throw new Error("poseWindow 进出时长之和不得超过总时长");
	if (ease !== "smooth" && ease !== "linear") throw new Error(`未知 poseWindow ease: ${String(ease)}`);
	const blend = (start: number, end: number, phase: number): number =>
		start + (end - start) * (ease === "linear" ? phase : smooth(phase));
	return withDomain((localMs) => {
		const at = clampTime(localMs, durationMs, "poseWindow");
		if (at === 0) return from;
		if (enterMs > 0 && at < enterMs) return blend(from, pose, at / enterMs);
		const exitStartMs = durationMs - exitMs;
		if (at < exitStartMs || (exitMs === 0 && at < durationMs)) return pose;
		if (at >= durationMs) return to;
		if (exitMs === 0) return to;
		return blend(pose, to, (at - exitStartMs) / exitMs);
	}, "local");
}

export interface SpringOptions {
	readonly from: number;
	readonly to: number;
	readonly peak?: number;
	readonly bounces?: number;
}

export function spring(spanOrDurationMs: SpanOrDuration, options: SpringOptions): LocalCurve {
	const durationMs = positiveDuration(spanOrDurationMs, "spring");
	const { from, to, peak = 0, bounces = 2 } = options;
	if (![from, to, peak].every(Number.isFinite)) throw new Error("spring from/to/peak 必须有限");
	if (!Number.isSafeInteger(bounces) || bounces < 1) throw new Error("spring bounces 必须为正整数");
	const cycles = 2 * bounces + 1;
	return withDomain((localMs) => {
		const at = clampTime(localMs, durationMs, "spring");
		if (at === 0) return from;
		if (at === durationMs) return to;
		const u = at / durationMs;
		const travel = from + (to - from) * smooth(u);
		const dampedBounce = peak * Math.sin(Math.PI * u) * Math.sin(cycles * Math.PI * u) * Math.exp(-1.5 * u);
		return travel + dampedBounce;
	}, "local");
}

export interface OscillateOptions {
	readonly amplitude: number;
	readonly cycles: number;
	readonly phase?: number;
	readonly fadeInMs?: number;
	readonly fadeOutMs?: number;
}

export function oscillate(spanOrDurationMs: SpanOrDuration, options: OscillateOptions): LocalCurve {
	const durationMs = positiveDuration(spanOrDurationMs, "oscillate");
	const { amplitude, cycles, phase = 0, fadeInMs = 0, fadeOutMs = 0 } = options;
	if (![amplitude, cycles, phase, fadeInMs, fadeOutMs].every(Number.isFinite))
		throw new Error("oscillate 参数必须有限");
	if (cycles <= 0) throw new Error("oscillate cycles 周期必须为正数");
	if (fadeInMs < 0 || fadeOutMs < 0) throw new Error("oscillate 淡入/淡出必须为非负数");
	if (fadeInMs + fadeOutMs > durationMs) throw new Error("oscillate 淡入/淡出之和不得超过总时长");
	return withDomain((localMs) => {
		const at = clampTime(localMs, durationMs, "oscillate");
		const u = at / durationMs;
		const fadeIn = fadeInMs === 0 ? 1 : smooth(Math.min(1, at / fadeInMs));
		const fadeOut = fadeOutMs === 0 ? 1 : smooth(Math.min(1, (durationMs - at) / fadeOutMs));
		return amplitude * Math.sin(2 * Math.PI * cycles * u + phase) * Math.min(fadeIn, fadeOut);
	}, "local");
}

export interface DuringOptions {
	readonly before?: number;
	readonly after?: number;
}

function validateSpan(span: TimeSpan, label: string): void {
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
}

function assertFiniteValue(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} 必须有限`);
	return value;
}

export function during(span: TimeSpan, curve: LocalCurve, options: DuringOptions = {}): ActionCurve {
	validateSpan(span, "during");
	const stableSpan = copySpan(span);
	assertLocalCurve(curve, "during curve");
	const before = options.before === undefined ? curve(0) : assertFiniteValue(options.before, "during before");
	const after =
		options.after === undefined ? curve(stableSpan.durationMs) : assertFiniteValue(options.after, "during after");
	const placed = withDomain((actionMs) => {
		if (!Number.isFinite(actionMs)) throw new Error(`during 采样时间必须有限: ${String(actionMs)}`);
		if (actionMs < stableSpan.startMs) return before;
		if (actionMs >= stableSpan.endMs) return after;
		return curve(actionMs - stableSpan.startMs);
	}, "action");
	actionCurveSpans.set(placed, Object.freeze([stableSpan]));
	return placed;
}

export interface CurvePart {
	readonly span: TimeSpan;
	readonly curve: LocalCurve;
}

export type TrackGap = number | "hold";
export interface TrackOptions {
	readonly before?: number;
	readonly gap?: TrackGap;
	readonly after?: number;
}

export function track(parts: readonly CurvePart[], options: TrackOptions = {}): ActionCurve {
	if (!Array.isArray(parts) || parts.length === 0) throw new Error("track parts 必须为非空数组");
	if (!options || typeof options !== "object") throw new Error("track options 必须是对象");
	const stableParts = parts.map((part, index) => {
		if (!part || typeof part !== "object") throw new Error(`track[${index}] 必须包含 span 和 curve`);
		validateSpan(part.span, `track[${index}]`);
		assertLocalCurve(part.curve, `track[${index}] curve`);
		const span = copySpan(part.span);
		return {
			span,
			curve: part.curve,
			startValue: assertFiniteValue(part.curve(0), `track[${index}] 起点`),
			endValue: assertFiniteValue(part.curve(span.durationMs), `track[${index}] 终点`),
		};
	});
	for (let index = 1; index < stableParts.length; index++) {
		const previous = stableParts[index - 1]!.span;
		const current = stableParts[index]!.span;
		if (current.startMs < previous.startMs) throw new Error("track parts 必须按起点排序");
		if (current.startMs < previous.endMs) throw new Error("track 位姿 span 不得重叠");
	}
	const first = stableParts[0]!;
	const last = stableParts.at(-1)!;
	const before = options.before === undefined ? first.startValue : assertFiniteValue(options.before, "track before");
	const after = options.after === undefined ? last.endValue : assertFiniteValue(options.after, "track after");
	const gap = options.gap ?? "hold";
	if (gap !== "hold" && !Number.isFinite(gap)) throw new Error("track gap 必须是有限常数或 hold");
	const placed = withDomain((actionMs) => {
		if (!Number.isFinite(actionMs)) throw new Error(`track 采样时间必须有限: ${String(actionMs)}`);
		for (let index = 0; index < stableParts.length; index++) {
			const part = stableParts[index]!;
			if (actionMs < part.span.startMs) {
				if (index === 0) return before;
				return gap === "hold" ? stableParts[index - 1]!.endValue : gap;
			}
			if (actionMs < part.span.endMs) return part.curve(actionMs - part.span.startMs);
		}
		return after;
	}, "action");
	actionCurveSpans.set(placed, Object.freeze(stableParts.map(({ span }) => span)));
	return placed;
}

export function absolute<C extends AnyCurve>(curve: C, speech?: SpeechPolicy): AbsoluteChannel<C> {
	if (typeof curve !== "function") throw new Error("absolute curve 必须是曲线函数");
	if (speech !== undefined && speech !== "allow" && speech !== "exclusive")
		throw new Error(`未知 speech 策略: ${String(speech)}`);
	return Object.freeze({ space: "absolute", curve, ...(speech === undefined ? {} : { speech }) });
}

export function offset<C extends AnyCurve>(curve: C): OffsetChannel<C> {
	if (typeof curve !== "function") throw new Error("offset curve 必须是曲线函数");
	return Object.freeze({ space: "baseline-offset", curve });
}

export function sumOffsets<C extends AnyCurve>(...channels: readonly OffsetChannel<C>[]): OffsetChannel<C> {
	if (channels.length === 0) throw new Error("sumOffsets 至少需要一个 baseline-offset 通道");
	let domain: CurveDomain | undefined;
	const speech = new Set<SpeechPolicy>();
	for (const [index, channel] of channels.entries()) {
		if (!channel || channel.space !== "baseline-offset")
			throw new Error(`sumOffsets 只接受 baseline-offset 通道: [${index}]`);
		if (typeof channel.curve !== "function") throw new Error(`sumOffsets[${index}] 缺少曲线函数`);
		const currentDomain = curveDomains.get(channel.curve);
		if (currentDomain && domain && currentDomain !== domain) throw new Error("sumOffsets 曲线时间域不一致");
		domain ??= currentDomain;
		if (channel.speech !== undefined) speech.add(channel.speech);
	}
	if (speech.size > 1) throw new Error("sumOffsets speech 策略不一致");
	const curves = channels.map(({ curve }) => curve);
	const combined = (timeMs: number) => curves.reduce((sum, curve) => sum + curve(timeMs), 0);
	if (domain) withDomain(combined, domain);
	if (domain === "action") {
		const spans = curves.flatMap((curve) => actionCurveSpans.get(curve) ?? []);
		if (spans.length > 0) actionCurveSpans.set(combined, Object.freeze(spans.map(copySpan)));
	}
	return Object.freeze({
		space: "baseline-offset",
		curve: combined as C,
		...(speech.size ? { speech: speech.values().next().value } : {}),
	});
}

export function mergeChannels<C extends AnyCurve>(
	...parts: readonly Readonly<Record<string, Channel<C>>>[]
): Readonly<Record<string, Channel<C>>> {
	const merged: Record<string, Channel<C>> = Object.create(null);
	for (const [partIndex, part] of parts.entries()) {
		if (!part || typeof part !== "object" || Array.isArray(part))
			throw new Error(`mergeChannels[${partIndex}] 必须是通道对象`);
		for (const [axis, channel] of Object.entries(part)) {
			if (Object.hasOwn(merged, axis)) throw new Error(`mergeChannels 同轴重复声明: ${axis}`);
			merged[axis] = channel;
		}
	}
	return Object.freeze(merged);
}
