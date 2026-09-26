import { BodyDirector } from "./body-director.js";
import type { ChannelArbiter } from "./channel-arbiter.js";
import { DEFAULT_EXPRESSIVE_INTENSITY, resolveBeatToParams } from "./parameter-mapper.js";
import { PhysiologicalNoise } from "./physiological-noise.js";
import {
	CHANNEL_PRIORITY,
	clampLive2DParam,
	type ExpressParams,
	type Live2DChannel,
	PARAM_CHANNEL_MAP,
} from "./types.js";

/**
 * Live2D 动作合成器 (Layered Motion Composer)
 * 职责：
 * 1. 自发生理底噪 (PhysiologicalNoise) - 3.6s 呼吸 + 泊松微眨眼；
 * 2. 动力学滤波与姿态导向 (BodyDirector) - 欠阻尼弹簧 + 软限速 + 内部脊柱跟随；
 * 3. 通道仲裁接入：动作锁定通道时抑制该通道底噪；
 * 4. 最终合成参数输出。
 */
export class MotionComposer {
	readonly noise = new PhysiologicalNoise();
	readonly bodyDirector = new BodyDirector();

	private currentBeatsController: AbortController | null = null;
	private currentAllowedChannels?: readonly Live2DChannel[];

	constructor(readonly arbiter?: ChannelArbiter) {}

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
				await this.delay(holdMs, internalController.signal);
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
		this.bodyDirector.resetVelocity("ParamAngleY");
		this.bodyDirector.dampenToNeutral();
	}

	compose(deltaMs: number): Record<string, number> {
		const isTorsoLocked = this.arbiter
			? (this.arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.ACTION) ||
			   this.arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.CUE))
			: false;

		const noise = this.noise.tick(deltaMs);
		const merged = this.bodyDirector.tick(deltaMs, { isTorsoLocked });

		for (const k in noise) {
			const ch = PARAM_CHANNEL_MAP[k];
			const isLocked = ch ? (this.arbiter?.isChannelLocked(ch, CHANNEL_PRIORITY.ACTION) ?? false) : false;
			const nVal = isLocked ? 0 : noise[k]!;

			if (k === "ParamEyeLOpen" || k === "ParamEyeROpen") {
				const blinkFactor = isLocked ? 1.0 : nVal;
				merged[k] = clampLive2DParam(k, (merged[k] ?? 1.0) * blinkFactor);
			} else {
				merged[k] = clampLive2DParam(k, (merged[k] ?? 0) + nVal);
			}
		}

		return merged;
	}

	private delay(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal?.aborted) return resolve();
			const timer = setTimeout(() => {
				if (signal) signal.removeEventListener("abort", abortHandler);
				resolve();
			}, ms);
			const abortHandler = () => {
				clearTimeout(timer);
				resolve();
			};
			if (signal) signal.addEventListener("abort", abortHandler, { once: true });
		});
	}
}
