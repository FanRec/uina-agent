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
import {
	DEFAULT_EXPRESSIVE_INTENSITY,
	REFLEX_POSES,
	REFLEX_POSE_PARAMS,
	computeVORCompensation,
	resolveBeatToParams,
	type ReflexStateKey,
} from "./parameter-mapper.js";
import { PhysiologicalNoise } from "./physiological-noise.js";

// 静默期 idle 律动：长静默（> IDLE_RAMP_DELAY_MS）时体态律动降档续跳而非冻结——
// 躯干死僵比发条感更像断电。幅度地板按感知阈标定：0.7 × 9° = ±6.3°，
// 跨过语流律动标定注释的 ±6° 线；相位速率贴呼吸浮动（0.85+0.3×breath），
// 与 3.6s 呼吸形成慢拍频。短停顿仍走"×0.25 近静止"裁定，两者以静默时长区分。
const IDLE_ACTIVITY = 0.7;
const IDLE_PHASE_RATE = 0.5;
const IDLE_RAMP_DELAY_MS = 4000;
const IDLE_BLEND_TAU_MS = 1000;
// 语流停顿相位速率（"近静止"裁定）。已知权衡：极安静语流（活动度 < 0.7 地板）
// 恢复说话的头 ~3s 幅度由 blend 残留托底缓降——单调无跳变，裁定为可接受的"收得慢"。
const PAUSE_PHASE_RATE = 0.25;

/**
 * 内部租约：通道占用记录 + 内部中止句柄。
 * channels 可变：被更高优先级抢占时从租约上剥离尚存的通道。
 */
interface ActiveLease extends ChannelLease {
	channels: Live2DChannel[];
	isReleased: boolean;
	abortController?: AbortController;
}

/**
 * 通道占用表：单线程 60Hz 循环里的并发护栏，不是任务系统。
 * 每个通道至多一个占用者；抢占 = 通道换主，被抢空的租约（或 atomic 租约）整体中止。
 */
class MotionLeaseManager {
	private readonly occupants = new Map<Live2DChannel, ActiveLease>();
	private leaseCounter = 0;

	async claim(
		channelsToClaim: readonly Live2DChannel[],
		options?: ChannelClaimOptions,
	): Promise<ChannelLease> {
		const opts = options ?? {};
		if (opts.signal?.aborted) {
			throw new Error(`Channel claim aborted before start: ${opts.reason ?? "action"}`);
		}

		const priority = opts.priority ?? CHANNEL_PRIORITY.ACTION;
		const reason = opts.reason ?? "action";
		const allowDegrade = opts.allowDegrade ?? false;
		const preemptSameReason = opts.preemptSameReason ?? false;
		const preemptSamePriority = opts.preemptSamePriority ?? false;

		// 冲突检测：可抢占的记入驱逐集合，不可抢占且不允许降级则失败
		const acquired: Live2DChannel[] = [];
		const toEvict = new Set<ActiveLease>();
		for (const ch of channelsToClaim) {
			const current = this.occupants.get(ch);
			if (!current || current.isReleased) {
				acquired.push(ch);
				continue;
			}
			const sameReason = preemptSameReason && current.reason === reason;
			const canPreempt =
				current.priority < priority ||
				(current.priority === priority && (sameReason || preemptSamePriority));
			if (!canPreempt) {
				if (!allowDegrade) {
					throw new Error(
						`Channel '${ch}' is locked by active task (${current.reason ?? "active"}, priority: ${current.priority} >= ${priority})`,
					);
				}
				continue;
			}
			toEvict.add(current);
			acquired.push(ch);
		}
		if (acquired.length === 0 && channelsToClaim.length > 0) {
			throw new Error(`Failed to claim any requested channels: [${channelsToClaim.join(", ")}]`);
		}

		// 驱逐：被占通道从旧租约剥离；旧租约无剩余通道或声明 atomic 时整体中止，防半残动作
		for (const old of toEvict) {
			old.channels = old.channels.filter((c) => !acquired.includes(c));
			if (old.channels.length === 0 || old.atomic) {
				old.release();
				old.abortController?.abort();
			}
		}

		// 签约：RAII 租约，绑定外部取消信号
		const controller = new AbortController();
		let released = false;
		const lease: ActiveLease = {
			id: `lease_${++this.leaseCounter}_${reason}`,
			channels: [...acquired],
			priority,
			reason,
			signal: controller.signal,
			abortController: controller,
			atomic: opts.atomic,
			isReleased: false,
			release: () => {
				if (released) return;
				released = true;
				lease.isReleased = true;
				for (const ch of acquired) {
					if (this.occupants.get(ch) === lease) this.occupants.delete(ch);
				}
			},
		};
		for (const ch of acquired) this.occupants.set(ch, lease);

		if (opts.signal) {
			const abortLease = () => {
				controller.abort();
				lease.release();
			};
			if (opts.signal.aborted) {
				abortLease();
			} else {
				opts.signal.addEventListener("abort", abortLease, { once: true });
			}
		}

		return lease;
	}

