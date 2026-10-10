import type { AudioObserver } from "./audio-observer.js";
import type { MotionDirector } from "./motion-director.js";

import type { VTSClient } from "./vts-client.js";
import { compileModelAdapter, type AdapterProgram } from "./model-adapter.js";
import type { ModelProfile } from "./model-profile.js";

export interface VTSCompanionOptions {
	targetFps?: number; // 默认 60
}

/**
 * Live2D 后台伴生服务 (VTSCompanion)
 * 职责：
 * 1. 运行 60Hz 渲染时钟，驱动 MotionDirector 动作合成；
 * 2. 调度 AudioObserver 驱动口型包络平滑衰减与瞬态捕获；
 * 3. 委派模型适配程序执行校准与输入转换；
 * 4. 向 VTube Studio 注入已核验的输入参数；
 * 5. 维护与汇报虚拟形象的真实物理在线状态；
 * 6. 按需时钟治理：VTS 离线时自动休眠定时器，连接恢复后重新激活，杜绝无意义的 CPU 空转。
 */
export class VTSCompanion {
	private adapterProfile?: ModelProfile;
	private adapterProgram?: AdapterProgram;
	lastSaturation: readonly string[] = [];
	getAdapter(): AdapterProgram | undefined {
		const profile = this.vtsClient.getModelProfile();
		if (!profile) {
			this.adapterProfile = undefined;
			this.adapterProgram = undefined;
			return;
		}
		if (profile !== this.adapterProfile) {
			this.adapterProgram = compileModelAdapter(profile);
			this.adapterProfile = profile;
		}
		return this.adapterProgram;
	}
	private tickerTimer: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastTickTime = 0;
	private readonly intervalMs: number;
	/** 连续 tick 失败计数：成功帧清零；节流告警，防止单帧异常刷屏或无声吞掉。 */
	private tickFailures = 0;

	constructor(
		readonly director: MotionDirector,
		readonly vtsClient: VTSClient,
		readonly audioObserver: AudioObserver,
		options?: VTSCompanionOptions,
	) {
		const fps = options?.targetFps ?? 60;
		this.intervalMs = 1000 / fps;

		this.vtsClient.setConnectionChangeListener((connected) => {
			this.director.abortAllMotions();
			this.director.resetBody();
			if (this.isRunning) {
				if (connected) {
					this.ensureTickerRunning();
				} else {
					this.stopTicker();
					this.audioObserver.reset({ immediate: true });
				}
			}
		});
	}

	start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.lastTickTime = performance.now();

		this.vtsClient.connect();

		// VTS 已连接才启动 ticker；否则等待连接成功回调再启动
		if (this.vtsClient.isConnected()) {
			this.ensureTickerRunning();
		}
	}

	private ensureTickerRunning(): void {
		if (this.tickerTimer) return;
		this.lastTickTime = performance.now();
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
		this.director.abortAllMotions();
		this.audioObserver.reset({ immediate: true });

		this.vtsClient.disconnect();
	}

	/**
	 * 单帧驱动（单调时钟，按完整经过时间推进）
	 * tick 体整体受异常防护：单帧抛错只计数告警，不允许炸掉定时器让整个伴生循环静默死亡。
	 */
	tick(): void {
		const now = performance.now();
		// 完整时间推进，避免物理时钟与动作时间线在卡帧后分叉。
		const deltaMs = this.lastTickTime > 0 ? Math.max(0, now - this.lastTickTime) : 0;
		this.lastTickTime = now;

		try {
			this.tickInner(deltaMs);
			this.tickFailures = 0;
		} catch (error) {
			this.tickFailures++;
			// 前 3 次逐帧报告，之后每 60 帧（约 1 秒）报告一次，避免刷屏也不至于无声无息。
			if (this.tickFailures <= 3 || this.tickFailures % 60 === 0) {
				console.warn(
					`[Live2D] tick 连续失败 ${this.tickFailures} 次：`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}

	private tickInner(deltaMs: number): void {
		this.audioObserver.tick(deltaMs);

		const mouthOpen = this.audioObserver.getMouthOpenY();
		const speechEnergy = this.audioObserver.getSpeechEnergy();

		const frame = this.director.compose(deltaMs, { speechEnergy, mouthOpen });

		const program = this.getAdapter();
		if (!program) return;
		this.director.setControlGroups(program.controlGroups);
		const encoded = program.encode(frame);
		this.lastSaturation = encoded.saturation;
		this.vtsClient.injectParameters(encoded.values);
	}
}
