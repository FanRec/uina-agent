/**
 * 自律发生器（P2-2）：呼吸 / 冷却锁眨眼 / 待机微晃 / 视线漂移。
 *
 * 依据：引擎规范 v4.6 §4.2 第 2 条 + 修订 A9（注入时钟与随机源）。
 *
 * - 底座优先级（autonomic，10）持续运作；输出轴增量（additive ΔX）与眨眼因子；
 * - 唯一主来源约束：external.breath === "vts" 时整体呼吸贡献源静默，杜绝双重叠加；
 * - external.blink !== "uina" 时眨眼静默（factor 恒 1），眨眼调制由眼睑管道（P3-1）执行；
 * - 避让规则：主动动作期间微晃衰减、注视锚定锁定时视线漂移抑制——由调用方每帧
 *   报告抑制系数，发生器内部平滑趋近，不产生突变；
 * - 全部推进为纯 step(dtMs)，随机源构造注入（A9），测试无真实等待。
 */

export interface AutonomicExternal {
	blink: "vts" | "uina" | "none";
	breath: "vts" | "none";
}

export interface AutonomicOptions {
	/** 随机源注入（A9）；缺省 Math.random。 */
	rng?: () => number;
	blink?: { cooldownMs?: number; meanDelayMs?: number; closeMs?: number; openMs?: number };
	breath?: { periodMs?: number; amplitude?: number };
	/** 待机微晃：轴 → 度幅值（头部角度轴用度，规范化轴用其自身单位）。 */
	sway?: Record<string, number>;
	/** 视线漂移：轴 → 幅值。 */
	drift?: Record<string, number>;
}

export interface AutonomicFrame {
	/** 本帧轴增量（additive ΔX，相对中性），仅含启用的贡献源。 */
	deltas: Record<string, number>;
	/** 眨眼因子 1=全开 0=全闭；眼睑管道（P3-1）据它做乘法调制。 */
	blinkFactor: number;
}

const DEFAULT_BLINK = { cooldownMs: 2000, meanDelayMs: 1500, closeMs: 60, openMs: 120 };
const DEFAULT_BREATH = { periodMs: 3200, amplitude: 0.08 };
const DEFAULT_SWAY: Record<string, number> = { "head.yaw": 1.2, "head.pitch": 0.8 };
const DEFAULT_DRIFT: Record<string, number> = { "gaze.x": 0.06, "gaze.y": 0.04 };
/** 抑制系数趋近平滑时间常数（ms）。 */
const SUPPRESSION_TAU_MS = 300;

type BlinkPhase = "idle" | "closing" | "opening";

export class AutonomicGenerator {
	private external: AutonomicExternal = { blink: "uina", breath: "none" };
	private readonly rng: () => number;
	private readonly blink: { cooldownMs: number; meanDelayMs: number; closeMs: number; openMs: number };
	private readonly breath: { periodMs: number; amplitude: number };
	private readonly sway: Readonly<Record<string, number>>;
	private readonly drift: Readonly<Record<string, number>>;
	private ageMs = 0;
	private swayLevel = 1;
	private driftLevel = 1;
	private swayTarget = 1;
	private driftTarget = 1;
	private blinkPhase: BlinkPhase = "idle";
	private blinkAgeMs = 0;
	private nextBlinkInMs: number;
	private swayEnabled = true;
	private blinkSuppressed = false;

	constructor(options: AutonomicOptions = {}) {
		this.rng = options.rng ?? Math.random;
		this.blink = { ...DEFAULT_BLINK, ...options.blink };
		this.breath = { ...DEFAULT_BREATH, ...options.breath };
		this.sway = options.sway ?? DEFAULT_SWAY;
		this.drift = options.drift ?? DEFAULT_DRIFT;
		this.nextBlinkInMs = this.sampleBlinkDelay();
	}

	/** 唯一主来源约束（§4.2）：切换 external 时重置眨眼状态机，杜绝跨来源状态残留。 */
	setExternal(external: AutonomicExternal): void {
		if (external.blink !== this.external.blink) {
			this.blinkPhase = "idle";
			this.blinkAgeMs = 0;
			this.nextBlinkInMs = this.sampleBlinkDelay();
		}
		this.external = { ...external };
	}

