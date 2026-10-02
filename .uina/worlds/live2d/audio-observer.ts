import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionDirector } from "./motion-director.js";

export interface AudioObserverOptions {
	// 电平域标定（2026-10-02，临时标定）：运行期诊断帧反推 TTS 桥侧语音 RMS ≈ 0.0009 量级
	//（单帧证据，偏薄），旧标定假设的 0.008~0.04 域与实际差约 10 倍——这正是"说话偶发
	// 才有动作"的根因：能量长期贴地爬不过活动度门限，且包络谷值被旧零值地板（0.0008）
	// 在 30Hz 事件间隙整体切除。全部阈值按 1/10 域重标。
	// ⚠ probeSample 探针（%TEMP%/uina-level-probe.log）验证分布前不得视为定案：
	//   若真实语音域显著高于 0.0036，口型/能量将饱和（恒满幅发条感），需按探针数据回调。
	gain?: number; // 口型增益 (默认 250.0，满幅对应 RMS ≈ 0.004)
	releaseMs?: number; // 释音衰减半衰期 (默认 90ms)
	transientThreshold?: number; // 声学微冲基础触发阈值 (默认 0.0018)
	onsetDeltaThreshold?: number; // 声学微冲起振能量差阈值 (默认 0.0008)
	refractoryPeriodMs?: number; // 声学微冲冷却不应期 (默认 220ms，防止持续长元音剧烈抽搐)
}

/**
 * Live2D 声学包络观察者 (AudioObserver)
 * 职责：
 * 1. 接收 voice 侧下发的电平事件 (rms/peak，约 30Hz)；
 * 2. 实时更新口型 RMS 包络，并在 60Hz tick(deltaMs) 中自然平滑衰减，彻底杜绝“说话后永久张嘴”；
 * 3. 捕捉重音/爆破音起振瞬态 (Onset Detection)，配合不应期防抖，通知 MotionDirector 触发头部声学节拍微冲；
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
	private director?: MotionDirector;

	// 【临时标定探针，电平分布确认后整体删除】写文件不进 TUI；写入 300 帧（约 10 分钟）自停。
	private static readonly PROBE_PATH = join(tmpdir(), "uina-level-probe.log");
	private probeWritesLeft = 300;
	private probeWindow = { events: 0, nonZero: 0, sum: 0, max: 0, at: Date.now() };

	constructor(options?: AudioObserverOptions) {
		this.gain = options?.gain ?? 250.0;
		this.releaseMs = options?.releaseMs ?? 90;
		this.transientThreshold = options?.transientThreshold ?? 0.0018;
		this.onsetDeltaThreshold = options?.onsetDeltaThreshold ?? 0.0008;
		this.refractoryPeriodMs = options?.refractoryPeriodMs ?? 220;
	}

	setDirector(director: MotionDirector): void {
		this.director = director;
	}

	getMouthOpenY(): number {
		return this.mouthOpenY;
	}

	getSpeechEnergy(): number {
		// TTS 桥侧语音域 RMS ≈ 0.0005~0.003，平滑归一化至 0.0~1.0
		return Math.max(0, Math.min(1.0, this.currentEnvelope * 280.0));
	}

	isSpeaking(): boolean {
		return this.currentEnvelope > 0.0003 || this.mouthOpenY > 0.03;
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
		this.director?.resetAcousticImpulse();
		this.director?.resetSpeechActivity();
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
		// 注意：不得把 slowEnvelope 钳到衰减后的包络谷值。持续发音时包络在事件间被
		// release 衰减挖出系统性谷值（rms * ~0.24），钳制会让慢包络长期低于真实电平，
		// 使 deltaSlow 每个不应期都假性过阈——持续元音变成周期性点头抽搐。
		// 静音复位由下方"包络归零时 slowEnvelope 清零"兜底。
		this.mouthOpenY = Math.max(0, Math.min(1.0, this.currentEnvelope * this.gain));

		if (this.mouthOpenY < 0.02) {
			this.mouthOpenY = 0;
		}
		if (this.currentEnvelope < 0.00008) {
			this.currentEnvelope = 0;
			this.slowEnvelope = 0;
		}
	}

	/**
	 * 处理 30~60Hz 的 voice:level 声学电平事件 (RMS / Peak)
	 * 采用【双包络起振瞬态检测（Dual-Envelope Onset Detection）+ 不应期（Refractory Period）】机制：
	 * 融合单帧瞬态差与慢速背景滑动包络差，既敏锐捕获爆破辅音，又精准检测平缓起振元音，
	 * 彻底避免持续发音或长元音期间头部被死死按在低位或频繁打桩抽搐。
	 */
	processLevel(event: { rms: number; peak?: number }): void {
		const rawRms = Math.max(0, event?.rms ?? 0);
		if (rawRms > this.currentEnvelope) {
			this.currentEnvelope = rawRms;
		}

		this.mouthOpenY = Math.max(0, Math.min(1.0, this.currentEnvelope * this.gain));

		// 融合单帧差 (deltaRms) 与自适应慢速背景包络差 (deltaSlow)
		const deltaRms = rawRms - this.previousRms;
		const deltaSlow = rawRms - this.slowEnvelope;
		const effectiveOnset = Math.max(deltaRms, deltaSlow);
		const isOnsetSpike = effectiveOnset >= this.onsetDeltaThreshold || rawRms >= 0.07;

		if (
			rawRms > this.transientThreshold &&
			isOnsetSpike &&
			this.cooldownRemainingMs <= 0 &&
			this.director
		) {
			// 实测语音域（RMS ≈ 0.0005~0.003）：阈值 0.0018 之上的余量以 0.0025 为满幅标尺
			const magnitude = Math.min(1.0, (rawRms - this.transientThreshold) / 0.0025);
			this.director.triggerAcousticImpulse(magnitude);
			this.cooldownRemainingMs = this.refractoryPeriodMs;
		}

		// 慢速包络平滑跟踪 (EMA 滤波，alpha = 0.35，约 100ms 快速收敛至稳态元音电平)
		this.slowEnvelope = this.slowEnvelope * 0.65 + rawRms * 0.35;
		this.previousRms = rawRms;

		this.probeSample(rawRms);
	}

	/**
	 * 【临时标定探针，电平分布确认后整体删除】
	 * 每 2 秒向临时目录追加一行窗口统计：事件到达率、非零占比、RMS 均值/峰值、
	 * 包络与口型。用于验证 1/10 重标定是否命中真实电平域，以及 rebuffer 断流占比。
	 */
	private probeSample(rawRms: number): void {
		if (this.probeWritesLeft <= 0) return;
		const w = this.probeWindow;
		w.events++;
		if (rawRms > 0) {
			w.nonZero++;
			w.sum += rawRms;
			if (rawRms > w.max) w.max = rawRms;
		}
		const now = Date.now();
		if (now - w.at < 2000) return;
		w.at = now;
		this.probeWritesLeft--;
		const avg = w.nonZero > 0 ? w.sum / w.nonZero : 0;
		const line =
			`[probe] rate=${(w.events / 2).toFixed(1)}/s nonZero=${w.nonZero}/${w.events} ` +
			`avg=${avg.toFixed(5)} max=${w.max.toFixed(5)} env=${this.currentEnvelope.toFixed(5)} ` +
			`energy=${this.getSpeechEnergy().toFixed(3)} mouth=${this.mouthOpenY.toFixed(3)}\n`;
		try {
			appendFileSync(AudioObserver.PROBE_PATH, line);
		} catch {
			this.probeWritesLeft = 0;
		}
		w.events = 0;
		w.nonZero = 0;
		w.sum = 0;
		w.max = 0;
	}
}


