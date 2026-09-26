import type { VoiceLevelEvent } from "../../extensions/voice/events.js";
import type { MotionComposer } from "./motion-composer.js";

export interface AudioObserverOptions {
	gain?: number; // 增益系数 (默认 3.0)
	releaseMs?: number; // 释音衰减半衰期 (默认 80ms)
	transientThreshold?: number; // 声学微冲基础触发阈值 (默认 0.30)
	onsetDeltaThreshold?: number; // 声学微冲起振能量差阈值 (默认 0.15)
	refractoryPeriodMs?: number; // 声学微冲冷却不应期 (默认 220ms，防止持续长元音剧烈抽搐)
}

/**
 * Live2D 声学包络观察者 (AudioObserver)
 * 职责：
 * 1. 接收 voice 侧下发的电平事件 (rms/peak，约 30Hz)；
 * 2. 实时更新口型 RMS 包络，并在 60Hz tick(deltaMs) 中自然平滑衰减，彻底杜绝“说话后永久张嘴”；
 * 3. 捕捉重音/爆破音起振瞬态 (Onset Detection)，配合不应期防抖，通知 MotionComposer 触发头部声学节拍微冲；
 * 4. 响应 reset/stop，立即将口型复位回 0，并清空冷却与历史电平。
 *
 * 输入契约选择的是**电平**而不是 PCM：口型只需要包络，而 PCM 逐帧跨进程传输会引入
 * 二进制通道与 60Hz 分配压力，收益不成比例。原 PCM 入口已删除。
 */
export class AudioObserver {
	private readonly gain: number;
	private readonly releaseMs: number;
	private readonly transientThreshold: number;
	private readonly onsetDeltaThreshold: number;
	private readonly refractoryPeriodMs: number;

	private currentEnvelope = 0;
	private slowEnvelope = 0;
	private previousRms = 0;
	private cooldownRemainingMs = 0;
	private mouthOpenY = 0;
	private composer?: MotionComposer;

	constructor(options?: AudioObserverOptions) {
		this.gain = options?.gain ?? 3.0;
		this.releaseMs = options?.releaseMs ?? 80;
		this.transientThreshold = options?.transientThreshold ?? 0.30;
		this.onsetDeltaThreshold = options?.onsetDeltaThreshold ?? 0.15;
		this.refractoryPeriodMs = options?.refractoryPeriodMs ?? 220;
	}

	setComposer(composer: MotionComposer): void {
		this.composer = composer;
	}

	getMouthOpenY(): number {
		return this.mouthOpenY;
	}

	/**
	 * 立即重置归零口型与声学冲量状态 (在音频结束或打断时调用)
	 */
	reset(): void {
		this.currentEnvelope = 0;
		this.slowEnvelope = 0;
		this.mouthOpenY = 0;
		this.previousRms = 0;
		this.cooldownRemainingMs = 0;
		this.composer?.resetAcousticImpulse();
	}

	/**
	 * 60Hz 渲染时钟驱动口型自然平滑衰减与微冲冷却计时
	 */
	tick(deltaMs: number): void {
		if (this.cooldownRemainingMs > 0) {
			this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - deltaMs);
		}

		if (this.currentEnvelope <= 0) {
			this.slowEnvelope = 0;
			return;
		}

		// 依据 releaseMs 进行指数自然衰减
		const decay = Math.exp(-deltaMs / this.releaseMs);
		this.currentEnvelope *= decay;
		if (this.slowEnvelope > this.currentEnvelope) {
			this.slowEnvelope = this.currentEnvelope;
		}
		this.mouthOpenY = Math.max(0, Math.min(1.0, this.currentEnvelope * this.gain));

		if (this.mouthOpenY < 0.015) {
			this.currentEnvelope = 0;
			this.slowEnvelope = 0;
			this.mouthOpenY = 0;
		}
	}

	/**
	 * 处理 30~60Hz 的 voice:level 声学电平事件 (RMS / Peak)
	 * 采用【双包络起振瞬态检测（Dual-Envelope Onset Detection）+ 不应期（Refractory Period）】机制：
	 * 融合单帧瞬态差与慢速背景滑动包络差，既敏锐捕获爆破辅音，又精准检测平缓起振元音，
	 * 彻底避免持续发音或长元音期间头部被死死按在低位或频繁打桩抽搐。
	 */
	processLevel(event: VoiceLevelEvent | { rms: number; peak?: number }): void {
		const rawRms = Math.max(0, event?.rms ?? 0);
		if (rawRms > this.currentEnvelope) {
			this.currentEnvelope = rawRms;
		}

		this.mouthOpenY = Math.max(0, Math.min(1.0, this.currentEnvelope * this.gain));

		// 融合单帧差 (deltaRms) 与自适应慢速背景包络差 (deltaSlow)
		const deltaRms = rawRms - this.previousRms;
		const deltaSlow = rawRms - this.slowEnvelope;
		const effectiveOnset = Math.max(deltaRms, deltaSlow);
		const isOnsetSpike = effectiveOnset >= this.onsetDeltaThreshold || rawRms >= 0.70;

		if (
			rawRms > this.transientThreshold &&
			isOnsetSpike &&
			this.cooldownRemainingMs <= 0 &&
			this.composer
		) {
			const magnitude = Math.min(1.0, (rawRms - this.transientThreshold) / 0.35);
			this.composer.triggerAcousticImpulse(magnitude);
			this.cooldownRemainingMs = this.refractoryPeriodMs;
		}

		// 慢速包络平滑跟踪 (EMA 滤波，alpha = 0.35，约 100ms 快速收敛至稳态元音电平)
		this.slowEnvelope = this.slowEnvelope * 0.65 + rawRms * 0.35;
		this.previousRms = rawRms;
	}
}