	/** 避让规则：传入 0..1 目标抑制系数（0=完全抑制），内部平滑趋近。 */
	setSuppression(targets: { sway?: number; drift?: number }): void {
		if (targets.sway !== undefined) this.swayTarget = Math.max(0, Math.min(1, targets.sway));
		if (targets.drift !== undefined) this.driftTarget = Math.max(0, Math.min(1, targets.drift));
	}

	setSwayEnabled(enabled: boolean): void {
		this.swayEnabled = enabled;
	}

	step(dtMs: number, suppressBlink = false): AutonomicFrame {
		this.ageMs += dtMs;
		const deltas: Record<string, number> = {};

		// 呼吸：3.2s 正弦；"vts" 时整体呼吸贡献源静默（含躯干微动）。
		if (this.external.breath !== "vts") {
			const phase = (2 * Math.PI * this.ageMs) / this.breath.periodMs;
			deltas["torso.breath"] = this.breath.amplitude * Math.sin(phase);
		}

		// 抑制系数平滑趋近（指数趋近，时间常数 SUPPRESSION_TAU_MS）。
		const approach = (level: number, target: number): number =>
			target + (level - target) * Math.exp(-dtMs / SUPPRESSION_TAU_MS);
		this.swayLevel = approach(this.swayLevel, this.swayTarget);
		this.driftLevel = approach(this.driftLevel, this.driftTarget);

		// 待机微晃：双正弦拟噪声（周期互质避免重合），主动动作期间衰减。
		if (this.swayEnabled && this.swayLevel > 0.001) {
			const yawPhase = (2 * Math.PI * this.ageMs) / 7300;
			const pitchPhase = (2 * Math.PI * this.ageMs) / 11300 + 1.3;
			for (const [axis, amplitude] of Object.entries(this.sway)) {
				let phase = yawPhase * 0.7 + amplitude;
				if (axis === "head.yaw") phase = yawPhase;
				else if (axis === "head.pitch") phase = pitchPhase;
				const value = amplitude * Math.sin(phase);
				deltas[axis] = (deltas[axis] ?? 0) + value * this.swayLevel;
			}
		}

		// 视线漂移：注视锚定锁定时抑制。
		if (this.driftLevel > 0.001) {
			const xPhase = (2 * Math.PI * this.ageMs) / 9700;
			const yPhase = (2 * Math.PI * this.ageMs) / 14900 + 0.6;
			for (const [axis, amplitude] of Object.entries(this.drift)) {
				const value = axis === "gaze.x" ? amplitude * Math.sin(xPhase) : amplitude * Math.sin(yPhase);
				deltas[axis] = (deltas[axis] ?? 0) + value * this.driftLevel;
			}
		}

		if (suppressBlink && !this.blinkSuppressed) {
			this.blinkPhase = "idle";
			this.blinkAgeMs = 0;
			this.nextBlinkInMs = this.sampleBlinkDelay();
		}
		this.blinkSuppressed = suppressBlink;
		return { deltas, blinkFactor: suppressBlink ? 1 : this.stepBlink(dtMs) };
	}

	/** 冷却锁随机眨眼：基础冷却 + 均值 meanDelay 的指数随机延迟；闭眼 closeMs / 睁眼 openMs。 */
	private stepBlink(dtMs: number): number {
		if (this.external.blink !== "uina") return 1;
		this.blinkAgeMs += dtMs;
		if (this.blinkPhase === "idle") {
			if (this.blinkAgeMs >= this.nextBlinkInMs) {
				this.blinkPhase = "closing";
				this.blinkAgeMs = 0;
			}
			return 1;
		}
		if (this.blinkPhase === "closing") {
			if (this.blinkAgeMs >= this.blink.closeMs) {
				this.blinkPhase = "opening";
				this.blinkAgeMs = 0;
				return 0;
			}
			return 1 - this.blinkAgeMs / this.blink.closeMs;
		}
		// opening
		if (this.blinkAgeMs >= this.blink.openMs) {
			this.blinkPhase = "idle";
			this.blinkAgeMs = 0;
			this.nextBlinkInMs = this.sampleBlinkDelay();
			return 1;
		}
		return this.blinkAgeMs / this.blink.openMs;
	}

	/** 基础冷却 T_cooldown + 服从均值 meanDelay 的指数随机延迟。 */
	private sampleBlinkDelay(): number {
		const u = Math.max(1e-9, Math.min(1 - 1e-9, this.rng()));
		return this.blink.cooldownMs - this.blink.meanDelayMs * Math.log(1 - u);
	}
}
