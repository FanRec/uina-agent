import type { ToolExecutionResult } from "../../../src/tools/broker.js";
import type { ModelRig } from "./adapter/rig.js";
import { VTSClient } from "./adapter/vts-client.js";
import type { CatalogMotionEntry, CatalogCostumeEntry } from "./authoring/catalog.js";
import type { CompiledMotion } from "./authoring/motion.js";
import { MotionDirector, type PlayOptions, type MotionHandle, type ExclusiveClaim } from "./director/director.js";
import { toolRejected, toolSucceeded, toolUnknown, withCancellation, settleMotion } from "./results.js";
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
}
export type SpatialOptions = PlayOptions & { callName?: string; onStarted?: () => void };
const SETTLE_MARGIN_MS = 60;
/** 回读核实重试：VTS 插值结算存在滞后，失败再等 SETTLE_RETRY_MS 重读，重试用尽才如实判未确认。 */
const SETTLE_RETRIES = 2;
const SETTLE_RETRY_MS = 250;
const RESTORE_SECONDS = 0.25;

const VTS_MOVE_LIMITS = { position: 1000, rotation: 360, size: 100 } as const;

type ModelPose = { positionX: number; positionY: number; rotation: number; size: number };

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
	async runSpatial(
		entry: CatalogMotionEntry,
		clip: CompiledMotion,
		options: SpatialOptions,
	): Promise<ToolExecutionResult> {
		const director = this.director,
			client = this.client,
			playOptions = options;
		const label = `动作 "${entry.description}"`;
		const spatial = entry.spatial;
		if (!spatial) return toolRejected("invalid_motion", "缺少空间特技定义。");
		const hasEffects = spatial.segments.some((segment) => segment.effects?.tint || segment.effects?.postProcessing);
		const hasPost = spatial.segments.some((segment) => segment.effects?.postProcessing);
		const hasTransform = spatial.segments.some((segment) => Object.values(segment.delta).some((value) => value !== 0));
		const claim = this.acquireClaim(
			["model:transform", ...(hasEffects ? ["effect:*"] : [])],
			"motion",
			options.signal,
			true,
		);
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
		let handle: MotionHandle | undefined;
		let motionResult: Promise<ToolExecutionResult> | undefined;
		let moved = false;
		let restored = true;
		let restoreAttempted = false;
		/** 进入时捕获的后处理状态（缺失则在副作用前拒绝）。tint 协议无读 API，按所有权模型恢复为白。 */
		let postBaseline: { active: boolean; activePreset: string | null } | undefined;
		/** 只有特技真的分发过效果才做效果归位——否则白/关复位会踩掉用户自己的染色与滤镜。 */
		let tintSent = false,
			postSent = false;
		const cleanup: MutableCleanup = { pose: "not_needed", tint: "not_needed", post: "not_needed" };
		let effectsRestored: { tint: boolean; post: boolean } | undefined;
		const dispatchFailures: string[] = [];
		const ensureActive = () => {
			if (!this.focused || !sameModel() || handle?.status === "releasing" || handle?.status === "cancelled")
				claim.cancel();
			claim.signal.throwIfAborted();
		};
		const restore = async (): Promise<boolean> => {
			if (restoreAttempted) return restored;
			restoreAttempted = true;
			restored = !moved || (base !== undefined && (await this.restorePose(client, base, sameModel)));
			return restored;
		};
		/** 三位一体归位的效果侧：染色刷白 + 后处理恢复进入时开关与具名 preset（无捕获则关闭；其余滤镜参数经 setAllOtherValuesToDefault 重置为默认，不逐项保真），逐项如实结算。 */
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
				base = await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
				ensureActive();
				// 组合值前瞻校验（302 根因修复）：实发绝对值 = base + delta，base 此刻已知——任一段越界
				// 即在发送前整体失败，不发半程特技。回读 rotation 为正表示法（-12 回读 348），合成前
				// 须 wrapDeg 归一化，否则正 delta 会越过 360（spin 的 rotation:360 恰好压边界即被拒）。
				const rotationBase = wrapDeg(base.rotation);
				const violations: string[] = [];
				for (const [index, segment] of spatial.segments.entries()) {
					const target = {
						positionX: base.positionX + (segment.delta.x ?? 0),
						positionY: base.positionY + (segment.delta.y ?? 0),
						rotation: rotationBase + (segment.delta.rotation ?? 0),
						size: base.size + (segment.delta.size ?? 0),
					};
					if (
						Math.abs(target.positionX) > VTS_MOVE_LIMITS.position ||
						Math.abs(target.positionY) > VTS_MOVE_LIMITS.position
					)
						violations.push(
							`段[${index}] position=(${target.positionX}, ${target.positionY}) 超出 ±${VTS_MOVE_LIMITS.position}`,
						);
					if (Math.abs(target.rotation) > VTS_MOVE_LIMITS.rotation)
						violations.push(`段[${index}] rotation=${target.rotation} 超出 ±${VTS_MOVE_LIMITS.rotation}`);
					if (Math.abs(target.size) > VTS_MOVE_LIMITS.size)
						violations.push(`段[${index}] size=${target.size} 超出 ±${VTS_MOVE_LIMITS.size}`);
				}
				if (violations.length > 0)
					return toolRejected(
						"invalid_motion",
						`${label} 空间轨迹与当前模型位姿组合后越界，未发送：${violations.join("；")}。`,
						{ violations },
					);
				// 预设前瞻校验（1203 根因修复）：preset 是 VTS Effects 环境文件名，不可假设存在；
				// 可用清单可枚举（PostProcessingListRequest），任一段引用缺失即发送前整体拒绝，零半程特效。
				// 空清单（旧版 VTS / 刷新失败）= 未知，放行走运行时裁决。
				const presets = client.getPostProcessingPresets();
				if (presets.length > 0) {
					const missing = [
						...new Set(
							spatial.segments.flatMap((s) =>
								s.effects?.postProcessing?.preset ? [s.effects.postProcessing.preset] : [],
							),
						),
					].filter((p) => !presets.includes(p));
					if (missing.length > 0)
						return toolRejected(
							"preset_missing",
							`${label} 引用的后处理预设不存在于 VTS，未发送：${missing.join("、")}。可用预设: ${presets.join("、")}。`,
							{ missingPresets: missing, availablePresets: presets },
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
				handle = director.play(clip, { ...playOptions, signal: claim.signal });
				options.onStarted?.();
				void handle.finished.then((result) => {
					if (result.status === "cancelled") claim.cancel();
				});
				motionResult = settleMotion(client, this.rig, handle, clip, label, options.callName);
				for (const [index, segment] of spatial.segments.entries()) {
					ensureActive();
					await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
					ensureActive();

					// 效果与位姿同段顺序派发：先等效果请求落地（allSettled，失败仅记录继续），再发位姿移动。
					// 位姿失败沿用既有语义：中止后续段并走归位守护；结算如实呈现。
					const effectDispatches: Promise<unknown>[] = [];
					if (segment.effects?.tint) {
						tintSent = true;
						cleanup.tint = "unknown";
						effectDispatches.push(client.tintModel(segment.effects.tint));
					}
					if (segment.effects?.postProcessing) {
						postSent = true;
						cleanup.post = "unknown";
						effectDispatches.push(client.updatePostProcessing(segment.effects.postProcessing));
					}
					const dispatched = await withCancellation(Promise.allSettled(effectDispatches), claim.signal);
					ensureActive();
					for (const [slot, outcome] of dispatched.entries())
						if (outcome.status === "rejected")
							dispatchFailures.push(
								`段[${index}]分发[${slot}]: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
							);
					if (hasTransform && segment.delta && Object.keys(segment.delta).length > 0) {
						moved = true;
						cleanup.pose = "unknown";
						await withCancellation(
							client.moveModel({
								timeInSeconds: segment.durationMs / 1000,
								valuesAreRelativeToModel: false,
								positionX: base.positionX + (segment.delta.x ?? 0),
								positionY: base.positionY + (segment.delta.y ?? 0),
								rotation: rotationBase + (segment.delta.rotation ?? 0),
								size: base.size + (segment.delta.size ?? 0),
							}),
							claim.signal,
						);
					}
					// 动画从 VTS 收到请求起跑 timeInSeconds；ACK 后全额等待，宁过勿欠——
					// 旧实现从效果派发前计时扣除，每段被抢跑"派发+往返"时长，末段插值未落地
					// 即回读到中间值（close_up"正常回位未确认"根因）。
					if (!(await sleep(segment.durationMs + (segment.holdMs ?? 0), claim.signal))) break;
				}
				ensureActive();
				// 末段不得携带 effects（编译期禁止）：效果复位由守护在此统一执行，作者不写重置值。
				const restoredEffects = await restoreEffects();
				restored = !moved;
				for (let attempt = 0; attempt <= SETTLE_RETRIES && !restored; attempt++) {
					ensureActive();
					await sleep(attempt === 0 ? SETTLE_MARGIN_MS : SETTLE_RETRY_MS, claim.signal);
					ensureActive();
					const now = await withCancellation(client.getModelPosition(this.rig.modelID), claim.signal);
					ensureActive();
					restored = sameModel() && poseMatches(now, base);
				}
				if (!restored) {
					handle.stop("cut");
					// restore() 内部自行等待 RESTORE_SECONDS 并回读确认；此处取其确认值如实上报，
					// 不能复用回读前的判定（陈旧 false 会把"实际已归位"报成"未确认"）。
					const confirmed = await restore();
					return toolUnknown(`${label} 正常回位未确认。`, { restored: confirmed, restoredEffects });
				}
				if (dispatchFailures.length > 0 || restoredEffects.tint === false || restoredEffects.post === false) {
					const problems = [...dispatchFailures];
					if (restoredEffects.tint === false) problems.push("染色归位未确认");
					if (restoredEffects.post === false) problems.push("滤镜归位未确认");
					return toolUnknown(`${label} 部分外部效果未完整：${problems.join("；")}`, {
						restored: true,
						restoredEffects,
					});
				}
				// 失联会停止合成时钟；空间表演不能永远等一个不再推进的句柄。
				let result: ToolExecutionResult | undefined;
				while (!result) {
					ensureActive();
					result = await Promise.race([motionResult, sleep(50).then(() => undefined)]);
				}
				ensureActive();
				return {
					...result,
					details: { ...(result.details as Record<string, unknown> | undefined), restored: true, restoredEffects },
				};
			} catch (error) {
				const cancelled = claim.signal.aborted || handle?.status === "releasing" || handle?.status === "cancelled";
				handle?.stop("cut");
				const confirmed = await restore();
				const restoredEffects = await restoreEffects();
				if (cancelled) {
					const clean = confirmed && restoredEffects.tint && restoredEffects.post;
					return {
						result: clean ? `${label} 已取消并完成清理。` : `${label} 已取消，外部清理未确认。`,
						status: "cancelled",
						details: {
							reason: "cancelled",
							effectStatus: clean ? "cancelled" : "unknown",
							restored: confirmed,
							restoredEffects,
						},
					};
				}
				return toolUnknown(`${label} 执行异常：${error instanceof Error ? error.message : String(error)}`, {
					...(moved ? { restored: confirmed } : {}),
					restoredEffects,
				});
			} finally {
				cleanup.pose = moved ? (restored ? "confirmed" : "unknown") : "not_needed";
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
	private async restorePose(client: VTSClient, base: ModelPose, sameModel: () => boolean): Promise<boolean> {
		try {
			if (!sameModel()) return false;
			await client.getModelPosition(this.rig.modelID);
			if (!sameModel()) return false;
			await client.moveModel({
				...base,
				timeInSeconds: RESTORE_SECONDS,
				valuesAreRelativeToModel: false,
			});
			await sleep(RESTORE_SECONDS * 1000 + SETTLE_MARGIN_MS);
			if (!sameModel()) return false;
			const now = await client.getModelPosition(this.rig.modelID);
			return sameModel() && poseMatches(now, base);
		} catch {
			return false;
		}
	}
}
