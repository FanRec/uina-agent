import { Operation, type RawPacket } from "./protocol.js";
import { WebSocketClientBase, type BaseClientOptions } from "./connection.js";
import {
  getWbiKeys,
  calculateWbiKey,
  signWbiParams,
  invalidateWbiCache,
  USER_AGENT,
} from "./wbi.js";
import {
  parseDanmaku,
  parseGift,
  parseSuperChat,
  parseGuardBuy,
  type DanmakuEvent,
  type GiftEvent,
  type SuperChatEvent,
  type GuardBuyEvent,
  type HeartbeatEvent,
  type RoomStatusEvent,
} from "./events.js";

export interface DanmakuHostServer {
  host: string;
  port: number;
  wss_port: number;
  ws_port: number;
}

export interface RoomInitResult {
  room_id: number;
  short_id: number;
  uid: number;
  live_status: number;
  title: string;
}

export interface DanmuInfoResult {
  token: string;
  host_list: DanmakuHostServer[];
}

/**
 * 获取当前登录用户 ID；无 SESSDATA 或未登录时返回 0
 */
export async function fetchUserId(sessdata?: string): Promise<number> {
  if (!sessdata) {
    return 0;
  }

  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `SESSDATA=${sessdata}`,
    },
  });

  if (!res.ok) {
    throw new Error(`fetchUserId HTTP error: ${res.status}`);
  }

  const json = (await res.json()) as any;
  if (json.code === -101 || !json?.data?.isLogin) {
    return 0;
  }
  if (json.code !== 0 || typeof json?.data?.mid !== "number") {
    throw new Error(
      `fetchUserId API error: ${json.message || "unknown"} (code ${json.code})`
    );
  }

  return json.data.mid;
}

export interface BilibiliLiveClientOptions extends BaseClientOptions {
  roomId: number;
  sessdata?: string;
  buvid?: string;
}

/** 本体账号近期发送记录：用于把 send 动作经 WS 回传的弹幕识别为回声 */
interface OwnSendRecord {
  text: string;
  at: number;
}

/**
 * 回声关联窗口。自有回声必然与发送文本一致；窗口取 15 秒，远大于回传延迟，
 * 同时把"人类在同一账号手动发出相同文本"的误杀窗口压到最小。
 * （弹幕 rnd 关联未经线上实证，不作为判定依据。）
 */
const OWN_SEND_TTL_MS = 15_000;

/**
 * 获取直播间基础信息与长号
 */
export async function fetchRoomInfo(
  roomId: number,
  sessdata?: string
): Promise<RoomInitResult> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
  };
  if (sessdata) {
    headers["Cookie"] = `SESSDATA=${sessdata}`;
  }

  const res = await fetch(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`fetchRoomInfo HTTP error: ${res.status}`);
  }

  const json = (await res.json()) as any;
  if (json.code !== 0 || !json.data) {
    throw new Error(
      `fetchRoomInfo API error: ${json.message || "unknown"} (code ${json.code})`
    );
  }

  return {
    room_id: json.data.room_id,
    short_id: json.data.short_id || 0,
    uid: json.data.uid,
    live_status: json.data.live_status,
    title: json.data.title || "",
  };
}

/**
 * 获取弹幕服务器配置与 Token (WBI 签名)
 */
