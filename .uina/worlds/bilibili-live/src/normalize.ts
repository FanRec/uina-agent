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

export type LiveActor = {
	kind: "uid" | "openId";
	value: string;
	name: string;
};

export type LiveEvent = {
	protocol: "web" | "openlive";
	eventId: string;
	kind: "danmaku" | "gift" | "superChat" | "guard";
	actor: LiveActor;
	occurredAtMs: number;
	payload: Record<string, unknown>;
};

export function normalizeWebDanmaku(event: DanmakuEvent): LiveEvent {
	return {
		protocol: "web", eventId: event.id, kind: "danmaku",
		actor: { kind: "uid", value: String(event.uid), name: event.uname },
		occurredAtMs: event.timestamp, payload: { text: event.text },
	};
}

export function normalizeOpenDanmaku(event: OpenDanmakuEvent): LiveEvent {
	return {
		protocol: "openlive", eventId: event.msgId, kind: "danmaku",
		actor: { kind: "openId", value: event.openId, name: event.uname },
		occurredAtMs: event.timestamp * 1000, payload: { text: event.msg },
	};
}

export function normalizeWebGuard(event: GuardBuyEvent): LiveEvent {
	return {
		protocol: "web", eventId: `guard:${event.uid}:${event.timestamp}`,
		kind: "guard", actor: { kind: "uid", value: String(event.uid), name: event.uname },
		occurredAtMs: event.timestamp, payload: { guardLevel: event.guardLevel, giftName: event.giftName },
	};
}

export function normalizeOpenGuard(event: OpenGuardBuyEvent): LiveEvent {
	return {
		protocol: "openlive", eventId: event.msgId, kind: "guard",
		actor: { kind: "openId", value: event.userInfo.openId, name: event.userInfo.uname },
		occurredAtMs: event.timestamp * 1000,
		payload: { guardLevel: event.guardLevel, giftName: event.guardUnit, count: event.guardNum },
	};
}

export function normalizeWebGift(event: GiftEvent): LiveEvent {
	return {
		protocol: "web",
		eventId: event.id,
		kind: "gift",
		actor: { kind: "uid", value: String(event.uid), name: event.uname },
		occurredAtMs: event.timestamp,
		payload: {
			giftId: event.giftId,
			giftName: event.giftName,
			count: event.count,
			price: event.price,
			// 与 parseGift 缺省语义一致：仅显式银瓜子视为免费礼物
			paid: event.coinType !== "silver",
			guardLevel: event.guardLevel,
			medalName: event.medalName,
			medalLevel: event.medalLevel,
		},
	};
}

export function normalizeOpenGift(event: OpenGiftEvent): LiveEvent {
	return {
		protocol: "openlive",
		eventId: event.msgId,
		kind: "gift",
		actor: { kind: "openId", value: event.openId, name: event.uname },
		occurredAtMs: event.timestamp * 1000,
		payload: {
			giftId: event.giftId,
			giftName: event.giftName,
			count: event.giftNum,
			price: event.rPrice,
			paid: event.paid,
			guardLevel: event.guardLevel,
			medalName: event.fansMedalName,
			medalLevel: event.fansMedalLevel,
		},
	};
}

export function normalizeOpenSuperChat(event: OpenSuperChatEvent): LiveEvent {
	return {
		protocol: "openlive",
		eventId: event.msgId || String(event.messageId),
		kind: "superChat",
		actor: { kind: "openId", value: event.openId, name: event.uname },
		occurredAtMs: event.timestamp * 1000,
		payload: {
			price: event.rmb,
			message: event.message,
			startTimeMs: event.startTime * 1000,
			endTimeMs: event.endTime * 1000,
		},
	};
}

export function normalizeWebSuperChat(event: SuperChatEvent): LiveEvent {
	return {
		protocol: "web",
		eventId: String(event.id),
		kind: "superChat",
		actor: { kind: "uid", value: String(event.uid), name: event.uname },
		occurredAtMs: event.timestamp,
		payload: {
			price: event.price,
			message: String(event.message),
			startTimeMs: event.startTime,
			endTimeMs: event.endTime,
		},
	};
}
