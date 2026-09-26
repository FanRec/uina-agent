import type { AppDef, ActionContext } from "../../../../src/extensions/app-framework/types.js";
import { BilibiliLiveClient } from "./blivedm-ts/client.js";
import { OpenLiveClient } from "./blivedm-ts/open-live.js";
import type {
  DanmakuEvent,
  GiftEvent,
  SuperChatEvent,
  GuardBuyEvent,
  HeartbeatEvent,
} from "./blivedm-ts/events.js";
import { LiveEventBuffer, sanitizeUntrustedText } from "./buffer.js";
import { loadConfig, type ResolvedLiveAppConfig } from "./config.js";
import { LiveEventJournal } from "./journal.js";
import { sendDanmaku } from "./send.js";
import type { LiveAppConfig, LiveAppState } from "./types.js";

/**
 * 伴生服务上下文扩展（支持模式二：强事件唤醒）
 */
export interface BilibiliLiveCompanionContext {
  signal: AbortSignal;
  wake?: (reason: string) => void;
}

/**
 * 零动态文本常量唤醒通知（彻底杜绝 Prompt Injection）
 */
export const HIGH_PRIORITY_WAKE_NOTICE =
  "[bilibili-live: high_priority_event_available]";

export async function handleConnectAction(
  args: Record<string, unknown>,
  ctx: ActionContext,
  config: ResolvedLiveAppConfig,
  appState: LiveAppState,
  initClient: (roomId: number) => BilibiliLiveClient | OpenLiveClient
): Promise<string> {
  const rawRoomId = args.roomId ?? args.room_id ?? config.defaultRoomId;
  const roomId = typeof rawRoomId === "number" ? rawRoomId : parseInt(String(rawRoomId), 10);

  if (!roomId || Number.isNaN(roomId) || roomId <= 0) {
    return "连接失败：必须提供有效的正整数直播间房号。";
  }

  const c = initClient(roomId);
  appState.roomId = roomId;
  c.connect().catch((err) => {
    console.warn(`[bilibili-live] 直播间 ${roomId} 连接异常:`, err);
  });

  ctx.setTier("expanded");
  return `正在连接B站直播间 ${roomId}... 当前状态: ${appState.connectionStatus}`;
}

export async function handleDisconnectAction(
  ctx: ActionContext,
  appState: LiveAppState,
  client: BilibiliLiveClient | OpenLiveClient | null,
  clearClient: () => void
): Promise<string> {
  if (client) {
    await client.disconnect();
    clearClient();
  }
  appState.connectionStatus = "disconnected";
  ctx.setTier("hidden");
  return "已断开B站直播间连接。";
}

export function handleStatusAction(
  appState: LiveAppState,
  buffer: LiveEventBuffer
): string {
  const pending = buffer.getPendingCounts();
  return JSON.stringify(
    {
      connection: appState.connectionStatus,
      roomId: appState.roomId,
      roomTitle: appState.roomTitle ? sanitizeUntrustedText(appState.roomTitle) : null,
      streamer: appState.streamerName ? sanitizeUntrustedText(appState.streamerName) : null,
      roomStatus: appState.roomStatus,
      popularity: appState.popularity,
      bufferedDanmaku: buffer.bufferSize,
      pendingSuperChats: pending.superChats,
      pendingGuards: pending.guards,
      pendingGifts: pending.gifts,
    },
    null,
    2
  );
}

export function handleMarkHandledAction(
  args: Record<string, unknown>,
  buffer: LiveEventBuffer
): string {
  const rawId = args.eventId ?? args.id;
  const eventId = String(rawId ?? "").trim();

  if (!eventId) {
    return "参数错误：必须提供待办事件的 eventId（如 sc_1, gd_1, gf_1）。";
  }

  const outcome = buffer.markHandled(eventId);
  return outcome.message;
}

export async function handleSendAction(
  args: Record<string, unknown>,
  config: ResolvedLiveAppConfig,
  appState: LiveAppState
): Promise<string> {
  const rawMsg = args.message ?? args.msg ?? args.text;
  const message = String(rawMsg ?? "").trim();

  const targetRoomId =
    (typeof args.roomId === "number" ? args.roomId : undefined) ??
    appState.roomId ??
    config.defaultRoomId;

  const outcome = await sendDanmaku({
    roomId: targetRoomId,
    message,
    sessdata: config.sessdata,
    biliJct: config.biliJct,
    buvid3: config.buvid3,
    timeoutMs: config.network.requestTimeoutMs,
  });

  return `[${outcome.status}] ${outcome.message}`;
}

export function handleRecentAction(
  args: Record<string, unknown>,
  buffer: LiveEventBuffer
): string {
  const rawCount = args.count;
  const count = typeof rawCount === "number" ? rawCount : 10;
  const recentList = buffer.getRecentDanmaku(count);

  if (recentList.length === 0) {
    return "当前缓冲池中暂无弹幕。";
  }

  const lines = ["最近弹幕记录:"];
  for (const item of recentList) {
    if (item.uniqueSenders > 1) {
      lines.push(
        `* [${item.id}] <data>${item.sender} 等 ${item.uniqueSenders} 人: ${item.text} (x${item.count})</data>`
      );
    } else if (item.count > 1) {
      lines.push(
        `* [${item.id}] <data>${item.sender}: ${item.text} (连发x${item.count})</data>`
      );
    } else {
      lines.push(`* [${item.id}] <data>${item.sender}: ${item.text}</data>`);
    }
  }

  return lines.join("\n");
}

/**
 * 创建 Bilibili Live 应用定义 (RC1-Pure)
 * 遵循高内聚低耦合与深模块架构
 *
 * @param userConfig 用户可选自定义配置
 */
