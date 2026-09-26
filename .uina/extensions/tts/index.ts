import type { ExtensionAPI } from "../../../src/extensions/runner.js";
import type { TurnStartEvent, OutputUpdateEvent } from "../../../src/runtime/events.js";
import {
	APP_EXPOSED_SHARED_NAME,
	type AppExposedRegistry,
} from "../../../src/extensions/app-framework/types.js";
import {
	VOICE_LEVEL_SINK_EXPOSED_PREFIX,
	isVoiceLevelSink,
	type VoiceLevelSink,
} from "../voice/events.js";
import { loadConfig } from "./config.js";
import { TtsBridgeClient, readPlaybackLevel, type PlaybackEvent } from "./client.js";
import { ensureCompanion } from "./companion.js";
import { StreamParser } from "./stream-parser.js";
import { TtsVoiceOutputDriver } from "./driver-impl.js";
import { renderBreakpointNotice, renderDeliveryLine } from "./delivery.js";

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

  // 交付视口：本扩展是交付事实的拥有者，所以也只有它投影视口。
  // 断点提示优先于实时进度行 —— 同一件事不铺两行；两者都无话可说时整体 0 token。
  let breakpointNotice: string | null = null;

  const consumeDeliveryViewport = (): string | null => {
    if (breakpointNotice) {
      const notice = breakpointNotice;
      breakpointNotice = null;
      return notice;
    }
    return renderDeliveryLine(driver.snapshot());
  };

  // 1. 伴生服务管理（所有权自律：谁拉起谁销毁）
  // 句柄由本激活函数持有：若拉起了进程，在返回的 teardown 中 await stop()，
  // 保证“扩展卸载完成”与“伴生进程已结束”是同一事实。复用外部服务时 stop 是 no-op。
  let companionHandle: Awaited<ReturnType<typeof ensureCompanion>> | undefined;
  try {
    companionHandle = await ensureCompanion(config, pi.signal);
    driver.setOnline(true);
  } catch (err) {
    driver.setOnline(false);
    await driver.setMuted(true);
    pi.reportError(`[TTS] 伴生服务未连接，已降级为纯打字模式 (可通过 voice 工具开麦自动重试): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. 注册向下驱动服务（遵循 Uina IPC 序列化规范，纯数据交互）
  pi.registerService("voice_driver:set_muted", async (input: { muted: boolean }) => {
    return await driver.setMuted(Boolean(input?.muted));
  });

  pi.registerService("voice_driver:interrupt", async (input?: { expectedTraceId?: string }) => {
    const bp = await driver.interrupt(input?.expectedTraceId);
    if (bp) breakpointNotice = renderBreakpointNotice(bp);
    return bp;
  });

  // 读取路径只有一条：交付快照。同步事实的跨扩展代理，不做第二份账。
  pi.registerService("voice_driver:snapshot", async () => driver.snapshot());

  // 3. 声学电平下发：桥侧电平 -> 具备口型的身体外壳
  //
  //    方向是"生产者推、消费者只提供接收端"：外壳用 ctx.expose 暴露 sink（应用只写、
  //    读不到他人共享值），tts 用 pi.shared 拉取并按前缀筛选后推送。外壳因此不需要
  //    知道音频从哪来，也不需要为口型引入第二条传输通道。
  const readExposedFeed = (): AppExposedRegistry | undefined => {
    // 声学电平是**增强能力**。宿主未提供同进程共享表（例如核心早于本扩展的进程）
    // 时必须跳过扇出而不是让整个 tts 激活失败——否则"缺一个唇形驱动"会把
    // "说话"本身一起弄死，而发声才是这个扩展的存在意义。
    if (typeof pi.shared !== "function") return undefined;
    return pi.shared(APP_EXPOSED_SHARED_NAME) as AppExposedRegistry | undefined;
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

  // 缓存 + 随共享表变化重解析：外壳可能在运行期被停用/重新启用（app_store 启停）。
  let levelSinks = resolveLevelSinks();
  const exposedFeed = readExposedFeed();
  if (!exposedFeed) {
    // 降级但如实上报：发声仍然可用，只是口型没有驱动来源。
    pi.reportError("[TTS] 宿主未提供同进程共享表，声学电平下发已停用（口型无驱动来源）；发声本身不受影响。");
  }
  exposedFeed?.subscribe(() => {
    levelSinks = resolveLevelSinks();
  });

  let levelStream: AbortController | null = null;

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

  const stopLevelStream = (): void => {
    levelStream?.abort();
    levelStream = null;
    // 音频结束/被打断时必须显式复位：这是"说话结束后不得永久张嘴"的兜底
    for (const sink of levelSinks) {
      try {
        sink.reset();
      } catch {
        // 同上
      }
    }
  };

  const startLevelStream = (traceId: string): void => {
    levelStream?.abort();
    const controller = new AbortController();
    levelStream = controller;
    void client.subscribeEvents(traceId, pushLevel, controller.signal).catch((error: unknown) => {
      // 电平是口型的增强能力：订阅失败只上报，绝不影响发声与回合推进
      if (!controller.signal.aborted) {
        pi.reportError(
          `[TTS] 声学电平订阅失败（口型将无驱动）: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

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
        if (!driver.isDelivering) stopProgressPolling();
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
    parser.reset();
    const traceId = driver.startTurn(e.turnNumber);
    // 伴生服务离线时不发无用请求，也就不会每回合刷一条错误
    if (driver.isOnline) startLevelStream(traceId);
  });

  pi.on("output_update", async (e: OutputUpdateEvent) => {
    if (e.channel !== "content" || driver.isMuted || !driver.isOnline) return;
    const sentences = parser.feed(e.text);
    for (const s of sentences) {
      try {
        await driver.submitSegment(s);
        // 提交才开探测：没有在途音频时不占用任何周期
        ensureProgressPolling();
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
          await driver.submitSegment(s);
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
    // 无论本回合是否真的发声，都要收束电平订阅并复位口型
    stopLevelStream();
    // 文本说完了，声音还在队列里：继续探测直到排空，视口才说得准。
    if (driver.isDelivering) ensureProgressPolling();
    else stopProgressPolling();
  });

  pi.on("turn_aborted", async () => {
    const bp = await driver.interrupt();
    if (bp) breakpointNotice = renderBreakpointNotice(bp);
    parser.reset();
    stopLevelStream();
    stopProgressPolling();
  });

  // 6. 交付视口投影：与上下文一同注入，独立 system 消息，不污染用户输入。
  //    视口只放坐标（第几句 / 还有几条），句子内容留在作者侧记账里按需查。
  pi.onHook("turn.transformContext", async (projection) => {
    if (projection.messages.length === 0) return undefined;
    const viewportText = consumeDeliveryViewport();
    if (!viewportText) return undefined;

    return {
      projection: {
        ...projection,
        messages: [
          ...projection.messages,
          { role: "system", content: viewportText },
        ],
      },
    };
  });

  // 卸载收束：先停探测与电平流，再等伴生进程真正退出（仅限本扩展拉起的进程）。
  // 停止失败如实上抛，由 runner 的 teardown 路径上报，不静默吞掉。
  return async () => {
    stopProgressPolling();
    stopLevelStream();
    await companionHandle?.stop();
  };
}
