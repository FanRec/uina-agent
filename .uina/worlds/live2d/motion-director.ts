import {
	ALL_CHANNELS,
	CHANNEL_PRIORITY,
	abortableDelay,
	clampLive2DParam,
	type ChannelClaimOptions,
	type ChannelLease,
	type ExpressParams,
	type Live2DChannel,
	PARAM_CHANNEL_MAP,
} from "./types.js";
import { BodyDirector } from "./body-director.js";
import { DEFAULT_EXPRESSIVE_INTENSITY, resolveBeatToParams } from "./parameter-mapper.js";
import { PhysiologicalNoise } from "./physiological-noise.js";

interface ChannelSlot {
	currentLease: InternalLease | null;
}

interface InternalLease extends ChannelLease {
	channels: Live2DChannel[];
	isReleased: boolean;
	onEvicted?: (channel: Live2DChannel) => void;
	abortController?: AbortController;
}

/**
 * Live2D 内部私有通道租约管理器
 * 职责：
 * 1. 严格在内部管理 mouth, eyes, gaze, head, torso 五个物理通道，杜绝向外泄露通道细节；
 * 2. 基于优先级的抢占与租约（RAII Lease）管理；
 * 3. 支持超时、取消信号与退避降级；
 * 4. 驱动语义 Cue 分发与原子租约保护。
 */
class MotionLeaseManager {
	private readonly channels: Map<Live2DChannel, ChannelSlot> = new Map();
	private cueDispatcher?: (cueId: string) => unknown;
	private leaseCounter = 0;

	constructor() {
		for (const ch of ALL_CHANNELS) {
			this.channels.set(ch, { currentLease: null });
		}
	}

	/**
	 * 设置语义 Cue 接收处理器
	 */
	setCueDispatcher(dispatcher: (cueId: string) => unknown): void {
		this.cueDispatcher = dispatcher;
	}

	/**
	 * 分发语义 Cue (如 warm_smile, curious_tilt)
	 */
	dispatchCue(cueId: string): void {
		if (this.cueDispatcher) {
			void this.cueDispatcher(cueId);
		}
	}

	/**
	 * 申请锁定指定通道
	 */
	async claim(
		channelsToClaim: readonly Live2DChannel[],
		options?: ChannelClaimOptions,
	): Promise<ChannelLease> {
		const opts = options ?? {};
		if (opts.signal?.aborted) {
			throw new Error(`Channel claim aborted before start: ${opts.reason ?? "action"}`);
		}

		const { acquiredChannels, leasesToEvict } = this.planAcquisition(channelsToClaim, opts);
		this.evictLeases(leasesToEvict, acquiredChannels);
		return this.createLease(acquiredChannels, opts);
	}

	/**
	 * 策略阶段：冲突检测与驱逐计划生成
	 */
	private planAcquisition(
		channelsToClaim: readonly Live2DChannel[],
		options: ChannelClaimOptions,
	): { acquiredChannels: Live2DChannel[]; leasesToEvict: Set<InternalLease> } {
		const priority = options.priority ?? CHANNEL_PRIORITY.ACTION;
		const reason = options.reason ?? "action";
		const allowDegrade = options.allowDegrade ?? false;
		const preemptSameReason = options.preemptSameReason ?? false;
		const preemptSamePriority = options.preemptSamePriority ?? false;

		const acquiredChannels: Live2DChannel[] = [];
		const leasesToEvict = new Set<InternalLease>();

		for (const ch of channelsToClaim) {
			const slot = this.channels.get(ch);
			if (!slot) continue;

			if (slot.currentLease && !slot.currentLease.isReleased) {
				const currentPriority = slot.currentLease.priority;
				const isSameReason = preemptSameReason && slot.currentLease.reason === reason;
				const canPreempt =
					currentPriority < priority ||
					(currentPriority === priority && (isSameReason || preemptSamePriority));

				if (!canPreempt) {
					if (!allowDegrade) {
						throw new Error(
							`Channel '${ch}' is locked by active task (${slot.currentLease.reason ?? "active"}, priority: ${currentPriority} >= ${priority})`,
						);
					}
					continue;
				}
				leasesToEvict.add(slot.currentLease);
			}
			acquiredChannels.push(ch);
		}

		if (acquiredChannels.length === 0 && channelsToClaim.length > 0) {
			throw new Error(`Failed to claim any requested channels: [${channelsToClaim.join(", ")}]`);
		}

		return { acquiredChannels, leasesToEvict };
	}