	async claimAllChannels(reason: string, signal?: AbortSignal): Promise<ChannelLease> {
		return this.claim(ALL_CHANNELS, {
			priority: CHANNEL_PRIORITY.ACTION,
			reason,
			signal,
			allowDegrade: false,
			atomic: true,
		});
	}

	release(lease: ChannelLease): void {
		lease.release();
	}

	isChannelLocked(channel: Live2DChannel, minPriority: number): boolean {
		const lease = this.occupants.get(channel);
		return !!lease && !lease.isReleased && lease.priority >= minPriority;
	}

	getActiveLeases(): ChannelLease[] {
		return [...new Set(this.occupants.values())].filter((l) => !l.isReleased);
	}

	releaseAll(): void {
		for (const lease of new Set(this.occupants.values())) {
			lease.abortController?.abort();
			lease.release();
		}
		this.occupants.clear();
	}
}

/**
 * Live2D 动作唯一所有者：通道占用（MotionLeaseManager）与逐帧合成、节拍播放同属此类。
 * 此前的"composer + 假继承门面 + 独立 arbiter"三层洋葱已折叠——
 * 门面每个能力都要穿透两层重导出，而所有权一张字段表就能说清。
 */
export class MotionDirector {
	private readonly arbiter = new MotionLeaseManager();
	readonly noise: PhysiologicalNoise;
	readonly bodyDirector: BodyDirector;

	private currentBeatsController: AbortController | null = null;
	private currentAllowedChannels?: readonly Live2DChannel[];
	private speechPhase = 0;
	private speechActivity = 0;

	// idle 律动状态：silenceMs 累计无语音帧时长；idleBlend 一阶趋近（0=语流停顿态，
	// 1=idle 态），消除长静默切入 / 说话恢复两个方向的幅度跳变；lastBreath 供相位
	// 速率做呼吸调制（一帧滞后，呼吸周期 3.6s 下不可感知）
	private silenceMs = 0;
	private idleBlend = 0;
	private lastBreath = 0.5;

	// 思考视线状态：thinking 持续期间 gaze 有"瞟向远方"的声明意图——
	// VOR 为其让位，并叠加慢速游移；clearStatePose 时一并清零，无残留
	private thinkingGazeActive = false;
	private thinkingGazePhase = 0;

	// 声学重音脉冲：onset 事件驱动的下潜-回弹（260ms 单周期衰减正弦）。
	// 与匀速正弦律动互补——发条感来自"与语流节奏无关的连续摆动"，
	// 脉冲由真实重音时刻触发，是"跟着语拍动"的来源
	private acousticPulseRemainingMs = 0;
	private acousticPulseMag = 0;
	private acousticPulseAgeMs = 0;
	/** 语义 cue 接收处理器：cue 分发是观察者回调，与通道占用仲裁无关。 */
	private cueDispatcher?: (cueId: string) => unknown;

	constructor() {
		this.noise = new PhysiologicalNoise();
		this.bodyDirector = new BodyDirector();
	}

	// —— 通道占用 ——

	async claim(
		channels: readonly Live2DChannel[],
		options?: ChannelClaimOptions,
	): Promise<ChannelLease> {
		return this.arbiter.claim(channels, options);
	}

	async claimAllChannels(reason: string, signal?: AbortSignal): Promise<ChannelLease> {
		return this.arbiter.claimAllChannels(reason, signal);
	}

	release(lease: ChannelLease): void {
		this.arbiter.release(lease);
	}

	isChannelLocked(channel: Live2DChannel, minPriority: number): boolean {
		return this.arbiter.isChannelLocked(channel, minPriority);
	}

