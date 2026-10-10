/**
 * 轴级专用管道（引擎规范 §4.2 阶段 B，P3-1）。
 *
 * 仲裁合成（阶段 A）产出目标值后，按轴域分流：
 * - 骨骼轴（head.x / torso.x / body.x）→ 二阶解析弹簧 SpringFilter（ζ=0.85、ω=15，A10 可配置）；
 *   高优先级动作切入默认保留位置与速度（弹簧状态按轴持久，与写入者无关）；
 *   仅显式 resetVelocity（剧烈惊跳）重置速度；Δt > 100ms 子步细分防过冲（A10）。
 * - 面部轴（mouth.x / face.x / brows.x / eyes.x.smile）→ 轻量阻尼平滑 SmoothFilter（敏捷不拖沓）。
 * - 视线轴（gaze.*）→ 头姿后置补偿：θ_eye = Clamp(aim − θ_head/headRange, comfort)；
 *   在头部实际姿态（弹簧输出）确定之后结算，杜绝点头/转头导致注视点漂移；
 *   动作 Override 或槽位已声明的视线轴让位（登记决策：补偿只作用于未被认领的视线轴）。
 * - 开合通道：眼睑乘法调制（EyeOpen·(1−W·(1−Factor))）+ 口型包络跟随
 *   （MouthOpen_base + (1−base)·L，暂停 50ms 线性释放回零，exclusive 压制 L=0）。
 *
 * 时钟完全由调用方 step(dt) 驱动（A9），无真实定时器。
 */

/** 弹簧参数（A10 可配置）。 */
export interface SpringParams {
	zeta: number;
	omega: number;
	/** 单个子步上限（ms）：超过则细分推进（规范：Δt>0.1s 保护，取一半裕量）。 */
	maxSubstepMs: number;
}

export const DEFAULT_SPRING: SpringParams = { zeta: 0.85, omega: 15, maxSubstepMs: 50 };

export const DEFAULT_SMOOTH_TAU_MS = 80;
export const DEFAULT_SPEECH_RELEASE_MS = 50;

/** 注视目标 → 视线瞄准（归一化 [-1,1]）。命名目标为缺省表，目录（P5）可经 options 覆盖。 */
export type GazeAim = { x: number; y: number };
export const DEFAULT_NAMED_AIMS: Readonly<Record<string, GazeAim>> = {
	user: { x: 0, y: 0.15 },
	screen: { x: 0, y: 0 },
	avert_down: { x: 0, y: -0.6 },
	avert_left: { x: -0.8, y: 0 },
	avert_right: { x: 0.8, y: 0 },
};

const boneAxis = (axis: string): boolean => /^(head|torso|body)\./.test(axis);
const faceAxis = (axis: string): boolean => /^(mouth|face|brows)\./.test(axis) || /^eyes\..*\.smile$/.test(axis);
const gazeAxis = (axis: string): boolean => axis.startsWith("gaze.");

/** 二阶解析弹簧：连续时间精确解，数学上无条件稳定；子步只为帧内大步长的视觉保护。 */
export class SpringFilter {
	private readonly params: SpringParams;
	private readonly state = new Map<string, { x: number; v: number }>();

	constructor(params: Partial<SpringParams> = {}) {
		this.params = { ...DEFAULT_SPRING, ...params };
	}

	/** 以初值建立轴状态（缺省从中性出发，无启动瞬态）。 */
	ensure(axis: string, x0: number): void {
		if (!this.state.has(axis)) this.state.set(axis, { x: x0, v: 0 });
	}

	/** 剧烈动作（resetVelocity）切入时重置速度；位置保留。 */
	resetVelocity(axes: Iterable<string>): void {
		for (const axis of axes) {
			const s = this.state.get(axis);
			if (s) s.v = 0;
		}
	}

	/** 推进一步，返回全部已跟踪轴的当前位置。target 不可省略（调用方保证 frame 内有值）。 */
	step(targets: Readonly<Record<string, number>>, dtMs: number): void {
		if (dtMs <= 0) return;
		const substeps = Math.max(1, Math.ceil(dtMs / this.params.maxSubstepMs));
		const h = dtMs / substeps / 1000;
		for (const [axis, target] of Object.entries(targets)) {
			const s = this.state.get(axis);
			if (!s) continue;
			for (let i = 0; i < substeps; i++) this.integrate(s, target, h);
		}
	}

	get(axis: string): number | undefined {
		return this.state.get(axis)?.x;
	}

