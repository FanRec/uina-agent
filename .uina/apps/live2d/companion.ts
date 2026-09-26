import type { AudioObserver } from "./audio-observer.js";
import type { ChannelArbiter } from "./channel-arbiter.js";
import type { MotionComposer } from "./motion-composer.js";
import { CHANNEL_PRIORITY } from "./types.js";
import {
	type VTSClient,
	type VTSHotkeyInfo,
} from "./vts-client.js";
import {
	CUBISM_TO_VTS_MAP,
	VTSParameterRetargeter,
} from "./vts-retargeter.js";

export { CUBISM_TO_VTS_MAP, VTSParameterRetargeter };

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
	idleOfflineFps?: number; // 离线空闲时的帧率，默认 0 (离线无动作时挂起定时器，连接后激活)
}

/**
 * Live2D 后台伴生服务 (VTSCompanion)
 * 职责：
 * 1. 运行 60Hz 渲染时钟，驱动 MotionComposer 动作合成；
 * 2. 调度 AudioObserver 驱动口型包络平滑衰减与瞬态捕获；
 * 3. 委派 VTSParameterRetargeter 执行语义重定向与表情融合；
 * 4. 向 VTube Studio 注入标准参数；
 * 5. 维护与汇报虚拟形象的真实物理在线状态；
 * 6. 按需时钟治理：当 VTS 离线且无动作时自动休眠，杜绝无意义的 CPU 空转。
 */
export class VTSCompanion {
	readonly stateTracker = new Live2DStateTracker();
	readonly retargeter = new VTSParameterRetargeter();
	private tickerTimer: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastTickTime = 0;
	private readonly intervalMs: number;
	private readonly idleOfflineFps: number;

	constructor(
		readonly composer: MotionComposer,
		readonly arbiter: ChannelArbiter,
		readonly vtsClient: VTSClient,
		readonly audioObserver: AudioObserver,
		options?: VTSCompanionOptions,
	) {
		const fps = options?.targetFps ?? 60;
		this.intervalMs = Math.floor(1000 / fps);
		this.idleOfflineFps = options?.idleOfflineFps ?? 0;

		this.vtsClient.setConnectionChangeListener((connected) => {
			this.stateTracker.setVtsConnected(connected);
			if (this.isRunning) {
				if (connected) {
					this.ensureTickerRunning();
				} else if (this.idleOfflineFps === 0) {
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

		// 如果 VTS 已连接或允许离线空转，则启动 ticker；否则等待连接成功后启动
		if (this.vtsClient.isConnected() || this.idleOfflineFps > 0) {
			this.ensureTickerRunning();
		}
	}

	private ensureTickerRunning(): void {
		if (this.tickerTimer) return;
		const interval = this.vtsClient.isConnected()
			? this.intervalMs
			: (this.idleOfflineFps > 0 ? Math.floor(1000 / this.idleOfflineFps) : this.intervalMs);
		this.tickerTimer = setInterval(() => {
			this.tick();
		}, interval);
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
		const deltaMs = this.lastTickTime > 0 ? Math.min(now - this.lastTickTime, 100) : this.intervalMs;
		this.lastTickTime = now;

		// 1. 驱动音频口型自然平滑衰减
		this.audioObserver.tick(deltaMs);

		// 2. 合成动效
		const frame = this.composer.compose(deltaMs);

		// 3. 提取实时音频口型开度 (当 mouth 通道未被高优先级 Action 锁定时)
		const isMouthLocked = this.arbiter.isChannelLocked("mouth", CHANNEL_PRIORITY.ACTION);
		const mouthOpen = isMouthLocked ? undefined : this.audioObserver.getMouthOpenY();

		// 4. 重定向与融合为 VTS 参数包 (零分配)
		const params = this.retargeter.retarget(frame, mouthOpen);

		// 5. 注入 VTube Studio
		this.vtsClient.injectParameters(params);
	}
}
