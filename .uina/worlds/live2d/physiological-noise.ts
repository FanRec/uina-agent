import { AMBIENT } from "./motion-library.js";
import { sampleLoop, sampleMotion } from "./motion.js";
/**
 * Live2D 自发生理底噪生成器 (PhysiologicalNoise)
 * 职责：
 * 从动作库采样呼吸、头部微摆、躯干游移和视线微动。
 * 随机眨眼的准入与开合状态独立推进，输出均为逻辑轴。
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

	constructor(options?: PhysiologicalNoiseOptions) {
		this.randomFn = options?.randomFn ?? Math.random;
		this.timeUntilNextBlinkMs = this.generateBlinkInterval();
	}

	private generateBlinkInterval(): number {
		// 均匀分布：2.5s ~ 5.5s，均值 4s
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

	tick(deltaMs: number, options?: { allowBlink?: boolean }): Record<string, number> {
		this.phase += deltaMs * 0.001;

		// Carry elapsed time across phases. A slow frame must not stretch a blink.
		let remaining = Math.max(0, deltaMs);
		while (remaining > 0) {
			if (this.blinkPhase === BlinkPhase.IDLE) {
				const used = Math.min(remaining, this.timeUntilNextBlinkMs);
				this.timeUntilNextBlinkMs -= used;
				remaining -= used;
				if (this.timeUntilNextBlinkMs > 0) break;
				if (options?.allowBlink === false) {
					this.timeUntilNextBlinkMs = this.generateBlinkInterval();
					continue;
				}
				this.triggerBlink({ willDoubleBlink: this.randomFn() < 0.1 });
			} else {
				const blink = this.willDoubleBlink ? AMBIENT.doubleBlink : AMBIENT.blink;
				const keys = blink.tracks[0]!.keys;
				const duration = keys[this.blinkPhase]!.atMs - keys[this.blinkPhase - 1]!.atMs;
				const used = Math.min(remaining, duration - this.phaseElapsedMs);
				this.phaseElapsedMs += used;
				remaining -= used;
				if (this.phaseElapsedMs < duration) break;
				if (this.blinkPhase === keys.length - 1) {
					this.blinkPhase = BlinkPhase.IDLE;
					this.timeUntilNextBlinkMs = this.generateBlinkInterval();
				} else this.blinkPhase++;
				this.phaseElapsedMs = 0;
			}
		}
		const blink = this.willDoubleBlink ? AMBIENT.doubleBlink : AMBIENT.blink;
		const atMs =
			this.blinkPhase === BlinkPhase.IDLE
				? blink.durationMs
				: blink.tracks[0]!.keys[this.blinkPhase - 1]!.atMs + this.phaseElapsedMs;

		return {
			...sampleLoop(AMBIENT.noise, this.phase * 1000),
			...sampleMotion(blink, atMs),
		};
	}
}
