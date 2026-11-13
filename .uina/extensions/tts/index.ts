import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type {
	TurnStartEvent,
	TurnEndEvent,
} from "../../../src/runtime/events.js";
import { WORLD_EXPOSED_SHARED_NAME, type WorldExposedRegistry } from "../../../src/extensions/world-framework/types.js";
import { VOICE_LEVEL_SINK_EXPOSED_PREFIX, type VoiceLevelSink } from "../../../src/extensions/world-framework/seams.js";
import { loadConfig } from "./config.js";
import { TtsBridgeClient, readPlaybackLevel, type PlaybackEvent } from "./client.js";
import { ensureCompanion } from "./companion.js";
import { ensureSubtitleService } from "./subtitle-companion.js";
import { TtsVoiceOutputDriver } from "./driver-impl.js";
import type { InterruptResult } from "./delivery-facts.js";

import { createTtsTool } from "./tool.js";
import { createTtsGenerateTool } from "./generate.js";

export * from "./delivery-facts.js";
export * from "./client.js";
export * from "./config.js";

/** 进度探测周期。只在"还有音频在路上"时运行，静默即停。 */
const PROGRESS_POLL_INTERVAL_MS = 1000;

/** 结构校验：共享表里的值必须真的具备电平接收端契约（消费方职责留在消费方）。 */
function isVoiceLevelSink(value: unknown): value is VoiceLevelSink {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.processLevel === "function" && typeof candidate.reset === "function";
}

/**
 * TTS 交付层（输出表达体系）：Driver/Bridge 只负责合成与当前物理播放、
 * Session/Epoch、停止/恢复、字幕电平与进程所有权。哪些普通模型输出应读出、
 * Cue 文本语法、分句与 Utterance 业务全部归 Speech 扩展；本扩展经
 * `tts_delivery:*` 服务向 Speech 提供交付端口，并把播放事实回推给它的
 * `speech_delivery:on_playback`。
 */
