import { sampleMotion, smooth, type CompiledMotion } from "../authoring/motion.js";
import type { RigControlDef } from "../adapter/rig.js";
import { AutonomicGenerator, type AutonomicExternal } from "./autonomic.js";

/** director 构造选项：external 声明自律主来源（缺省不启用自律发生器）；rng 注入（A9）。 */
export interface DirectorOptions {
	external?: AutonomicExternal;
	rng?: () => number;
}

/**
 * MotionDirector（P2-1）：槽位 Set/Patch、逐轴 Override 仲裁、类别优先级、独占声明。
 *
 * 依据：引擎规范 v4.6 §4.1 + 修订 A1/A9/A11/A12/A15/A17。
 *
 * 核心模型（逐轴、单一仲裁点）：
 * - 每个轴的 Override 写入权按 (类别优先级, 激活序) 仲裁，最高者为当帧写入方；
 * - 槽位（posture/expression）是 transition 级（20）的常驻 Override 来源；
 * - 被遮蔽者播放时间继续流逝，重新接管时从当前帧值平滑淡入（A17.3 交还连续性）；
 * - Additive（baseline-offset 轨道）独立叠加、永不构成抢占（A17.1）；
 * - 抢占 = Override 写入权变更：仅当更高类别接管 atomic 动作的任一轴时整场 cancel，
 *   finished 在自身 fadeOut 收势后结算（A17.2）；同类同轴冲突 = shadow，不取消；
 * - 类别到优先级的映射固定且私有（A1）：外部任何路径拿不到自定义优先级数值；
 * - 时钟完全由调用方 step(dtMs) 驱动（A9），全部测试手工步进，无真实等待。
 *
 * 已登记的实现决策（规范留白处，最小语义）：
 * - 同类别同轴多写入者 = shadow（新者在上，旧者时间继续），不触发 atomic 取消——
 *   取消只发生在严格跨类别抢占时；legacy 以 reason 字符串判同优先级冲突的机制废弃；
 * - 独占声明 v1 仅声明间互斥（reason 相同 = 幂等替换，否则 resource_conflict；
 *   cleanup 声明在完成前一律拒绝）；与参数动作的资源互斥待 adapter 资源表（P4-5）。
 */

export type MotionCategory = "reflex" | "voluntary" | "transition" | "autonomic";

/** A1：矩阵数值只在本模块内可见，类型层不暴露任何 priority 入参。 */
const CATEGORY_PRIORITY: Readonly<Record<MotionCategory, number>> = {
	reflex: 40,
	voluntary: 30,
	transition: 20,
	autonomic: 10,
};

/** A15：具名化抢占错误，携带被抢占的轴集合；以 instanceof 判定。 */
export class SupersededError extends Error {
	constructor(readonly axes: readonly string[]) {
		super(`被更新的意图抢占: ${axes.join(", ")}`);
		this.name = "SupersededError";
	}
}

export type MotionStatus = "playing" | "releasing" | "cancelling" | "finished" | "cancelled";
export type MotionTerminationStatus = "completed" | "cancelled" | "failed";

export interface SomaticActionResult {
	readonly status: MotionTerminationStatus;
	readonly reason?: string;
}

/** A3：Handle 仅保留 id/status/currentTime/duration/finished/stop(mode?)。 */
export interface MotionHandle {
	readonly id: string;
	readonly status: MotionStatus;
	readonly currentTime: number;
	readonly duration: number;
	/** 保证在所有终态必定结算，绝不悬挂（引擎 #8）。 */
	readonly finished: Promise<SomaticActionResult>;
	stop(mode?: "release" | "cut"): void;
}

export interface SlotOptions {
	durationMs?: number;
	/** A11：保持时长；到期该槽自动平滑回中性，多槽独立计时。 */
	holdMs?: number;
}

