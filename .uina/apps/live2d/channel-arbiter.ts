import {
	ALL_CHANNELS,
	CHANNEL_PRIORITY,
	type ChannelClaimOptions,
	type ChannelLease,
	type Live2DChannel,
} from "./types.js";

interface ChannelSlot {
	currentLease: InternalLease | null;
}

interface InternalLease extends ChannelLease {
	isReleased: boolean;
	onEvicted?: (channel: Live2DChannel) => void;
	abortController?: AbortController;
}

/**
 * Live2D 内部私有 5 通道仲裁器 (ChannelArbiter)
 * 职责：
 * 1. 严格在内部管理 mouth, eyes, gaze, head, torso 五个物理通道，杜绝向外泄露通道细节；
 * 2. 基于优先级的抢占与租约（RAII Lease）管理；
 * 3. 支持超时、取消信号与退避降级；
 * 4. 驱动语义 Cue 分发与原子租约保护。
 */
export class ChannelArbiter {
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
				oldLease.onEvicted?.(ch);
			}
			const remainingChannels = oldLease.channels.filter((c) => !acquiredChannels.includes(c));
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
			channels: Object.freeze([...acquiredChannels]),
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
