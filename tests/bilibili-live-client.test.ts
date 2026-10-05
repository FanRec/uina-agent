import { afterEach, describe, expect, it, vi } from "vitest";
import { BilibiliLiveClient, fetchUserId } from "../.uina/worlds/bilibili-live/src/blivedm-ts/client.js";
import { USER_AGENT } from "../.uina/worlds/bilibili-live/src/blivedm-ts/wbi.js";

afterEach(() => vi.unstubAllGlobals());

describe("BilibiliLiveClient initialization failures", () => {
	it("preserves the original room API error for the reconnect layer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("room API unavailable");
			}),
		);
		const client = new BilibiliLiveClient({ roomId: 24194689 });

		await expect(client.initRoom()).rejects.toThrow("room API unavailable");
	});
});

describe("BilibiliLiveClient WebSocket handshake", () => {
	it("sends the User-Agent that signs the danmaku token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("room API unavailable");
			}),
		);
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const expectedHeaders = { "User-Agent": USER_AGENT };

		expect((client as any).options.handshakeHeaders).toEqual(expectedHeaders);
	});
});
describe("BilibiliLiveClient authenticated uid", () => {
	it("uses the logged-in mid in the auth packet instead of uid 0", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
			if (url === "https://api.bilibili.com/x/web-interface/nav") {
				return response({
					code: 0,
					data: {
						isLogin: true,
						mid: 34194689,
						wbi_img: { img_url: "https://example.com/img-key.png", sub_url: "https://example.com/sub-key.png" },
					},
				});
			}
			if (url === "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo") {
				return response({
					code: 0,
					data: { token: "token", host_list: [{ host: "example", port: 2243, wss_port: 443, ws_port: 2244 }] },
				});
			}
			return response({ code: 0, data: { room_id: 24194689, short_id: 0, uid: 1, live_status: 0, title: "" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchUserId("session")).toBe(34194689);
		const client = new BilibiliLiveClient({ roomId: 24194689, sessdata: "session" });
		await client.initRoom();
		expect(await fetchUserId("session")).toBe(34194689);
		const sendPacket = vi.fn();
		(client as any).sendPacket = sendPacket;
		client.sendAuth();
		const payload = JSON.parse(sendPacket.mock.calls[0][1]);
		expect(payload.uid).toBe(34194689);
	});

	it("falls back to uid 0 when SESSDATA is not logged in", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: -101 }) })),
		);
		expect(await fetchUserId()).toBe(0);
		expect(await fetchUserId("session")).toBe(0);
	});
});

describe("BilibiliLiveClient handleBusinessMessage command dispatching", () => {
	it("dispatches SEND_GIFT_V2 and colon-suffixed commands", () => {
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const gifts: any[] = [];
		const danmakus: any[] = [];
		client.on("gift", (g) => gifts.push(g));
		client.on("danmaku", (d) => danmakus.push(d));

		// SEND_GIFT_V2
		client.handleBusinessMessage({
			header: {} as any,
			body: {
				cmd: "SEND_GIFT_V2",
				data: {
					uid: 1001,
					uname: "测试用户",
					gift_id: 31036,
					gift_name: "小花花",
					num: 5,
					price: 100,
					tid: "tid-v2-1",
				},
			},
		});

		// SEND_GIFT:1 (with colon parameter)
		client.handleBusinessMessage({
			header: {} as any,
			body: {
				cmd: "SEND_GIFT:1",
				data: {
					uid: 1002,
					uname: "老板",
					giftId: 20001,
					giftName: "辣条",
					num: 1,
					price: 100,
					tid: "tid-colon-2",
				},
			},
		});

		// DANMU_MSG:4:0:2:2:2:0
		client.handleBusinessMessage({
			header: {} as any,
			body: {
				cmd: "DANMU_MSG:4:0:2:2:2:0",
				info: [[0, 1, 25, 16777215, 1728000000, 123456], "这是一条带后缀的弹幕", [1003, "弹幕姬"]],
			},
		});

		expect(gifts).toHaveLength(2);
		expect(gifts[0].giftName).toBe("小花花");
		expect(gifts[0].count).toBe(5);
		expect(gifts[0].id).toBe("tid-v2-1");
		expect(gifts[1].giftName).toBe("辣条");
		expect(gifts[1].id).toBe("tid-colon-2");

		expect(danmakus).toHaveLength(1);
		expect(danmakus[0].text).toBe("这是一条带后缀的弹幕");
		expect(danmakus[0].uname).toBe("弹幕姬");
	});
});
