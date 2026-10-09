import { decodeSendGiftV2 } from "./gift-v2-protobuf.js";

/**
 * Web 端弹幕消息事件
 */
export interface DanmakuEvent {
  id: string;             // 弹幕唯一标识 (时间戳+rnd)
  uid: number;            // 发送者 UID
  uname: string;          // 发送者昵称
  text: string;           // 弹幕内容
  timestamp: number;      // 发送时间戳 (ms)
  medalName?: string;     // 粉丝勋章名
  medalLevel?: number;    // 粉丝勋章等级
  guardLevel?: number;    // 舰队身份: 0无, 1总督, 2提督, 3舰长
  userLevel?: number;     // 用户等级
  isEmoji?: boolean;      // 是否表情弹幕
}

/**
 * Web 端礼物消息事件
 */
export interface GiftEvent {
  id: string;             // 礼物事件唯一标识
  uid: number;            // 赠送者 UID
  uname: string;          // 赠送者昵称
  giftId: number;         // 礼物 ID
  giftName: string;       // 礼物名称
  count: number;          // 礼物数量
  price: number;          // 单个礼物面值 (金瓜子/1000 = 元)
  coinType: "gold" | "silver"; // 瓜子类型
  action: string;         // 动作 (如 "投喂", "赠送")
  timestamp: number;      // 时间戳
  guardLevel?: number;    // 舰队等级
  medalName?: string;     // 勋章名
  medalLevel?: number;    // 勋章等级
}

/**
 * Web 端醒目留言 (SuperChat) 事件
 */
export interface SuperChatEvent {
  id: number | string;    // SC 唯一 ID
  uid: number;            // 赠送者 UID
  uname: string;          // 赠送者昵称
  price: number;          // 价格 (人民币元)
  message: number | string;// 留言内容
  startTime: number;      // 生效开始时间
  endTime: number;        // 结束时间
  timestamp: number;      // 接收时间戳
  medalName?: string;     // 勋章名
  medalLevel?: number;    // 勋章等级
  guardLevel?: number;    // 舰队等级
}

/**
 * Web 端大航海 (上舰) 事件
 */
export interface GuardBuyEvent {
  uid: number;            // 用户 UID
  uname: string;          // 用户昵称
  guardLevel: number;     // 舰队等级: 1总督, 2提督, 3舰长
  num: number;            // 数量
  price: number;          // 金瓜子数
  giftName: string;       // 礼物名 (如 "舰长", "提督")
  timestamp: number;      // 时间戳
}

/**
 * 房间开播状态事件
 */
export interface RoomStatusEvent {
  status: "online" | "offline";
}

/**
 * 心跳与人气值事件
 */
export interface HeartbeatEvent {
  popularity: number;     // 在线人气值
}

/**
 * 官方开放平台 - 弹幕事件
 */
export interface OpenDanmakuEvent {
  uname: string;
  openId: string;
  uface: string;
  timestamp: number;
  roomId: number;
  msg: string;
  msgId: string;
  guardLevel: number;
  fansMedalWearingStatus: boolean;
  fansMedalName: string;
  fansMedalLevel: number;
  emojiImgUrl: string;
  dmType: number;
  gloryLevel: number;
  replyOpenId?: string;
  replyUname?: string;
  isAdmin: boolean;
}

/**
 * 官方开放平台 - 礼物事件
 */
export interface OpenGiftEvent {
  roomId: number;
  openId: string;
  uname: string;
  uface: string;
  giftId: number;
  giftName: string;
  giftNum: number;
  price: number;
  rPrice: number;
  paid: boolean;
  fansMedalName?: string;
  fansMedalLevel?: number;
  guardLevel: number;
  timestamp: number;
  msgId: string;
  giftIcon: string;
  comboGift: boolean;
  comboCount?: number;
}

/**
 * 官方开放平台 - 醒目留言事件
 */
export interface OpenSuperChatEvent {
  roomId: number;
  openId: string;
  uname: string;
  uface: string;
  messageId: number;
  message: string;
  rmb: number;
  timestamp: number;
  startTime: number;
  endTime: number;
  guardLevel: number;
  fansMedalName?: string;
  fansMedalLevel?: number;
  msgId: string;
}

/**
 * 官方开放平台 - 醒目留言删除事件
 */
export interface OpenSuperChatDeleteEvent {
  roomId: number;
  messageIds: number[];
  msgId: string;
}

/**
 * 官方开放平台 - 大航海事件
 */
export interface OpenGuardBuyEvent {
  roomId: number;
  userInfo: {
    openId: string;
    uname: string;
    uface: string;
  };
  guardLevel: number;
  guardNum: number;
  guardUnit: string;
  fansMedalName?: string;
  fansMedalLevel?: number;
  msgId: string;
  timestamp: number;
}

/**
 * 官方开放平台 - 点赞事件
 */
export interface OpenLikeEvent {
  uname: string;
  openId: string;
  uface: string;
  timestamp: number;
  roomId: number;
  likeText: string;
  likeCount: number;
  fansMedalName?: string;
  fansMedalLevel?: number;
  msgId: string;
}