	getActiveLeases(): readonly ChannelLease[] {
		return this.arbiter.getActiveLeases();
	}

	releaseAll(): void {
		this.arbiter.releaseAll();
	}

	dispatchCue(cueId: string): void {
		if (this.cueDispatcher) {
			void this.cueDispatcher(cueId);
		}
	}

	setCueDispatcher(dispatcher: (cueId: string) => unknown): void {
		this.cueDispatcher = dispatcher;
	}

	// —— 合成与节拍 ——

	getSpeechActivity(): number {
		return this.speechActivity;
	}

	resetSpeechActivity(): void {
		this.speechActivity = 0;
		this.speechPhase = 0;
		// 语义同 abortAllMotions：节奏状态清零后静默计时重新起算，
		// 由 idleBlend 一阶趋近自然缓入，不残留切换跳变
		this.silenceMs = 0;
		this.idleBlend = 0;
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

	/**
	 * 回正到基准姿态；若仍有表情节拍在播放，则保留这些节拍活跃的参数不被覆盖。
	 * "保留哪些参数"的策略收在合成层，避免反射层窥探合成层内部状态后自行拼装。
	 */
	dampenToNeutralPreservingActiveBeats(): void {
		if (this.isPlayingExpressiveBeats()) {
			this.bodyDirector.dampenToNeutral(this.getActiveExpressiveParams());
		} else {
			this.bodyDirector.dampenToNeutral();
		}
	}

	/**
	 * 应用反射持续状态姿态（按声明式表中的键，调用方不需要知道具体参数名）。
	 * 逐参数按通道门控：被 >= REFLEX 级租约占用的通道不写入——
	 * 否则只锁了 head 而 gaze 空闲时，"让位"检查会整体放行并覆盖别人正在用的 head。
	 */
	showStatePose(key: ReflexStateKey): void {
		const writable = REFLEX_POSES[key].filter((target) => {
			const channel = PARAM_CHANNEL_MAP[target.name];
			return !channel || !this.arbiter.isChannelLocked(channel, CHANNEL_PRIORITY.REFLEX);
		});
		// 节奏分层：眼球 ω×0.75 缓缓飘走，头/身体 ω×0.6 慢慢歪过去——
		// 视线先动、姿态跟上，动线自然且带"迟疑感"；统一 ω 会让眼动像弹射，生硬
		const eyes = writable.filter((t) => t.name.startsWith("ParamEyeBall"));
		const rest = writable.filter((t) => !t.name.startsWith("ParamEyeBall"));
		if (eyes.length > 0) this.bodyDirector.setTargets(eyes, { omegaScale: 0.75 });
		if (rest.length > 0) this.bodyDirector.setTargets(rest, { omegaScale: 0.6 });
		this.thinkingGazeActive = key === "thinking";
		if (this.thinkingGazeActive) this.thinkingGazePhase = 0;
	}

	/**
	 * 清除反射持续状态，令反射占用的参数回归基准。
	 * 与 dampenToNeutralPreservingActiveBeats 同一口径：正在播放的节拍所持有的参数不回归，
	 * 否则 thinking -> content 的复位会把一个正演到一半的头部/视线节拍当场截断。
	 */
	clearStatePose(): void {
		this.thinkingGazeActive = false;
		const active = new Set(this.getActiveExpressiveParams());
		const names = REFLEX_POSE_PARAMS.filter((name) => !active.has(name));
		// 复位同样慢速（ω×0.7）：从沉思姿态缓缓回正，与进入节奏同量级，消除切换断点
		if (names.length > 0) this.bodyDirector.dampenParams(names, { omegaScale: 0.7 });
	}

	triggerAcousticImpulse(magnitude = 1.0): void {
		const clampedMag = Math.max(0, Math.min(1.0, magnitude));
		if (clampedMag <= 0) return;
		// CUE 锁定时减半而非禁止：重音点头是语流的一部分，与表情 cue 短暂叠加无害；
		// 完全禁止会让"说话+表情"并存时重音律动消失，呈现场不一致感
		const gate = this.arbiter.isChannelLocked("head", CHANNEL_PRIORITY.CUE) ? 0.5 : 1.0;
		this.acousticPulseMag = clampedMag * gate;
		this.acousticPulseAgeMs = 0;
		this.acousticPulseRemainingMs = 260;
	}

	resetAcousticImpulse(): void {
		this.acousticPulseRemainingMs = 0;
		this.acousticPulseMag = 0;
	}

	async playExpressiveBeats(
		params: ExpressParams,
		options?: { signal?: AbortSignal; allowedChannels?: readonly Live2DChannel[] },
	): Promise<void> {
		const signal = options?.signal;
		const allowedChannels = options?.allowedChannels;

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

			// beat 走弹簧路径（setTargets）：速度跨节拍延续、落位带欠阻尼回弹，
			// 消除此前"每拍 cubic-out 归零速度"的逐格动画感。节奏由 ω 缩放表达：
			// snappy≈350ms 落位、smooth≈490ms、gentle≈650ms（@基线 ω=10）。
			const tempoScale = params.transition === "snappy"
				? 1.6
				: params.transition === "gentle"
				? 0.75
				: 1.15;

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
					this.bodyDirector.setTargets(filtered, { omegaScale: tempoScale });
				}

				const holdMs = Math.max(200, Math.min(3000, beat.hold_ms ?? 800));
				await abortableDelay(holdMs, internalController.signal);
			}

