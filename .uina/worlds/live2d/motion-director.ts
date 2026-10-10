import {
	ALL_CHANNELS,
	CHANNEL_PRIORITY,
	type ChannelClaimOptions,
	type ChannelLease,
	type Live2DChannel,
	type BasePoseName,
	type MotionTransition,
	type SpeechPolicy,
} from "./types.js";
import { AXES, AXIS_NAMES, NEUTRAL_AXES, type AxisValues, type MotionAxis } from "./motion-axes.js";
import { BodyDirector } from "./body-director.js";
import { BASE_POSES, STATE_MOTIONS, AMBIENT, compilePoseTransition, type ReflexStateKey } from "./motion-library.js";
import { isCompiledMotion, sampleMotion, sampleLoop, sampleSpeechGain, smooth, type CompiledMotion } from "./motion.js";
import { PhysiologicalNoise } from "./physiological-noise.js";
interface ActiveLease extends ChannelLease {
	channels: Live2DChannel[];
}

/**
 * 通道占用表：单线程 60Hz 循环里的并发护栏，不是任务系统。
 * 每个通道至多一个占用者；抢占 = 通道换主，被抢空的租约（或 atomic 租约）整体中止。
 */
class MotionLeaseManager {
	private readonly occupants = new Map<Live2DChannel, ActiveLease>();
	private leaseCounter = 0;
	constructor(private readonly revoke: (lease: ChannelLease, channels: readonly Live2DChannel[]) => void) {}

	claim(channelsToClaim: readonly Live2DChannel[], options?: ChannelClaimOptions): ChannelLease {
		const opts = options ?? {};
		if (opts.signal?.aborted) {
			throw new Error(`Channel claim aborted before start: ${opts.reason ?? "action"}`);
		}

		const priority = opts.priority ?? CHANNEL_PRIORITY.ACTION;
		const reason = opts.reason ?? "action";
		const preemptSameReason = opts.preemptSameReason ?? false;
		const preemptSamePriority = opts.preemptSamePriority ?? false;

		// 先核验全部通道，任何冲突都在驱逐旧租约前失败。
		const acquired: Live2DChannel[] = [];
		const toEvict = new Set<ActiveLease>();
		for (const ch of new Set(channelsToClaim)) {
			const current = this.occupants.get(ch);
			if (!current) {
				acquired.push(ch);
				continue;
			}
			const sameReason = preemptSameReason && current.reason === reason;
			const canPreempt =
				current.priority < priority || (current.priority === priority && (sameReason || preemptSamePriority));
			if (!canPreempt) {
				throw new Error(
					`Channel '${ch}' is locked by active task (${current.reason ?? "active"}, priority: ${current.priority} >= ${priority})`,
				);
			}
			toEvict.add(current);
			acquired.push(ch);
		}

		// 驱逐：被占通道从旧租约剥离；旧租约无剩余通道或声明 atomic 时整体中止，防半残动作
		for (const old of toEvict) {
			this.revoke(old, old.atomic ? [...old.channels] : old.channels.filter((c) => acquired.includes(c)));
			old.channels = old.channels.filter((c) => !acquired.includes(c));
			if (old.channels.length === 0 || old.atomic) {
				old.release();
			}
		}

		// 签约：RAII 租约，绑定外部取消信号
		const controller = new AbortController();
		let released = false;
		let unbindAbort: (() => void) | undefined;
		const lease: ActiveLease = {
			id: `lease_${++this.leaseCounter}_${reason}`,
			channels: [...acquired],
			priority,
			reason,
			signal: controller.signal,
			atomic: opts.atomic,
			release: () => {
				if (released) return;
				released = true;
				this.revoke(lease, [...lease.channels]);
				unbindAbort?.();
				for (const ch of acquired) {
					if (this.occupants.get(ch) === lease) this.occupants.delete(ch);
				}
				controller.abort();
			},
		};
		for (const ch of acquired) this.occupants.set(ch, lease);

		if (opts.signal) {
			const abortLease = () => {
				lease.release();
			};
			if (opts.signal.aborted) {
				abortLease();
			} else {
				opts.signal.addEventListener("abort", abortLease, { once: true });
				unbindAbort = () => opts.signal?.removeEventListener("abort", abortLease);
			}
		}

		return lease;
	}

	isChannelLocked(channel: Live2DChannel, minPriority: number): boolean {
		const lease = this.occupants.get(channel);
		return !!lease && lease.priority >= minPriority;
	}

