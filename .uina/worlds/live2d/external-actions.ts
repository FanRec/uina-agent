import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import type { CompiledAction } from "./authoring/action.js";
import type { CatalogCostumeEntry } from "./authoring/catalog.js";
import { smooth } from "./authoring/curves.js";
import type { CompiledSpatialEvent } from "./authoring/spatial.js";
import { type ExclusiveClaim, MotionDirector, type MotionHandle, type PlayOptions } from "./director/director.js";
import { describeEnvironmentChange, type EnvironmentToken, sameEnvironment } from "./environment.js";
import { actionReceipt, settleMotion, toolRejected, toolSucceeded, toolUnknown, withCancellation } from "./results.js";
import { resolveTiming, type TimingProfile } from "./timing.js";
export type CleanupState = "not_needed" | "confirmed" | "unknown";
export interface CleanupFacts {
	readonly pose: CleanupState;
	readonly tint: CleanupState;
	readonly post: CleanupState;
}
type MutableCleanup = { -readonly [K in keyof CleanupFacts]: CleanupFacts[K] };
export interface ExternalRecord extends CleanupFacts {
	readonly kind: "spatial" | "costume";
	readonly hotkey: "not_needed" | "accepted" | "unknown";
}
export interface ExternalSettlementSummary {
	readonly complete: boolean;
	readonly pending: number;
	readonly unconfirmed: readonly string[];
	readonly last?: ExternalRecord;
}
interface ExternalActionOptions {
	client: VTSClient;
	rig: ModelRig;
	director: MotionDirector;
	/** 环境快照来源（runtime 提供）；外部动作开始时捕获一次，之后只用 sameEnvironment 比较。 */
	getEnvironment: () => EnvironmentToken;
	isFocused: () => boolean;
	cleanupTimeoutMs: number;
	/** 时序/容差覆盖值；缺省 DEFAULT_TIMING。非法值在构造时失败，不做静默回退。 */
	timing?: Partial<TimingProfile>;
	onSpatialTrace?: (trace: SpatialRequestTrace) => void;
}
export type SpatialRequestTrace =
	| {
			readonly phase: "baseline";
			readonly modelID: string;
			readonly basePose: Readonly<{ positionX: number; positionY: number; rotation: number; size: number }>;
			readonly clockAtMs: number;
	  }
	| {
			readonly phase: "dispatch" | "ack";
			readonly eventIndex: number;
			readonly request: "moveModel" | "tintModel" | "updatePostProcessing";
			readonly plannedAtMs: number;
			readonly clockAtMs: number;
			readonly actionAtMs: number;
			readonly lateByMs: number;
			readonly eventLateByMs?: number;
			readonly estimatedEndAtMs?: number;
			readonly outcome?: "confirmed" | "failed" | "unknown";
	  };
export type SpatialOptions = PlayOptions & {
	motionName: string;
	onStarted?: () => void;
	onTrace?: (trace: SpatialRequestTrace) => void;
};
const VTS_MOVE_LIMITS = { position: 1000, rotation: 360, size: 100 } as const;

type ModelPose = { positionX: number; positionY: number; rotation: number; size: number };
type PoseTransition = { from: ModelPose; to: ModelPose };

class SpatialWindowMissedError extends Error {
	constructor() {
		super("spatial_window_missed");
		this.name = "SpatialWindowMissedError";
	}
}

class ExternalPoseChangedError extends Error {
	constructor() {
		super("external_pose_changed");
		this.name = "ExternalPoseChangedError";
	}
}

const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const wrapDeg = (d: number): number => (((d % 360) + 540) % 360) - 180;

const poseMatches = (now: ModelPose, base: ModelPose): boolean =>
	Math.abs(wrapDeg(now.rotation - base.rotation)) <= 0.5 &&
	Math.abs(now.positionX - base.positionX) <= 0.01 &&
	Math.abs(now.positionY - base.positionY) <= 0.01 &&
	Math.abs(now.size - base.size) <= 0.01;