	private integrate(s: { x: number; v: number }, target: number, h: number): void {
		const { zeta, omega } = this.params;
		const A = s.x - target;
		if (zeta < 1) {
			const wd = omega * Math.sqrt(1 - zeta * zeta);
			const B = (s.v + zeta * omega * A) / wd;
			const e = Math.exp(-zeta * omega * h);
			const c = Math.cos(wd * h);
			const sn = Math.sin(wd * h);
			s.x = target + e * (A * c + B * sn);
			s.v = e * ((-zeta * omega * A + B * wd) * c + (-zeta * omega * B - A * wd) * sn);
		} else {
			// ζ≥1：临界/过阻尼解析解（r1,2 = −ω(ζ±√(ζ²−1))），ζ=1 时重根。
			const r = Math.sqrt(Math.max(0, zeta * zeta - 1));
			const r1 = -omega * (zeta - r);
			const r2 = -omega * (zeta + r);
			if (r < 1e-9) {
				const C1 = A;
				const C2 = s.v + omega * A;
				s.x = target + (C1 + C2 * h) * Math.exp(r1 * h);
				s.v = Math.exp(r1 * h) * (C2 + (r1 * C1 + r1 * C2 * h));
			} else {
				const C2 = (s.v - r1 * A) / (r2 - r1);
				const C1 = A - C2;
				s.x = target + C1 * Math.exp(r1 * h) + C2 * Math.exp(r2 * h);
				s.v = C1 * r1 * Math.exp(r1 * h) + C2 * r2 * Math.exp(r2 * h);
			}
		}
	}
}

/** 面部轻量阻尼平滑：一阶指数逼近，敏捷而不拖沓。 */
export class SmoothFilter {
	private readonly tauMs: number;
	private readonly state = new Map<string, number>();

	constructor(tauMs = DEFAULT_SMOOTH_TAU_MS) {
		this.tauMs = tauMs;
	}

	ensure(axis: string, x0: number): void {
		if (!this.state.has(axis)) this.state.set(axis, x0);
	}

	step(targets: Readonly<Record<string, number>>, dtMs: number): void {
		if (dtMs <= 0) return;
		const k = 1 - Math.exp(-dtMs / this.tauMs);
		for (const [axis, target] of Object.entries(targets)) {
			const s = this.state.get(axis);
			if (s === undefined) continue;
			this.state.set(axis, s + (target - s) * k);
		}
	}

	get(axis: string): number | undefined {
		return this.state.get(axis);
	}
}

/** 口型包络跟随：快攻（目标升高立即跟随）、目标下降/暂停起 50ms 线性释放回零。 */
export class SpeechEnvelope {
	private readonly releaseMs: number;
	private target = 0;
	private level = 0;
	private releaseElapsedMs: number | undefined;
	private releaseFrom = 0;

	constructor(releaseMs = DEFAULT_SPEECH_RELEASE_MS) {
		this.releaseMs = releaseMs;
	}

	/** TTS 电平输入（P3-2 接 Audio Level / RMS）。 */
	setLevel(level: number): void {
		this.target = Math.max(0, Math.min(1, level));
	}

	step(dtMs: number): number {
		if (dtMs > 0) {
			if (this.target >= this.level) {
				this.level = this.target;
				this.releaseElapsedMs = undefined;
			} else {
				// 释放起点冻结：自进入释放起 50ms 线性降到零（不被逐帧乘性衰减稀释）。
				if (this.releaseElapsedMs === undefined) {
					this.releaseElapsedMs = 0;
					this.releaseFrom = this.level;
				}
				this.releaseElapsedMs = Math.min(this.releaseElapsedMs + dtMs, this.releaseMs);
				this.level = Math.max(this.target, this.releaseFrom * (1 - this.releaseElapsedMs / this.releaseMs));
			}
		}
		return this.level;
	}

	get current(): number {
		return this.level;
	}
}

/** 视线头姿后置补偿 + 开合通道调制（无状态纯函数，便于断言）。 */
export const gazeCompensation = (
	aim: GazeAim,
	headActualYaw: number,
	headActualPitch: number,
	headYawRange: number,
	headPitchRange: number,
	comfort = 1,
): GazeAim => {
	// 头姿换算到视线单位：全量程头转 = 1.0 归一化视线；眼球只承担余量并夹紧舒适域。
	const clamp1 = (v: number): number => Math.max(-comfort, Math.min(comfort, v));
	return {
		x: clamp1(aim.x - headActualYaw / headYawRange),
		y: clamp1(aim.y - headActualPitch / headPitchRange),
	};
};

export const eyelidModulation = (eyeOpen: number, factor: number, blinkWeight: number): number =>
	eyeOpen * (1 - blinkWeight * (1 - factor));

export const speechMouthOpen = (mouthBase: number, level: number): number =>
	mouthBase + (1 - mouthBase) * level;

// ---------- 编排容器 ----------

export interface PipelineOptions {
	spring?: Partial<SpringParams>;
	smoothTauMs?: number;
	speechReleaseMs?: number;
	/** 舒适视野夹紧（归一化视线单位，1 = 轴全量程）。 */
	comfortGaze?: number;
	namedAims?: Readonly<Record<string, GazeAim>>;
}

/** 单帧管道上下文：director 仲裁后提供的事实。 */
export interface PipelineFrameContext {
	/** 注视目标的视线瞄准；未注视时省略。 */
	gazeAim?: GazeAim;
	/** 本帧被动作 Override 或槽位认领的视线轴（补偿让位）。 */
	gazeClaimed: ReadonlySet<string>;
	/** 语音增益（exclusive → 0）。 */
	speechGain: number;
	blinkFactor: number;
	blinkWeight: number;
}

