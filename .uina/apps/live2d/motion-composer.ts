import { BodyDirector } from "./body-director.js";
import type { ChannelArbiter } from "./channel-arbiter.js";
import { DEFAULT_EXPRESSIVE_INTENSITY, resolveBeatToParams } from "./parameter-mapper.js";
import { PhysiologicalNoise } from "./physiological-noise.js";
import {
	abortableDelay,
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
	private speechPhase = 0;
	private speechActivity = 0;

	constructor(readonly arbiter?: ChannelArbiter) {}

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
		if (this.arbiter?.isChannelLocked("head", CHANNEL_PRIORITY.CUE)) {
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

		const isTorsoLocked = this.arbiter?.isChannelLocked("torso", CHANNEL_PRIORITY.CUE) ?? false;
		const isHeadLocked = this.arbiter?.isChannelLocked("head", CHANNEL_PRIORITY.CUE) ?? false;

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
