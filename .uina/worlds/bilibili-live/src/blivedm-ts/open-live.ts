import { createHash, createHmac, randomUUID } from "node:crypto";
import { Operation, type RawPacket } from "./protocol.js";
import { WebSocketClientBase, type BaseClientOptions } from "./connection.js";
import {
  parseOpenDanmaku,
  parseOpenGift,
  parseOpenSuperChat,
  parseOpenSuperChatDelete,
  parseOpenGuardBuy,
  parseOpenLike,
} from "./events.js";

export const START_URL = "https://live-open.biliapi.com/v2/app/start";
export const HEARTBEAT_URL = "https://live-open.biliapi.com/v2/app/heartbeat";
export const END_URL = "https://live-open.biliapi.com/v2/app/end";

export interface OpenLiveClientOptions extends BaseClientOptions {
  accessKeyId: string;
  accessKeySecret: string;
  appId: number;
  roomOwnerAuthCode: string;
  gameHeartbeatInterval?: number;
  fetchFn?: typeof fetch;
}

const OPEN_EVENT_PARSERS: Record<string, { event: string; parse: (data: any) => any }> = {
  LIVE_OPEN_PLATFORM_DM: { event: "danmaku", parse: parseOpenDanmaku },
  LIVE_OPEN_PLATFORM_SEND_GIFT: { event: "gift", parse: parseOpenGift },
  LIVE_OPEN_PLATFORM_SUPER_CHAT: { event: "superChat", parse: parseOpenSuperChat },
  LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL: { event: "superChatDel", parse: parseOpenSuperChatDelete },
  LIVE_OPEN_PLATFORM_GUARD: { event: "guardBuy", parse: parseOpenGuardBuy },
  LIVE_OPEN_PLATFORM_LIKE: { event: "like", parse: parseOpenLike },
};

/**
 * 官方开放平台 HMAC-SHA256 请求签名
 */
