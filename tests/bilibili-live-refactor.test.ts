import { describe, expect, it } from "vitest";
import {
	normalizeOpenGift,
	normalizeOpenSuperChat,
	normalizeWebGift,
	} from "../.uina/worlds/bilibili-live/src/normalize.js";

describe("bilibili live canonical event boundary", () => {
	it("normalizes web and OpenLive gift identities without losing source semantics", () => {
		const web = normalizeWebGift({
			id: "web-1",
			uid: 42,
			uname: "web-user",
			giftId: 7,
			giftName: "flower",
			count: 2,
			price: 100,
			coinType: "gold",
			action: "赠送",
			timestamp: 1_700_000_000_000,
		});
		const open = normalizeOpenGift({
			roomId: 1,
			openId: "open-user",
			uname: "open-user-name",
			uface: "",
			giftId: 7,
			giftName: "flower",
			giftNum: 2,
			price: 100,
			rPrice: 100,
			paid: true,
			guardLevel: 0,
			timestamp: 1_700_000_000,
			msgId: "open-1",
			giftIcon: "",
			comboGift: false,
		});

		expect(web.actor).toEqual({ kind: "uid", value: "42", name: "web-user" });
		expect(open.actor).toEqual({ kind: "openId", value: "open-user", name: "open-user-name" });
		expect(open.occurredAtMs).toBe(1_700_000_000_000);
		expect(web.eventId).toBe("web-1");
		expect(open.eventId).toBe("open-1");
	});

	it("normalizes OpenLive super chat message fields", () => {
		const event = normalizeOpenSuperChat({
			roomId: 1,
			openId: "open-user",
			uname: "user",
			uface: "",
			messageId: 9,
			message: "hello",
			rmb: 30,
			timestamp: 1_700_000_000,
			startTime: 1_700_000_000,
			endTime: 1_700_001_000,
			guardLevel: 0,
			msgId: "sc-1",
		});
		expect(event.eventId).toBe("sc-1");
		expect(event.actor.value).toBe("open-user");
		expect(event.payload).toMatchObject({ price: 30, message: "hello" });
		expect(event.occurredAtMs).toBe(1_700_000_000_000);
	});
});
