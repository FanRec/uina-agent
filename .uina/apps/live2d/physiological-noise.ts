/**
 * Live2D 自发生理底噪生成器 (PhysiologicalNoise)
 * 职责：
 * 1. 正弦胸腹呼吸 (3.6s 周期驱动 ParamBreath)；
 * 2. 头部低频微摆与躯干游移：多谐波复合正弦的倾角与左右微转 (ParamAngleZ / ParamAngleX / ParamBodyAngleX)；
 * 3. 随机泊松眨眼机制与微眼颤 (ParamEyeLOpen, ParamEyeROpen, ParamEyeBallX, ParamEyeBallY)。
 */
export const enum BlinkPhase {
	IDLE = 0,
	CLOSING_1 = 1,
	OPENING_1 = 2,
	DOUBLE_BLINK_PAUSE = 3,
	CLOSING_2 = 4,
	OPENING_2 = 5,
}

export interface PhysiologicalNoiseOptions {
	randomFn?: () => number;
}

export class PhysiologicalNoise {
	private phase = 0;
	private readonly randomFn: () => number;

	// 眨眼状态机 (显式状态枚举：支持单眨与连眨)
	private blinkPhase: BlinkPhase = BlinkPhase.IDLE;
	private timeUntilNextBlinkMs: number;
	private phaseElapsedMs = 0;
	private willDoubleBlink = false;

	private readonly blinkClose1DurationMs = 60;
	private readonly blinkOpen1DurationMs = 100;
	private readonly doubleBlinkPauseMs = 50;
	private readonly blinkClose2DurationMs = 50;
	private readonly blinkOpen2DurationMs = 80;

	private saccadeX = 0;
	private saccadeY = 0;

	constructor(options?: PhysiologicalNoiseOptions) {
		this.randomFn = options?.randomFn ?? Math.random;
		this.timeUntilNextBlinkMs = this.generateBlinkInterval();
	}

	private generateBlinkInterval(): number {
		// 泊松分布近似：2.5s ~ 5.5s 均值 4s
		return 2500 + this.randomFn() * 3000;
	}

	getBlinkPhase(): BlinkPhase {
		return this.blinkPhase;
	}

	/**
	 * 显式触发一次眨眼（单测与特定表情联动使用）
	 */
	triggerBlink(options?: { willDoubleBlink?: boolean }): void {
		this.blinkPhase = BlinkPhase.CLOSING_1;
		this.phaseElapsedMs = 0;
		this.willDoubleBlink = options?.willDoubleBlink ?? false;
	}

	reset(): void {
		this.phase = 0;
		this.blinkPhase = BlinkPhase.IDLE;
		this.phaseElapsedMs = 0;
		this.willDoubleBlink = false;
		this.timeUntilNextBlinkMs = this.generateBlinkInterval();
		this.saccadeX = 0;
		this.saccadeY = 0;
	}