	owns(lease: ChannelLease): boolean {
		return lease.channels.length > 0 && lease.channels.every((channel) => this.occupants.get(channel) === lease);
	}

	getActiveLeases(): ChannelLease[] {
		return [...new Set(this.occupants.values())];
	}

	releaseAll(): void {
		for (const lease of new Set(this.occupants.values())) {
			lease.release();
		}
		this.occupants.clear();
	}
}

export interface MotionOutcome {
	status: "completed" | "cancelled";
}
interface Playback {
	controller: AbortController;
	lease: ChannelLease;
	motion: CompiledMotion;
	ageMs: number;
	blendMs: number;
	exitMs: number;
	tempo: number;
	baseline: Readonly<Record<string, number>>;
	visibleChannels: Set<Live2DChannel>;
	speech?: SpeechPolicy;
	latch: boolean;
	finish: (status: MotionOutcome["status"]) => void;
}

interface FadingLayer {
	motion?: CompiledMotion;
	baseline: Readonly<Record<string, number>>;
	ageMs: number;
	tempo: number;
	speechGain?: number;
	speech?: SpeechPolicy;
	channels: Map<Live2DChannel, { weight: number; ageMs: number; durationMs: number }>;
}

function fadeWeight(fade: { weight: number; ageMs: number; durationMs: number }): number {
	return fade.weight * (1 - smooth(fade.ageMs / fade.durationMs));
}

function playbackWeight(playback: Playback): number {
	const entry = playback.blendMs === 0 ? 1 : smooth(playback.ageMs / playback.blendMs);
	if (playback.latch || playback.ageMs < playback.motion.durationMs) return entry;
	return entry * (1 - smooth((playback.ageMs - playback.motion.durationMs) / playback.exitMs));
}

const TRANSITIONS = {
	snappy: { blendMs: 110, exitMs: 200, tempo: 1.2 },
	smooth: { blendMs: 180, exitMs: 320, tempo: 1 },
	gentle: { blendMs: 280, exitMs: 420, tempo: 0.85 },
} satisfies Record<MotionTransition, { blendMs: number; exitMs: number; tempo: number }>;