// ==========================================
// 业务消息纯解析函数 (Pure Parsers)
// ==========================================

export function parseDanmaku(info: any[]): DanmakuEvent {
  const meta = info[0] || [];
  const text = String(info[1] || "");
  const userInfo = info[2] || [];
  const medalInfo = info[3] || [];
  const userLevelInfo = info[4] || [];
  const guardLevel = typeof info[7] === "number" ? info[7] : 0;

  const timestamp = meta[4] || Date.now();
  const rnd = meta[5] || Math.floor(Math.random() * 1000000);
  const id = `${timestamp}_${rnd}`;

  const uid = userInfo[0] || 0;
  const uname = userInfo[1] || "";

  const medalLevel = medalInfo.length > 0 ? medalInfo[0] : undefined;
  const medalName = medalInfo.length > 1 ? medalInfo[1] : undefined;

  const userLevel = userLevelInfo.length > 0 ? userLevelInfo[0] : undefined;
  const isEmoji = meta[12] === 1;

  return {
    id,
    uid,
    uname,
    text,
    timestamp,
    medalName,
    medalLevel,
    guardLevel,
    userLevel,
    isEmoji,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

function timestampInMilliseconds(value: unknown): number {
  if (value === undefined || value === null || value === "") return Date.now();
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("gift timestamp is invalid");
  return timestamp > 1e11 ? timestamp : timestamp * 1000;
}

function parseGiftPrice(data: Record<string, unknown>, count: number): number {
  const priceValue = data.price;
  const totalCoinValue = data.total_coin;
  const price = priceValue === undefined || priceValue === null || priceValue === "" ? undefined : Number(priceValue);
  const totalCoin = totalCoinValue === undefined || totalCoinValue === null || totalCoinValue === "" ? undefined : Number(totalCoinValue);
  const perGift = price ?? (totalCoin === undefined ? undefined : Math.round(totalCoin / count));
  if (perGift === undefined || !Number.isFinite(perGift) || perGift < 0) {
    throw new Error("gift is missing a valid price or total_coin");
  }
  return perGift;
}

/** Parse the legacy JSON-shaped SEND_GIFT payload. */
export function parseGift(input: unknown): GiftEvent {
  if (!isRecord(input)) throw new Error("SEND_GIFT data is not an object");
  const sender = isRecord(input.sender_uinfo) ? input.sender_uinfo : {};
  const senderBase = isRecord(sender.base) ? sender.base : {};
  const giftInfo = isRecord(input.gift_info) ? input.gift_info : {};

  // 0 and empty strings are placeholders in some payload versions, not usable identities.
  const uid = firstPositiveInteger(input.uid, sender.uid);
  const uname = firstNonEmptyString(input.uname, sender.uname, senderBase.name);
  const giftId = firstPositiveInteger(input.giftId, input.gift_id, giftInfo.giftId, giftInfo.gift_id);
  const giftName = firstNonEmptyString(input.giftName, input.gift_name, giftInfo.giftName, giftInfo.gift_name);
  const count = firstPositiveInteger(input.num, input.combo_num, input.count);
  if (!uid) throw new Error("SEND_GIFT is missing a valid sender uid");
  if (!uname) throw new Error("SEND_GIFT is missing sender uname");
  if (!giftId) throw new Error("SEND_GIFT is missing a valid gift id");
  if (!giftName) throw new Error("SEND_GIFT is missing gift name");
  if (!count) throw new Error("SEND_GIFT is missing a valid count");

  const coinType = input.coin_type;
  if (coinType !== "gold" && coinType !== "silver") throw new Error("SEND_GIFT has an unknown coin_type");
  const timestamp = timestampInMilliseconds(input.timestamp);
  const id = firstNonEmptyString(input.tid, input.transaction_id, input.rnd) ?? `${timestamp}_${uid}_${giftId}_${count}`;
  const medalInfo = isRecord(input.medal_info) ? input.medal_info : {};
  const guardLevel = Number.isSafeInteger(input.guard_level) ? Number(input.guard_level) : undefined;
  const medalLevel = Number.isSafeInteger(medalInfo.medal_level) ? Number(medalInfo.medal_level) : undefined;
  const medalName = firstNonEmptyString(medalInfo.medal_name);

  return {
    id,
    uid,
    uname,
    giftId,
    giftName,
    count,
    price: parseGiftPrice(input, count),
    coinType,
    action: firstNonEmptyString(input.action) ?? "赠送",
    timestamp,
    ...(guardLevel === undefined ? {} : { guardLevel }),
    ...(medalName === undefined ? {} : { medalName }),
    ...(medalLevel === undefined ? {} : { medalLevel }),
  };
}

/** Parse SEND_GIFT_V2's Protobuf broadcast, which may contain several gift items. */
export function parseGiftV2(input: unknown): GiftEvent[] {
  const broadcast = decodeSendGiftV2(input);
  return broadcast.gifts.map((gift, index) => {
    const timestamp = timestampInMilliseconds(gift.timestamp);
    return {
      id: gift.id || `${timestamp}_${broadcast.uid}_${gift.giftId}_${gift.count}_${index}`,
      uid: broadcast.uid,
      uname: broadcast.uname,
      giftId: gift.giftId,
      giftName: gift.giftName,
      count: gift.count,
      price: gift.price,
      coinType: gift.coinType,
      action: gift.action || "赠送",
      timestamp,
      ...(broadcast.guardLevel === undefined ? {} : { guardLevel: broadcast.guardLevel }),
      ...(broadcast.medalName === undefined ? {} : { medalName: broadcast.medalName }),
      ...(broadcast.medalLevel === undefined ? {} : { medalLevel: broadcast.medalLevel }),
    };
  });
}

export function parseSuperChat(data: any): SuperChatEvent {
  const medalInfo = data.medal_info;
  const userInfo = data.user_info || {};

  return {
    id: data.id,
    uid: data.uid,
    uname: userInfo.uname || data.uname || "",
    price: data.price || 0,
    message: data.message,
    startTime: data.start_time ? data.start_time * 1000 : Date.now(),
    endTime: data.end_time ? data.end_time * 1000 : Date.now(),
    timestamp: Date.now(),
    medalName: medalInfo?.medal_name,
    medalLevel: medalInfo?.medal_level,
    guardLevel: userInfo.guard_level || data.guard_level,
  };
}

export function parseGuardBuy(data: any): GuardBuyEvent {
  return {
    uid: data.uid,
    uname: data.username || data.uname || "",
    guardLevel: data.guard_level,
    num: data.num || 1,
    price: data.price || 0,
    giftName: data.gift_name,
    timestamp: data.start_time ? data.start_time * 1000 : Date.now(),
  };
}

export function parseOpenDanmaku(data: any): OpenDanmakuEvent {
  return {
    uname: data.uname || "",
    openId: data.open_id || "",
    uface: data.uface || "",
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    roomId: data.room_id || 0,
    msg: data.msg || "",
    msgId: data.msg_id || "",
    guardLevel: data.guard_level || 0,
    fansMedalWearingStatus: !!data.fans_medal_wearing_status,
    fansMedalName: data.fans_medal_name || "",
    fansMedalLevel: data.fans_medal_level || 0,
    emojiImgUrl: data.emoji_img_url || "",
    dmType: data.dm_type || 0,
    gloryLevel: data.glory_level || 0,
    replyOpenId: data.reply_open_id || undefined,
    replyUname: data.reply_uname || undefined,
    isAdmin: data.is_admin === 1,
  };
}

export function parseOpenGift(data: any): OpenGiftEvent {
  return {
    roomId: data.room_id || 0,
    openId: data.open_id || "",
    uname: data.uname || "",
    uface: data.uface || "",
    giftId: data.gift_id || 0,
    giftName: data.gift_name || "",
    giftNum: data.gift_num || 1,
    price: data.price || 0,
    rPrice: data.r_price || data.price || 0,
    paid: !!data.paid,
    fansMedalName: data.fans_medal_name || undefined,
    fansMedalLevel: data.fans_medal_level || undefined,
    guardLevel: data.guard_level || 0,
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    msgId: data.msg_id || "",
    giftIcon: data.gift_icon || "",
    comboGift: !!data.combo_gift,
    comboCount: data.combo_info?.combo_count,
  };
}

export function parseOpenSuperChat(data: any): OpenSuperChatEvent {
  return {
    roomId: data.room_id || 0,
    openId: data.open_id || "",
    uname: data.uname || "",
    uface: data.uface || "",
    messageId: data.message_id || 0,
    message: data.message || "",
    rmb: data.rmb || 0,
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    startTime: data.start_time || 0,
    endTime: data.end_time || 0,
    guardLevel: data.guard_level || 0,
    fansMedalName: data.fans_medal_name || undefined,
    fansMedalLevel: data.fans_medal_level || undefined,
    msgId: data.msg_id || "",
  };
}

export function parseOpenSuperChatDelete(data: any): OpenSuperChatDeleteEvent {
  return {
    roomId: data.room_id || 0,
    messageIds: Array.isArray(data.message_ids) ? data.message_ids : [],
    msgId: data.msg_id || "",
  };
}

export function parseOpenGuardBuy(data: any): OpenGuardBuyEvent {
  const userInfo = data.user_info || {};
  return {
    roomId: data.room_id || 0,
    userInfo: {
      openId: userInfo.open_id || "",
      uname: userInfo.uname || "",
      uface: userInfo.uface || "",
    },
    guardLevel: data.guard_level || 3,
    guardNum: data.guard_num || 1,
    guardUnit: data.guard_unit || "月",
    fansMedalName: data.fans_medal_name || undefined,
    fansMedalLevel: data.fans_medal_level || undefined,
    msgId: data.msg_id || "",
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
  };
}

export function parseOpenLike(data: any): OpenLikeEvent {
  return {
    uname: data.uname || "",
    openId: data.open_id || "",
    uface: data.uface || "",
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    roomId: data.room_id || 0,
    likeText: data.like_text || "为主播点赞了",
    likeCount: data.like_count || 1,
    fansMedalName: data.fans_medal_name || undefined,
    fansMedalLevel: data.fans_medal_level || undefined,
    msgId: data.msg_id || "",
  };
}