const poseWithinTransition = (now: ModelPose, transition: PoseTransition): boolean => {
	const { from, to } = transition;
	const positionAxes = [
		{ now: now.positionX, from: from.positionX, to: to.positionX, tolerance: 0.01 },
		{ now: now.positionY, from: from.positionY, to: to.positionY, tolerance: 0.01 },
		{ now: now.size, from: from.size, to: to.size, tolerance: 0.01 },
	];
	const movingAxis = positionAxes.find(({ from: start, to: end, tolerance }) => Math.abs(end - start) > tolerance);
	const rotationDelta = wrapDeg(to.rotation - from.rotation);
	const halfTurn = Math.abs(rotationDelta) === 180;
	let progress: number;
	if (movingAxis) progress = (movingAxis.now - movingAxis.from) / (movingAxis.to - movingAxis.from);
	else if (Math.abs(rotationDelta) > 0.5)
		progress = halfTurn
			? Math.abs(wrapDeg(now.rotation - from.rotation)) / 180
			: wrapDeg(now.rotation - from.rotation) / rotationDelta;
	else return poseMatches(now, from);
	progress = Math.max(0, Math.min(1, progress));
	const rotationAtProgress = wrapDeg(from.rotation + rotationDelta * progress);
	const rotationMatches = halfTurn
		? Math.min(
				Math.abs(wrapDeg(now.rotation - wrapDeg(from.rotation + 180 * progress))),
				Math.abs(wrapDeg(now.rotation - wrapDeg(from.rotation - 180 * progress))),
			) <= 0.5
		: Math.abs(wrapDeg(now.rotation - rotationAtProgress)) <= 0.5;
	return (
		positionAxes.every(
			({ now: value, from: start, to: end, tolerance }) =>
				Math.abs(value - (start + (end - start) * progress)) <= tolerance,
		) && rotationMatches
	);
};
/** 一次外部动作拥有请求、清理及资源释放；暂停只消费它的分项事实。 */
export class ExternalActions {
	private readonly client: VTSClient;
	private readonly rig: ModelRig;
	private readonly director: MotionDirector;
	/** 生效的时序参数；diagnose 与测试都读这一份，不再有第二个真值来源。 */
	readonly timing: TimingProfile;
	private claimSeq = 0;
	private spatialClaim?: ExclusiveClaim;
	private readonly pending = new Set<Promise<ExternalRecord>>();
	private readonly unconfirmed = new Set<string>();
	private last?: ExternalRecord;
	constructor(private readonly options: ExternalActionOptions) {
		this.client = options.client;
		this.rig = options.rig;
		this.director = options.director;
		this.timing = resolveTiming(options.timing);
	}
	private get focused() {
		return this.options.isFocused();
	}
	private identityMatched() {
		return this.client.getModelProfile()?.modelID === this.rig.modelID;
	}
	private acquireClaim(
		resources: readonly string[],
		kind: string,
		signal?: AbortSignal,
		cleanup = true,
	): ExclusiveClaim | ToolExecutionResult {
		try {
			return this.director.claimExclusive(resources, { reason: `${kind}#${++this.claimSeq}`, cleanup, signal });
		} catch {
			return signal?.aborted
				? toolRejected("cancelled", "调用已中止，未执行。")
				: toolRejected("resource_conflict", "独占资源被占用（动作正在进行或清理中）。");
		}
	}
	private trackSettlement(task: Promise<ExternalRecord>) {
		const tracked = task
			.then((record) => {
				this.last = Object.freeze({ ...record });
				for (const field of ["pose", "tint", "post", "hotkey"] as const)
					if (record[field] === "unknown") this.unconfirmed.add(field);
				return record;
			})
			.finally(() => this.pending.delete(tracked));
		this.pending.add(tracked);
	}
	cancelSpatial(): void {
		this.spatialClaim?.cancel();
	}
	cancelAll(): void {
		this.director.cancelClaims();
	}
	acknowledgeUnconfirmed(): void {
		this.unconfirmed.clear();
	}
	snapshot(): ExternalSettlementSummary {
		return Object.freeze({
			complete: !this.pending.size && !this.unconfirmed.size,
			pending: this.pending.size,
			unconfirmed: Object.freeze([...this.unconfirmed]),
			...(this.last ? { last: this.last } : {}),
		});
	}
	async settlePending(): Promise<ExternalSettlementSummary> {
		const deadline = Date.now() + this.options.cleanupTimeoutMs;
		while (this.pending.size && Date.now() < deadline)
			await Promise.race([
				Promise.allSettled([...this.pending]),
				sleep(Math.min(50, Math.max(0, deadline - Date.now()))),
			]);
		return this.snapshot();
	}
	async runSpatial(clip: CompiledAction, options: SpatialOptions): Promise<ToolExecutionResult> {
		const spatial = clip.spatial;
		if (spatial.length === 0)
			return toolRejected("invalid_motion", actionReceipt(options.motionName, "FAILED", "missing_spatial_events"));
		const hasEffects = spatial.some((event) => event.effects !== undefined);
		const hasTransform = spatial.some((event) => event.transform !== undefined);
		const resources = [...(hasTransform ? ["model:transform"] : []), ...(hasEffects ? ["effect:*"] : [])];
		const claim = this.acquireClaim(resources, "action", options.signal, true);
		if ("status" in claim) return claim;
		this.spatialClaim = claim;
		let completeCleanup: (record: ExternalRecord) => void = () => {};
		this.trackSettlement(
			new Promise<ExternalRecord>((resolve) => {
				completeCleanup = resolve;
			}),
		);
		const emitTrace =
			options.onTrace || this.options.onSpatialTrace
				? (trace: SpatialRequestTrace) => {
						const frozen = Object.freeze(trace);
						try {
							options.onTrace?.(frozen);
						} catch {
							/* local diagnostic callbacks cannot interrupt an external action */
						}
						try {
							this.options.onSpatialTrace?.(frozen);
						} catch {
							/* local diagnostic callbacks cannot interrupt an external action */
						}
					}
				: undefined;
		const run = new SpatialRun({
			client: this.client,
			rig: this.rig,
			director: this.director,
			isFocused: () => this.focused,
			identityMatched: () => this.identityMatched(),
			environment: this.options.getEnvironment(),
			currentEnvironment: () => this.options.getEnvironment(),
			timing: this.timing,
			spatial,
			clip,
			options,
			claim,
			emitTrace,
			onCleanup: completeCleanup,
			onRelease: () => {
				if (this.spatialClaim === claim) this.spatialClaim = undefined;
			},
		});
		const result = await run.execute();
		return { ...result, details: { ...(result.details as object), cleanup: { ...run.cleanup } } };
	}