export interface PlayOptions {
	/** A1：类别即优先级，这是唯一的优先级表达方式。 */
	category: MotionCategory;
	/** 默认 true：任一轴被更高类别 Override 接管即整场取消（A17.2）。 */
	atomic?: boolean;
	fadeInMs?: number;
	fadeOutMs?: number;
	/** Override 轨道入场起点：current = 捕获当前合成值（默认），neutral = 从中性起。 */
	entry?: "current" | "neutral";
	/** 抑制更低类别动作在本动作 Override 轴上的 Additive 贡献（§4.1 增量抑制遮罩）。 */
	inhibitAdditives?: boolean | readonly string[];
	/** P3-1 骨骼弹簧消费；director 仅透传存储。 */
	resetVelocity?: boolean;
	signal?: AbortSignal;
}

export interface ExclusiveClaim {
	readonly id: string;
	readonly resources: ReadonlySet<string>;
	/** A12：带清理的声明在清理完成前不可被抢占；调用方在清理完成后必须 release()。 */
	release(): void;
	cancel(): void;
	readonly signal: AbortSignal;
}

export type AttentionTarget = { x: number; y: number } | "user" | "screen" | "avert_down" | "avert_left" | "avert_right";

/** 槽位过渡组：一组同批声明的轴过渡，共享一个 Promise；同轴竞争时整组拒绝但运动继续。 */
interface SlotOp {
	axes: ReadonlySet<string>;
	total: number;
	completed: number;
	superseded: boolean;
	resolve: () => void;
	reject: (error: SupersededError) => void;
}

interface SlotTransition {
	from: number;
	to: number;
	ageMs: number;
	durationMs: number;
	op?: SlotOp;
}

interface SlotState {
	values: Map<string, number>;
	transitions: Map<string, SlotTransition>;
	/** A11：保持倒计时（ms）；undefined = 持续。 */
	holdRemainingMs?: number;
	seq: number;
}

interface Playback {
	id: string;
	clip: CompiledMotion;
	category: MotionCategory;
	priority: number;
	atomic: boolean;
	fadeInMs: number;
	fadeOutMs: number;
	inhibitAdditives: boolean | readonly string[];
	signal?: AbortSignal;
	/** Override 轴（clip 内含 absolute 轨道的轴）。 */
	overrideAxes: ReadonlySet<string>;
	/** Additive 轴（仅 baseline-offset 轨道的轴）。 */
	additiveAxes: ReadonlySet<string>;
	ageMs: number;
	seq: number;
	state: MotionStatus;
	/** 退出结算状态：自然结束 = completed；release/preempt = cancelled。 */
	exitStatus: "completed" | "cancelled";
	/** 退出权重推进起点（自然结束 = durationMs；release/preempt = 进入该态时刻）。 */
	exitStartMs: number;
	/** play() 时刻捕获的底座（sequence 片段内 blend 的 resting 事实）。 */
	baseline: Readonly<Record<string, number>>;
	/** 每个正在写入的 Override 轴的入场捕获与增益年龄；被遮蔽期间冻结。 */
	gain: Map<string, { from: number; ageMs: number }>;
	resolve: (result: SomaticActionResult) => void;
	settled: boolean;
	handle: MotionHandle;
}

interface HandoffFade {
	from: number;
	ageMs: number;
	durationMs: number;
}

interface InternalClaim {
	id: string;
	resources: Set<string>;
	cleanup: boolean;
	controller: AbortController;
}

const DEFAULT_SLOT_TRANSITION_MS = 350;

export class MotionDirector {
	private readonly controls: Readonly<Record<string, RigControlDef>>;
	private readonly neutral: Readonly<Record<string, number>>;
	private readonly playbacks: Playback[] = [];
	private readonly handoffs = new Map<string, HandoffFade>();
	private readonly slots: { posture: SlotState; expression: SlotState } = {
		posture: { values: new Map(), transitions: new Map(), seq: 0 },
		expression: { values: new Map(), transitions: new Map(), seq: 0 },
	};
	private attention: { target: AttentionTarget; holdRemainingMs?: number } | undefined;
	private readonly claims = new Set<InternalClaim>();
	private counter = 0;
	private seqCounter = 0;
	private frozen = false;
	private frame: Record<string, number>;
	private readonly autonomic?: AutonomicGenerator;
	private autonomicBlinkFactor = 1;