export async function fetchDanmuInfo(
  roomId: number,
  sessdata?: string
): Promise<DanmuInfoResult> {
  const roomInfo = await fetchRoomInfo(roomId, sessdata);
  const realRoomId = roomInfo.room_id;

  const { img_key, sub_key } = await getWbiKeys(sessdata);
  const wbiKey = calculateWbiKey(img_key, sub_key);
  const signedParams = signWbiParams(
    {
      id: realRoomId,
      type: 0,
    },
    wbiKey
  );

  const searchParams = new URLSearchParams(signedParams);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
  };
  if (sessdata) {
    headers["Cookie"] = `SESSDATA=${sessdata}`;
  }

  const res = await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${searchParams.toString()}`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(`fetchDanmuInfo HTTP error: ${res.status}`);
  }

  const json = (await res.json()) as any;
  if (json.code !== 0 || !json.data) {
    if (json.code === -352) {
      invalidateWbiCache(); // WBI 秘钥失效，清除缓存
    }
    throw new Error(
      `fetchDanmuInfo API error: ${json.message || "unknown"} (code ${json.code})`
    );
  }

  return {
    token: json.data.token,
    host_list: json.data.host_list || [],
  };
}

export interface BilibiliLiveClientEvents {
  roomInfo: (event: RoomInitResult) => void;
  roomStatus: (event: RoomStatusEvent) => void;
  connected: () => void;
  disconnected: () => void;
  reconnecting: (info: { retryCount: number; totalRetryCount: number; delaySeconds: number }) => void;
  heartbeat: (event: HeartbeatEvent) => void;
  danmaku: (event: DanmakuEvent) => void;
  gift: (event: GiftEvent) => void;
  superChat: (event: SuperChatEvent) => void;
  guardBuy: (event: GuardBuyEvent) => void;
  raw: (command: any) => void;
  error: (err: any) => void;
  timeout: (err: any) => void;
}

/**
 * B站 Web 直播弹幕客户端
 */
export class BilibiliLiveClient extends WebSocketClientBase {
  declare protected options: BilibiliLiveClientOptions;
  private _realRoomId = 0;
  private hostList: DanmakuHostServer[] = [];
  private token = "";
  private uid = 0;
  private recentOwnSends: OwnSendRecord[] = [];

  constructor(options: BilibiliLiveClientOptions) {
    super({
      ...options,
      handshakeHeaders: {
        "User-Agent": USER_AGENT,
        ...options.handshakeHeaders,
      },
    });
    this._realRoomId = options.roomId;
  }

  public get realRoomId(): number {
    return this._realRoomId;
  }

  public async initRoom(): Promise<boolean> {
    try {
      const roomInfo = await fetchRoomInfo(
        this.options.roomId,
        this.options.sessdata
      );
      this._realRoomId = roomInfo.room_id;
      this.uid = await fetchUserId(this.options.sessdata);
		this.emit("roomInfo", roomInfo);

      const danmuInfo = await fetchDanmuInfo(
        this.options.roomId,
        this.options.sessdata
      );
      this.token = danmuInfo.token;
      this.hostList = danmuInfo.host_list;

      return this.hostList.length > 0;
    } catch (err) {
      throw err;
    }
  }

  public getWsUrl(retryCount: number): string {
    if (!this.hostList || this.hostList.length === 0) {
      return "wss://broadcastlv.chat.bilibili.com:443/sub";
    }

    const host = this.hostList[retryCount % this.hostList.length]!;
    return `wss://${host.host}:${host.wss_port}/sub`;
  }

  public sendAuth(): void {
    const authPayload = {
      uid: this.uid,
      roomid: this._realRoomId,
      protover: 3,
      platform: "web",
      type: 2,
      key: this.token,
      buvid: this.options.buvid || "",
    };

    this.sendPacket(Operation.AUTH, JSON.stringify(authPayload));
  }

  public handleBusinessMessage(packet: RawPacket): void {
    const { body } = packet;
    if (!body || typeof body !== "object") {
      return;
    }

    this.emit("raw", body);

    const rawCmd = typeof body.cmd === "string" ? body.cmd : "";
    const cmd = rawCmd.split(":")[0];
    if (cmd === "DANMU_MSG" && Array.isArray(body.info)) {
      const event = parseDanmaku(body.info);
      if (this.isOwnEcho(event)) {
        return;
      }
      this.emit("danmaku", event);
    } else if ((cmd === "SEND_GIFT" || cmd === "SEND_GIFT_V2") && body.data) {
      this.emit("gift", parseGift(body.data));
    } else if (cmd === "SUPER_CHAT_MESSAGE" && body.data) {
      this.emit("superChat", parseSuperChat(body.data));
    } else if (cmd === "GUARD_BUY" && body.data) {
      this.emit("guardBuy", parseGuardBuy(body.data));
    } else if (cmd === "LIVE") {
      this.emit("roomStatus", { status: "online" });
    } else if (cmd === "PREPARING") {
      this.emit("roomStatus", { status: "offline" });
    }
  }

  /**
   * 登记 send 动作的成功发送（文本），供回声判定关联。
   * 同一账号的人类弹幕不会被登记，因此照常被感知。
   */
  public noteOwnSend(text: string): void {
    this.pruneOwnSends();
    this.recentOwnSends.push({ text: text.trim(), at: Date.now() });
  }

  /**
   * 回声判定：发送者必须是登录账号本人，且文本命中窗口内的发送记录。
   * uid 未知（未登录）时不过滤，避免误杀观众弹幕。
   */
  private isOwnEcho(event: DanmakuEvent): boolean {
    if (this.uid === 0 || event.uid !== this.uid) {
      return false;
    }
    const recent = this.pruneOwnSends();
    if (recent.length === 0) {
      return false;
    }
    const text = event.text.trim();
    return recent.some((entry) => entry.text === text);
  }

  private pruneOwnSends(): OwnSendRecord[] {
    const now = Date.now();
    this.recentOwnSends = this.recentOwnSends.filter(
      (entry) => now - entry.at < OWN_SEND_TTL_MS
    );
    return this.recentOwnSends;
  }
}