	async runCostume(entry: CatalogCostumeEntry, signal?: AbortSignal): Promise<ToolExecutionResult> {
		const hotkey = this.client.findHotkey(entry.hotkeyID);
		if (!hotkey)
			return toolRejected(
				"hotkey_missing",
				`${actionReceipt(entry.id, "FAILED", "hotkey_missing")} (${entry.hotkeyID})`,
				{ hotkeyID: entry.hotkeyID },
			);
		const claim = this.acquireClaim(["effect:*"], "costume", signal);
		if ("status" in claim) return claim;
		const environment = this.options.getEnvironment();
		let finish: (record: ExternalRecord) => void = () => {};
		this.trackSettlement(
			new Promise<ExternalRecord>((resolve) => {
				finish = resolve;
			}),
		);
		let accepted = false;
		try {
			claim.signal.throwIfAborted();
			await this.client.triggerHotkey(hotkey.hotkeyID);
			accepted = sameEnvironment(environment, this.options.getEnvironment()) && this.identityMatched();
			if (!accepted) {
				const current = this.options.getEnvironment();
				return toolUnknown(actionReceipt(entry.id, "UNKNOWN", "environment_changed"), {
					reason: "environment_changed",
					change: describeEnvironmentChange(environment, current),
				});
			}
			if (claim.signal.aborted)
				return {
					result: actionReceipt(entry.id, "CANCELLED", "accepted_before_cancel"),
					status: "cancelled",
					details: { effectStatus: "accepted", hotkey: "accepted", verification: "local_intent" },
				};
			return toolSucceeded(actionReceipt(entry.id, "OK"), {
				effectStatus: "accepted",
				verification: "local_intent",
				hotkey: "accepted",
			});
		} catch (error) {
			return toolUnknown(actionReceipt(entry.id, "UNKNOWN", "hotkey_result_unconfirmed"), {
				reason: "hotkey_result_unconfirmed",
				cause: error instanceof Error ? error.message : String(error),
			});
		} finally {
			finish({
				kind: "costume",
				pose: "not_needed",
				tint: "not_needed",
				post: "not_needed",
				hotkey: accepted ? "accepted" : "unknown",
			});
			claim.release();
		}
	}
}

interface SpatialRunHost {
	client: VTSClient;
	rig: ModelRig;
	director: MotionDirector;
	isFocused: () => boolean;
	identityMatched: () => boolean;
	environment: EnvironmentToken;
	/** 每次比较都重新取环境：缓存快照只能证明"当时是谁"，不能证明"现在还是谁"。 */
	currentEnvironment: () => EnvironmentToken;
	timing: TimingProfile;
	spatial: CompiledAction["spatial"];
	clip: CompiledAction;
	options: SpatialOptions;
	claim: ExclusiveClaim;
	emitTrace: ((trace: SpatialRequestTrace) => void) | undefined;
	onCleanup: (record: ExternalRecord) => void;
	onRelease: () => void;
}

type SpatialSpan = NonNullable<CompiledSpatialEvent["span"]>;

/**
 * 一次 spatial 动作的显式阶段机。
 *
 * 以前这些阶段、17 个可变闭包变量和两套"只跑一次"归位习惯挤在 `runSpatial` 一个 557 行函数里：成功路径、
 * 取消路径、异常路径各自重跑一遍 restore/restoreEffects，漏一个检查不会报错，只会把旧位姿写到新模型上。
 *
 * 现在按阶段拆开，并声明各自的幂等性：
 * - `prepare`：只读（位姿基线、滤镜预设、后期基线），返回拒绝结果或 undefined。可重入判定，不写外部状态。
 * - `play` / `dispatch` / `drive*`：不可重入。被 claim 取消即抛错，由 `settleFailure` 统一收口。
 * - `restorePose` / `restoreEffects`：幂等（内部 `once` 记忆）。三条路径共用同一份结算事实，不再各写一份。
 * - `finish`：只执行一次。写 cleanup 事实、切掉 playback、释放 claim。
 */