	constructor(controls: Readonly<Record<string, RigControlDef>>, options: DirectorOptions = {}) {
		this.controls = controls;
		this.neutral = Object.fromEntries(Object.entries(controls).map(([axis, c]) => [axis, c.neutral]));
		this.frame = { ...this.neutral };
		if (options.external) {
			this.autonomic = new AutonomicGenerator({ rng: options.rng });
			this.autonomic.setExternal(options.external);
		}
	}

	/** 最近一帧合成结果（safeStop 保持帧与诊断的事实来源）。 */
	get currentFrame(): Readonly<Record<string, number>> {
		return this.frame;
	}

	/** 眨眼因子（1=全开 0=全闭）；眼睑管道（P3-1）据它做乘法调制。未启用自律时恒 1。 */
	get blinkFactor(): number {
		return this.autonomicBlinkFactor;
	}

	// ---------- 槽位（§2.2 + A11）----------

	/** 整槽替换：未声明轴平滑归中，槽内所有进行中的旧过渡立即以 SupersededError reject（引擎 #12）。 */
	setPosture(values: Readonly<Record<string, number>>, options: SlotOptions = {}): Promise<void> {
		return this.setSlot("posture", values, options);
	}
	setExpression(values: Readonly<Record<string, number>>, options: SlotOptions = {}): Promise<void> {
		return this.setSlot("expression", values, options);
	}
	/** 逐轴局部修改：同轴竞争旧 Promise 立即 SupersededError，未冲突轴运动继续（引擎 #6）。 */
	patchPosture(patch: Readonly<Record<string, number>>, options: SlotOptions = {}): Promise<void> {
		return this.patchSlot("posture", patch, options);
	}
	patchExpression(patch: Readonly<Record<string, number>>, options: SlotOptions = {}): Promise<void> {
		return this.patchSlot("expression", patch, options);
	}
	/** 注视目标槽：存储事实，轴级转换由视线管道（P3-1）结算。 */
	setAttention(target: AttentionTarget, options: SlotOptions = {}): void {
		this.attention = { target, holdRemainingMs: options.holdMs };
	}

	getAttention(): AttentionTarget | undefined {
		return this.attention?.target;
	}

	private setSlot(name: "posture" | "expression", values: Readonly<Record<string, number>>, options: SlotOptions): Promise<void> {
		const slot = this.slots[name];
		this.validateSlotValues(name, values);
		this.supersedeAll(name);
		// 整槽替换的作用域 = 新声明轴 ∪ 槽内既有轴（后者归中）。
		const axes = new Set([...Object.keys(values), ...slot.values.keys(), ...slot.transitions.keys()]);
		const holdTotalMs = options.holdMs === undefined ? undefined : options.holdMs + (options.durationMs ?? DEFAULT_SLOT_TRANSITION_MS);
		return this.beginSlotTransitions(name, axes, (axis) => values[axis], options.durationMs ?? DEFAULT_SLOT_TRANSITION_MS, holdTotalMs);
	}