/** 管道编排：骨骼弹簧 → 面部平滑 → 视线补偿 → 开合通道（§4.2 阶段 B 顺序）。 */
export class SomaticPipelines {
	private readonly springs: SpringFilter;
	private readonly smooth: SmoothFilter;
	private readonly envelope: SpeechEnvelope;
	private readonly namedAims: Readonly<Record<string, GazeAim>>;
	private readonly comfortGaze: number;
	private readonly boneAxes: string[] = [];
	private readonly faceAxes: string[] = [];
	private readonly gazeAxes: string[] = [];
	private readonly eyelidAxes: string[] = [];
	private readonly halfRanges: Readonly<Record<string, number>>;

	constructor(
		controls: Readonly<Record<string, { min: number; max: number }>>,
		private readonly neutral: Readonly<Record<string, number>>,
		options: PipelineOptions = {},
	) {
		this.smooth = new SmoothFilter(options.smoothTauMs ?? DEFAULT_SMOOTH_TAU_MS);
		this.springs = new SpringFilter(options.spring);
		this.envelope = new SpeechEnvelope(options.speechReleaseMs ?? DEFAULT_SPEECH_RELEASE_MS);
		this.namedAims = options.namedAims ?? DEFAULT_NAMED_AIMS;
		this.comfortGaze = options.comfortGaze ?? 1;
		const halfRanges: Record<string, number> = {};
		for (const [axis, control] of Object.entries(controls)) {
			halfRanges[axis] = (control.max - control.min) / 2;
		}
		this.halfRanges = halfRanges;
		for (const axis of Object.keys(controls)) {
			if (boneAxis(axis)) {
				this.boneAxes.push(axis);
				this.springs.ensure(axis, neutral[axis]!);
			} else if (faceAxis(axis)) {
				this.faceAxes.push(axis);
				this.smooth.ensure(axis, neutral[axis]!);
			} else if (gazeAxis(axis)) {
				this.gazeAxes.push(axis);
			} else if (/^eyes\..*\.open$/.test(axis)) {
				this.eyelidAxes.push(axis);
			}
		}
	}

	/** 剧烈动作（resetVelocity）切入时重置骨骼弹簧速度。 */
	resetVelocity(axes: Iterable<string>): void {
		this.springs.resetVelocity([...axes].filter(boneAxis));
	}

	setSpeechLevel(level: number): void {
		this.envelope.setLevel(level);
	}

	/** 命名注视目标 → 瞄准；未知名称返回 undefined（诚实不猜）。 */
	namedAim(name: string): GazeAim | undefined {
		return this.namedAims[name];
	}

	process(frame: Record<string, number>, dtMs: number, ctx: PipelineFrameContext): void {
		// 1) 骨骼弹簧：目标是仲裁+自律叠加后的合成帧值。
		const boneTargets: Record<string, number> = {};
		for (const axis of this.boneAxes) boneTargets[axis] = frame[axis] ?? this.neutral[axis]!;
		this.springs.step(boneTargets, dtMs);
		for (const axis of this.boneAxes) frame[axis] = this.springs.get(axis)!;

		// 2) 面部平滑。
		const faceTargets: Record<string, number> = {};
		for (const axis of this.faceAxes) faceTargets[axis] = frame[axis] ?? this.neutral[axis]!;
		this.smooth.step(faceTargets, dtMs);
		for (const axis of this.faceAxes) frame[axis] = this.smooth.get(axis)!;

		// 3) 视线补偿：在头部实际姿态（弹簧输出）确定后结算；被认领的视线轴让位。
		const aim = ctx.gazeAim;
		if (aim) {
			const yawRange = this.halfRanges["head.yaw"] || 1;
			const pitchRange = this.halfRanges["head.pitch"] || 1;
			const compensated = gazeCompensation(
				aim,
				frame["head.yaw"] ?? 0,
				frame["head.pitch"] ?? 0,
				yawRange,
				pitchRange,
				this.comfortGaze,
			);
			for (const axis of this.gazeAxes) {
				if (ctx.gazeClaimed.has(axis)) continue;
				if (axis === "gaze.x") frame[axis] = compensated.x;
				if (axis === "gaze.y") frame[axis] = compensated.y;
			}
		}

		// 4) 眼睑乘法调制。
		if (ctx.blinkWeight > 0 && ctx.blinkFactor < 1) {
			for (const axis of this.eyelidAxes) {
				if (frame[axis] !== undefined) frame[axis] = eyelidModulation(frame[axis]!, ctx.blinkFactor, ctx.blinkWeight);
			}
		}

		// 5) 口型包络跟随（exclusive 经 speechGain 压制）。
		if (frame["mouth.open"] !== undefined) {
			const level = this.envelope.step(dtMs) * ctx.speechGain;
			frame["mouth.open"] = speechMouthOpen(frame["mouth.open"]!, level);
		}
	}
}
