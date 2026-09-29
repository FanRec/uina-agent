import { afterEach, describe, expect, it, vi } from "vitest";
import { BilibiliLiveClient, fetchUserId } from "../.uina/worlds/bilibili-live/src/blivedm-ts/client.js";
import { USER_AGENT } from "../.uina/worlds/bilibili-live/src/blivedm-ts/wbi.js";

afterEach(() => vi.unstubAllGlobals());

describe("BilibiliLiveClient initialization failures", () => {
	it("preserves the original room API error for the reconnect layer", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("room API unavailable"); }));
		const client = new BilibiliLiveClient({ roomId: 24194689 });

		await expect(client.initRoom()).rejects.toThrow("room API unavailable");
	});
});

describe("BilibiliLiveClient WebSocket handshake", () => {
	it("sends the User-Agent that signs the danmaku token", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("room API unavailable"); }));
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
				return response({ code: 0, data: { token: "token", host_list: [{ host: "example", port: 2243, wss_port: 443, ws_port: 2244 }] } });
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
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: -101 }) })));
		expect(await fetchUserId()).toBe(0);
		expect(await fetchUserId("session")).toBe(0);
	});
});