			// 检查是否声明姿态留存 (latch)：若声明留存，则停留在最终姿态，不再强行拉回中性位
			const shouldLatchLast = params.latch_last || beats[beats.length - 1]?.latch;
			if (!internalController.signal.aborted && !shouldLatchLast) {
				const neutralTargets: Record<string, number> = {};
				for (const [name, ch] of Object.entries(PARAM_CHANNEL_MAP)) {
					if (!allowedChannels || allowedChannels.includes(ch)) {
						neutralTargets[name] = this.bodyDirector.getBasePoseTarget(name);
					}
				}
				if (Object.keys(neutralTargets).length > 0) {
					// 回落同样走弹簧且比发力更慢（收势慢于发力，"缓缓收回"而非急停）
					this.bodyDirector.setTargets(
						Object.entries(neutralTargets).map(([name, value]) => ({ name, value })),
						{ omegaScale: 0.7 },
					);
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
		// 急停后回归"先静止再缓入 idle"：清零让静默计时重新起算，
		// 避免打断瞬间残留的 idleBlend 直接顶出满幅晃动
		this.silenceMs = 0;
		this.idleBlend = 0;
		// 急停语义覆盖思考视线状态：不清会让游移与 VOR 让位残留到下一回合
		this.thinkingGazeActive = false;
		this.acousticPulseRemainingMs = 0;
		this.acousticPulseMag = 0;
		this.bodyDirector.resetVelocity("ParamAngleY");
		this.bodyDirector.dampenToNeutral();
	}

	/**
	 * 律动状态机推进（compose 的状态前置步）：语流活动度 attack/decay、静默计时、
	 * idle blend 一阶趋近、相位推进；返回本帧有效律动幅度——语流活动度与 idle
	 * 地板的较大者（地板按感知阈标定，见顶部常量注释）。
	 * 两条相位裁定：语流停顿 ×0.25 近静止（真人体态律动随语流起停）；长静默降档
	 * 续跳且速率贴呼吸（躯干死僵比发条感更像断电）。说话恢复时 speechActivity
	 * 快速爬升接管幅度，两个方向都无跳变。
	 */
	private updateRhythmState(deltaMs: number, dt: number, speechEnergy: number): number {
		if (speechEnergy > 0.02) {
			this.silenceMs = 0;
			const targetActivity = Math.min(1.0, speechEnergy * 2.5);
			this.speechActivity += (targetActivity - this.speechActivity) * Math.min(1.0, dt * 8.0);
			this.speechPhase += dt;
		} else {
			this.silenceMs += deltaMs;
			if (this.speechActivity > 0) {
				this.speechActivity *= Math.exp(-deltaMs / 250);
				if (this.speechActivity < 0.005) {
					this.speechActivity = 0;
				}
			}
			const idleTarget = this.silenceMs > IDLE_RAMP_DELAY_MS ? 1 : 0;
			this.idleBlend += (idleTarget - this.idleBlend) * Math.min(1, deltaMs / IDLE_BLEND_TAU_MS);
			const phaseRate =
				this.speechActivity > 0.005
					? PAUSE_PHASE_RATE
					: IDLE_PHASE_RATE * (0.85 + 0.3 * this.lastBreath);
			this.speechPhase += dt * phaseRate;
		}
		return Math.max(this.speechActivity, this.idleBlend * IDLE_ACTIVITY);
	}

	compose(deltaMs: number, options?: { speechEnergy?: number }): Record<string, number> {
		const dt = Math.max(0.0001, deltaMs * 0.001);
		const speechEnergy = options?.speechEnergy ?? 0;
		const rhythmAmp = this.updateRhythmState(deltaMs, dt, speechEnergy);

		const isTorsoLocked = this.arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.CUE);
		const isHeadLocked = this.arbiter.isChannelLocked("head", CHANNEL_PRIORITY.CUE);

		const noise = this.noise.tick(deltaMs);
		this.lastBreath = noise.ParamBreath ?? this.lastBreath;
		const merged = this.bodyDirector.tick(deltaMs, { isTorsoLocked });

		for (const k in noise) {
			const ch = PARAM_CHANNEL_MAP[k];
			const isLocked = ch ? this.arbiter.isChannelLocked(ch, CHANNEL_PRIORITY.ACTION) : false;
			const nVal = isLocked ? 0 : noise[k]!;

			if (k === "ParamEyeLOpen" || k === "ParamEyeROpen") {
				const blinkFactor = isLocked ? 1.0 : nVal;
				merged[k] = clampLive2DParam(k, (merged[k] ?? 1.0) * blinkFactor);
			} else if (k === "ParamMouthForm") {
				// 待机微笑是"底色"（下限）而非增量：姿态/表情自带的 MouthForm 权威值
				// 不再被 0.25 底色系统性抬高（confident 的 0.85 曾被顶成 1.0 满格）。
				merged[k] = clampLive2DParam(k, Math.max(merged[k] ?? 0, nVal));
			} else {
				merged[k] = clampLive2DParam(k, (merged[k] ?? 0) + nVal);
			}
		}

		// 前庭动眼反射 (VOR): 根据头部空间转角，动态计算眼球对镜头 (0, 0) 的反向代偿，
		// 消除“歪头即散瞳”感，在任意倾斜姿态下均维持对用户的专注眼神交流。
		// 当 gaze 通道被明确意图锁定时不覆盖角色的主动视线偏转：
		// (a) Cue/Action 的租约锁定；(b) 反射思考的持续视线意图——
		// 思考的"瞟向远方"若被 VOR 拉回镜头，就成了"歪头盯着你"，思考感全无
		const isGazeLocked =
			this.arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.CUE) || this.thinkingGazeActive;
		if (!isGazeLocked) {
			const headX = merged.ParamAngleX ?? 0;
			const headY = merged.ParamAngleY ?? 0;
			const headZ = merged.ParamAngleZ ?? 0;
			const { vorX, vorY } = computeVORCompensation(headX, headY, headZ);
			merged.ParamEyeBallX = clampLive2DParam("ParamEyeBallX", (merged.ParamEyeBallX ?? 0) + vorX);
			merged.ParamEyeBallY = clampLive2DParam("ParamEyeBallY", (merged.ParamEyeBallY ?? 0) + vorY);
		}