	private patchSlot(name: "posture" | "expression", patch: Readonly<Record<string, number>>, options: SlotOptions): Promise<void> {
		this.validateSlotValues(name, patch);
		const slot = this.slots[name];
		const axes = new Set(Object.keys(patch));
		// 同轴竞争：与进行中过渡重叠的轴，其所属旧 Promise 立即 SupersededError（携带冲突轴集合）；
		// 旧调用中未冲突的轴运动不受影响（引擎 #6）。
		const superseded = new Set<SlotOp>();
		for (const [axis, transition] of slot.transitions) {
			if (axes.has(axis) && transition.op && !transition.op.superseded) superseded.add(transition.op);
		}
		for (const op of superseded) {
			op.superseded = true;
			op.reject(new SupersededError([...op.axes].filter((axis) => axes.has(axis))));
			for (const transition of slot.transitions.values()) if (transition.op === op) transition.op = undefined;
		}
		return this.beginSlotTransitions(name, axes, (axis) => patch[axis]!, options.durationMs ?? DEFAULT_SLOT_TRANSITION_MS, options.holdMs);
	}

	private validateSlotValues(name: string, values: Readonly<Record<string, number>>): void {
		for (const [axis, value] of Object.entries(values)) {
			const control = this.controls[axis];
			if (!control) throw new Error(`${name} 引用未声明控制: ${axis}`);
			if (!Number.isFinite(value) || value < control.min || value > control.max)
				throw new Error(`${name} 控制超出范围: ${axis}=${value}`);
		}
	}

	private beginSlotTransitions(
		name: "posture" | "expression",
		axes: ReadonlySet<string>,
		targetOf: (axis: string) => number,
		durationMs: number,
		holdTotalMs: number | undefined,
	): Promise<void> {
		const slot = this.slots[name];
		if (axes.size === 0) return Promise.resolve();
		const op: SlotOp = {
			axes,
			total: axes.size,
			completed: 0,
			superseded: false,
			resolve: () => {},
			reject: () => {},
		};
		const promise = new Promise<void>((resolve, reject) => {
			op.resolve = resolve;
			op.reject = reject;
		});
		for (const axis of axes) {
			const target = targetOf(axis);
			const current = this.slotValue(slot, axis);
			slot.transitions.set(axis, { from: current, to: target, ageMs: 0, durationMs, op });
		}
		slot.seq = ++this.seqCounter;
		slot.holdRemainingMs = holdTotalMs;
		return promise;
	}

	private supersedeAll(name: "posture" | "expression"): void {
		const slot = this.slots[name];
		for (const transition of slot.transitions.values()) {
			if (transition.op && !transition.op.superseded) {
				transition.op.superseded = true;
				transition.op.reject(new SupersededError([...transition.op.axes]));
				transition.op = undefined;
			}
		}
	}

	// ---------- 播放（§4.1 + §5.2）----------

	play(clip: CompiledMotion, options: PlayOptions): MotionHandle {
		const overrideAxes = new Set(clip.tracks.filter((t) => t.space === "absolute").map((t) => t.axis));
		const additiveAxes = new Set(
			clip.tracks.filter((t) => t.space === "baseline-offset").map((t) => t.axis).filter((a) => !overrideAxes.has(a)),
		);
		const baseline: Record<string, number> =
			options.entry === "neutral" ? { ...this.neutral } : { ...this.slotComposite() };
		const playback: Playback = {
			id: `motion-${++this.counter}`,
			clip,
			category: options.category,
			priority: CATEGORY_PRIORITY[options.category],
			atomic: options.atomic ?? true,
			fadeInMs: options.fadeInMs ?? 120,
			fadeOutMs: options.fadeOutMs ?? 250,
			inhibitAdditives: options.inhibitAdditives ?? false,
			signal: options.signal,
			overrideAxes,
			additiveAxes,
			ageMs: 0,
			seq: ++this.seqCounter,
			state: "playing",
			exitStatus: "completed",
			exitStartMs: clip.durationMs,
			baseline,
			gain: new Map(),
			resolve: () => {},
			settled: false,
			handle: undefined as unknown as MotionHandle,
		};
		const finished = new Promise<SomaticActionResult>((resolve) => {
			playback.resolve = resolve;
		});
		playback.handle = {
			id: playback.id,
			get status(): MotionStatus {
				return playback.state;
			},
			get currentTime(): number {
				return Math.min(playback.ageMs, playback.clip.durationMs) / 1000;
			},
			get duration(): number {
				return playback.clip.durationMs / 1000;
			},
			finished,
			stop: (mode: "release" | "cut" = "release") => {
				if (playback.settled || playback.state === "cancelling") return;
				if (mode === "cut") {
					// §4.1.4：cut 立即清零权重并结算 cancelled，无淡出（引擎 #8）。
					this.finishPlayback(playback, { status: "cancelled", reason: "stopped" });
					return;
				}
				if (playback.state === "releasing") return;
				// release：立即交还控制权，fadeOut 收势后结算 cancelled。
				playback.state = "releasing";
				playback.exitStatus = "cancelled";
				playback.exitStartMs = playback.ageMs;
				this.beginHandoff(playback);
			},
		};
		this.playbacks.push(playback);
		if (options.signal) {
			const abort = () => playback.handle.stop("cut");
			if (options.signal.aborted) abort();
			else options.signal.addEventListener("abort", abort, { once: true });
		}
		return playback.handle;
	}