	/**
	 * 驱逐阶段：剥离通道，当无剩余通道或声明原子性时全量终止旧租约
	 */
	private evictLeases(leasesToEvict: Set<InternalLease>, acquiredChannels: Live2DChannel[]): void {
		for (const oldLease of leasesToEvict) {
			for (const ch of acquiredChannels) {
				if (oldLease.channels.includes(ch)) oldLease.onEvicted?.(ch);
			}
			const remainingChannels = oldLease.channels.filter((c) => !acquiredChannels.includes(c));
			oldLease.channels = remainingChannels;
			// 若旧租约无剩余通道，或声明了原子性 (atomic: true)，则全量中断与释放，防止半残动作
			if (remainingChannels.length === 0 || oldLease.atomic) {
				oldLease.release();
				oldLease.abortController?.abort();
			}
		}
	}

	/**
	 * 签约阶段：构造 RAII 租约并绑定 AbortSignal 与通道槽
	 */
	private createLease(
		acquiredChannels: Live2DChannel[],
		options: ChannelClaimOptions,
	): ChannelLease {
		const priority = options.priority ?? CHANNEL_PRIORITY.ACTION;
		const reason = options.reason ?? "action";
		const leaseId = `lease_${++this.leaseCounter}_${reason}`;
		const leaseController = new AbortController();
		let released = false;

		const lease: InternalLease = {
			id: leaseId,
			channels: [...acquiredChannels],
			priority,
			reason,
			signal: leaseController.signal,
			abortController: leaseController,
			atomic: options.atomic,
			isReleased: false,
			release: () => {
				if (released) return;
				released = true;
				lease.isReleased = true;
				for (const ch of acquiredChannels) {
					const slot = this.channels.get(ch);
					if (slot && slot.currentLease === lease) {
						slot.currentLease = null;
					}
				}
			},
		};

		for (const ch of acquiredChannels) {
			const slot = this.channels.get(ch)!;
			slot.currentLease = lease;
		}

		if (options.signal) {
			if (options.signal.aborted) {
				leaseController.abort();
				lease.release();
			} else {
				options.signal.addEventListener(
					"abort",
					() => {
						leaseController.abort();
						lease.release();
					},
					{ once: true },
				);
			}
		}

		return lease;
	}

	/**
	 * 申请锁定所有通道 (用于 costume 换装、flip 全身翻转、safeStop 急停等)
	 */
	async claimAllChannels(
		reason: string,
		signal?: AbortSignal,
		priority = CHANNEL_PRIORITY.ACTION,
		atomic = true,
	): Promise<ChannelLease> {
		return this.claim(ALL_CHANNELS, { priority, reason, signal, allowDegrade: false, atomic });
	}

	/**
	 * 释放租约
	 */
	release(lease: ChannelLease): void {
		lease.release();
	}

	/**
	 * 检查通道当前是否被锁定
	 */
	isChannelLocked(channel: Live2DChannel, minPriority: number = CHANNEL_PRIORITY.IDLE): boolean {
		const slot = this.channels.get(channel);
		if (!slot || !slot.currentLease || slot.currentLease.isReleased) return false;
		return slot.currentLease.priority >= minPriority;
	}

	/**
	 * 获取当前所有被占用的租约
	 */
	getActiveLeases(): ChannelLease[] {
		const leases = new Set<ChannelLease>();
		for (const slot of this.channels.values()) {
			if (slot.currentLease && !slot.currentLease.isReleased) {
				leases.add(slot.currentLease);
			}
		}
		return [...leases];
	}