		// 思考视线游移：目光在"斜上方打底"上缓慢飘移——双频不同相叠加产生非周期感
		//（X 周期 ~3.7s、Y ~5.7s），这是"陷入沉思"区别于"盯着你看"的关键。
		// thinkingGazeActive 清零即消失，无残留状态。
		if (this.thinkingGazeActive) {
			this.thinkingGazePhase += dt;
			merged.ParamEyeBallX = clampLive2DParam(
				"ParamEyeBallX",
				(merged.ParamEyeBallX ?? 0) + Math.sin(this.thinkingGazePhase * 1.7) * 0.18,
			);
			merged.ParamEyeBallY = clampLive2DParam(
				"ParamEyeBallY",
				(merged.ParamEyeBallY ?? 0) + Math.sin(this.thinkingGazePhase * 1.1 + 1.3) * 0.12,
			);
		}

		// 语流连续律动注入 (当未被高优先级动作锁定通道时，赋予自然说话体态节律；
		// 长静默期由 idle 地板维持降档续跳——见 updateRhythmState 注释)
		if (rhythmAmp > 0.001) {
			const p = this.speechPhase;

			if (!isTorsoLocked) {
				// 躯干左右微晃重心游移 (优化双谐波波形，柔和有机)。幅度标定以"融合 ×0.75
				// 稀释后仍可见"为准——低于 ±6° 的缓慢摆动在 30° 量程模型上低于感知阈
				const bodySwayX =
					(Math.sin(p * 3.8) * 0.72 + Math.sin(p * 1.9 + 0.5) * 0.28) * 9.0 * rhythmAmp;
				// 胸腔起伏与说话前倾
				const bodyPitchY =
					(Math.sin(p * 3.0 + 1.0) * 0.6 + Math.cos(p * 1.5) * 0.4) * 5.5 * rhythmAmp;
				// 脊柱侧倾配合重心转移
				const bodyRollZ = Math.cos(p * 3.8 + 0.8) * 5.0 * rhythmAmp;

				merged.ParamBodyAngleX = clampLive2DParam("ParamBodyAngleX", (merged.ParamBodyAngleX ?? 0) + bodySwayX);
				merged.ParamBodyAngleY = clampLive2DParam("ParamBodyAngleY", (merged.ParamBodyAngleY ?? 0) + bodyPitchY);
				merged.ParamBodyAngleZ = clampLive2DParam("ParamBodyAngleZ", (merged.ParamBodyAngleZ ?? 0) + bodyRollZ);
			}

			if (!isHeadLocked) {
				// 头部语流随动轻晃 (与躯干有机耦合，消除固定时钟发条感)
				const headSwayZ = Math.sin(p * 3.8 + 1.2) * 5.0 * rhythmAmp;
				const headSwayX = Math.sin(p * 1.9) * 3.5 * rhythmAmp;
				// 语流重音微点头律动 (主导节拍随语流起伏，在音步重音处产生自然的下潜微点头)。
				// 只跟语流活动度、不吃 idle 地板——静默时有节奏点头是在附和空气，且必发条感
				const headNodY =
					(Math.sin(p * 3.8 - 0.3) * 0.65 + Math.sin(p * 7.6) * 0.35) * -4.5 * this.speechActivity;

				merged.ParamAngleZ = clampLive2DParam("ParamAngleZ", (merged.ParamAngleZ ?? 0) + headSwayZ);
				merged.ParamAngleX = clampLive2DParam("ParamAngleX", (merged.ParamAngleX ?? 0) + headSwayX);
				merged.ParamAngleY = clampLive2DParam("ParamAngleY", (merged.ParamAngleY ?? 0) + headNodY);
			}
		}

