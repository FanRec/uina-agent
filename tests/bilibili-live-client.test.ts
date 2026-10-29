import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BilibiliLiveClient, fetchUserId } from "../.uina/worlds/bilibili-live/src/blivedm-ts/client.js";
import type { DanmakuEvent, GiftEvent } from "../.uina/worlds/bilibili-live/src/blivedm-ts/events.js";
import { USER_AGENT } from "../.uina/worlds/bilibili-live/src/blivedm-ts/wbi.js";
import { LiveEventBuffer } from "../.uina/worlds/bilibili-live/src/buffer.js";
import { loadConfig } from "../.uina/worlds/bilibili-live/src/config.js";
import { LiveEventIngestion } from "../.uina/worlds/bilibili-live/src/live-event-ingestion.js";

let tempDir: string | undefined;

afterEach(() => {
	vi.unstubAllGlobals();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

// SendGiftBroadcast: uid 1001, 主播铁粉, 舰长, 真爱粉 Lv15; two gift_list items.
const SEND_GIFT_V2_PB =
	"COkHEgzkuLvmkq3pk4HnsokoA0INKA8yCeecn+eIseeyiVI0CAESCeWwj+W/g+W/gxgDKGQ4rAJCBGdvbGRKCWhlYXJ0LXRpZFCA4s+qBpIBBui1oOmAgVIrCAISCeWwj+iKseiKsRgBKGQ4ZEIEZ29sZEoKZmxvd2VyLXRpZFCB4s+qBg==";
// Same broadcast without price: total_coin / num must still yield a unit price of 100.
const SEND_GIFT_V2_TOTAL_COIN_PB =
	"COkHEgzkuLvmkq3pk4HnsokoA0INKA8yCeecn+eIseeyiVIyCAESCeWwj+W/g+W/gxgDOKwCQgRnb2xkSgloZWFydC10aWRQgOLPqgaSAQbotaDpgIFSKQgCEgnlsI/oirHoirEYAThkQgRnb2xkSgpmbG93ZXItdGlkUIHiz6oG";

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
		const gifts: GiftEvent[] = [];
		const danmakus: DanmakuEvent[] = [];
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
					coin_type: "gold",
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
					coin_type: "gold",
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

	it.each([
		["price", SEND_GIFT_V2_PB],
		["total_coin", SEND_GIFT_V2_TOTAL_COIN_PB],
	])("decodes Protobuf SEND_GIFT_V2 with %s and renders its senders", async (_priceSource, pb) => {
		tempDir = mkdtempSync(join(tmpdir(), "uina-gift-v2-"));
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const config = loadConfig({ storage: { dataDir: tempDir } });
		const buffer = new LiveEventBuffer(config);
		const ingestion = new LiveEventIngestion(
			config,
			buffer,
			() => undefined,
			() => undefined,
		);
		const gifts: GiftEvent[] = [];
		client.on("gift", (gift) => gifts.push(gift));
		ingestion.replace(client);

		client.handleBusinessMessage({
			header: {} as any,
			body: { cmd: "SEND_GIFT_V2", data: { pb } },
		});

		expect(gifts).toHaveLength(2);
		expect(gifts[0]).toMatchObject({
			id: "heart-tid",
			uid: 1001,
			uname: "主播铁粉",
			giftId: 1,
			giftName: "小心心",
			count: 3,
			price: 100,
			coinType: "gold",
			timestamp: 1_700_000_000_000,
		});
		expect(gifts[1]).toMatchObject({
			id: "flower-tid",
			uid: 1001,
			uname: "主播铁粉",
			giftId: 2,
			giftName: "小花花",
			count: 1,
			price: 100,
			coinType: "gold",
			timestamp: 1_700_000_001_000,
		});
		expect(buffer.drainQuietTransientGifts(0, performance.now())).toEqual([
			'* <user name="主播铁粉" uid="1001" identity="舰长" medal="真爱粉Lv15"/> 赠送 小心心 x3',
			'* <user name="主播铁粉" uid="1001" identity="舰长" medal="真爱粉Lv15"/> 赠送 小花花 x1',
		]);

		await ingestion.stop();
		buffer.dispose();
	});

	it.each([
		["invalid base64", "!"],
		["truncated varint", "CIA="],
		["truncated gift item", SEND_GIFT_V2_PB.slice(0, -4)],
		["missing sender uid", Buffer.from(SEND_GIFT_V2_PB, "base64").subarray(3).toString("base64")],
		["invalid UTF-8", "COkHEgH/"],
		[
			"wrong gift_list wire type",
			Buffer.concat([Buffer.from(SEND_GIFT_V2_PB, "base64"), Buffer.from([0x50, 1])]).toString("base64"),
		],
	])("rejects the whole V2 batch with %s", (_reason, pb) => {
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const gifts: GiftEvent[] = [];
		const errors: Error[] = [];
		client.on("gift", (gift) => gifts.push(gift));
		client.on("error", (error) => errors.push(error));

		client.handleBusinessMessage({ header: {} as any, body: { cmd: "SEND_GIFT_V2", data: { pb } } });

		expect(gifts).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("SEND_GIFT_V2 parse failed");
	});

	it("propagates gift listener failures without misreporting them as parsing errors", () => {
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const onError = vi.fn();
		client.on("error", onError);
		client.on("gift", () => {
			throw new Error("journal write failed");
		});

		expect(() =>
			client.handleBusinessMessage({
				header: {} as any,
				body: { cmd: "SEND_GIFT_V2", data: { pb: SEND_GIFT_V2_PB } },
			}),
		).toThrow("journal write failed");
		expect(onError).not.toHaveBeenCalled();
	});

	it("uses non-empty nested sender_uinfo values when legacy top-level fields are placeholders", () => {
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const gifts: GiftEvent[] = [];
		client.on("gift", (gift) => gifts.push(gift));

		client.handleBusinessMessage({
			header: {} as any,
			body: {
				cmd: "SEND_GIFT_V2",
				data: {
					uid: 0,
					uname: "",
					sender_uinfo: { uid: 2002, base: { name: "嵌套昵称" } },
					gift_id: 7,
					gift_name: "小花花",
					num: 2,
					price: 100,
					coin_type: "gold",
					tid: "nested-sender-gift",
				},
			},
		});

		expect(gifts).toHaveLength(1);
		expect(gifts[0]).toMatchObject({ uid: 2002, uname: "嵌套昵称", giftId: 7, giftName: "小花花", count: 2 });
	});

	it("rejects malformed gift payloads instead of emitting uid 0 and a fake x1", () => {
		const client = new BilibiliLiveClient({ roomId: 24194689 });
		const gifts: GiftEvent[] = [];
		const errors: Error[] = [];
		client.on("gift", (gift) => gifts.push(gift));
		client.on("error", (error) => errors.push(error));

		client.handleBusinessMessage({
			header: {} as any,
			body: { cmd: "SEND_GIFT_V2", data: { pb: "AA==" } },
		});
		client.handleBusinessMessage({
			header: {} as any,
			body: { cmd: "SEND_GIFT", data: { uid: 0, uname: "", gift_id: 0, gift_name: "", num: 0 } },
		});

		expect(gifts).toEqual([]);
		expect(errors).toHaveLength(2);
		expect(errors[0].message).toContain("SEND_GIFT_V2 parse failed");
		expect(errors[1].message).toContain("SEND_GIFT parse failed");
	});
});