export function signOpenLiveRequest(
  body: Record<string, any>,
  accessKeyId: string,
  accessKeySecret: string,
  fixedNonce?: string,
  fixedTimestamp?: string
): { headers: Record<string, string>; bodyString: string } {
  const bodyString = JSON.stringify(body);
  const contentMd5 = createHash("md5").update(bodyString).digest("hex");
  const nonce = fixedNonce || randomUUID().replace(/-/g, "");
  const timestamp = fixedTimestamp || Math.floor(Date.now() / 1000).toString();

  const headerMap: Record<string, string> = {
    "x-bili-accesskeyid": accessKeyId,
    "x-bili-content-md5": contentMd5,
    "x-bili-signature-method": "HMAC-SHA256",
    "x-bili-signature-nonce": nonce,
    "x-bili-signature-version": "1.0",
    "x-bili-timestamp": timestamp,
  };

  const strToSign = Object.entries(headerMap)
    .map(([k, v]) => `${k}:${v}`)
    .join("\n");

  const signature = createHmac("sha256", accessKeySecret)
    .update(strToSign)
    .digest("hex");

  return {
    headers: {
      ...headerMap,
      Authorization: signature,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    bodyString,
  };
}

/**
 * B站官方开放平台客户端 (OpenLiveClient)
 */
export class OpenLiveClient extends WebSocketClientBase {
  declare protected options: OpenLiveClientOptions;

  private _gameId = "";
  private _roomId = 0;
  private _roomOwnerUid = 0;
  private _roomOwnerOpenId = "";
  private hostServerUrlList: string[] = [];
  private authBody = "";
  private gameHeartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: OpenLiveClientOptions) {
    super(options);
  }

  public get gameId(): string {
    return this._gameId;
  }

  public get roomId(): number {
    return this._roomId;
  }

  public get roomOwnerUid(): number {
    return this._roomOwnerUid;
  }

  public get roomOwnerOpenId(): string {
    return this._roomOwnerOpenId;
  }

  public async initRoom(): Promise<boolean> {
    const success = await this.startGame();
    if (!success) {
      return false;
    }

    if (this._gameId && !this.gameHeartbeatTimer) {
      const intervalMs = (this.options.gameHeartbeatInterval ?? 20) * 1000;
      this.gameHeartbeatTimer = setInterval(() => {
        this.sendGameHeartbeat().catch((err) => {
          this.emitError(err);
        });
      }, intervalMs);
    }

    return true;
  }

  private applyStartGameData(data: any): boolean {
    this._gameId = data.game_info?.game_id || "";
    this.authBody = data.websocket_info?.auth_body || "";
    this.hostServerUrlList = data.websocket_info?.wss_link || [];
    this._roomId = data.anchor_info?.room_id || 0;
    this._roomOwnerUid = data.anchor_info?.uid || 0;
    this._roomOwnerOpenId = data.anchor_info?.open_id || "";
    return this.hostServerUrlList.length > 0;
  }

  public async startGame(): Promise<boolean> {
    const fetchFn = this.options.fetchFn ?? fetch;
    try {
      const { headers, bodyString } = signOpenLiveRequest(
        {
          code: this.options.roomOwnerAuthCode,
          app_id: this.options.appId,
        },
        this.options.accessKeyId,
        this.options.accessKeySecret
      );

      const res = await fetchFn(START_URL, {
        method: "POST",
        headers,
        body: bodyString,
      });

      if (!res.ok) {
        throw new Error(`OpenLive startGame HTTP error: ${res.status}`);
      }

      const json = (await res.json()) as any;
      if (json.code !== 0 || !json.data) {
        throw new Error(`OpenLive startGame API error: ${json.message} (code ${json.code})`);
      }

      return this.applyStartGameData(json.data);
    } catch (err) {
      this.emitError(err);
      return false;
    }
  }

  public async sendGameHeartbeat(): Promise<boolean> {
    if (!this._gameId) {
      return false;
    }

    const fetchFn = this.options.fetchFn ?? fetch;
    try {
      const { headers, bodyString } = signOpenLiveRequest(
        { game_id: this._gameId },
        this.options.accessKeyId,
        this.options.accessKeySecret
      );

      const res = await fetchFn(HEARTBEAT_URL, {
        method: "POST",
        headers,
        body: bodyString,
      });

      if (!res.ok) {
        return false;
      }

      const json = (await res.json()) as any;
      if (json.code !== 0) {
        if (json.code === 7003) {
          this.needInitRoom = true;
          this.ws?.close();
        }
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  public async endGame(): Promise<boolean> {
    if (!this._gameId) {
      return true;
    }

    const fetchFn = this.options.fetchFn ?? fetch;
    try {
      const { headers, bodyString } = signOpenLiveRequest(
        {
          app_id: this.options.appId,
          game_id: this._gameId,
        },
        this.options.accessKeyId,
        this.options.accessKeySecret
      );

      const res = await fetchFn(END_URL, {
        method: "POST",
        headers,
        body: bodyString,
      });

      this._gameId = "";
      if (!res.ok) {
        return false;
      }

      const json = (await res.json()) as any;
      return json.code === 0 || json.code === 7000 || json.code === 7003;
    } catch {
      this._gameId = "";
      return false;
    }
  }

  public override async disconnect(): Promise<void> {
    if (this.gameHeartbeatTimer) {
      clearInterval(this.gameHeartbeatTimer);
      this.gameHeartbeatTimer = null;
    }

    await this.endGame();
    await super.disconnect();
  }

  public getWsUrl(retryCount: number): string {
    if (!this.hostServerUrlList || this.hostServerUrlList.length === 0) {
      return "";
    }
    return this.hostServerUrlList[retryCount % this.hostServerUrlList.length]!;
  }

  public sendAuth(): void {
    this.sendPacket(Operation.AUTH, this.authBody);
  }

  public handleBusinessMessage(packet: RawPacket): void {
    const { body } = packet;
    if (!body || typeof body !== "object") {
      return;
    }

    const cmd = body.cmd;
    if (cmd === "LIVE_OPEN_PLATFORM_INTERACTION_END") {
      if (body.data?.game_id === this._gameId) {
        this.needInitRoom = true;
        this.ws?.close();
      }
      return;
    }

    this.emit("raw", body);

    const parserEntry = OPEN_EVENT_PARSERS[cmd];
    if (parserEntry && body.data) {
      this.emit(parserEntry.event, parserEntry.parse(body.data));
    }
  }
}
