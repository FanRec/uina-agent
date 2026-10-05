import { describe, expect, it } from "vitest";
import {
	normalizeOpenGift,
	normalizeOpenGuard,
	normalizeOpenSuperChat,
	normalizeWebGift,
} from "../.uina/worlds/bilibili-live/src/normalize.js";

describe("bilibili live canonical event boundary", () => {
	it("normalizes web and OpenLive gift identities into top-level domain fields", () => {
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
			price: 10, // 10 电池
			rPrice: 100,
			paid: true,
			guardLevel: 0,
			timestamp: 1_700_000_000,
			msgId: "open-1",
			giftIcon: "",
			comboGift: false,
		});

		expect(web.uid).toBe(42);
		expect(web.uname).toBe("web-user");
		expect(web.price).toBe(100);

		expect(open.uid).toBe("open-user");
		expect(open.uname).toBe("open-user-name");
		// 10 电池按 1 电池 = 100 金瓜子转换为规范领域面值 1000 金瓜子（￥1）
		expect(open.price).toBe(1000);
		expect(open.occurredAtMs).toBe(1_700_000_000_000);
		expect(web.eventId).toBe("web-1");
		expect(open.eventId).toBe("open-1");
	});

	it("normalizes OpenLive super chat into clean top-level fields", () => {
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
		expect(event.uid).toBe("open-user");
		expect(event.uname).toBe("user");
		expect(event.price).toBe(30);
		expect(event.message).toBe("hello");
		expect(event.occurredAtMs).toBe(1_700_000_000_000);
	});

	it("maps OpenLive guard title properly instead of using unit string", () => {
		const event = normalizeOpenGuard({
			roomId: 1,
			userInfo: { openId: "open-user", uname: "captain", uface: "" },
			guardLevel: 3,
			guardNum: 2,
			guardUnit: "月",
			msgId: "guard-1",
			timestamp: 1_700_000_000,
		});
		expect(event.eventId).toBe("guard-1");
		expect(event.uid).toBe("open-user");
		expect(event.uname).toBe("captain");
		expect(event.guardLevel).toBe(3);
		expect(event.giftName).toBe("舰长");
		expect(event.count).toBe(2);
	});
});
