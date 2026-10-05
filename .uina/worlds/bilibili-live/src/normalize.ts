import type {
	DanmakuEvent,
	GiftEvent,
	GuardBuyEvent,
	OpenDanmakuEvent,
	OpenGiftEvent,
	OpenGuardBuyEvent,
	OpenSuperChatEvent,
	SuperChatEvent,
} from "./blivedm-ts/events.js";

export type CanonicalLiveDanmaku = {
	readonly kind: "danmaku";
	readonly eventId: string;
	readonly uid: string | number;
	readonly uname: string;
	readonly occurredAtMs: number;
	readonly text: string;
	readonly guardLevel?: number;
	readonly medalName?: string;
	readonly medalLevel?: number;
};

export type CanonicalLiveSuperChat = {
	readonly kind: "superChat";
	readonly eventId: string;
	readonly uid: string | number;
	readonly uname: string;
	readonly occurredAtMs: number;
	readonly price: number;
	readonly message: string;
	readonly startTimeMs: number;
	readonly endTimeMs: number;
	readonly guardLevel?: number;
	readonly medalName?: string;
	readonly medalLevel?: number;
};

export type CanonicalLiveGuard = {
	readonly kind: "guard";
	readonly eventId: string;
	readonly uid: string | number;
	readonly uname: string;
	readonly occurredAtMs: number;
	readonly guardLevel: number;
	readonly giftName: string;
	readonly count: number;
	readonly medalName?: string;
	readonly medalLevel?: number;
};

export type CanonicalLiveGift = {
	readonly kind: "gift";
	readonly eventId: string;
	readonly uid: string | number;
	readonly uname: string;
	readonly occurredAtMs: number;
	readonly giftId: number;
	readonly giftName: string;
	readonly count: number;
	readonly price: number;
	readonly paid: boolean;
	readonly guardLevel?: number;
	readonly medalName?: string;
	readonly medalLevel?: number;
};

export type CanonicalLiveEvent =
	| CanonicalLiveDanmaku
	| CanonicalLiveSuperChat
	| CanonicalLiveGuard
	| CanonicalLiveGift;

export type LiveEvent = CanonicalLiveEvent;

export function normalizeWebDanmaku(event: DanmakuEvent): CanonicalLiveDanmaku {
	return {
		kind: "danmaku",
		eventId: event.id,
		uid: event.uid,
		uname: event.uname,
		occurredAtMs: event.timestamp,
		text: event.text,
		guardLevel: event.guardLevel,
		medalName: event.medalName,
		medalLevel: event.medalLevel,
	};
}

export function normalizeOpenDanmaku(event: OpenDanmakuEvent): CanonicalLiveDanmaku {
	return {
		kind: "danmaku",
		eventId: event.msgId,
		uid: event.openId,
		uname: event.uname,
		occurredAtMs: event.timestamp * 1000,
		text: event.msg,
		guardLevel: event.guardLevel,
		medalName: event.fansMedalName,
		medalLevel: event.fansMedalLevel,
	};
}

export function normalizeWebGuard(event: GuardBuyEvent): CanonicalLiveGuard {
	return {
		kind: "guard",
		eventId: `${event.uid}:${event.guardLevel}:${event.timestamp}`,
		uid: event.uid,
		uname: event.uname,
		occurredAtMs: event.timestamp,
		guardLevel: event.guardLevel,
		giftName: event.giftName,
		count: event.num ?? 1,
	};
}

export function normalizeOpenGuard(event: OpenGuardBuyEvent): CanonicalLiveGuard {
	const guardTitle =
		event.guardLevel === 1 ? "总督" : event.guardLevel === 2 ? "提督" : "舰长";
	return {
		kind: "guard",
		eventId: event.msgId,
		uid: event.userInfo.openId,
		uname: event.userInfo.uname,
		occurredAtMs: event.timestamp * 1000,
		guardLevel: event.guardLevel,
		giftName: guardTitle,
		count: event.guardNum ?? 1,
		medalName: event.fansMedalName,
		medalLevel: event.fansMedalLevel,
	};
}

export function normalizeWebGift(event: GiftEvent): CanonicalLiveGift {
	return {
		kind: "gift",
		eventId: event.id,
		uid: event.uid,
		uname: event.uname,
		occurredAtMs: event.timestamp,
		giftId: event.giftId,
		giftName: event.giftName,
		count: event.count,
		price: event.price,
		paid: event.coinType !== "silver",
		guardLevel: event.guardLevel,
		medalName: event.medalName,
		medalLevel: event.medalLevel,
	};
}

export function normalizeOpenGift(event: OpenGiftEvent): CanonicalLiveGift {
	// 领域规范：统一以金瓜子作为礼物面值（1000 瓜子 = ￥1）
	// 开放平台付费礼物单位为电池（1 电池 = ￥0.1 = 100 金瓜子）
	// 免费礼物为银瓜子，面值直接按银瓜子计算
	const normalizedPrice = event.paid ? event.price * 100 : event.rPrice;
	return {
		kind: "gift",
		eventId: event.msgId,
		uid: event.openId,
		uname: event.uname,
		occurredAtMs: event.timestamp * 1000,
		giftId: event.giftId,
		giftName: event.giftName,
		count: event.giftNum,
		price: normalizedPrice,
		paid: event.paid,
		guardLevel: event.guardLevel,
		medalName: event.fansMedalName,
		medalLevel: event.fansMedalLevel,
	};
}

export function normalizeOpenSuperChat(event: OpenSuperChatEvent): CanonicalLiveSuperChat {
	return {
		kind: "superChat",
		eventId: event.msgId || String(event.messageId),
		uid: event.openId,
		uname: event.uname,
		occurredAtMs: event.timestamp * 1000,
		price: event.rmb,
		message: event.message,
		startTimeMs: event.startTime * 1000,
		endTimeMs: event.endTime * 1000,
		guardLevel: event.guardLevel,
		medalName: event.fansMedalName,
		medalLevel: event.fansMedalLevel,
	};
}

export function normalizeWebSuperChat(event: SuperChatEvent): CanonicalLiveSuperChat {
	return {
		kind: "superChat",
		eventId: String(event.id),
		uid: event.uid,
		uname: event.uname,
		occurredAtMs: event.timestamp,
		price: event.price,
		message: String(event.message),
		startTimeMs: event.startTime,
		endTimeMs: event.endTime,
		guardLevel: event.guardLevel,
		medalName: event.medalName,
		medalLevel: event.medalLevel,
	};
}