export function createBilibiliLiveApp(userConfig?: Partial<LiveAppConfig>): AppDef {
  const config: ResolvedLiveAppConfig = loadConfig(userConfig);
  const journal = new LiveEventJournal(config.storage);
  const buffer = new LiveEventBuffer(config, journal);

  const appState: LiveAppState = {
    connectionStatus: "disconnected",
    roomId: config.defaultRoomId || null,
    roomTitle: null,
    streamerName: null,
    roomStatus: "unknown",
    popularity: 0,
    lastHeartbeatTime: 0,
  };

  let wakeFn: ((reason: string) => void) | undefined;
  let client: BilibiliLiveClient | OpenLiveClient | null = null;

  function initClient(roomId: number): BilibiliLiveClient | OpenLiveClient {
    if (client) {
      void client.disconnect();
      client = null;
    }

    const c = config.openPlatform
      ? new OpenLiveClient({
          accessKeyId: config.openPlatform.accessKeyId,
          accessKeySecret: config.openPlatform.accessKeySecret,
          appId: config.openPlatform.appId,
          roomOwnerAuthCode: config.openPlatform.code,
          autoReconnect: config.network.autoReconnect,
        })
      : new BilibiliLiveClient({
          roomId,
          sessdata: config.sessdata,
          buvid: config.buvid3,
          autoReconnect: config.network.autoReconnect,
        });

    c.on("danmaku", (msg: DanmakuEvent) => {
      buffer.addDanmaku(msg.uid, msg.uname, msg.text);
    });

    c.on("superChat", (msg: SuperChatEvent) => {
      const { shouldWake } = buffer.ingestSuperChat(msg);
      if (shouldWake) wakeFn?.(HIGH_PRIORITY_WAKE_NOTICE);
    });

    c.on("guardBuy", (msg: GuardBuyEvent) => {
      const { shouldWake } = buffer.ingestGuard(msg);
      if (shouldWake) wakeFn?.(HIGH_PRIORITY_WAKE_NOTICE);
    });

    c.on("gift", (msg: GiftEvent) => {
      const { shouldWake } = buffer.ingestGift(msg);
      if (shouldWake) wakeFn?.(HIGH_PRIORITY_WAKE_NOTICE);
    });

    c.on("heartbeat", (evt: HeartbeatEvent) => {
      appState.popularity = evt.popularity;
      appState.lastHeartbeatTime = Date.now();
    });

    c.on("connected", () => {
      appState.connectionStatus = "connected";
    });

    c.on("disconnected", () => {
      appState.connectionStatus = "disconnected";
    });

    c.on("reconnecting", () => {
      appState.connectionStatus = "reconnecting";
    });

    client = c;
    return c;
  }

  return {
    name: "bilibili-live",
    description:
      "B站直播应用，支持实时弹幕监控、SC/大航海/礼物感知、弹幕发送与待办互动管理。",

    async onStart(ctx: BilibiliLiveCompanionContext): Promise<void> {
      wakeFn = ctx.wake;

      ctx.signal?.addEventListener("abort", () => {
        if (client) {
          void client.disconnect();
          client = null;
        }
        buffer.dispose();
      });

      if (config.defaultRoomId) {
        const c = initClient(config.defaultRoomId);
        c.connect().catch((err) => {
          console.warn("[bilibili-live] 初始连接直播间失败:", err);
        });
      }
    },

    async onStop(): Promise<void> {
      if (client) {
        await client.disconnect();
        client = null;
      }
      buffer.dispose();
      wakeFn = undefined;
    },

    render(tier: "ambient" | "expanded"): string {
      return buffer.render(tier, appState);
    },

    actions: {
      connect: {
        description: "连接指定的B站直播间。如果不传 roomId 则连接默认直播间。",
        parameters: {
          type: "object",
          properties: {
            roomId: {
              type: "number",
              description: "B站直播间房号（长号或短号均可）",
            },
          },
        },
        run: (args, ctx) => handleConnectAction(args, ctx, config, appState, initClient),
      },

      disconnect: {
        description: "断开当前B站直播间连接并收起视口。",
        run: (_args, ctx) =>
          handleDisconnectAction(ctx, appState, client, () => {
            client = null;
          }),
      },

      status: {
        description: "查看当前B站直播间详细连接状态与待办统计。",
        run: async () => handleStatusAction(appState, buffer),
      },

      mark_handled: {
        description:
          "将指定的醒目留言(SC)、大航海或大额礼物待办事件标记为已处理/已感谢。",
        parameters: {
          type: "object",
          properties: {
            eventId: {
              type: "string",
              description: "待办事件短 ID（例如 sc_1, gd_1, gf_1）",
            },
          },
          required: ["eventId"],
        },
        run: async (args) => handleMarkHandledAction(args, buffer),
      },

      send: {
        description: "向当前连接的B站直播间发送一条弹幕。",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "弹幕文本（最多 50 字符）",
            },
            roomId: {
              type: "number",
              description: "可选的目标直播间房号，默认使用当前连接的房间",
            },
          },
          required: ["message"],
        },
        run: (args) => handleSendAction(args, config, appState),
      },

      recent: {
        description: "查看最近收到的弹幕列表（不消耗或影响视口）。",
        parameters: {
          type: "object",
          properties: {
            count: {
              type: "number",
              description: "获取的弹幕条数（1-50，默认 10）",
            },
          },
        },
        run: async (args) => handleRecentAction(args, buffer),
      },

      clear: {
        description: "清空当前的易失弹幕感知缓冲池（不会清除未处理待办互动）。",
        run: async () => {
          buffer.clearDanmaku();
          return "已清空易失弹幕缓冲池。";
        },
      },
    },
  };
}

export default createBilibiliLiveApp;