	private finishPlayback(playback: Playback, result: SomaticActionResult): void {
		if (playback.settled) return;
		playback.settled = true;
		playback.state = result.status === "completed" ? "finished" : "cancelled";
		const index = this.playbacks.indexOf(playback);
		if (index >= 0) this.playbacks.splice(index, 1);
		playback.resolve({ status: result.status, reason: result.reason });
	}

	// ---------- 独占声明（A12）----------

	claimExclusive(
		resources: readonly string[],
		options: { reason: string; cleanup?: boolean; signal?: AbortSignal },
	): ExclusiveClaim {
		if (options.signal?.aborted) throw new Error("动作已取消");
		const requested = new Set(resources);
		for (const existing of this.claims) {
			if (![...requested].some((r) => existing.resources.has(r))) continue;
			if (existing.cleanup) throw new Error("资源冲突：正在执行外部清理");
			// 幂等重触发：同 reason 的再声明替换旧声明；其余一律 resource_conflict（边界 #9）。
			if (!existing.id.endsWith(`:${options.reason}`)) throw new Error("资源冲突");
		}
		for (const existing of [...this.claims]) {
			if ([...requested].some((r) => existing.resources.has(r))) this.releaseClaim(existing);
		}
		const controller = new AbortController();
		const claim: InternalClaim = {
			id: `claim-${++this.counter}:${options.reason}`,
			resources: requested,
			cleanup: options.cleanup ?? false,
			controller,
		};
		this.claims.add(claim);
		if (options.signal) {
			const abort = () => controller.abort();
			if (options.signal.aborted) abort();
			else options.signal.addEventListener("abort", abort, { once: true });
		}
		return {
			id: claim.id,
			resources: requested,
			release: () => this.releaseClaim(claim),
			cancel: () => controller.abort(),
			signal: controller.signal,
		};
	}

	private releaseClaim(claim: InternalClaim): void {
		if (!this.claims.delete(claim)) return;
		claim.controller.abort();
	}

	// ---------- 代次失效与暂停 ----------

	/** 模型更换/绑定失效：全部活跃 Handle 结算 cancelled，槽位过渡作废（引擎 #11；§3.3.2）。 */
	invalidateAll(reason = "binding generation changed"): void {
		for (const playback of [...this.playbacks]) {
			playback.settled = true;
			playback.state = "cancelled";
			const index = this.playbacks.indexOf(playback);
			if (index >= 0) this.playbacks.splice(index, 1);
			playback.resolve({ status: "cancelled", reason });
		}
		this.handoffs.clear();
		for (const name of ["posture", "expression"] as const) {
			const slot = this.slots[name];
			this.supersedeAll(name);
			slot.transitions.clear();
			slot.values.clear();
			slot.holdRemainingMs = undefined;
		}
		this.attention = undefined;
	}