export default async function activate(pi: ExtensionAPI): Promise<void | (() => Promise<void>)> {
	const config = loadConfig();
	const client = new TtsBridgeClient(config.serviceUrl, config.requestTimeoutMs);
	const driver = new TtsVoiceOutputDriver(client, config.generationTimeoutMs);
	let companionHandle: Awaited<ReturnType<typeof ensureCompanion>> | undefined;
	driver.setRestartBridge(async (signal, timeoutMs) => {
		if (!companionHandle?.didSpawn) {
			return {
				status: "not_started",
				ownership: companionHandle ? "external" : "unknown",
				reason: companionHandle
					? "服务由外部程序运行，请在那个程序中重启"
					: "未确认服务进程归属，不能自行重启，请由启动它的程序处理",
			};
		}
		try {
			await companionHandle.stop();
			companionHandle = await ensureCompanion(
				{ ...config, startupTimeoutMs: Math.min(config.startupTimeoutMs, timeoutMs ?? config.startupTimeoutMs) },
				signal ? AbortSignal.any([signal, pi.signal]) : pi.signal,
			);
			driver.setBridgeOwnership(companionHandle.didSpawn ? "owned" : "external");
			driver.setOnline(true);
			return companionHandle.didSpawn
				? { status: "succeeded", ownership: "owned", ready: true }
				: {
						status: "unknown",
						ownership: "external",
						oldProcessStopped: true,
						reason: "旧服务已退出，现服务由外部程序提供，未自行重启",
					};
		} catch (error) {
			driver.setBridgeOwnership("unknown");
			driver.setOnline(false);
			return { status: "unknown", ownership: "owned", reason: error instanceof Error ? error.message : String(error) };
		}
	});
	pi.registerTool(createTtsTool(driver));
	pi.registerTool(
		createTtsGenerateTool({ cwd: pi.cwd, client, signal: pi.signal, timeoutMs: config.generationTimeoutMs }),
	);

	// 1. 伴生服务管理（所有权自律：谁拉起谁销毁）
	// 句柄由本激活函数持有：若拉起了进程，在返回的 teardown 中 await stop()，
	// 清理失败交给 runner 报告；复用外部服务时 stop 是 no-op。
	let subtitleHandle: Awaited<ReturnType<typeof ensureSubtitleService>> | undefined;
	const subtitleStartup = (async () => {
		try {
			subtitleHandle = await ensureSubtitleService(config, pi.signal);
		} catch (err) {
			pi.reportError(
				`[TTS] OBS 字幕伴生服务未连接，已降级（不影响发声）: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})();
	// 伴生服务后台预热：ensureCompanion 可能 spawn Python 桥并轮询健康检查
	// （startupTimeoutMs 配置 30s），同步 await 会拖住 host.start、把 TUI 首个
	// 上下文快照推迟十几秒。改为后台启动；提交前等待就绪，teardown 等待收尾。
	const companionStartup = (async () => {
		try {
			companionHandle = await ensureCompanion(config, pi.signal);
			driver.setBridgeOwnership(companionHandle.didSpawn ? "owned" : "external");
			driver.setOnline(true);
		} catch (err) {
			driver.setBridgeOwnership("unknown");
			// 降级是连接事实，不是用户偏好：只标记离线，不改 muted。
			driver.setOnline(false);
			const degradedMessage = `[TTS] 伴生服务不可用（未连接或协议不兼容），已降级为纯打字模式（可经 speech/tts 工具重试）: ${err instanceof Error ? err.message : String(err)}`;
			// 这是可恢复的能力降级，不是扩展生命周期错误。reportError 会产生
			// extension_error 红色错误事件，导致 Uina 刚启动就被错误打断；这里只做警告通知。
			if (pi.ui?.notify) pi.ui.notify(degradedMessage, "warning", 8000);
			else console.warn(degradedMessage);
		}
	})();
	let cleanupPromise: Promise<void> | undefined;
	const stopOwnedCompanions = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			await companionStartup;
			await subtitleStartup;
			const cleanup = await Promise.allSettled([
				(async () => {
					await companionHandle?.stop();
				})(),
				(async () => {
					await subtitleHandle?.stop();
				})(),
			]);
			const errors = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (errors.length)
				throw new AggregateError(
					errors.map((result) => result.reason),
					"TTS companion cleanup failed",
				);
		})();
		return cleanupPromise;
	};
	try {
		// 2. 交付端口（Speech 的唯一物理执行面）：utteranceId 是 Speech 侧表达身份，
		//    Driver Source（trace）在本层映射与持有。
		const utteranceSources = new Map<string, string>();
		const sourceOf = (utteranceId: string): string | undefined => utteranceSources.get(utteranceId);

		pi.registerService("tts_delivery:submit", async (input) => {
			const { utteranceId, text } = (input ?? {}) as { utteranceId?: string; text?: string };
			if (typeof utteranceId !== "string" || !utteranceId || typeof text !== "string" || !text)
				return { status: "not_started", reason: "交付参数不完整" };
			await companionStartup;
			let trace = sourceOf(utteranceId);
			if (!trace) {
				trace = driver.beginSource(utteranceId);
				utteranceSources.set(utteranceId, trace);
			}
			const result = await driver.submitSegment(text, undefined, undefined, trace);
			// 规范结果：Driver 的 uncertain 在适配边界统一映射为 unknown，
			// Speech 端口对 unknown 保留来源并可目标性停止，不得按拒绝丢弃。
			const status = result.status === "uncertain" ? "unknown" : result.status;
			if (status === "accepted" || status === "unknown") {
				startLevelStream();
				ensureProgressPolling();
			}
			return { ...result, status, traceId: trace };
		});

		pi.registerService("tts_delivery:seal", async (input) => {
			const utteranceId = (input as { utteranceId?: string } | undefined)?.utteranceId;
			const trace = typeof utteranceId === "string" ? sourceOf(utteranceId) : undefined;
			if (!trace) return { status: "not_started", reason: "该表达没有进行中的声音来源" };
			try {
				const sealed = await driver.endSource(trace);
				// 只有远端确认（turn-end 成功或来源已取消）才是 sealed；否则如实 unknown。
				return sealed === "sealed" ? { status: "sealed" } : { status: "unknown", reason: "来源结束未确认" };
			} catch (error) {
				return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
			}
		});

		pi.registerService("tts_delivery:stop", async (input) => {
			const utteranceId = (input as { utteranceId?: string } | undefined)?.utteranceId;
			const trace = typeof utteranceId === "string" ? sourceOf(utteranceId) : undefined;
			if (utteranceId !== undefined && !trace)
				return { outcome: "no_op", breakpoint: null, reason: "没有该表达的声音来源" };
			const result: InterruptResult = await driver.interrupt(trace);
			return result;
		});

		pi.registerService("tts_delivery:set_muted", async (input) => {
			const muted = (input as { muted?: unknown } | undefined)?.muted === true;
			if (muted) {
				utteranceSources.clear();
				const result = await driver.setMuted(true);
				stopProgressPolling();
				stopLevelStream();
				return result;
			}
			return await driver.setMuted(false);
		});

		// 读取路径只有一条：交付快照。同步事实的跨扩展代理，不做第二份账。
		pi.registerService("tts_delivery:snapshot", async () => driver.snapshot());

		// 3. 播放事实回推：Driver 的状态迁移转发给 Speech 交付簿记（trace → utteranceId）。
		driver.setPlaybackObserver((fact) => {
			const utteranceId = [...utteranceSources.entries()].find(([, trace]) => trace === fact.traceId)?.[0];
			if (!utteranceId) return;
			if (typeof pi.hasService !== "function" || !pi.hasService("speech_delivery:on_playback")) return;
			void pi
				.callService("speech_delivery:on_playback", { ...fact, utteranceId })
				.catch(() => undefined);
		});

		// 4. 声学电平下发：桥侧电平 -> 具备口型的身体外壳（生产者推、消费者只提供接收端）。
		//
		//    方向是"生产者推、消费者只提供接收端"：外壳用 ctx.expose 暴露 sink（世界只写、
		//    读不到他人共享值），tts 用 pi.shared 拉取并按前缀筛选后推送。外壳因此不需要
		//    知道音频从哪来，也不需要为口型引入第二条传输通道。
		const readExposedFeed = (): WorldExposedRegistry | undefined => {
			// 声学电平是**增强能力**。宿主未提供同进程共享表（例如核心早于本扩展的进程）
			// 时必须跳过扇出而不是让整个 tts 激活失败——否则"缺一个唇形驱动"会把
			// "说话"本身一起弄死，而发声才是这个扩展的存在意义。
			if (typeof pi.shared !== "function") return undefined;
			return pi.shared(WORLD_EXPOSED_SHARED_NAME) as WorldExposedRegistry | undefined;
		};

		const resolveLevelSinks = (): VoiceLevelSink[] => {
			const feed = readExposedFeed();
			if (!feed) return [];
			const sinks: VoiceLevelSink[] = [];
			for (const name of feed.names()) {
				if (!name.startsWith(VOICE_LEVEL_SINK_EXPOSED_PREFIX)) continue;
				const value = feed.get(name);
				if (isVoiceLevelSink(value)) {
					sinks.push(value);
				} else {
					pi.reportError(
						new Error(`共享名 "${name}" 声明为电平接收端，但取到的值不满足 VoiceLevelSink 契约，已忽略。`),
					);
				}
			}
			return sinks;
		};

		// 缓存 + 随共享表变化重解析：外壳可能在运行期被停用/重新启用（world_store 启停）。
		let levelSinks = resolveLevelSinks();
		const exposedFeed = readExposedFeed();
		if (!exposedFeed) {
			// 降级但如实上报：发声仍然可用，只是口型没有驱动来源。
			pi.reportError("[TTS] 宿主未提供同进程共享表，声学电平下发已停用（口型无驱动来源）；发声本身不受影响。");
		}
		const unsubscribeExposedFeed = exposedFeed?.subscribe(() => {
			levelSinks = resolveLevelSinks();
		});

		let levelStream: AbortController | null = null;
		let levelReady: Promise<boolean> | undefined;

		const pushLevel = (event: PlaybackEvent): void => {
			if (!driver.ownsSource(event.trace_id)) return;
			driver.receive(event);
			if (!driver.isDelivering) {
				stopProgressPolling();
				resetLevelSinks();
			}
			const level = readPlaybackLevel(event);
			if (!level) return;
			for (const sink of levelSinks) {
				try {
					sink.processLevel(level);
				} catch {
					// 单个外壳异常不影响其余外壳，更不影响发声
				}
			}
		};

		function stopLevelStream(): void {
			levelStream?.abort();
			levelStream = null;
			resetLevelSinks();
		}

		function resetLevelSinks(): void {
			// 音频结束/被打断时必须显式复位：这是"说话结束后不得永久张嘴"的兜底
			for (const sink of levelSinks) {
				try {
					sink.reset();
				} catch {
					// 同上
				}
			}
		}

		function startLevelStream(): Promise<boolean> {
			if (levelStream !== null) return levelReady ?? Promise.resolve(false);
			const controller = new AbortController();
			levelStream = controller;
			let ready!: (value: boolean) => void;
			levelReady = new Promise((resolve) => {
				ready = resolve;
			});
			void client
				.subscribeEvents(undefined, pushLevel, controller.signal, () => ready(true))
				.then(() => {
					ready(false);
					if (levelStream === controller) levelStream = null;
				})
				.catch((error: unknown) => {
					ready(false);
					if (levelStream === controller) levelStream = null;
					// 电平是口型的增强能力：订阅失败只上报，绝不影响发声与回合推进
					if (!controller.signal.aborted) {
						pi.reportError(
							`[TTS] 声学电平订阅失败（口型将无驱动）: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				});
			return levelReady;
		}
		driver.setReconnectFeed(async (signal) => {
			stopLevelStream();
			signal?.throwIfAborted();
			signal?.addEventListener("abort", stopLevelStream, { once: true });
			try {
				return await startLevelStream();
			} finally {
				signal?.removeEventListener("abort", stopLevelStream);
			}
		});

		// 电平订阅的生命周期只有一个主人：返回的 teardown。
		// 不再额外挂 pi.signal 的 abort 监听 —— runner 卸载时本就是"先 abort、再跑 teardown"，
		// 两条路清同一个东西，只会有两条路各自出错的余量。

		// 5. 进度探测：唯一的 IO 读点，由事实拥有者自己推进。渲染路径永远只读内存快照。
		let progressTimer: ReturnType<typeof setInterval> | null = null;

		const stopProgressPolling = (): void => {
			if (progressTimer === null) return;
			clearInterval(progressTimer);
			progressTimer = null;
		};

		const tickProgress = (): void => {
			void driver
				.probe()
				.catch(() => {
					// 探测失败即"这一拍没看到新事实"，快照保留上一次观测；不刷屏、不臆造。
				})
				.then(() => {
					// 来源终局且不再用于停止/对账后回收双向关联（不留只增映射）。
					for (const [utteranceId, trace] of [...utteranceSources]) {
						if (driver.isSourceRetired(trace)) utteranceSources.delete(utteranceId);
					}
					if (!driver.isDelivering) {
						stopProgressPolling();
						resetLevelSinks();
					}
				});
		};

		const ensureProgressPolling = (): void => {
			if (progressTimer !== null || !driver.isOnline) return;
			const timer = setInterval(tickProgress, PROGRESS_POLL_INTERVAL_MS);
			(timer as unknown as { unref?: () => void }).unref?.();
			progressTimer = timer;
		};

		// 6. 回合边界：自动恢复与电平流仍归本扩展；输出/中断的语音业务全归 Speech。
		pi.on("turn_start", (_e: TurnStartEvent) => {
			// 伴生服务离线时不发无用请求，也就不会每回合刷一条错误
			if (driver.isOnline) startLevelStream();
			// Connection recovery and an unknown delivery barrier are independent.
			void driver
				.attemptAutoRecovery()
				.then(() => {
					if (driver.isOnline) startLevelStream();
				})
				.catch(() => undefined);
		});

		pi.on("turn_end", (_e: TurnEndEvent) => {
			// 文本说完了：若音频仍在物理播放或在途队列，保持电平流直到交付彻底完成；
			// 仅在完全无在途音频时立即收束电平与口型复位。
			if (driver.isDelivering) {
				ensureProgressPolling();
			} else {
				stopProgressPolling();
				resetLevelSinks();
			}
		});

		// 卸载收束：先停探测与电平流，再等伴生进程真正退出（仅限本扩展拉起的进程）。
		// 停止失败如实上抛，由 runner 的 teardown 路径上报，不静默吞掉。
		return async () => {
			const stopped = await Promise.allSettled([driver.dispose()]);
			unsubscribeExposedFeed?.();
			stopProgressPolling();
			stopLevelStream();
			await stopOwnedCompanions();
			if (stopped[0].status === "rejected") throw stopped[0].reason;
		};
	} catch (error) {
		try {
			await stopOwnedCompanions();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "TTS activation and cleanup failed");
		}
		throw error;
	}
}