	/**
	 * 强制释放所有通道 (急停恢复使用)
	 */
	releaseAll(): void {
		for (const slot of this.channels.values()) {
			if (slot.currentLease) {
				slot.currentLease.abortController?.abort();
				slot.currentLease.release();
				slot.currentLease = null;
			}
		}
	}
}

/**
 * 动作合成器：物理基准姿态、生理噪声、语流律动与表情节拍的逐帧合成。
 * 只读消费租约状态（isChannelLocked），不拥有租约。
 */
class MotionFrameComposer {
	readonly noise = new PhysiologicalNoise();
	readonly bodyDirector = new BodyDirector();

	private currentBeatsController: AbortController | null = null;
	private currentAllowedChannels?: readonly Live2DChannel[];
	private speechPhase = 0;
	private speechActivity = 0;

	constructor(private readonly arbiter: MotionLeaseManager) {}

	getSpeechActivity(): number {
		return this.speechActivity;
	}

	resetSpeechActivity(): void {
		this.speechActivity = 0;
		this.speechPhase = 0;
	}

	isPlayingExpressiveBeats(): boolean {
		return this.currentBeatsController !== null && !this.currentBeatsController.signal.aborted;
	}

	getActiveExpressiveParams(): readonly string[] {
		if (!this.isPlayingExpressiveBeats()) return [];
		if (!this.currentAllowedChannels) return Object.keys(PARAM_CHANNEL_MAP);
		const allowed = new Set(this.currentAllowedChannels);
		return Object.keys(PARAM_CHANNEL_MAP).filter((param) => {
			const ch = PARAM_CHANNEL_MAP[param];
			return ch && allowed.has(ch);
		});
	}

	triggerAcousticImpulse(magnitude = 1.0): void {
		if (this.arbiter.isChannelLocked("head", CHANNEL_PRIORITY.CUE)) {
			return;
		}
		const clampedMag = Math.max(0, Math.min(1.0, magnitude));
		this.bodyDirector.applyVelocityImpulse("ParamAngleY", -115.0 * clampedMag);
	}

	resetAcousticImpulse(): void {
		this.bodyDirector.resetVelocity("ParamAngleY");
	}

	async playExpressiveBeats(
		params: ExpressParams,
		options?: { signal?: AbortSignal; allowedChannels?: readonly Live2DChannel[] } | AbortSignal,
	): Promise<void> {
		const signal = options instanceof AbortSignal ? options : options?.signal;
		const allowedChannels = options instanceof AbortSignal ? undefined : options?.allowedChannels;

		this.currentBeatsController?.abort();
		const internalController = new AbortController();
		this.currentBeatsController = internalController;
		this.currentAllowedChannels = allowedChannels;

		const onExternalAbort = () => internalController.abort();
		if (signal) {
			if (signal.aborted) {
				internalController.abort();
			} else {
				signal.addEventListener("abort", onExternalAbort, { once: true });
			}
		}

		try {
			const beats = params.beats && params.beats.length > 0
				? params.beats
				: [{ head: params.head, gaze: params.gaze, face: params.face, hold_ms: 1000 }];
			const intensity = params.intensity ?? DEFAULT_EXPRESSIVE_INTENSITY;

			for (const beat of beats) {
				if (internalController.signal.aborted) break;

				const targets = resolveBeatToParams(beat, intensity);
				const filtered = allowedChannels
					? targets.filter((t) => {
						const ch = PARAM_CHANNEL_MAP[t.name];
						return ch && allowedChannels.includes(ch);
					})
					: targets;

				if (filtered.length > 0) {
					this.bodyDirector.transitionTargets(filtered, 250);
				}

				const holdMs = Math.max(200, Math.min(3000, beat.hold_ms ?? 800));
				await abortableDelay(holdMs, internalController.signal);
			}

			if (!internalController.signal.aborted) {
				const neutralTargets: Record<string, number> = {};
				for (const [name, ch] of Object.entries(PARAM_CHANNEL_MAP)) {
					if (!allowedChannels || allowedChannels.includes(ch)) {
						neutralTargets[name] = this.bodyDirector.getBasePoseTarget(name);
					}
				}
				if (Object.keys(neutralTargets).length > 0) {
					this.bodyDirector.transitionPose(neutralTargets, 400);
				}
			}
		} finally {
			if (signal) {
				signal.removeEventListener("abort", onExternalAbort);
			}
			if (this.currentBeatsController === internalController) {
				this.currentBeatsController = null;
				this.currentAllowedChannels = undefined;
			}
		}
	}