	/** A11 冻结规则：任何非播放态（暂停/失焦）下保持倒计时与过渡暂停，恢复后继续剩余。 */
	setFrozen(frozen: boolean): void {
		this.frozen = frozen;
	}

	// ---------- 合成（A9：显式步进）----------

	/** 推进一帧并返回合成逻辑帧。冻结时返回当前帧快照（倒计时与过渡全部暂停）。 */
	step(deltaMs: number): Readonly<Record<string, number>> {
		if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("非法渲染时间");
		if (this.frozen) return { ...this.frame };
		const dt = deltaMs;

		// 1. 槽位过渡推进 + 保持倒计时（多槽独立计时，A11）。
		for (const name of ["posture", "expression"] as const) {
			const slot = this.slots[name];
			for (const [axis, transition] of [...slot.transitions]) {
				transition.ageMs += dt;
				if (transition.durationMs <= 0 || transition.ageMs >= transition.durationMs) {
					slot.values.set(axis, transition.to);
					slot.transitions.delete(axis);
					if (transition.op && !transition.op.superseded) {
						transition.op.completed++;
						if (transition.op.completed >= transition.op.total) transition.op.resolve();
					}
				}
			}
			if (slot.holdRemainingMs !== undefined) {
				slot.holdRemainingMs -= dt;
				if (slot.holdRemainingMs <= 0) {
					slot.holdRemainingMs = undefined;
					this.beginNeutralReturn(name);
				}
			}
		}
		if (this.attention?.holdRemainingMs !== undefined) {
			this.attention.holdRemainingMs -= dt;
			if (this.attention.holdRemainingMs <= 0) this.attention = undefined;
		}

		// 2. 播放推进 + 生命周期：自然结束/preempt/release 统一走 handoff 交还（A17.3）。
		for (const playback of [...this.playbacks]) {
			playback.ageMs += dt;
			if (playback.state === "playing" && playback.ageMs >= playback.clip.durationMs) {
				// 自然播放完毕：立即交还控制权（下一来源接管），fadeOut 后结算 completed。
				this.beginExit(playback, "completed");
			} else if (playback.state !== "playing" && playback.ageMs >= playback.exitStartMs + playback.fadeOutMs) {
				this.finishPlayback(playback, {
					status: playback.exitStatus,
					reason: playback.state === "releasing" ? "released" : playback.exitStatus === "completed" ? undefined : "preempted",
				});
			}
		}

		// 3. 手交淡出推进（A17.3）。
		for (const [axis, fade] of [...this.handoffs]) {
			fade.ageMs += dt;
			if (fade.durationMs <= 0 || fade.ageMs >= fade.durationMs) this.handoffs.delete(axis);
		}

		// 4. 基座帧：中性 + 槽位合成 + 手交混合。
		const frame: Record<string, number> = { ...this.neutral };
		for (const [axis, value] of Object.entries(this.slotComposite())) frame[axis] = value;
		for (const [axis, fade] of this.handoffs) {
			const weight = fade.durationMs > 0 ? smooth(fade.ageMs / fade.durationMs) : 1;
			frame[axis] = fade.from + (frame[axis]! - fade.from) * weight;
		}

		// 5. 逐轴 Override 仲裁：候选 = 槽位轴（transition 级）+ 各播放的 Override 轴。
		interface Candidate {
			priority: number;
			seq: number;
			playback?: Playback;
			slotValue?: number;
		}
		const candidates = new Map<string, Candidate[]>();
		for (const name of ["posture", "expression"] as const) {
			const slot = this.slots[name];
			for (const axis of new Set([...slot.values.keys(), ...slot.transitions.keys()])) {
				const list = candidates.get(axis) ?? [];
				list.push({ priority: CATEGORY_PRIORITY.transition, seq: slot.seq, slotValue: this.slotValue(slot, axis) });
				candidates.set(axis, list);
			}
		}
		for (const playback of this.playbacks) {
			// 退场中（releasing/cancelling）已交还控制权，不再是候选；handoff 淡出负责连续性。
			if (playback.state !== "playing") continue;
			for (const axis of playback.overrideAxes) {
				const list = candidates.get(axis) ?? [];
				list.push({ priority: playback.priority, seq: playback.seq, playback });
				candidates.set(axis, list);
			}
		}

		const inhibitMask = new Map<string, number>(); // axis -> 抑制者的优先级
		for (const [axis, list] of candidates) {
			list.sort((a, b) => b.priority - a.priority || b.seq - a.seq);
			const winner = list[0]!;
			// 被遮蔽者清除入场增益：重新接管时从当前帧值重新淡入（§4.1.3 平滑恢复）。
			for (const loser of list) {
				if (loser.playback && loser !== winner) loser.playback.gain.delete(axis);
			}
			// A17.2：atomic 动作的轴被严格更高优先级 Override 接管 → 整场取消（本帧立即生效）。
			for (const loser of list) {
				if (loser.playback && loser !== winner && loser.playback.priority < winner.priority && loser.playback.atomic) {
					this.beginExit(loser.playback, "cancelled");
				}
			}
			if (winner.playback) {
				const p = winner.playback;
				// 首次写入或遮蔽恢复：捕获当前帧值平滑淡入（§4.1.3）；被遮蔽期间增益冻结。
				let gainState = p.gain.get(axis);
				if (!gainState) {
					gainState = { from: frame[axis] ?? this.neutral[axis]!, ageMs: 0 };
					p.gain.set(axis, gainState);
				}
				gainState.ageMs += dt;
				const gain = p.fadeInMs > 0 ? smooth(gainState.ageMs / p.fadeInMs) : 1;
				const sampled = sampleMotion(p.clip, p.ageMs, p.baseline)[axis] ?? frame[axis]!;
				// 候选恒为 playing 且 ageMs < durationMs（退场在 §2 已转换并交还），无退出混合项。
				frame[axis] = gainState.from + (sampled - gainState.from) * gain;
				if (p.inhibitAdditives === true || (Array.isArray(p.inhibitAdditives) && p.inhibitAdditives.includes(axis))) {
					inhibitMask.set(axis, p.priority);
				}
			} else {
				frame[axis] = winner.slotValue!;
			}
		}

		// 6. Additive 层：独立叠加 ΔX，永不抢占（A17.1）；受增量抑制遮罩约束。
		for (const playback of this.playbacks) {
			if (!playback.additiveAxes.size) continue;
			const sampled = sampleMotion(playback.clip, playback.ageMs, playback.baseline);
			for (const axis of playback.additiveAxes) {
				const maskPriority = inhibitMask.get(axis);
				if (maskPriority !== undefined && playback.priority < maskPriority) continue;
				const delta = sampled[axis]! - (playback.baseline[axis] ?? this.neutral[axis]!);
				frame[axis] = (frame[axis] ?? this.neutral[axis]!) + delta * this.lifeWeight(playback);
			}
		}

		// 6.5 自律底座（autonomic，10）：呼吸/微晃/漂移增量 + 眨眼因子（§4.2 第 2 条）。
		if (this.autonomic) {
			// 避让规则：存在更高类别主动 Override 时微晃衰减；注视锚定锁定时漂移抑制。
			const activeMotion = this.playbacks.some((p) => p.state === "playing" && p.priority > CATEGORY_PRIORITY.autonomic);
			this.autonomic.setSuppression({ sway: activeMotion ? 0 : 1, drift: this.attention ? 0 : 1 });
			const auto = this.autonomic.step(dt);
			this.autonomicBlinkFactor = auto.blinkFactor;
			for (const [axis, delta] of Object.entries(auto.deltas)) {
				// rig 未声明的轴（如 MO 无 torso.breath）静默丢弃。
				if (!this.controls[axis]) continue;
				const maskPriority = inhibitMask.get(axis);
				if (maskPriority !== undefined && CATEGORY_PRIORITY.autonomic < maskPriority) continue;
				frame[axis] = (frame[axis] ?? this.neutral[axis]!) + delta;
			}
			// 眼睑调制（P2 简化版，引擎 #3）：blinkFactor 乘性作用于最终眼开值——
			// 表情把眼压到 0.8 时眨眼仍能完全闭拢再回 0.8。P3-1 管道化后迁入 pipelines。
			if (this.autonomicBlinkFactor < 1) {
				for (const axis of ["eyes.left.open", "eyes.right.open"]) {
					if (frame[axis] !== undefined) frame[axis] = frame[axis] * this.autonomicBlinkFactor;
				}
			}
		}

		// 7. 范围安全网。
		for (const [axis, value] of Object.entries(frame)) {
			const control = this.controls[axis];
			frame[axis] = control ? Math.max(control.min, Math.min(control.max, value)) : value;
		}
		this.frame = frame;
		return { ...frame };
	}

