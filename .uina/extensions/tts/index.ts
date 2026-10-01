import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { TurnStartEvent, OutputInterruptedEvent, OutputUpdateEvent } from "../../../src/runtime/events.js";
import {
	WORLD_EXPOSED_SHARED_NAME,
	type WorldExposedRegistry,
} from "../../../src/extensions/world-framework/types.js";
import {
	VOICE_LEVEL_SINK_EXPOSED_PREFIX,
	isVoiceLevelSink,
	type VoiceLevelSink,
} from "../voice/events.js";
import { loadConfig } from "./config.js";
import { TtsBridgeClient, readPlaybackLevel, type PlaybackEvent } from "./client.js";
import { ensureCompanion } from "./companion.js";
import { ensureSubtitleService } from "./subtitle-companion.js";
import { StreamParser } from "./stream-parser.js";
import { TtsVoiceOutputDriver } from "./driver-impl.js";

import { createTtsTool } from "./tool.js";
import { loadVoicePreferences } from "../voice/preferences.js";

export * from "./delivery.js";
export * from "./driver-impl.js";
export * from "./client.js";
export * from "./config.js";

/** 进度探测周期。只在"还有音频在路上"时运行，静默即停。 */
const PROGRESS_POLL_INTERVAL_MS = 1000;

export default async function activate(pi: ExtensionAPI): Promise<void | (() => Promise<void>)> {
  const config = loadConfig();
  const client = new TtsBridgeClient(config.serviceUrl, config.requestTimeoutMs);
  const parser = new StreamParser({ maxSentenceChars: config.maxSentenceChars });
  const driver = new TtsVoiceOutputDriver(client);
  let companionHandle: Awaited<ReturnType<typeof ensureCompanion>> | undefined;
  driver.setRestartBridge(async () => {
    if (!companionHandle?.didSpawn) {
      return { status: "not_started", ownership: "external", reason: "Bridge 不是当前扩展明确拥有的进程" };
    }
    try {
      await companionHandle.stop();
      companionHandle = await ensureCompanion(config, pi.signal);
      driver.setBridgeOwnership(companionHandle.didSpawn ? "owned" : "external");
      driver.setOnline(true);
      return { status: "succeeded", ownership: "owned", ready: true };
    } catch (error) {
      driver.setBridgeOwnership("unknown");
      driver.setOnline(false);
      return { status: "unknown", ownership: "owned", reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const initialPreferences = await loadVoicePreferences(pi);
  let readAssistantText = initialPreferences.readAssistantText;
  (pi as ExtensionAPI & { registerTool?: (tool: import("../../../src/tools/broker.js").Tool) => unknown }).registerTool?.(createTtsTool(driver));

  const recordPerception = async (fact: { kind: "interrupted" | "delivery_failed" | "delivery_unknown"; summary: string }): Promise<void> => {
    if (typeof pi.hasService !== "function" || !pi.hasService("voice_perception:record") || typeof pi.callService !== "function") return;
    await pi.callService("voice_perception:record", { fact }).catch(() => undefined);
  };

  // 1. 伴生服务管理（所有权自律：谁拉起谁销毁）
  // 句柄由本激活函数持有：若拉起了进程，在返回的 teardown 中 await stop()，
  // 清理失败交给 runner 报告；复用外部服务时 stop 是 no-op。
  let subtitleHandle: Awaited<ReturnType<typeof ensureSubtitleService>> | undefined;
  const subtitleStartup = (async () => {
    try {
      subtitleHandle = await ensureSubtitleService(config, pi.signal);
    } catch (err) {
      pi.reportError(`[TTS] OBS 字幕伴生服务未连接，已降级（不影响发声）: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  let cleanupPromise: Promise<void> | undefined;
  const stopOwnedCompanions = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await subtitleStartup;
      const cleanup = await Promise.allSettled([
        (async () => { await companionHandle?.stop(); })(),
        (async () => { await subtitleHandle?.stop(); })(),
      ]);
      const errors = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "TTS companion cleanup failed");
    })();
    return cleanupPromise;
  };
  try {
    try {
      companionHandle = await ensureCompanion(config, pi.signal);
      driver.setBridgeOwnership(companionHandle.didSpawn ? "owned" : "external");
      driver.setOnline(true);
    } catch (err) {
      driver.setBridgeOwnership("unknown");
      driver.setOnline(false);
      await driver.setMuted(true);
      pi.reportError(`[TTS] 伴生服务不可用（未连接或协议不兼容），已降级为纯打字模式 (可通过 voice 工具重试): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. 注册向下驱动服务（遵循 Uina IPC 序列化规范，纯数据交互）
    pi.registerService("voice_driver:set_muted", async (input: { muted: boolean }) => {
      return await driver.setMuted(Boolean(input?.muted));
    });
    pi.registerService("voice_driver:set_text_reading", async (input: { enabled: boolean }) => {
      readAssistantText = Boolean(input?.enabled);
      return { success: true };
    });

    pi.registerService("voice_driver:speak", async (input?: { text?: string; replace?: boolean; invocationId?: string }) => {
      const result = await driver.speak(
        typeof input?.text === "string" ? input.text : "",
        typeof input?.invocationId === "string" ? input.invocationId : undefined,
        input?.replace === true,
      );
      if (result.status === "unknown" || result.status === "uncertain" || result.status === "failed") {
        await recordPerception({
          kind: result.status === "unknown" || result.status === "uncertain" ? "delivery_unknown" : "delivery_failed",
          summary: `直接发声${result.status === "unknown" || result.status === "uncertain" ? "结果未知" : "失败"}：${result.reason ?? "未提供原因"}。`,
        });
      }
      return result;
    });

    pi.registerService("voice_driver:interrupt", async (input?: { expectedTraceId?: string }) => {
      const result = await driver.interrupt(input?.expectedTraceId);
      if (result.outcome === "unknown" || result.outcome === "failed") {
        await recordPerception({ kind: result.outcome === "unknown" ? "delivery_unknown" : "delivery_failed", summary: `声音停止结果${result.outcome === "unknown" ? "未知" : "失败"}：${result.reason}。` });
      } else if (result.outcome === "interrupted") {
        await recordPerception({ kind: "interrupted", summary: "上一段声音被主动打断，后续内容未交付。" });
      }
      return result;
    });

    // 读取路径只有一条：交付快照。同步事实的跨扩展代理，不做第二份账。
    pi.registerService("voice_driver:snapshot", async () => driver.snapshot());

    // 3. 声学电平下发：桥侧电平 -> 具备口型的身体外壳
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
          pi.reportError(new Error(`共享名 "${name}" 声明为电平接收端，但取到的值不满足 VoiceLevelSink 契约，已忽略。`));
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
    let aborted = false;

    const pushLevel = (event: PlaybackEvent): void => {
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

    function startLevelStream(): void {
      if (levelStream !== null) return;
      const controller = new AbortController();
      levelStream = controller;
      void client.subscribeEvents(undefined, pushLevel, controller.signal)
        .then(() => {
          if (levelStream === controller) levelStream = null;
        })
        .catch((error: unknown) => {
          if (levelStream === controller) levelStream = null;
          // 电平是口型的增强能力：订阅失败只上报，绝不影响发声与回合推进
          if (!controller.signal.aborted) {
            pi.reportError(
              `[TTS] 声学电平订阅失败（口型将无驱动）: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
    }

    // 电平订阅的生命周期只有一个主人：返回的 teardown。
    // 不再额外挂 pi.signal 的 abort 监听 —— runner 卸载时本就是"先 abort、再跑 teardown"，
    // 两条路清同一个东西，只会有两条路各自出错的余量。

    // 4. 进度探测：唯一的 IO 读点，由事实拥有者自己推进。渲染路径永远只读内存快照。
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
          if (!driver.isDelivering) {
            stopProgressPolling();
          }
        });
    };

    const ensureProgressPolling = (): void => {
      if (progressTimer !== null || !driver.isOnline) return;
      const timer = setInterval(tickProgress, PROGRESS_POLL_INTERVAL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      progressTimer = timer;
    };

    // 5. 事实事件流闭环驱动
    pi.on("turn_start", (e: TurnStartEvent) => {
      aborted = false;
      parser.reset();
      driver.startTurn(e.turnNumber);
      // 伴生服务离线时不发无用请求，也就不会每回合刷一条错误
      if (driver.isOnline) startLevelStream();
    });

    const submitTextSegment = async (text: string): Promise<void> => {
      const result = await driver.submitSegment(text);
      if (["unknown", "uncertain", "failed", "rejected"].includes(result.status)) {
        await recordPerception({
          kind: result.status === "unknown" || result.status === "uncertain" ? "delivery_unknown" : "delivery_failed",
          summary: `正文发声${result.status === "unknown" || result.status === "uncertain" ? "结果未知" : "失败"}：${result.reason ?? "来源存在未确认缺口"}。`,
        });
        if (result.status === "unknown" || result.status === "uncertain") {
          driver.setOnline(false);
          await driver.setMuted(true);
        }
        throw new Error(result.reason ?? `TTS submit ${result.status}`);
      }
      ensureProgressPolling();
    };

    pi.on("output_update", async (e: OutputUpdateEvent) => {
      if (aborted || e.channel !== "content" || !readAssistantText || driver.isMuted || !driver.isOnline) return;
      const sentences = parser.feed(e.text);
      for (const s of sentences) {
        try {
          await submitTextSegment(s);
        } catch (err) {
          driver.setOnline(false);
          await driver.setMuted(true);
          pi.reportError(`[TTS] 发声投递失败，已自动转为静音 (伴生服务可能离线): ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    });

    pi.on("turn_end", async () => {
      if (!driver.isMuted && driver.isOnline && driver.currentTraceId) {
        const tail = parser.flush();
        for (const s of tail) {
          try {
            await submitTextSegment(s);
          } catch (err) {
            driver.setOnline(false);
            await driver.setMuted(true);
            pi.reportError(`[TTS] 尾句发声投递失败，已自动转为静音: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
        if (driver.isOnline) {
          try {
            await client.turnEnd(driver.currentTraceId, undefined, driver.snapshot().submittedSegments);
          } catch (err) {
            pi.reportError(`[TTS Extension] 回合结束通知失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      // 文本说完了：若音频仍在物理播放或在途队列，保持电平流直到交付彻底完成；
      // 仅在完全无在途音频时立即收束电平与口型复位。
      if (driver.isDelivering) {
        ensureProgressPolling();
      } else {
        stopProgressPolling();
        resetLevelSinks();
      }
    });

    let interruption: Promise<void> | null = null;
    const interruptPlayback = (): Promise<void> => {
      if (interruption) return interruption;
      interruption = (async () => {
        parser.reset();
        stopProgressPolling();
        stopLevelStream();
        const result = await driver.interrupt();
        if (result.outcome === "unknown" || result.outcome === "failed") {
          await recordPerception({ kind: result.outcome === "unknown" ? "delivery_unknown" : "delivery_failed", summary: `声音停止结果${result.outcome === "unknown" ? "未知" : "失败"}：${result.reason}。` });
        } else if (result.outcome === "interrupted") {
          await recordPerception({ kind: "interrupted", summary: "上一段声音被主动打断，后续内容未交付。" });
        }
      })().finally(() => {
        interruption = null;
      });
      return interruption;
    };

    pi.on("output_interrupted", (_event: OutputInterruptedEvent) => {
      void interruptPlayback();
    });

    pi.on("turn_aborted", () => {
      aborted = true;
      void interruptPlayback();
    });

    // 卸载收束：先停探测与电平流，再等伴生进程真正退出（仅限本扩展拉起的进程）。
    // 停止失败如实上抛，由 runner 的 teardown 路径上报，不静默吞掉。
    return async () => {
      unsubscribeExposedFeed?.();
      stopProgressPolling();
      stopLevelStream();
      await stopOwnedCompanions();
    };
  } catch (error) {
    try { await stopOwnedCompanions(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "TTS activation and cleanup failed"); }
    throw error;
  }

}