	abortAllMotions(): void {
		this.currentBeatsController?.abort();
		this.currentBeatsController = null;
		this.currentAllowedChannels = undefined;
		this.speechActivity = 0;
		this.speechPhase = 0;
		this.bodyDirector.resetVelocity("ParamAngleY");
		this.bodyDirector.dampenToNeutral();
	}

	compose(deltaMs: number, options?: { speechEnergy?: number }): Record<string, number> {
		const dt = Math.max(0.0001, deltaMs * 0.001);
		const speechEnergy = options?.speechEnergy ?? 0;

		// 语流连续律动动态跟踪 (Attack: ~120ms 爬升, Decay: ~250ms 半衰期指数平滑衰减)
		if (speechEnergy > 0.02) {
			const targetActivity = Math.min(1.0, speechEnergy * 1.5);
			this.speechActivity += (targetActivity - this.speechActivity) * Math.min(1.0, dt * 8.0);
			this.speechPhase += dt;
		} else if (this.speechActivity > 0) {
			this.speechActivity *= Math.exp(-deltaMs / 250);
			if (this.speechActivity < 0.005) {
				this.speechActivity = 0;
			} else {
				this.speechPhase += dt * 0.5;
			}
		}

		const isTorsoLocked = this.arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.CUE);
		const isHeadLocked = this.arbiter.isChannelLocked("head", CHANNEL_PRIORITY.CUE);

		const noise = this.noise.tick(deltaMs);
		const merged = this.bodyDirector.tick(deltaMs, { isTorsoLocked });

		for (const k in noise) {
			const ch = PARAM_CHANNEL_MAP[k];
			const isLocked = ch ? this.arbiter.isChannelLocked(ch, CHANNEL_PRIORITY.ACTION) : false;
			const nVal = isLocked ? 0 : noise[k]!;

			if (k === "ParamEyeLOpen" || k === "ParamEyeROpen") {
				const blinkFactor = isLocked ? 1.0 : nVal;
				merged[k] = clampLive2DParam(k, (merged[k] ?? 1.0) * blinkFactor);
			} else {
				merged[k] = clampLive2DParam(k, (merged[k] ?? 0) + nVal);
			}
		}

		// 语流连续律动注入 (当未被高优先级动作锁定通道时，赋予自然说话体态节律)
		if (this.speechActivity > 0.001) {
			const p = this.speechPhase;
			const act = this.speechActivity;

			if (!isTorsoLocked) {
				// 躯干左右微晃重心游移 (双谐波复合波：主频 ~0.65Hz 对应意群句式周期约 1.5s，次频 ~1.3Hz 对应音节音步)
				const bodySwayX = (Math.sin(p * 4.1) * 0.72 + Math.sin(p * 2.05 + 0.5) * 0.28) * 6.0 * act;
				// 胸腔起伏与说话呼吸前倾
				const bodyPitchY = (Math.sin(p * 3.2 + 1.0) * 0.6 + Math.cos(p * 1.6) * 0.4) * 4.0 * act;
				// 脊柱侧倾配合重心转移
				const bodyRollZ = Math.cos(p * 4.1 + 0.8) * 3.5 * act;

				merged.ParamBodyAngleX = clampLive2DParam("ParamBodyAngleX", (merged.ParamBodyAngleX ?? 0) + bodySwayX);
				merged.ParamBodyAngleY = clampLive2DParam("ParamBodyAngleY", (merged.ParamBodyAngleY ?? 0) + bodyPitchY);
				merged.ParamBodyAngleZ = clampLive2DParam("ParamBodyAngleZ", (merged.ParamBodyAngleZ ?? 0) + bodyRollZ);
			}

			if (!isHeadLocked) {
				// 头部语流随动轻晃 (与躯干柔和耦合，形成生动的三维二次元律动)
				const headSwayZ = Math.sin(p * 4.1 + 1.2) * 3.8 * act;
				const headSwayX = Math.sin(p * 2.05) * 2.8 * act;
				// 语流重音微点头律动 (主导节拍随语流起伏，在音步重音处产生自然的下潜微点头)
				const headNodY = (Math.sin(p * 4.1 - 0.3) * 0.65 + Math.sin(p * 8.2) * 0.35) * -3.2 * act;

				merged.ParamAngleZ = clampLive2DParam("ParamAngleZ", (merged.ParamAngleZ ?? 0) + headSwayZ);
				merged.ParamAngleX = clampLive2DParam("ParamAngleX", (merged.ParamAngleX ?? 0) + headSwayX);
				merged.ParamAngleY = clampLive2DParam("ParamAngleY", (merged.ParamAngleY ?? 0) + headNodY);
			}
		}