	/** A17.2/A17.3：退场统一入口——立即交还控制权，退场轴经 handoff 淡向下一来源，fadeOut 后结算。 */
	private beginExit(playback: Playback, status: "completed" | "cancelled"): void {
		if (playback.settled || playback.state !== "playing") return;
		playback.state = status === "completed" ? "cancelling" : "releasing";
		playback.exitStatus = status;
		playback.exitStartMs = playback.ageMs;
		this.beginHandoff(playback);
	}

	private beginHandoff(playback: Playback): void {
		for (const axis of playback.overrideAxes) {
			this.handoffs.set(axis, { from: this.frame[axis] ?? this.neutral[axis]!, ageMs: 0, durationMs: playback.fadeOutMs });
		}
	}

	/**
	 * 生命权重：1 = 动作完全生效，0 = 已完全交还底座。
	 * 播放中恒为 1；自然结束/releasing/cancelling 后随 fadeOut 平滑衰减到 0。
	 * Override 退出走 handoff（beginExit）；Additive 贡献乘 lifeWeight 平滑收势。
	 */
	private lifeWeight(playback: Playback): number {
		const exitFrom = playback.state === "playing" ? playback.clip.durationMs : playback.exitStartMs;
		const over = playback.ageMs - exitFrom;
		if (over <= 0) return 1;
		return playback.fadeOutMs > 0 ? 1 - smooth(over / playback.fadeOutMs) : 0;
	}

