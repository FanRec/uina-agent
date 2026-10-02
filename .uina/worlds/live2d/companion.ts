import type { AudioObserver } from "./audio-observer.js";
import type { MotionDirector } from "./motion-director.js";

import { CHANNEL_PRIORITY } from "./types.js";
import { type VTSClient, type VTSHotkeyInfo } from "./vts-client.js";
import { VTSParameterRetargeter } from "./vts-retargeter.js";

export class Live2DStateTracker {
	private online = false;
	private fault?: string;

	getState(): { online: boolean; fault?: string } {
		return {
			online: this.online,
			fault: this.fault,
		};
	}

	setVtsConnected(connected: boolean): void {
		this.online = connected;
		this.fault = connected ? undefined : "vts_disconnected";
	}
}

export interface VTSCompanionOptions {
	targetFps?: number; // 默认 60
}

/**
 * Live2D 后台伴生服务 (VTSCompanion)
 * 职责：
 * 1. 运行 60Hz 渲染时钟，驱动 MotionDirector 动作合成；
 * 2. 调度 AudioObserver 驱动口型包络平滑衰减与瞬态捕获；
 * 3. 委派 VTSParameterRetargeter 执行语义重定向与表情融合；
 * 4. 向 VTube Studio 注入标准参数；
 * 5. 维护与汇报虚拟形象的真实物理在线状态；
 * 6. 按需时钟治理：VTS 离线时自动休眠定时器，连接恢复后重新激活，杜绝无意义的 CPU 空转。
 */
export class VTSCompanion {
	readonly stateTracker = new Live2DStateTracker();
	readonly retargeter = new VTSParameterRetargeter();
	private tickerTimer: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastTickTime = 0;
	private readonly intervalMs: number;

	constructor(
		readonly director: MotionDirector,
		readonly vtsClient: VTSClient,
		readonly audioObserver: AudioObserver,
		options?: VTSCompanionOptions,
	) {
		const fps = options?.targetFps ?? 60;
		this.intervalMs = Math.floor(1000 / fps);

		this.vtsClient.setConnectionChangeListener((connected) => {
			this.stateTracker.setVtsConnected(connected);
			if (this.isRunning) {
				if (connected) {
					this.ensureTickerRunning();
				} else {
					this.stopTicker();
				}
			}
		});
	}

	start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.lastTickTime = Date.now();

		this.vtsClient.connect();

		// VTS 已连接才启动 ticker；否则等待连接成功回调再启动
		if (this.vtsClient.isConnected()) {
			this.ensureTickerRunning();
		}
	}

	private ensureTickerRunning(): void {
		if (this.tickerTimer) return;
		this.tickerTimer = setInterval(() => {
			this.tick();
		}, this.intervalMs);
	}

	private stopTicker(): void {
		if (this.tickerTimer) {
			clearInterval(this.tickerTimer);
			this.tickerTimer = null;
		}
	}

	stop(): void {
		if (!this.isRunning) return;
		this.isRunning = false;
		this.stopTicker();

		this.vtsClient.disconnect();
		this.stateTracker.setVtsConnected(false);
	}

	getAvailableHotkeys(): readonly VTSHotkeyInfo[] {
		return this.vtsClient.getAvailableHotkeys();
	}

	/**
	 * 单帧驱动 (60Hz 零分配热路径)
	 */
	tick(): void {
		const now = Date.now();
		// start() 已保证 lastTickTime 有值；即使冷调用 tick 也被 100ms 上限兜底
		const deltaMs = Math.min(now - this.lastTickTime, 100);
		this.lastTickTime = now;

		// 1. 驱动音频口型自然平滑衰减
		this.audioObserver.tick(deltaMs);

		// 2. 提取实时音频口型开度与语流能量
		// 口型策略（显式化两个不同决策，而非统一阈值）：
		// - 口型开度归音频驱动：只有 >= ACTION 级的动作才抑制（如 flip 特技期间的统一编排）；
		//   CUE 级表情经 retargeter 的 max 融合叠加，不会顶掉说话口型。
		// - 躯干/头部律动是装饰性的：在 compose 内按 CUE 级让位，此处不重复门控。
		const isMouthLocked = this.director.isChannelLocked("mouth", CHANNEL_PRIORITY.ACTION);
		const mouthOpen = isMouthLocked ? undefined : this.audioObserver.getMouthOpenY();
		// 语流能量不随嘴锁熄灭：嘴锁只决定口型注入归属（retargeter 已处理优先级）。
		// 此前用嘴锁归零语流能量，说话期间任何占用嘴的动作都会让全身律动突然消失——
		// 那是"律动时有时无"的运行不正确来源。
		const speechEnergy = this.audioObserver.getSpeechEnergy();

		// 3. 合成动效 (传入当前语流能量，自动驱动躯干连续循环律动)
		const frame = this.director.compose(deltaMs, { speechEnergy });

		// 4. 重定向与融合为 VTS 参数包 (零分配)
		const params = this.retargeter.retarget(frame, mouthOpen);

	// 5. 注入 VTube Studio
	this.vtsClient.injectParameters(params);
}
}