	tick(deltaMs: number): Record<string, number> {
		this.phase += deltaMs * 0.001;

		// 1. 呼吸：3.6s 周期驱动胸腔起伏 (ParamBreath)
		const breath = (Math.sin(this.phase * 1.74) + 1) * 0.5;

		// 2. 呼吸联动胸腹与头部微仰低 (ParamAngleY: ±1.5°)
		const headAngleY = (breath - 0.5) * 3.0;

		// 3. 姿态自然漂移：多谐波复合正弦波，低频慢晃 (杜绝机械摇摆与视觉眩晕)
		const headTiltZ = Math.cos(this.phase * 0.45) * 2.2 + Math.sin(this.phase * 0.18) * 1.2;
		const headGlanceX = Math.sin(this.phase * 0.3) * 1.8;

		// 4. 显式状态机驱动眨眼与微眼颤
		let eyeOpen = 1.0;
		switch (this.blinkPhase) {
			case BlinkPhase.IDLE:
				this.timeUntilNextBlinkMs -= deltaMs;
				if (this.timeUntilNextBlinkMs <= 0) {
					this.blinkPhase = BlinkPhase.CLOSING_1;
					this.phaseElapsedMs = 0;
					this.willDoubleBlink = this.randomFn() < 0.15;
					// 每次眨眼 35% 概率刷新视线微跳动 (micro-saccades, ±0.20 内清晰可见)
					if (this.randomFn() < 0.35) {
						this.saccadeX = (this.randomFn() - 0.5) * 0.4;
						this.saccadeY = (this.randomFn() - 0.5) * 0.25;
					}
				}
				break;

			case BlinkPhase.CLOSING_1:
				this.phaseElapsedMs += deltaMs;
				eyeOpen = Math.max(0, 1.0 - this.phaseElapsedMs / this.blinkClose1DurationMs);
				if (this.phaseElapsedMs >= this.blinkClose1DurationMs) {
					this.blinkPhase = BlinkPhase.OPENING_1;
					this.phaseElapsedMs = 0;
				}
				break;

			case BlinkPhase.OPENING_1:
				this.phaseElapsedMs += deltaMs;
				eyeOpen = Math.min(1.0, this.phaseElapsedMs / this.blinkOpen1DurationMs);
				if (this.phaseElapsedMs >= this.blinkOpen1DurationMs) {
					if (this.willDoubleBlink) {
						this.blinkPhase = BlinkPhase.DOUBLE_BLINK_PAUSE;
						this.phaseElapsedMs = 0;
					} else {
						this.blinkPhase = BlinkPhase.IDLE;
						this.timeUntilNextBlinkMs = this.generateBlinkInterval();
					}
				}
				break;

			case BlinkPhase.DOUBLE_BLINK_PAUSE:
				this.phaseElapsedMs += deltaMs;
				eyeOpen = 1.0;
				if (this.phaseElapsedMs >= this.doubleBlinkPauseMs) {
					this.blinkPhase = BlinkPhase.CLOSING_2;
					this.phaseElapsedMs = 0;
				}
				break;

			case BlinkPhase.CLOSING_2:
				this.phaseElapsedMs += deltaMs;
				eyeOpen = Math.max(0, 1.0 - this.phaseElapsedMs / this.blinkClose2DurationMs);
				if (this.phaseElapsedMs >= this.blinkClose2DurationMs) {
					this.blinkPhase = BlinkPhase.OPENING_2;
					this.phaseElapsedMs = 0;
				}
				break;

			case BlinkPhase.OPENING_2:
				this.phaseElapsedMs += deltaMs;
				eyeOpen = Math.min(1.0, this.phaseElapsedMs / this.blinkOpen2DurationMs);
				if (this.phaseElapsedMs >= this.blinkOpen2DurationMs) {
					this.blinkPhase = BlinkPhase.IDLE;
					this.willDoubleBlink = false;
					this.timeUntilNextBlinkMs = this.generateBlinkInterval();
				}
				break;
		}

		// 5. 待机常驻萌态微笑底色 (0.20 ~ 0.30, 消除冰冷呆板感)
		const restingSmile = 0.25 + Math.sin(this.phase * 0.8) * 0.05;

		return {
			ParamBreath: Math.max(0, Math.min(1, breath)),
			ParamAngleX: headGlanceX,
			ParamAngleY: headAngleY,
			ParamAngleZ: headTiltZ,
			// 躯干低频微晃 (与头部轻微反相/错相，表现活体自然重心游移)
			ParamBodyAngleX: Math.sin(this.phase * 0.87) * 1.2,
			ParamEyeLOpen: Math.max(0, Math.min(1, eyeOpen)),
			ParamEyeROpen: Math.max(0, Math.min(1, eyeOpen)),
			ParamEyeBallX: this.saccadeX,
			ParamEyeBallY: this.saccadeY,
			ParamMouthForm: restingSmile,
			ParamEyeLSmile: 0.15,
			ParamEyeRSmile: 0.15,
		};
	}
}