	private slotComposite(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const name of ["posture", "expression"] as const) {
			const slot = this.slots[name];
			for (const [axis, value] of slot.values) result[axis] = value;
			for (const [axis, transition] of slot.transitions) {
				const weight = transition.durationMs > 0 ? smooth(transition.ageMs / transition.durationMs) : 1;
				result[axis] = transition.from + (transition.to - transition.from) * weight;
			}
		}
		return result;
	}

	private slotValue(slot: SlotState, axis: string): number {
		const transition = slot.transitions.get(axis);
		if (!transition) return slot.values.get(axis) ?? this.neutral[axis]!;
		const weight = transition.durationMs > 0 ? smooth(transition.ageMs / transition.durationMs) : 1;
		return transition.from + (transition.to - transition.from) * weight;
	}

	/** A11：到期自动回中性，走平滑过渡，无 Promise 归属。 */
	private beginNeutralReturn(name: "posture" | "expression"): void {
		const slot = this.slots[name];
		const axes = new Set([...slot.values.keys(), ...slot.transitions.keys()]);
		for (const axis of axes) {
			const current = this.slotValue(slot, axis);
			slot.transitions.set(axis, { from: current, to: this.neutral[axis]!, ageMs: 0, durationMs: DEFAULT_SLOT_TRANSITION_MS });
			slot.values.delete(axis);
		}
	}
}