class SpatialRun {
	readonly cleanup: MutableCleanup = { pose: "not_needed", tint: "not_needed", post: "not_needed" };
	private readonly dispatchFailures: string[] = [];
	/** 归位是幂等的：同一 key 只跑一次，后来者拿同一个结果。 */
	private readonly settled = new Map<string, Promise<unknown>>();
	private handle: MotionHandle | undefined;
	private motionResult: Promise<ToolExecutionResult> | undefined;
	private base: ModelPose | undefined;
	private expectedPose: ModelPose | undefined;
	private pendingPose: ModelPose | undefined;
	private poseTransition: PoseTransition | undefined;
	private baseCapturedAtMs: number | undefined;
	private t0 = 0;
	private moved = false;
	private restored = true;
	private poseOwnershipLost = false;
	private postBaseline: { active: boolean; activePreset: string | null } | undefined;
	private tintSent = false;
	private postSent = false;
	constructor(private readonly host: SpatialRunHost) {}

	async execute(): Promise<ToolExecutionResult> {
		try {
			this.ensureActive();
			const refused = await this.prepare();
			if (refused) return refused;
			this.play();
			for (const event of this.host.spatial) await this.dispatch(event);
			const result = await this.waitForMotion();
			return await this.settleSuccess(result);
		} catch (error) {
			return await this.settleFailure(error);
		} finally {
			this.finish();
		}
	}

	private get clip() {
		return this.host.clip;
	}
	private get director() {
		return this.host.director;
	}
	private get client() {
		return this.host.client;
	}
	private get spatial() {
		return this.host.spatial;
	}
	private get motionName() {
		return this.host.options.motionName;
	}
	private get timing() {
		return this.host.timing;
	}
	private sameModel(): boolean {
		return sameEnvironment(this.host.environment, this.host.currentEnvironment()) && this.identityMatched();
	}
	private identityMatched(): boolean {
		return this.host.identityMatched();
	}
	private ensureActive(): void {
		if (
			!this.host.isFocused() ||
			!this.sameModel() ||
			this.handle?.status === "releasing" ||
			this.handle?.status === "cancelled"
		)
			this.host.claim.cancel();
		this.host.claim.signal.throwIfAborted();
	}
	private emitTrace(trace: SpatialRequestTrace): void {
		this.host.emitTrace?.(trace);
	}
	private actionNowMs(): number {
		return Math.max(0, (this.director.clockMs - this.t0) * this.clip.speed);
	}
	private once<T>(key: string, run: () => Promise<T>): Promise<T> {
		const existing = this.settled.get(key) as Promise<T> | undefined;
		if (existing) return existing;
		const started = run();
		this.settled.set(key, started);
		return started;
	}

	/** 只读阶段：位姿/预设/后期基线 + 越界检查。返回拒绝结果表示动作没有开始。 */
	private async prepare(): Promise<ToolExecutionResult | undefined> {
		const { client, claim } = this.host;
		if (this.spatial.some((event) => event.transform !== undefined)) {
			this.base = await withCancellation(client.getModelPosition(this.host.rig.modelID), claim.signal);
			this.ensureActive();
			this.baseCapturedAtMs = this.director.clockMs;
			const base = this.base;
			if (![base.positionX, base.positionY, base.rotation, base.size].every(Number.isFinite))
				return toolRejected("invalid_motion", actionReceipt(this.motionName, "FAILED", "pose_unavailable"));
			this.expectedPose = { ...base };
			const rotationBase = wrapDeg(base.rotation);
			const violations: string[] = [];
			for (const [index, event] of this.spatial.entries()) {
				const transform = event.transform;
				if (!transform) continue;
				if (transform.relativeRotation !== undefined) {
					if (Math.abs(transform.relativeRotation) > VTS_MOVE_LIMITS.rotation)
						violations.push(
							`事件[${index}] relativeRotation=${transform.relativeRotation} 超出 ±${VTS_MOVE_LIMITS.rotation}`,
						);
					continue;
				}
				const delta = transform.delta ?? {};
				const target = {
					positionX: base.positionX + (delta.x ?? 0),
					positionY: base.positionY + (delta.y ?? 0),
					rotation: rotationBase + (delta.rotation ?? 0),
					size: base.size + (delta.size ?? 0),
				};
				if (
					Math.abs(target.positionX) > VTS_MOVE_LIMITS.position ||
					Math.abs(target.positionY) > VTS_MOVE_LIMITS.position
				)
					violations.push(
						`事件[${index}] position=(${target.positionX}, ${target.positionY}) 超出 ±${VTS_MOVE_LIMITS.position}`,
					);
				if (Math.abs(target.rotation) > VTS_MOVE_LIMITS.rotation)
					violations.push(`事件[${index}] rotation=${target.rotation} 超出 ±${VTS_MOVE_LIMITS.rotation}`);
				if (Math.abs(target.size) > VTS_MOVE_LIMITS.size)
					violations.push(`事件[${index}] size=${target.size} 超出 ±${VTS_MOVE_LIMITS.size}`);
			}
			if (violations.length > 0)
				return toolRejected(
					"invalid_motion",
					`${actionReceipt(this.motionName, "FAILED", "spatial_plan_out_of_range")} (${violations.join("; ")})`,
					{ violations },
				);
		}
		const presets = client.getPostProcessingPresets();
		if (presets.length > 0) {
			const missing = [
				...new Set(
					this.spatial.flatMap((event) =>
						event.effects?.postProcessing?.preset ? [event.effects.postProcessing.preset] : [],
					),
				),
			].filter((preset) => !presets.includes(preset));
			if (missing.length > 0)
				return toolRejected(
					"preset_missing",
					`${actionReceipt(this.motionName, "FAILED", "preset_missing")} (missing: ${missing.join(", ")}; available: ${presets.join(", ")})`,
					{ missingPresets: missing, availablePresets: presets },
				);
		}
		if (this.spatial.some((event) => event.effects?.postProcessing !== undefined)) {
			try {
				this.postBaseline = await withCancellation(client.readPostProcessing(), this.host.claim.signal);
				if (
					typeof this.postBaseline.active !== "boolean" ||
					!(this.postBaseline.activePreset === null || typeof this.postBaseline.activePreset === "string")
				)
					throw new Error("Invalid post-processing baseline");
			} catch (error) {
				if (this.host.claim.signal.aborted) throw error;
				return toolRejected(
					"effect_baseline_unavailable",
					actionReceipt(this.motionName, "FAILED", "effect_baseline_unavailable"),
				);
			}
		}
		this.ensureActive();
		if (this.base && this.baseCapturedAtMs !== undefined)
			this.emitTrace({
				phase: "baseline",
				modelID: this.host.rig.modelID,
				basePose: Object.freeze({ ...this.base }),
				clockAtMs: this.baseCapturedAtMs,
			});
		this.t0 = this.director.clockMs;
		return undefined;
	}