/** Owns intent arbitration. Only this class assembles targets for the body springs. */
export class MotionDirector {
	private readonly arbiter = new MotionLeaseManager((lease, channels) => {
		let hasPlayback = false;
		for (const playback of this.playbacks) {
			if (playback.lease === lease) {
				hasPlayback = true;
				this.retire(playback, channels);
			}
		}
		if (!hasPlayback && this.shownHolds.has(lease) && !this.stopping) {
			this.fadingLayers.add({
				baseline: { ...NEUTRAL_AXES, ...this.leaseTargets.get(lease) },
				ageMs: 0,
				tempo: 1,
				speechGain: 0,
				channels: new Map(
					channels.map((channel) => [channel, { weight: 1, ageMs: 0, durationMs: TRANSITIONS.smooth.exitMs }]),
				),
			});
		}
	});
	private body = new BodyDirector();
	private controlGroups: readonly (readonly Live2DChannel[])[] = [];
	resetBody(): void {
		this.body = new BodyDirector();
	}
	setControlGroups(groups: readonly (readonly Live2DChannel[])[]): void {
		this.controlGroups = groups;
	}
	private expandChannels(channels: readonly Live2DChannel[]): Live2DChannel[] {
		const result = new Set(channels);
		let changed = true;
		while (changed) {
			changed = false;
			for (const group of this.controlGroups)
				if (group.some((ch) => result.has(ch)))
					for (const ch of group)
						if (!result.has(ch)) {
							result.add(ch);
							changed = true;
						}
		}
		return [...result];
	}
	readonly noise: PhysiologicalNoise;
	private readonly playbacks = new Set<Playback>();
	private readonly fadingLayers = new Set<FadingLayer>();
	private stopping = false;
	private motionGeneration = 0;
	private readonly latched = new Map<string, number>();
	private latchedSpeech: SpeechPolicy = "blend";
	private basePoseTargets: Readonly<Record<string, number>> = { ...NEUTRAL_AXES };
	private presentedBase: AxisValues = { ...NEUTRAL_AXES };
	private baseTransition?: { motion: CompiledMotion; ageMs: number };
	private holdRemainingMs?: number;
	private onBasePoseExpired?: () => void;
	private readonly leaseTargets = new WeakMap<ChannelLease, Record<string, number>>();
	private readonly shownHolds = new WeakSet<ChannelLease>();
	private statePose?: ReflexStateKey;
	private stateLayer?: {
		key: ReflexStateKey;
		ageMs: number;
		from: AxisValues;
		fromWeight: number;
		releaseAgeMs?: number;
		releaseValues?: AxisValues;
		releaseWeight?: number;
	};
	private reflexVisibility = { from: 1, to: 1, ageMs: 0 };
	private attentionAgeMs = AMBIENT.attention.durationMs;
	private lastTargets: Record<string, number> = { ...NEUTRAL_AXES };
	private phase = 0;
	private speechPhase = 0;
	private speechActivity = 0;
	private silenceMs = 0;
	private idleGapMs = 7000;
	private idleShift?: {
		motion: CompiledMotion;
		name: MotionAxis;
		sign: number;
		ageMs: number;
		release?: { ageMs: number; value: number };
	};
	private pulseAgeMs = 260;
	private pulseMagnitude = 0;
	private cueDispatcher?: (cueId: string) => unknown;
	constructor(private readonly randomFn: () => number = Math.random) {
		this.noise = new PhysiologicalNoise({ randomFn });
	}
	private retire(playback: Playback, channels: readonly Live2DChannel[]): void {
		const lost = channels.filter((channel) => playback.visibleChannels.delete(channel));
		if (!lost.length || this.stopping) return;
		const weight = playbackWeight(playback);
		if (weight <= 0) return;
		this.fadingLayers.add({
			motion: playback.motion,
			baseline: playback.baseline,
			ageMs: playback.ageMs,
			tempo: playback.tempo,
			speech: playback.speech,
			channels: new Map(lost.map((channel) => [channel, { weight, ageMs: 0, durationMs: playback.exitMs }])),
		});
	}
	private stateOffsets(): { values: AxisValues; weight: number } {
		const layer = this.stateLayer;
		if (!layer) return { values: {}, weight: 0 };
		const definition = STATE_MOTIONS[layer.key];
		const entry = smooth(layer.ageMs / definition.entry.durationMs);
		const release = layer.releaseAgeMs === undefined ? 1 : 1 - smooth(layer.releaseAgeMs / definition.exitMs);
		const values = { ...layer.releaseValues };
		if (!layer.releaseValues) {
			Object.assign(values, sampleMotion(definition.entry, layer.ageMs));
			for (const axis of definition.entry.axes)
				values[axis] = (values[axis] ?? 0) + (layer.from[axis] ?? 0) * (1 - entry);
		}
		for (const axis of definition.entry.axes) values[axis] = (values[axis] ?? 0) * release;
		const weight = layer.releaseWeight ?? layer.fromWeight + (1 - layer.fromWeight) * entry;
		return { values, weight: weight * release };
	}
	private reflexWeight(): number {
		const fade = this.reflexVisibility;
		return fade.from + (fade.to - fade.from) * smooth(fade.ageMs / 320);
	}
	setReflexVisible(visible: boolean): void {
		const to = visible ? 1 : 0;
		if (this.reflexVisibility.to === to) return;
		this.reflexVisibility = { from: this.reflexWeight(), to, ageMs: 0 };
	}
	triggerAttention(): void {
		this.attentionAgeMs = 0;
	}
	async claim(channels: readonly Live2DChannel[], options?: ChannelClaimOptions): Promise<ChannelLease> {
		const lease = this.arbiter.claim(this.expandChannels(channels), options);
		this.leaseTargets.set(
			lease,
			Object.fromEntries(
				AXIS_NAMES.filter((name) => lease.channels.includes(AXES[name as MotionAxis].channel)).map((name) => [
					name,
					this.body.getParamTarget(name),
				]),
			),
		);
		return lease;
	}
	claimAllChannels(reason: string, signal?: AbortSignal): Promise<ChannelLease> {
		return this.claim(ALL_CHANNELS, { priority: CHANNEL_PRIORITY.ACTION, reason, signal, atomic: true });
	}
	isChannelLocked(channel: Live2DChannel, priority: number): boolean {
		return this.arbiter.isChannelLocked(channel, priority);
	}
	getActiveLeases(): readonly ChannelLease[] {
		return this.arbiter.getActiveLeases();
	}
	dispatchCue(cueId: string): void {
		const dispatched = this.cueDispatcher?.(cueId);
		// 派发是"发射后不管"的旁路信号，但拒绝被吞：异步失败只告警，不打断调用方。
		if (dispatched instanceof Promise) {
			dispatched.catch((error) => {
				console.warn(`[Live2D] cue 派发失败: ${cueId}`, error);
			});
		}
	}
	setCueDispatcher(dispatcher: (cueId: string) => unknown): void {
		this.cueDispatcher = dispatcher;
	}
	getParam(name: string): number {
		return this.body.getParam(name);
	}
	getParamTarget(name: string): number {
		return this.body.getParamTarget(name);
	}
	getSpeechActivity(): number {
		return this.speechActivity;
	}
	resetSpeechActivity(): void {
		// Release the signal; the body springs carry the physical return without a phase jump.
		this.speechActivity = 0;
		this.silenceMs = 0;
		if (this.idleShift && !this.idleShift.release)
			this.idleShift.release = { ageMs: 0, value: this.idleValue(this.idleShift) };
	}
	isPlaying(): boolean {
		return [...this.playbacks].some((p) => !p.controller.signal.aborted);
	}
	applyBasePose(name: BasePoseName, options?: { transitionMs?: number; holdMs?: number }, clearLatch = true): void {
		if (!Object.hasOwn(BASE_POSES, name)) throw new Error("Unknown base pose: " + name);
		const durationMs = options?.transitionMs ?? 800;
		if (!Number.isFinite(durationMs) || durationMs < 0)
			throw new Error("Pose transition must be finite and nonnegative");
		if (options?.holdMs !== undefined && (!Number.isFinite(options.holdMs) || options.holdMs < 0))
			throw new Error("Pose hold must be finite and nonnegative");
		this.basePoseTargets = { ...NEUTRAL_AXES, ...BASE_POSES[name] };
		this.baseTransition =
			durationMs === 0
				? undefined
				: { motion: compilePoseTransition(this.presentedBase, this.basePoseTargets, durationMs, name), ageMs: 0 };
		if (durationMs === 0) this.presentedBase = { ...this.basePoseTargets };
		this.holdRemainingMs = options?.holdMs !== undefined && options.holdMs > 0 ? options.holdMs : undefined;
		if (clearLatch) {
			this.releaseLatch(ALL_CHANNELS, durationMs || TRANSITIONS.smooth.exitMs);
		}
	}
	getBasePoseTarget(name: string): number {
		return this.basePoseTargets[name] ?? 0;
	}
	getBasePoseTargets(): Readonly<Record<string, number>> {
		return this.basePoseTargets;
	}
	getHoldRemainingMs(): number | undefined {
		return this.holdRemainingMs;
	}
	setOnBasePoseExpired(callback: () => void): void {
		this.onBasePoseExpired = callback;
	}
	showStatePose(key: ReflexStateKey): void {
		if (!Object.hasOwn(STATE_MOTIONS, key)) throw new Error("Unknown state motion: " + key);
		if (this.statePose === key) return;
		const current = this.stateOffsets();
		this.stateLayer = { key, ageMs: 0, from: current.values, fromWeight: current.weight };
		this.statePose = key;
	}
	clearStatePose(): void {
		if (this.stateLayer && this.stateLayer.releaseAgeMs === undefined) {
			const current = this.stateOffsets();
			this.stateLayer.releaseAgeMs = 0;
			this.stateLayer.releaseValues = current.values;
			this.stateLayer.releaseWeight = current.weight;
		}
		this.statePose = undefined;
	}
	private releaseLatch(channels: readonly Live2DChannel[], durationMs: number): void {
		const released = channels.filter((channel) =>
			[...this.latched.keys()].some((name) => AXES[name as MotionAxis].channel === channel),
		);
		if (released.length && !this.stopping) {
			this.fadingLayers.add({
				baseline: { ...this.lastTargets, ...Object.fromEntries(this.latched) },
				ageMs: 0,
				tempo: 1,
				speechGain: this.latchedSpeech === "blend" ? 1 : 0,
				channels: new Map(released.map((channel) => [channel, { weight: 1, ageMs: 0, durationMs }])),
			});
		}
		for (const name of this.latched.keys())
			if (channels.includes(AXES[name as MotionAxis].channel)) this.latched.delete(name);
		if (channels.includes("mouth")) this.latchedSpeech = "blend";
	}
	triggerAcousticImpulse(magnitude = 1): void {
		// 新脉冲重置相位：后到的脉冲直接覆盖未走完的旧脉冲，不做条件叠加。
		this.pulseMagnitude = Math.max(0, Math.min(1, magnitude));
		this.pulseAgeMs = 0;
	}
	resetAcousticImpulse(): void {
		this.pulseMagnitude = 0;
		this.pulseAgeMs = 260;
	}
	private idleValue(shift: NonNullable<MotionDirector["idleShift"]>): number {
		return (sampleMotion(shift.motion, shift.ageMs)[shift.name] ?? 0) * shift.sign;
	}
	private currentTargets(playback: Pick<Playback, "baseline" | "motion" | "ageMs">): Record<string, number> {
		return {
			...playback.baseline,
			...sampleMotion(playback.motion, playback.ageMs, playback.baseline as AxisValues),
		};
	}
	private fadingTargets(layer: FadingLayer): Record<string, number> {
		return layer.motion ? this.currentTargets({ ...layer, motion: layer.motion }) : { ...layer.baseline };
	}
	private speechContribution(source: Playback | FadingLayer): number {
		if ("speechGain" in source && source.speechGain !== undefined) return source.speechGain;
		if (source.speech) return source.speech === "blend" ? 1 : 0;
		return source.motion ? sampleSpeechGain(source.motion, source.ageMs) : 1;
	}
	private prepareHandoff(channels: readonly Live2DChannel[], durationMs: number): void {
		for (const channel of channels) {
			const sources = [...this.fadingLayers].filter((layer) => layer.channels.has(channel));
			const latest = sources.pop();
			let weight = 0;
			let speechGain = 0;
			const values: Record<string, number> = {};
			for (const layer of sources) {
				const contribution = fadeWeight(layer.channels.get(channel)!);
				weight += contribution;
				speechGain += this.speechContribution(layer) * contribution;
				for (const [name, value] of Object.entries(this.fadingTargets(layer)))
					values[name] = (values[name] ?? 0) + value * contribution;
				layer.channels.delete(channel);
				if (!layer.channels.size) this.fadingLayers.delete(layer);
			}
			// Older handoffs become one current residual. The latest outgoing clip still advances.
			// Repeated interruptions cannot accumulate an unbounded graph of obsolete performances.
			if (weight > 0) {
				this.fadingLayers.add({
					baseline: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value / weight])),
					ageMs: 0,
					tempo: 1,
					speechGain: speechGain / weight,
					channels: new Map([[channel, { weight, ageMs: 0, durationMs }]]),
				});
			}
			if (latest) {
				latest.channels.set(channel, { weight: fadeWeight(latest.channels.get(channel)!), ageMs: 0, durationMs });
			}
		}
	}
	getPresentationState(): { active: number; fading: number; poseTransition: boolean; reflex?: ReflexStateKey } {
		return {
			active: this.playbacks.size,
			fading: this.fadingLayers.size,
			poseTransition: Boolean(this.baseTransition),
			reflex: this.statePose,
		};
	}
	async play(
		motion: CompiledMotion,
		options?: {
			signal?: AbortSignal;
			lease?: ChannelLease;
			latch?: boolean;
			transition?: MotionTransition;
			atomic?: boolean;
			speech?: SpeechPolicy;
		},
	): Promise<MotionOutcome> {
		const generation = this.motionGeneration;
		if (!isCompiledMotion(motion)) throw new Error("Motion must be compiled before playback");
		const transitionName = options?.transition ?? "smooth";
		if (!Object.hasOwn(TRANSITIONS, transitionName)) throw new Error("Unknown motion transition: " + transitionName);
		const speech = options?.speech;
		if (speech !== undefined && speech !== "blend" && speech !== "exclusive")
			throw new Error("Unknown speech policy: " + speech);
		const lease =
			options?.lease ??
			(await this.claim(motion.channels, {
				reason: "motion",
				preemptSameReason: true,
				signal: options?.signal,
				atomic: options?.atomic,
			}));
		if (!lease.signal.aborted && !this.arbiter.owns(lease))
			throw new Error("Playback lease does not belong to this director");
		if (options?.atomic && !lease.atomic) throw new Error("Atomic playback requires an atomic lease");
		for (const previous of this.playbacks) if (previous.lease === lease) previous.controller.abort();
		if (generation !== this.motionGeneration || lease.signal.aborted || options?.signal?.aborted) {
			if (!options?.lease) lease.release();
			return { status: "cancelled" };
		}
		const controller = new AbortController();
		const transition = TRANSITIONS[transitionName];
		const blendMs = Math.min(motion.durationMs * 0.4, transition.blendMs);
		this.shownHolds.delete(lease);
		this.releaseLatch(lease.channels, blendMs);
		this.prepareHandoff(lease.channels, blendMs);
		const baseline = { ...this.basePoseTargets };
		const signals = [...new Set([lease.signal, options?.signal].filter((s): s is AbortSignal => !!s))];
		return new Promise<MotionOutcome>((resolve) => {
			let finished = false;
			const abort = () => controller.abort();
			const playback: Playback = {
				controller,
				lease,
				motion,
				baseline,
				visibleChannels: new Set(lease.channels),
				speech,
				ageMs: 0,
				blendMs,
				exitMs: transition.exitMs,
				tempo: transition.tempo,
				latch: options?.latch ?? false,
				finish: (status) => {
					if (finished) return;
					finished = true;
					for (const signal of signals) signal.removeEventListener("abort", abort);
					const targets = this.currentTargets(playback);
					if (status === "completed") {
						if (playback.latch) {
							for (const [name, value] of Object.entries(targets))
								if (lease.channels.includes(AXES[name as MotionAxis].channel)) this.latched.set(name, value);
							if (lease.channels.includes("mouth"))
								this.latchedSpeech = this.speechContribution(playback) === 0 ? "exclusive" : "blend";
						}
						this.leaseTargets.set(lease, { ...this.lastTargets });
					} else {
						this.retire(playback, [...playback.visibleChannels]);
					}
					this.playbacks.delete(playback);
					if (!options?.lease) lease.release();
					resolve({ status });
				},
			};
			controller.signal.addEventListener("abort", () => playback.finish("cancelled"), { once: true });
			for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
			this.playbacks.add(playback);
		});
	}
	abortAllMotions(): void {
		this.motionGeneration++;
		this.stopping = true;
		this.arbiter.releaseAll();
		for (const p of this.playbacks) p.controller.abort();
		this.fadingLayers.clear();
		this.latched.clear();
		this.latchedSpeech = "blend";
		this.statePose = undefined;
		this.stateLayer = undefined;
		this.attentionAgeMs = AMBIENT.attention.durationMs;
		this.resetSpeechActivity();
		this.resetAcousticImpulse();
		this.stopping = false;
	}
	private mixForeground(target: Record<string, number>, tempos: Record<string, number>): number {
		let speechGain = this.latchedSpeech === "exclusive" ? 0 : 1;
		const owners = this.getActiveLeases();
		const sampled = new Map<Playback | FadingLayer, Record<string, number>>();
		for (const playback of this.playbacks) sampled.set(playback, this.currentTargets(playback));
		for (const layer of this.fadingLayers) sampled.set(layer, this.fadingTargets(layer));
		for (const channel of ALL_CHANNELS) {
			const owner = owners.find((lease) => lease.channels.includes(channel));
			const playback = owner && [...this.playbacks].find((p) => p.lease === owner);
			if (owner && !playback) {
				this.shownHolds.add(owner);
				// A physical hold freezes the current target; hidden outgoing clips must never replay afterwards.
				for (const layer of this.fadingLayers) {
					layer.channels.delete(channel);
					if (!layer.channels.size) this.fadingLayers.delete(layer);
				}
				for (const [name, value] of Object.entries(this.leaseTargets.get(owner) ?? {})) {
					if (AXES[name as MotionAxis].channel === channel) target[name] = value;
				}
				if (channel === "mouth") speechGain = 0;
				continue;
			}
			const layers: { source: Playback | FadingLayer; weight: number }[] = [];
			if (playback) layers.push({ source: playback, weight: playbackWeight(playback) });
			for (const layer of this.fadingLayers) {
				const fade = layer.channels.get(channel);
				if (fade) layers.push({ source: layer, weight: fadeWeight(fade) });
			}
			const total = layers.reduce((sum, layer) => sum + layer.weight, 0);
			const divisor = Math.max(1, total);
			const background = Math.max(0, 1 - total);
			for (const name of AXIS_NAMES.filter((axis) => AXES[axis].channel === channel)) {
				target[name] =
					target[name]! * background +
					layers.reduce((value, layer) => value + (sampled.get(layer.source)![name]! * layer.weight) / divisor, 0);
				tempos[name] =
					background + layers.reduce((value, layer) => value + (layer.source.tempo * layer.weight) / divisor, 0);
			}
			if (channel === "mouth") {
				speechGain =
					speechGain * background +
					layers.reduce((gain, layer) => {
						const sourceGain = this.speechContribution(layer.source);
						return gain + (sourceGain * layer.weight) / divisor;
					}, 0);
			}
		}
		return speechGain;
	}
	compose(deltaMs: number, options?: { speechEnergy?: number; mouthOpen?: number }): Record<string, number> {
		let remaining = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
		let frame: Record<string, number>;
		do {
			// Sample moving intents at render resolution; split at expiration before recomposing ownership.
			const elapsed = Math.min(remaining, 1000 / 60, this.holdRemainingMs ?? Infinity);
			frame = this.composeStep(elapsed, options);
			remaining = Math.max(0, remaining - elapsed);
			if (this.holdRemainingMs !== undefined) {
				this.holdRemainingMs -= elapsed;
				if (this.holdRemainingMs <= 0.000001) {
					this.applyBasePose("relaxed", { transitionMs: 600 });
					this.onBasePoseExpired?.();
				}
			}
		} while (remaining > 0.000001);
		return frame;
	}
	private composeStep(
		deltaMs: number,
		options?: { speechEnergy?: number; mouthOpen?: number },
	): Record<string, number> {
		for (const playback of this.playbacks) playback.ageMs += deltaMs;
		this.reflexVisibility.ageMs += deltaMs;
		this.attentionAgeMs += deltaMs;
		for (const layer of this.fadingLayers) {
			layer.ageMs += deltaMs;
			for (const [channel, fade] of layer.channels) {
				fade.ageMs += deltaMs;
				if (fade.ageMs >= fade.durationMs) layer.channels.delete(channel);
			}
			if (!layer.channels.size) this.fadingLayers.delete(layer);
		}
		if (this.baseTransition) {
			this.baseTransition.ageMs += deltaMs;
			this.presentedBase = sampleMotion(this.baseTransition.motion, this.baseTransition.ageMs);
			if (this.baseTransition.ageMs >= this.baseTransition.motion.durationMs) this.baseTransition = undefined;
		}
		if (this.stateLayer) {
			this.stateLayer.ageMs += deltaMs;
			if (this.stateLayer.releaseAgeMs !== undefined) {
				this.stateLayer.releaseAgeMs += deltaMs;
				if (this.stateLayer.releaseAgeMs >= STATE_MOTIONS[this.stateLayer.key].exitMs) this.stateLayer = undefined;
			}
		}
		const elapsed = Math.max(0, deltaMs),
			dt = elapsed / 1000;
		this.phase += dt;
		const energy = Math.max(0, Math.min(1, options?.speechEnergy ?? 0));
		const activityTarget = Math.min(1, energy * 1.5);
		this.speechActivity +=
			(activityTarget - this.speechActivity) *
			(1 - Math.exp(-dt / (activityTarget > this.speechActivity ? 0.12 : 0.3)));
		this.silenceMs = energy > 0.02 ? 0 : this.silenceMs + elapsed;
		if (this.speechActivity < 0.001) this.speechActivity = 0;
		this.speechPhase += dt * (energy > 0.02 ? 1 : 0.25);
		const target: Record<string, number> = { ...NEUTRAL_AXES, ...this.presentedBase };
		const tempos: Record<string, number> = {};
		for (const [name, value] of this.latched) target[name] = value;
		const state = this.stateOffsets();
		const reflexWeight = this.reflexWeight();
		for (const [name, value] of Object.entries(state.values)) {
			if (!this.latched.has(name)) target[name]! += value * reflexWeight;
		}
		const offsets: Record<string, number> = {};
		const addAmbient = (name: string, value: number) => {
			offsets[name] = (offsets[name] ?? 0) + value;
		};
		if (this.attentionAgeMs < AMBIENT.attention.durationMs) {
			for (const [name, value] of Object.entries(sampleMotion(AMBIENT.attention, this.attentionAgeMs)))
				addAmbient(name, value * reflexWeight);
		}
		const free = (ch: Live2DChannel, priority: number = CHANNEL_PRIORITY.CUE) => !this.isChannelLocked(ch, priority);
		if (this.idleShift) {
			const shift = this.idleShift;
			if (
				!shift.release &&
				(this.speechActivity > 0.03 ||
					this.statePose ||
					this.latched.has(shift.name) ||
					!free(AXES[shift.name].channel))
			)
				shift.release = { ageMs: 0, value: this.idleValue(shift) };
			shift.ageMs += elapsed;
			if (shift.release) shift.release.ageMs += elapsed;
			const value = shift.release
				? shift.release.value * (1 - smooth(shift.release.ageMs / AMBIENT.idleReleaseMs))
				: this.idleValue(shift);
			addAmbient(shift.name, value);
			if (shift.ageMs >= shift.motion.durationMs || (shift.release && shift.release.ageMs >= AMBIENT.idleReleaseMs))
				this.idleShift = undefined;
		} else if (this.silenceMs > 4000 && !this.statePose && this.speechActivity < 0.03) {
			this.idleGapMs -= elapsed;
			if (this.idleGapMs <= 0) {
				const motion = AMBIENT.idle[this.randomFn() < 0.55 ? 0 : 1]!;
				const name = motion.axes[0]!;
				if (free(AXES[name].channel) && !this.latched.has(name)) {
					this.idleShift = { motion, name, sign: this.randomFn() < 0.5 ? -1 : 1, ageMs: 0 };
					this.idleGapMs = 6000 + this.randomFn() * 6000;
				}
			}
		}
		const noise = this.noise.tick(elapsed, {
			allowBlink: free("eyes") && !this.latched.has("eyes.left.open") && !this.latched.has("eyes.right.open"),
		});
		for (const [name, value] of Object.entries(noise)) {
			if (name === "eyes.left.open" || name === "eyes.right.open") continue;
			if (name === "torso.breath") target[name] = value * (1 - this.speechActivity * 0.15);
			else addAmbient(name, value);
		}
		for (const [name, value] of Object.entries(sampleLoop(AMBIENT.speech, this.speechPhase * 1000))) {
			addAmbient(name, value * this.speechActivity);
		}
		this.pulseAgeMs += elapsed;
		if (this.pulseAgeMs < AMBIENT.accent.durationMs)
			for (const [name, value] of Object.entries(sampleMotion(AMBIENT.accent, this.pulseAgeMs))) {
				addAmbient(name, value * this.pulseMagnitude);
			}
		if (!this.latched.has("gaze.x") && !this.latched.has("gaze.y")) {
			const gaze = sampleLoop(AMBIENT.gazeThinking, this.phase * 1000);
			const { vorX, vorY } = compensateGaze(
				this.body.getParam("head.yaw"),
				this.body.getParam("head.pitch"),
				this.body.getParam("head.roll"),
			);
			const gazeWeight = state.weight * reflexWeight;
			addAmbient("gaze.x", gaze["gaze.x"]! * gazeWeight + vorX * (1 - gazeWeight));
			addAmbient("gaze.y", gaze["gaze.y"]! * gazeWeight + vorY * (1 - gazeWeight));
		}
		// Ornament uses remaining headroom; authored foreground retains its full intended amplitude.
		for (const [name, offset] of Object.entries(offsets)) {
			const axis = AXES[name as MotionAxis];
			const room = Math.max(0, offset >= 0 ? axis.max - target[name]! : target[name]! - axis.min);
			if (room > 0) target[name]! += room * Math.tanh(offset / room);
		}
		const speechGain = this.mixForeground(target, tempos);
		const mouthOpen = Number.isFinite(options?.mouthOpen) ? Math.max(0, Math.min(1, options!.mouthOpen!)) : 0;
		target["mouth.open"]! += (1 - target["mouth.open"]!) * mouthOpen * speechGain;
		if (mouthOpen > 0) tempos["mouth.open"] = (tempos["mouth.open"] ?? 1) + speechGain * 1.2;
		this.lastTargets = { ...target };
		for (const [name, value] of Object.entries(target)) this.body.setTarget(name, value, tempos[name] ?? 1);
		const frame = this.body.tick(elapsed);
		// A blink is an aperture waveform, independent of the slower authored facial transition.
		// Admission only gates NEW blinks. An admitted blink finishes, so taking/releasing eyes never pops.
		frame["eyes.left.open"]! *= noise["eyes.left.open"] ?? 1;
		frame["eyes.right.open"]! *= noise["eyes.right.open"] ?? 1;
		for (const playback of this.playbacks)
			if (playback.ageMs + 0.000001 >= playback.motion.durationMs + (playback.latch ? 0 : playback.exitMs))
				playback.finish("completed");
		return frame;
	}
}

function compensateGaze(yaw: number, pitch: number, roll: number): { vorX: number; vorY: number } {
	return {
		vorX: Math.max(-0.6, Math.min(0.6, -yaw / 45 - roll / 90)),
		vorY: Math.max(-0.6, Math.min(0.6, -pitch / 45)),
	};
}