		// 声学重音脉冲：onset 触发的下潜-回弹（260ms 单周期衰减正弦），输出层叠加。
		// 挑眉与点头同相——重音时刻"点头+眉微抬"是真人强调语的标志性微表情
		if (this.acousticPulseRemainingMs > 0) {
			this.acousticPulseRemainingMs = Math.max(0, this.acousticPulseRemainingMs - deltaMs);
			this.acousticPulseAgeMs += deltaMs;
			const envelope = Math.exp(-this.acousticPulseAgeMs / 130) * Math.sin((this.acousticPulseAgeMs / 260) * Math.PI);
			const pulse = this.acousticPulseMag * envelope;
			merged.ParamAngleY = clampLive2DParam("ParamAngleY", (merged.ParamAngleY ?? 0) - 7.0 * pulse);
			if (!this.arbiter.isChannelLocked("eyes", CHANNEL_PRIORITY.CUE)) {
				merged.ParamBrowLY = clampLive2DParam("ParamBrowLY", (merged.ParamBrowLY ?? 0) + 0.6 * pulse);
				merged.ParamBrowRY = clampLive2DParam("ParamBrowRY", (merged.ParamBrowRY ?? 0) + 0.6 * pulse);
			}
		}

		// 呼吸-语流耦合：说话时呼吸变浅（生理事实），由语流活动度收窄呼吸深度。
		// ParamBreath 是噪声层输出的 0~1 绝对量，此处按活动度比例收窄而非叠加
		if (this.speechActivity > 0.001 && merged.ParamBreath !== undefined) {
			merged.ParamBreath = clampLive2DParam(
				"ParamBreath",
				merged.ParamBreath * (1 - 0.4 * Math.min(1.0, this.speechActivity)),
			);
		}

		return merged;
	}
}
