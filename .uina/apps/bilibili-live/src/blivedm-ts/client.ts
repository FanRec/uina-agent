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

export interface BilibiliLiveClientOptions extends BaseClientOptions {
  roomId: number;
  sessdata?: string;
  buvid?: string;
}

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

  constructor(options: BilibiliLiveClientOptions) {
    super(options);
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

      const danmuInfo = await fetchDanmuInfo(
        this.options.roomId,
        this.options.sessdata
      );
      this.token = danmuInfo.token;
      this.hostList = danmuInfo.host_list;

      return this.hostList.length > 0;
    } catch (err) {
      this.emitError(err);
      return false;
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
      uid: 0,
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

    const cmd = body.cmd;
    if (cmd === "DANMU_MSG" && Array.isArray(body.info)) {
      this.emit("danmaku", parseDanmaku(body.info));
    } else if (cmd === "SEND_GIFT" && body.data) {
      this.emit("gift", parseGift(body.data));
    } else if (cmd === "SUPER_CHAT_MESSAGE" && body.data) {
      this.emit("superChat", parseSuperChat(body.data));
    } else if (cmd === "GUARD_BUY" && body.data) {
      this.emit("guardBuy", parseGuardBuy(body.data));
    }
  }
}
