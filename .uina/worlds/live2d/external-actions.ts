import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import type { CatalogCostumeEntry } from "./authoring/catalog.js";
import type { CompiledAction } from "./authoring/action.js";
import type { CompiledSpatialEvent } from "./authoring/spatial.js";
import { smooth } from "./authoring/curves.js";
import { type ExclusiveClaim, MotionDirector, type MotionHandle, type PlayOptions } from "./director/director.js";
import { settleMotion, toolRejected, toolSucceeded, toolUnknown, withCancellation } from "./results.js";
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
	getCatalogGeneration: () => number;
	isFocused: () => boolean;
	cleanupTimeoutMs: number;
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
	callName?: string;
	description?: string;
	onStarted?: () => void;
	onTrace?: (trace: SpatialRequestTrace) => void;
};
const SETTLE_MARGIN_MS = 60;
/** 回读核实重试：VTS 插值结算存在滞后，失败再等 SETTLE_RETRY_MS 重读，重试用尽才如实判未确认。 */
const SETTLE_RETRIES = 2;
const SETTLE_RETRY_MS = 250;
const RESTORE_SECONDS = 0.25;
/** relative 旋转段的逐帧驱动节拍（~60fps，对齐 VTS 渲染帧率）。 */
const DRIVE_INTERVAL_MS = 16;
/** 逐帧驱动的事件阈值（°）：低于它不发空转请求。 */
const DRIVE_MIN_DELTA_DEG = 0.01;
/** Per-request relative rotation cap prevents shortest-arc wrap after a slow ACK. */
const MAX_RELATIVE_STEP_DEG = 90;
/** Allow only the small tail left by tick/ACK scheduling; larger residuals mean the authored window was missed. */
const MAX_ENDPOINT_RESIDUAL_DEG = 2;
/** Initial conservative movement window; requires later live-VTS calibration. */
const MIN_USEFUL_MOVE_MS = 100;

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
	private claimSeq = 0;
	private spatialClaim?: ExclusiveClaim;
	private readonly pending = new Set<Promise<ExternalRecord>>();
	private readonly unconfirmed = new Set<string>();
	private last?: ExternalRecord;
	constructor(private readonly options: ExternalActionOptions) {
		this.client = options.client;
		this.rig = options.rig;
		this.director = options.director;
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
		const director = this.director;
		const client = this.client;
		const spatial = clip.spatial;
		const label = `动作 "${options.description ?? options.callName ?? "未命名"}"`;
		if (spatial.length === 0) return toolRejected("invalid_motion", `${label} 缺少空间事件。`);
		const hasEffects = spatial.some((event) => event.effects !== undefined);
		const hasPost = spatial.some((event) => event.effects?.postProcessing !== undefined);
		const hasTransform = spatial.some((event) => event.transform !== undefined);
		const resources = [...(hasTransform ? ["model:transform"] : []), ...(hasEffects ? ["effect:*"] : [])];
		const claim = this.acquireClaim(resources, "action", options.signal, true);
		if ("status" in claim) return claim;
		this.spatialClaim = claim;
		const generation = this.options.getCatalogGeneration();
		const modelGeneration = client.getModelGeneration();
		const connectionGeneration = client.getInjectionStats().generation;
		const sameModel = () =>
			generation === this.options.getCatalogGeneration() &&
			this.identityMatched() &&
			client.isConnected() &&
			client.getModelGeneration() === modelGeneration &&
			client.getInjectionStats().generation === connectionGeneration;
		let completeCleanup: (record: ExternalRecord) => void = () => {};
		this.trackSettlement(
			new Promise<ExternalRecord>((resolve) => {
				completeCleanup = resolve;
			}),
		);
		let base: ModelPose | undefined;
		let expectedPose: ModelPose | undefined;
		let pendingPose: ModelPose | undefined;
		let poseTransition: PoseTransition | undefined;
		let baseCapturedAtMs: number | undefined;
		let handle: MotionHandle | undefined;
		let motionResult: Promise<ToolExecutionResult> | undefined;
		let moved = false;
		let restored = true;
		let restoreAttempted = false;
		let poseOwnershipLost = false;
		let postBaseline: { active: boolean; activePreset: string | null } | undefined;
		let tintSent = false;
		let postSent = false;
		const cleanup: MutableCleanup = { pose: "not_needed", tint: "not_needed", post: "not_needed" };
		let effectsRestored: { tint: boolean; post: boolean } | undefined;
		const dispatchFailures: string[] = [];
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
		const ensureActive = () => {
			if (!this.focused || !sameModel() || handle?.status === "releasing" || handle?.status === "cancelled")
				claim.cancel();
			claim.signal.throwIfAborted();
		};
		const confirmPoseOwnership = async (observed: ModelPose, active: boolean): Promise<ModelPose | undefined> => {
			if (!expectedPose) return observed;
			let current = observed;
			for (let attempt = 0; attempt <= SETTLE_RETRIES; attempt++) {
				if (active) ensureActive();
				if (!sameModel()) {
					if (active) ensureActive();
					return undefined;
				}
				if (
					poseMatches(current, expectedPose) ||
					(pendingPose && poseMatches(current, pendingPose)) ||
					(poseTransition && poseWithinTransition(current, poseTransition))
				)
					return current;
				if (attempt === SETTLE_RETRIES) break;
				await sleep(attempt === 0 ? SETTLE_MARGIN_MS : SETTLE_RETRY_MS, active ? claim.signal : undefined);
				if (active) ensureActive();
				if (!sameModel()) {
					if (active) ensureActive();
					return undefined;
				}
				current = await client.getModelPosition(this.rig.modelID);
			}
			poseOwnershipLost = true;
			cleanup.pose = "unknown";
			return undefined;
		};
		const restore = async (): Promise<boolean> => {
			if (restoreAttempted) return restored;
			restoreAttempted = true;
			if (!moved) return (restored = true);
			if (!base || !expectedPose || poseOwnershipLost || !sameModel()) return (restored = false);
			try {
				const current = await client.getModelPosition(this.rig.modelID);
				const confirmedPose = await confirmPoseOwnership(current, false);
				if (!sameModel() || !confirmedPose) return (restored = false);
				if (!sameModel()) return (restored = false);
				if (!pendingPose && !poseTransition && poseMatches(confirmedPose, base)) return (restored = true);
				pendingPose = { ...base };
				poseTransition = { from: { ...current }, to: { ...base } };
				await client.moveModel({
					...base,
					timeInSeconds: RESTORE_SECONDS,
					valuesAreRelativeToModel: false,
				});
				expectedPose = { ...base };
				pendingPose = undefined;
				await sleep(RESTORE_SECONDS * 1000 + SETTLE_MARGIN_MS);
				poseTransition = undefined;
				if (!sameModel()) return (restored = false);
				const now = await client.getModelPosition(this.rig.modelID);
				restored = sameModel() && poseMatches(now, base);
			} catch {
				restored = false;
			}
			return restored;
		};
		const restoreEffects = async (): Promise<{ tint: boolean; post: boolean }> => {
			if (effectsRestored) return effectsRestored;
			const restoreTint = async () => {
				if (!tintSent) return true;
				try {
					if (!sameModel()) return false;
					await client.getModelPosition(this.rig.modelID);
					if (!sameModel()) return false;
					await client.tintModel({ r: 255, g: 255, b: 255, a: 255 });
					return sameModel();
				} catch {
					return false;
				}
			};
			const restorePost = async () => {
				if (!postSent) return true;
				try {
					if (!sameModel() || !postBaseline) return false;
					await client.getModelPosition(this.rig.modelID);
					if (!sameModel()) return false;
					await client.updatePostProcessing({
						on: postBaseline.active,
						...(postBaseline.active && postBaseline.activePreset ? { preset: postBaseline.activePreset } : {}),
						fadeTime: 0.25,
					});
					if (!sameModel()) return false;
					const now = await client.readPostProcessing();
					return (
						sameModel() &&
						now.active === postBaseline.active &&
						(!(postBaseline.active && postBaseline.activePreset) || now.activePreset === postBaseline.activePreset)
					);
				} catch {
					return false;
				}
			};
			const [tint, post] = await Promise.all([restoreTint(), restorePost()]);
			cleanup.tint = tintSent ? (tint ? "confirmed" : "unknown") : "not_needed";
			cleanup.post = postSent ? (post ? "confirmed" : "unknown") : "not_needed";
			return (effectsRestored = { tint, post });
		};
		const execute = async (): Promise<ToolExecutionResult> => {
			try {
				ensureActive();
				if (hasTransform) {
					base = await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
					ensureActive();
					baseCapturedAtMs = director.clockMs;
					if (![base.positionX, base.positionY, base.rotation, base.size].every(Number.isFinite))
						return toolRejected("invalid_motion", `${label} 无法读取有限的模型位姿，未发送。`);
					expectedPose = { ...base };
					const rotationBase = wrapDeg(base.rotation);
					const violations: string[] = [];
					for (const [index, event] of spatial.entries()) {
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
							`${label} 空间计划与当前模型位姿组合后越界，未发送：${violations.join("；")}`,
							{
								violations,
							},
						);
				}
				const presets = client.getPostProcessingPresets();
				if (presets.length > 0) {
					const missing = [
						...new Set(
							spatial.flatMap((event) =>
								event.effects?.postProcessing?.preset ? [event.effects.postProcessing.preset] : [],
							),
						),
					].filter((preset) => !presets.includes(preset));
					if (missing.length > 0)
						return toolRejected(
							"preset_missing",
							`${label} 引用的后处理预设不存在于 VTS，未发送：${missing.join("、")}。可用预设: ${presets.join("、")}`,
							{
								missingPresets: missing,
								availablePresets: presets,
							},
						);
				}
				if (hasPost) {
					try {
						postBaseline = await withCancellation(client.readPostProcessing(), claim.signal);
						if (
							typeof postBaseline.active !== "boolean" ||
							!(postBaseline.activePreset === null || typeof postBaseline.activePreset === "string")
						)
							throw new Error("Invalid post-processing baseline");
					} catch (error) {
						if (claim.signal.aborted) throw error;
						return toolRejected("effect_baseline_unavailable", `${label} 未执行：无法捕获后处理基线。`);
					}
				}
				ensureActive();
				if (emitTrace && base && baseCapturedAtMs !== undefined) {
					emitTrace({
						phase: "baseline",
						modelID: this.rig.modelID,
						basePose: Object.freeze({ ...base }),
						clockAtMs: baseCapturedAtMs,
					});
				}
				const t0 = director.clockMs;
				const actionNowMs = () => Math.max(0, (director.clockMs - t0) * clip.speed);
				const traceRequest = (
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
				) => {
					if (!emitTrace) return;
					emitTrace({
						phase,
						eventIndex,
						request,
						plannedAtMs,
						clockAtMs,
						actionAtMs: actionNowMs(),
						lateByMs: Math.max(0, actionNowMs() - plannedAtMs),
						...extra,
					});
				};
				const waitUntilActionMs = async (targetMs: number) => {
					while (actionNowMs() < targetMs) {
						ensureActive();
						const remainingWallMs = (targetMs - actionNowMs()) / clip.speed;
						if (!(await sleep(Math.min(DRIVE_INTERVAL_MS, Math.max(1, remainingWallMs)), claim.signal))) ensureActive();
					}
				};
				const sendEffect = async (
					event: CompiledSpatialEvent,
					request: "tintModel" | "updatePostProcessing",
					dispatch: () => Promise<unknown>,
				) => {
					const clockAtMs = director.clockMs;
					traceRequest("dispatch", event.order, request, event.atMs, clockAtMs);
					try {
						await withCancellation(Promise.resolve().then(dispatch), claim.signal);
						ensureActive();
						traceRequest("ack", event.order, request, event.atMs, director.clockMs, { outcome: "confirmed" });
					} catch (error) {
						if (claim.signal.aborted) throw error;
						dispatchFailures.push(
							`事件[${event.order}]分发 ${request}: ${error instanceof Error ? error.message : String(error)}`,
						);
						traceRequest("ack", event.order, request, event.atMs, director.clockMs, { outcome: "failed" });
					}
				};
				const sendEffects = async (event: CompiledSpatialEvent) => {
					const jobs: Promise<void>[] = [];
					if (event.effects?.tint) {
						tintSent = true;
						cleanup.tint = "unknown";
						jobs.push(sendEffect(event, "tintModel", () => client.tintModel(event.effects!.tint!)));
					}
					if (event.effects?.postProcessing) {
						postSent = true;
						cleanup.post = "unknown";
						jobs.push(
							sendEffect(event, "updatePostProcessing", () =>
								client.updatePostProcessing(event.effects!.postProcessing!),
							),
						);
					}
					await Promise.all(jobs);
				};
				const ensureUsefulWindow = (event: CompiledSpatialEvent): void => {
					const span = event.span!;
					const remainingActionMs = span.endMs - actionNowMs();
					if (remainingActionMs <= 0 || remainingActionMs / clip.speed < MIN_USEFUL_MOVE_MS)
						throw new SpatialWindowMissedError();
				};
				handle = director.play(clip, { ...options, signal: claim.signal });
				options.onStarted?.();
				void handle.finished.then((result) => {
					if (result.status === "cancelled") claim.cancel();
				});
				motionResult = settleMotion(client, this.rig, handle, clip, label, options.callName);
				for (const event of spatial) {
					await waitUntilActionMs(event.atMs);
					ensureActive();
					// Per-event VTS read validates model identity even when cached generations lag a model switch.
					const observedPose = await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
					ensureActive();
					if (!(await confirmPoseOwnership(observedPose, true))) {
						if (poseOwnershipLost) throw new ExternalPoseChangedError();
						ensureActive();
					}
					if (!event.span && actionNowMs() >= clip.durationMs) {
						dispatchFailures.push(`事件[${event.order}] marker 已过期`);
						continue;
					}
					const eventLateByMs = Math.max(0, actionNowMs() - event.atMs);
					if (event.transform) ensureUsefulWindow(event);
					if (event.effects) {
						await sendEffects(event);
						if (event.transform) {
							const poseAfterEffects = await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
							ensureActive();
							if (!(await confirmPoseOwnership(poseAfterEffects, true))) {
								if (poseOwnershipLost) throw new ExternalPoseChangedError();
								ensureActive();
							}
							ensureUsefulWindow(event);
						}
					}
					if (!event.transform) continue;
					const span = event.span!;
					if (event.transform.relativeRotation !== undefined) {
						moved = true;
						cleanup.pose = "unknown";
						const total = event.transform.relativeRotation;
						let sentAngle = 0;
						while (actionNowMs() < span.endMs) {
							ensureActive();
							const elapsedActionMs = Math.max(0, actionNowMs() - span.startMs);
							const targetAngle = total * smooth(elapsedActionMs / span.durationMs);
							let delta = targetAngle - sentAngle;
							if (Math.abs(delta) < DRIVE_MIN_DELTA_DEG) {
								const remainingWallMs = (span.endMs - actionNowMs()) / clip.speed;
								if (!(await sleep(Math.min(DRIVE_INTERVAL_MS, Math.max(1, remainingWallMs)), claim.signal)))
									ensureActive();
								continue;
							}
							delta = Math.sign(delta) * Math.min(Math.abs(delta), MAX_RELATIVE_STEP_DEG);
							const plannedAtMs = actionNowMs();
							const clockAtMs = director.clockMs;
							pendingPose = { ...expectedPose!, rotation: expectedPose!.rotation + delta };
							traceRequest("dispatch", event.order, "moveModel", plannedAtMs, clockAtMs, {
								eventLateByMs,
								estimatedEndAtMs: span.endMs,
							});
							await withCancellation(
								client.moveModel({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: delta }),
								claim.signal,
							);
							sentAngle += delta;
							expectedPose = pendingPose;
							pendingPose = undefined;
							ensureActive();
							traceRequest("ack", event.order, "moveModel", plannedAtMs, director.clockMs, {
								eventLateByMs,
								estimatedEndAtMs: span.endMs,
								outcome: "confirmed",
							});
						}
						const residual = total - sentAngle;
						if (Math.abs(residual) > MAX_ENDPOINT_RESIDUAL_DEG) throw new SpatialWindowMissedError();
						if (Math.abs(residual) >= DRIVE_MIN_DELTA_DEG) {
							ensureActive();
							const plannedAtMs = actionNowMs();
							const clockAtMs = director.clockMs;
							pendingPose = { ...expectedPose!, rotation: expectedPose!.rotation + residual };
							traceRequest("dispatch", event.order, "moveModel", plannedAtMs, clockAtMs, {
								eventLateByMs,
								estimatedEndAtMs: span.endMs,
							});
							await withCancellation(
								client.moveModel({ timeInSeconds: 0, valuesAreRelativeToModel: true, rotation: residual }),
								claim.signal,
							);
							sentAngle += residual;
							expectedPose = pendingPose;
							pendingPose = undefined;
							ensureActive();
							traceRequest("ack", event.order, "moveModel", plannedAtMs, director.clockMs, {
								eventLateByMs,
								estimatedEndAtMs: span.endMs,
								outcome: "confirmed",
							});
						}
					} else {
						const rotationBase = wrapDeg(base!.rotation);
						const delta = event.transform.delta ?? {};
						const request = {
							timeInSeconds: (span.endMs - actionNowMs()) / clip.speed / 1000,
							valuesAreRelativeToModel: false,
							positionX: base!.positionX + (delta.x ?? 0),
							positionY: base!.positionY + (delta.y ?? 0),
							rotation: rotationBase + (delta.rotation ?? 0),
							size: base!.size + (delta.size ?? 0),
						};
						if (request.timeInSeconds <= 0) throw new SpatialWindowMissedError();
						moved = true;
						cleanup.pose = "unknown";
						pendingPose = {
							positionX: request.positionX,
							positionY: request.positionY,
							rotation: request.rotation,
							size: request.size,
						};
						poseTransition = { from: { ...expectedPose! }, to: { ...pendingPose } };
						const clockAtMs = director.clockMs;
						traceRequest("dispatch", event.order, "moveModel", span.startMs, clockAtMs, {
							estimatedEndAtMs: span.endMs,
						});
						await withCancellation(client.moveModel(request), claim.signal);
						expectedPose = pendingPose;
						pendingPose = undefined;
						ensureActive();
						traceRequest("ack", event.order, "moveModel", span.startMs, director.clockMs, {
							estimatedEndAtMs: span.endMs,
							outcome: "confirmed",
						});
						await waitUntilActionMs(span.endMs);
						poseTransition = undefined;
					}
				}
				ensureActive();
				let result: ToolExecutionResult | undefined;
				while (!result) {
					ensureActive();
					result = await Promise.race([motionResult!, sleep(50).then(() => undefined)]);
				}
				ensureActive();
				const [poseRestored, restoredEffects] = await Promise.all([
					moved ? restore() : Promise.resolve(true),
					restoreEffects(),
				]);
				restored = poseRestored;
				if (poseOwnershipLost)
					return toolUnknown(`${label} 执行期间检测到模型位姿被手动修改，已保留当前位姿。`, {
						reason: "external_pose_changed",
						restored: false,
						restoredEffects,
					});
				if (!restored)
					return toolUnknown(`${label} 正常回位未确认。`, {
						reason: "spatial_pose_unconfirmed",
						restored: false,
						restoredEffects,
					});
				if (dispatchFailures.length > 0 || !restoredEffects.tint || !restoredEffects.post) {
					const problems = [...dispatchFailures];
					if (!restoredEffects.tint) problems.push("染色归位未确认");
					if (!restoredEffects.post) problems.push("滤镜归位未确认");
					return toolUnknown(`${label} 部分外部效果未完整：${problems.join("；")}`, {
						reason: "spatial_effect_unconfirmed",
						restored: true,
						restoredEffects,
					});
				}
				return {
					...result,
					details: { ...(result.details as Record<string, unknown> | undefined), restored: true, restoredEffects },
				};
			} catch (error) {
				const missedWindow = error instanceof SpatialWindowMissedError;
				const cancelled =
					missedWindow || claim.signal.aborted || handle?.status === "releasing" || handle?.status === "cancelled";
				if (missedWindow) claim.cancel();
				handle?.stop("cut");
				const [confirmed, restoredEffects] = await Promise.all([restore(), restoreEffects()]);
				if (poseOwnershipLost || error instanceof ExternalPoseChangedError)
					return toolUnknown(`${label} 执行期间检测到模型位姿被手动修改，已保留当前位姿。`, {
						reason: "external_pose_changed",
						restored: false,
						restoredEffects,
					});
				if (cancelled) {
					const clean = confirmed && restoredEffects.tint && restoredEffects.post;
					return {
						result: missedWindow
							? `${label} 空间位姿窗口已错过，动作已取消并清理。`
							: clean
								? `${label} 已取消并完成清理。`
								: `${label} 已取消，外部清理未确认。`,
						status: missedWindow ? "unknown" : "cancelled",
						details: {
							reason: missedWindow ? "spatial_window_missed" : "cancelled",
							effectStatus: clean ? (missedWindow ? "unknown" : "cancelled") : "unknown",
							restored: confirmed,
							restoredEffects,
						},
					};
				}
				return toolUnknown(`${label} 执行异常：${error instanceof Error ? error.message : String(error)}`, {
					reason: "spatial_execution_failed",
					...(moved ? { restored: confirmed } : {}),
					restoredEffects,
				});
			} finally {
				if (poseOwnershipLost) cleanup.pose = "unknown";
				else if (moved) cleanup.pose = restored ? "confirmed" : "unknown";
				completeCleanup({ kind: "spatial", ...cleanup, hotkey: "not_needed" });
				handle?.stop("cut");
				if (this.spatialClaim === claim) this.spatialClaim = undefined;
				claim.release();
			}
		};
		const result = await execute();
		return { ...result, details: { ...(result.details as object), cleanup: { ...cleanup } } };
	}
	async runCostume(entry: CatalogCostumeEntry, signal?: AbortSignal): Promise<ToolExecutionResult> {
		const hotkey = this.client.findHotkey(entry.hotkeyID);
		if (!hotkey) return toolRejected("hotkey_missing", `热键未在当前 VTS 模型登记: "${entry.hotkeyID}"。`);
		const claim = this.acquireClaim(["effect:*"], "costume", signal);
		if ("status" in claim) return claim;
		const modelGeneration = this.client.getModelGeneration(),
			connectionGeneration = this.client.getInjectionStats().generation,
			catalogGeneration = this.options.getCatalogGeneration();
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
			accepted =
				this.identityMatched() &&
				this.client.isConnected() &&
				modelGeneration === this.client.getModelGeneration() &&
				connectionGeneration === this.client.getInjectionStats().generation &&
				catalogGeneration === this.options.getCatalogGeneration();
			if (!accepted) return toolUnknown("外观请求返回时执行环境已变化，效果未知。");
			if (claim.signal.aborted)
				return {
					result: "外观请求已接受；调用已取消。",
					status: "cancelled",
					details: { effectStatus: "accepted", hotkey: "accepted", verification: "local_intent" },
				};
			return toolSucceeded(`${entry.id} OK`, {
				effectStatus: "accepted",
				verification: "local_intent",
				hotkey: "accepted",
			});
		} catch (error) {
			return toolUnknown(`外观触发结果不明：${error instanceof Error ? error.message : String(error)}`);
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