	/** 不可重入：把动作交给 director，同时开始观察注入事实。 */
	private play(): void {
		const handle = this.director.play(this.clip, { ...this.host.options, signal: this.host.claim.signal });
		this.handle = handle;
		this.host.options.onStarted?.();
		void handle.finished.then((result) => {
			if (result.status === "cancelled") this.host.claim.cancel();
		});
		this.motionResult = settleMotion(this.host.client, handle, this.motionName);
	}

	private traceRequest(
		phase: "dispatch" | "ack",
		eventIndex: number,
		request: "moveModel" | "tintModel" | "updatePostProcessing",
		plannedAtMs: number,
		clockAtMs: number,
		extra: {
			eventLateByMs?: number;
			estimatedEndAtMs?: number;
			outcome?: "confirmed" | "failed" | "unknown";
		} = {},
	): void {
		if (!this.host.emitTrace) return;
		this.emitTrace({
			phase,
			eventIndex,
			request,
			plannedAtMs,
			clockAtMs,
			actionAtMs: this.actionNowMs(),
			lateByMs: Math.max(0, this.actionNowMs() - plannedAtMs),
			...extra,
		});
	}

	private async waitUntilActionMs(targetMs: number): Promise<void> {
		while (this.actionNowMs() < targetMs) {
			this.ensureActive();
			const remainingWallMs = (targetMs - this.actionNowMs()) / this.clip.speed;
			if (!(await sleep(Math.min(this.timing.driveIntervalMs, Math.max(1, remainingWallMs)), this.host.claim.signal)))
				this.ensureActive();
		}
	}