		return merged;
	}
}

/**
 * 单一动作所有者：租约（MotionLeaseManager）与合成（MotionFrameComposer）
 * 由同一对象拥有并以组合方式聚合，公开面保持稳定。
 * 此前用"composer 持 protected arbiter + director 继承透传"的假继承，
 * 实质是两个正交职责硬拗成一条继承链；组合让所有权一目了然。
 */
export class MotionDirector {
	private readonly arbiter = new MotionLeaseManager();
	private readonly composer: MotionFrameComposer;
	readonly noise: PhysiologicalNoise;
	readonly bodyDirector: BodyDirector;

	constructor() {
		this.composer = new MotionFrameComposer(this.arbiter);
		this.noise = this.composer.noise;
		this.bodyDirector = this.composer.bodyDirector;
	}

	// —— 合成层委托 ——

	compose(deltaMs: number, options?: { speechEnergy?: number }): Record<string, number> {
		return this.composer.compose(deltaMs, options);
	}

	getSpeechActivity(): number {
		return this.composer.getSpeechActivity();
	}

	resetSpeechActivity(): void {
		this.composer.resetSpeechActivity();
	}

	isPlayingExpressiveBeats(): boolean {
		return this.composer.isPlayingExpressiveBeats();
	}

	getActiveExpressiveParams(): readonly string[] {
		return this.composer.getActiveExpressiveParams();
	}

	triggerAcousticImpulse(magnitude = 1.0): void {
		this.composer.triggerAcousticImpulse(magnitude);
	}

	resetAcousticImpulse(): void {
		this.composer.resetAcousticImpulse();
	}

	async playExpressiveBeats(
		params: ExpressParams,
		options?: { signal?: AbortSignal; allowedChannels?: readonly Live2DChannel[] } | AbortSignal,
	): Promise<void> {
		return this.composer.playExpressiveBeats(params, options);
	}

	abortAllMotions(): void {
		this.composer.abortAllMotions();
	}

	// —— 仲裁层委托 ——

	async claim(
		channels: readonly Live2DChannel[],
		options?: ChannelClaimOptions,
	): Promise<ChannelLease> {
		return this.arbiter.claim(channels, options);
	}

	async claimAllChannels(
		reason: string,
		signal?: AbortSignal,
		priority = CHANNEL_PRIORITY.ACTION,
		atomic = true,
	): Promise<ChannelLease> {
		return this.arbiter.claimAllChannels(reason, signal, priority, atomic);
	}

	release(lease: ChannelLease): void {
		this.arbiter.release(lease);
	}

	isChannelLocked(channel: Live2DChannel, minPriority: number = CHANNEL_PRIORITY.IDLE): boolean {
		return this.arbiter.isChannelLocked(channel, minPriority);
	}

	getActiveLeases(): readonly ChannelLease[] {
		return this.arbiter.getActiveLeases();
	}

	releaseAll(): void {
		this.arbiter.releaseAll();
	}

	dispatchCue(cueId: string): void {
		this.arbiter.dispatchCue(cueId);
	}

	setCueDispatcher(dispatcher: (cueId: string) => unknown): void {
		this.arbiter.setCueDispatcher(dispatcher);
	}
}