	private async sendEffect(
		event: CompiledSpatialEvent,
		request: "tintModel" | "updatePostProcessing",
		dispatch: () => Promise<unknown>,
	): Promise<void> {
		const clockAtMs = this.director.clockMs;
		this.traceRequest("dispatch", event.order, request, event.atMs, clockAtMs);
		try {
			await withCancellation(Promise.resolve().then(dispatch), this.host.claim.signal);
			this.ensureActive();
			this.traceRequest("ack", event.order, request, event.atMs, this.director.clockMs, {
				outcome: "confirmed",
			});
		} catch (error) {
			if (this.host.claim.signal.aborted) throw error;
			this.dispatchFailures.push(
				`事件[${event.order}]分发 ${request}: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.traceRequest("ack", event.order, request, event.atMs, this.director.clockMs, { outcome: "failed" });
		}
	}

	private async sendEffects(event: CompiledSpatialEvent): Promise<void> {
		const effects = event.effects;
		if (!effects) return;
		const jobs: Promise<void>[] = [];
		const tint = effects.tint;
		if (tint) {
			this.tintSent = true;
			this.cleanup.tint = "unknown";
			jobs.push(this.sendEffect(event, "tintModel", () => this.client.tintModel(tint)));
		}
		const post = effects.postProcessing;
		if (post) {
			this.postSent = true;
			this.cleanup.post = "unknown";
			jobs.push(this.sendEffect(event, "updatePostProcessing", () => this.client.updatePostProcessing(post)));
		}
		await Promise.all(jobs);
	}

	private ensureUsefulWindow(event: CompiledSpatialEvent): void {
		const span = event.span!;
		const remainingActionMs = span.endMs - this.actionNowMs();
		if (remainingActionMs <= 0 || remainingActionMs / this.clip.speed < this.timing.minUsefulMoveMs)
			throw new SpatialWindowMissedError();
	}

	/**
	 * 环境/焦点仍属于本次动作时返回 true。
	 * `active` 为 false 的归位路径只比较环境：此时动作已被取消，等焦点没有意义。
	 */
	private observeOwned(active: boolean): boolean {
		if (active) this.ensureActive();
		return this.sameModel();
	}

	private poseMatchesExpected(current: ModelPose): boolean {
		if (this.expectedPose && poseMatches(current, this.expectedPose)) return true;
		if (this.pendingPose && poseMatches(current, this.pendingPose)) return true;
		return this.poseTransition !== undefined && poseWithinTransition(current, this.poseTransition);
	}

	private async confirmPoseOwnership(observed: ModelPose, active: boolean): Promise<ModelPose | undefined> {
		if (!this.expectedPose) return observed;
		let current = observed;
		for (let attempt = 0; attempt <= this.timing.settleRetries; attempt++) {
			if (!this.observeOwned(active)) return undefined;
			if (this.poseMatchesExpected(current)) return current;
			if (attempt === this.timing.settleRetries) break;
			await sleep(
				attempt === 0 ? this.timing.settleMarginMs : this.timing.settleRetryMs,
				active ? this.host.claim.signal : undefined,
			);
			if (!this.observeOwned(active)) return undefined;
			current = await this.client.getModelPosition(this.host.rig.modelID);
		}
		this.poseOwnershipLost = true;
		this.cleanup.pose = "unknown";
		return undefined;
	}

	/** 幂等：位姿归位。成功/取消/异常三条路径共用。 */
	private restorePose(): Promise<boolean> {
		return this.once("pose", () => this.doRestorePose());
	}

	private async doRestorePose(): Promise<boolean> {
		if (!this.moved) return (this.restored = true);
		if (!this.base || !this.expectedPose || this.poseOwnershipLost || !this.sameModel()) return (this.restored = false);
		try {
			const current = await this.client.getModelPosition(this.host.rig.modelID);
			const confirmedPose = await this.confirmPoseOwnership(current, false);
			if (!this.sameModel() || !confirmedPose) return (this.restored = false);
			if (!this.pendingPose && !this.poseTransition && poseMatches(confirmedPose, this.base))
				return (this.restored = true);
			this.pendingPose = { ...this.base };
			this.poseTransition = { from: { ...current }, to: { ...this.base } };
			await this.client.moveModel({
				...this.base,
				timeInSeconds: this.timing.restoreSeconds,
				valuesAreRelativeToModel: false,
			});
			this.expectedPose = { ...this.base };
			this.pendingPose = undefined;
			await sleep(this.timing.restoreSeconds * 1000 + this.timing.settleMarginMs);
			this.poseTransition = undefined;
			if (!this.sameModel()) return (this.restored = false);
			const now = await this.client.getModelPosition(this.host.rig.modelID);
			this.restored = this.sameModel() && poseMatches(now, this.base);
		} catch {
			this.restored = false;
		}
		return this.restored;
	}

	/** 幂等：滤镜/后期归位。只归位自己动过的分项。 */
	private restoreEffects(): Promise<{ tint: boolean; post: boolean }> {
		return this.once("effects", () => this.doRestoreEffects());
	}

	private async doRestoreEffects(): Promise<{ tint: boolean; post: boolean }> {
		const restoreTint = async (): Promise<boolean> => {
			if (!this.tintSent) return true;
			try {
				if (!this.sameModel()) return false;
				await this.client.getModelPosition(this.host.rig.modelID);
				if (!this.sameModel()) return false;
				await this.client.tintModel({ r: 255, g: 255, b: 255, a: 255 });
				return this.sameModel();
			} catch {
				return false;
			}
		};
		const restorePost = async (): Promise<boolean> => {
			if (!this.postSent) return true;
			const baseline = this.postBaseline;
			try {
				if (!this.sameModel() || !baseline) return false;
				await this.client.getModelPosition(this.host.rig.modelID);
				if (!this.sameModel()) return false;
				await this.client.updatePostProcessing({
					on: baseline.active,
					...(baseline.active && baseline.activePreset ? { preset: baseline.activePreset } : {}),
					fadeTime: 0.25,
				});
				if (!this.sameModel()) return false;
				const now = await this.client.readPostProcessing();
				return (
					this.sameModel() &&
					now.active === baseline.active &&
					(!(baseline.active && baseline.activePreset) || now.activePreset === baseline.activePreset)
				);
			} catch {
				return false;
			}
		};
		const [tint, post] = await Promise.all([restoreTint(), restorePost()]);
		this.cleanup.tint = this.tintSent ? (tint ? "confirmed" : "unknown") : "not_needed";
		this.cleanup.post = this.postSent ? (post ? "confirmed" : "unknown") : "not_needed";
		return { tint, post };
	}

	/**
	 * 逐个事件重新读取位姿并确认归属：单次 VTS 读取能识破"代次缓存还没跟上换模型"的窗口。
	 * 归属失败按丢权抛错，取消/失焦交给 `ensureActive` 抛出。
	 */
	private async revalidatePose(): Promise<void> {
		const observed = await withCancellation(
			this.client.getModelPosition(this.host.rig.modelID),
			this.host.claim.signal,
		);
		this.ensureActive();
		if (await this.confirmPoseOwnership(observed, true)) return;
		if (this.poseOwnershipLost) throw new ExternalPoseChangedError();
		this.ensureActive();
	}

	private async dispatch(event: CompiledSpatialEvent): Promise<void> {
		await this.waitUntilActionMs(event.atMs);
		this.ensureActive();
		await this.revalidatePose();
		if (!event.span && this.actionNowMs() >= this.clip.durationMs) {
			this.dispatchFailures.push(`事件[${event.order}] marker 已过期`);
			return;
		}
		const eventLateByMs = Math.max(0, this.actionNowMs() - event.atMs);
		if (event.transform) this.ensureUsefulWindow(event);
		if (event.effects) {
			await this.sendEffects(event);
			if (event.transform) {
				await this.revalidatePose();
				this.ensureUsefulWindow(event);
			}
		}
		if (!event.transform) return;
		const span = event.span!;
		const rotation = event.transform.relativeRotation;
		if (rotation !== undefined) await this.driveRelativeRotation(event, span, rotation, eventLateByMs);
		else await this.moveAbsolute(event, span, eventLateByMs);
	}

	/** 相对旋转：按刷新节拍把总角度分摊成小步，避免慢 ACK 后的最短弧绕行。 */
	private async driveRelativeRotation(
		event: CompiledSpatialEvent,
		span: SpatialSpan,
		total: number,
		eventLateByMs: number,
	): Promise<void> {
		this.moved = true;
		this.cleanup.pose = "unknown";
		let sentAngle = 0;
		while (this.actionNowMs() < span.endMs) {
			this.ensureActive();
			const elapsedActionMs = Math.max(0, this.actionNowMs() - span.startMs);
			const targetAngle = total * smooth(elapsedActionMs / span.durationMs);
			let delta = targetAngle - sentAngle;
			if (Math.abs(delta) < this.timing.driveMinDeltaDeg) {
				const remainingWallMs = (span.endMs - this.actionNowMs()) / this.clip.speed;
				if (!(await sleep(Math.min(this.timing.driveIntervalMs, Math.max(1, remainingWallMs)), this.host.claim.signal)))
					this.ensureActive();
				continue;
			}
			delta = Math.sign(delta) * Math.min(Math.abs(delta), this.timing.maxRelativeStepDeg);
			await this.sendRelativeDelta(event, delta, eventLateByMs, span.endMs, this.actionNowMs());
			sentAngle += delta;
		}
		const residual = total - sentAngle;
		if (Math.abs(residual) > this.timing.maxEndpointResidualDeg) throw new SpatialWindowMissedError();
		if (Math.abs(residual) >= this.timing.driveMinDeltaDeg) {
			this.ensureActive();
			await this.sendRelativeDelta(event, residual, eventLateByMs, span.endMs, this.actionNowMs());
		}
	}

	private async sendRelativeDelta(
		event: CompiledSpatialEvent,
		delta: number,
		eventLateByMs: number,
		endAtMs: number,
		plannedAtMs: number,
	): Promise<void> {
		const clockAtMs = this.director.clockMs;
		this.pendingPose = { ...this.expectedPose!, rotation: this.expectedPose!.rotation + delta };
		this.traceRequest("dispatch", event.order, "moveModel", plannedAtMs, clockAtMs, {
			eventLateByMs,
			estimatedEndAtMs: endAtMs,
		});
		await withCancellation(
			this.client.moveModel({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: delta }),
			this.host.claim.signal,
		);
		this.expectedPose = this.pendingPose;
		this.pendingPose = undefined;
		this.ensureActive();
		this.traceRequest("ack", event.order, "moveModel", plannedAtMs, this.director.clockMs, {
			eventLateByMs,
			estimatedEndAtMs: endAtMs,
			outcome: "confirmed",
		});
	}

	/** 绝对位姿：一次 moveModel 到目标，随后等段结束。 */
	private async moveAbsolute(event: CompiledSpatialEvent, span: SpatialSpan, eventLateByMs: number): Promise<void> {
		const base = this.base!;
		const rotationBase = wrapDeg(base.rotation);
		const delta = event.transform!.delta ?? {};
		const request = {
			timeInSeconds: (span.endMs - this.actionNowMs()) / this.clip.speed / 1000,
			valuesAreRelativeToModel: false,
			positionX: base.positionX + (delta.x ?? 0),
			positionY: base.positionY + (delta.y ?? 0),
			rotation: rotationBase + (delta.rotation ?? 0),
			size: base.size + (delta.size ?? 0),
		};
		if (request.timeInSeconds <= 0) throw new SpatialWindowMissedError();
		this.moved = true;
		this.cleanup.pose = "unknown";
		this.pendingPose = {
			positionX: request.positionX,
			positionY: request.positionY,
			rotation: request.rotation,
			size: request.size,
		};
		this.poseTransition = { from: { ...this.expectedPose! }, to: { ...this.pendingPose } };
		const clockAtMs = this.director.clockMs;
		this.traceRequest("dispatch", event.order, "moveModel", span.startMs, clockAtMs, {
			eventLateByMs,
			estimatedEndAtMs: span.endMs,
		});
		await withCancellation(this.client.moveModel(request), this.host.claim.signal);
		this.expectedPose = this.pendingPose;
		this.pendingPose = undefined;
		this.ensureActive();
		this.traceRequest("ack", event.order, "moveModel", span.startMs, this.director.clockMs, {
			eventLateByMs,
			estimatedEndAtMs: span.endMs,
			outcome: "confirmed",
		});
		await this.waitUntilActionMs(span.endMs);
		this.poseTransition = undefined;
	}

	private async waitForMotion(): Promise<ToolExecutionResult> {
		let result: ToolExecutionResult | undefined;
		while (!result) {
			this.ensureActive();
			result = await Promise.race([this.motionResult!, sleep(50).then(() => undefined)]);
		}
		this.ensureActive();
		return result;
	}

	private async settleSuccess(motion: ToolExecutionResult): Promise<ToolExecutionResult> {
		const [poseRestored, restoredEffects] = await Promise.all([
			this.moved ? this.restorePose() : Promise.resolve(true),
			this.restoreEffects(),
		]);
		this.restored = poseRestored;
		if (this.poseOwnershipLost)
			return toolUnknown(actionReceipt(this.motionName, "UNKNOWN", "external_pose_changed"), {
				reason: "external_pose_changed",
				restored: false,
				restoredEffects,
			});
		if (!this.restored)
			return toolUnknown(actionReceipt(this.motionName, "UNKNOWN", "spatial_pose_unconfirmed"), {
				reason: "spatial_pose_unconfirmed",
				restored: false,
				restoredEffects,
			});
		if (this.dispatchFailures.length > 0 || !restoredEffects.tint || !restoredEffects.post) {
			const effectIssues = [...this.dispatchFailures];
			if (!restoredEffects.tint) effectIssues.push("染色归位未确认");
			if (!restoredEffects.post) effectIssues.push("滤镜归位未确认");
			return toolUnknown(actionReceipt(this.motionName, "UNKNOWN", "spatial_effect_unconfirmed"), {
				reason: "spatial_effect_unconfirmed",
				restored: true,
				restoredEffects,
				effectIssues,
			});
		}
		return {
			...motion,
			details: { ...(motion.details as Record<string, unknown> | undefined), restored: true, restoredEffects },
		};
	}

	private async settleFailure(error: unknown): Promise<ToolExecutionResult> {
		const missedWindow = error instanceof SpatialWindowMissedError;
		const cancelled =
			missedWindow ||
			this.host.claim.signal.aborted ||
			this.handle?.status === "releasing" ||
			this.handle?.status === "cancelled";
		if (missedWindow) this.host.claim.cancel();
		this.handle?.stop("cut");
		const [confirmed, restoredEffects] = await Promise.all([this.restorePose(), this.restoreEffects()]);
		if (this.poseOwnershipLost || error instanceof ExternalPoseChangedError)
			return toolUnknown(actionReceipt(this.motionName, "UNKNOWN", "external_pose_changed"), {
				reason: "external_pose_changed",
				restored: false,
				restoredEffects,
			});
		if (cancelled) {
			const clean = confirmed && restoredEffects.tint && restoredEffects.post;
			const result = missedWindow
				? actionReceipt(this.motionName, "UNKNOWN", "spatial_window_missed")
				: actionReceipt(this.motionName, "CANCELLED", clean ? undefined : "cleanup_unconfirmed");
			return {
				result,
				status: missedWindow ? "unknown" : "cancelled",
				details: {
					reason: missedWindow ? "spatial_window_missed" : "cancelled",
					effectStatus: clean ? (missedWindow ? "unknown" : "cancelled") : "unknown",
					restored: confirmed,
					restoredEffects,
				},
			};
		}
		return toolUnknown(actionReceipt(this.motionName, "UNKNOWN", "spatial_execution_failed"), {
			reason: "spatial_execution_failed",
			cause: error instanceof Error ? error.message : String(error),
			...(this.moved ? { restored: confirmed } : {}),
			restoredEffects,
		});
	}

	private finish(): void {
		if (this.poseOwnershipLost) this.cleanup.pose = "unknown";
		else if (this.moved) this.cleanup.pose = this.restored ? "confirmed" : "unknown";
		this.host.onCleanup({ kind: "spatial", ...this.cleanup, hotkey: "not_needed" });
		this.handle?.stop("cut");
		this.host.onRelease();
		this.host.claim.release();
	}
}
