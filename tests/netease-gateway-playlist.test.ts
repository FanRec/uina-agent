import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NeteaseGateway, NeteaseUncertainWriteError } from "../.uina/worlds/netease-jukebox/netease-gateway.js";

/**
 * 真实歌单响应的脱敏副本：232 首、单首 55 字段，未投影时约 336 KB。
 *
 * 不手工构造精简对象，是因为"投影后到底多小"只有在真实字段密度上才有意义：
 * 手写的三字段假数据会让任何投影都显得足够小，测不出回归。
 */
const playlistDetail = JSON.parse(
	readFileSync(new URL("./fixtures/netease-playlist-detail.json", import.meta.url), "utf8"),
) as { code: number; playlist: { id: number; trackCount: number; trackIds: { id: number }[] } };
const TRACK_IDS = playlistDetail.playlist.trackIds.map((entry) => String(entry.id));
const RAW_BYTES = Buffer.byteLength(JSON.stringify(playlistDetail));

function serve(body: unknown): void {
	// 每次调用都要新建 Response：同一个实例的 body 只能读一次，翻页测试会在第二次请求炸掉。
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

const viewGateway = () => new NeteaseGateway("http://netease.test");

describe("NeteaseGateway playlist writes", () => {
	afterEach(() => vi.restoreAllMocks());

	it("uses the dedicated add endpoint", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
		await new NeteaseGateway("http://netease.test").addToPlaylist("p1", "s1");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/playlist_track_add");
	});

	it("falls back to playlist_tracks when the dedicated endpoint is missing", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("missing", { status: 404 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
		await new NeteaseGateway("http://netease.test").removeFromPlaylist("p1", "s1");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/playlist_tracks");
	});

	it("does not fall back to a second POST after an uncertain 5xx write", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gateway error", { status: 502 }));

		await expect(new NeteaseGateway("http://netease.test").addToPlaylist("p1", "s1")).rejects.toBeInstanceOf(
			NeteaseUncertainWriteError,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/playlist_track_add");
	});

	it("wraps uncertain POST failures (timeout) as effect-unknown", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("网易云请求超时"));
		await expect(new NeteaseGateway("http://netease.test").createPlaylist("list", "public")).rejects.toBeInstanceOf(
			NeteaseUncertainWriteError,
		);
	});

	it("wraps POST 5xx as effect-unknown instead of throwing a bare error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
		await expect(new NeteaseGateway("http://netease.test").addToPlaylist("p1", "s1")).rejects.toBeInstanceOf(
			NeteaseUncertainWriteError,
		);
	});

	it("keeps GET failures as plain errors", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
		await expect(new NeteaseGateway("http://netease.test").accountStatus()).rejects.not.toBeInstanceOf(
			NeteaseUncertainWriteError,
		);
	});

	it("retries transient GET failures once but does not retry client errors", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
		await expect(new NeteaseGateway("http://netease.test").accountStatus()).resolves.toMatchObject({ code: 200 });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockClear();
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		await expect(new NeteaseGateway("http://netease.test").accountStatus()).rejects.toThrow("HTTP 401");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("NeteaseGateway playlist view", () => {
	afterEach(() => vi.restoreAllMocks());

	it("projects one page of a real 232-track response to a fraction of its size", async () => {
		serve(playlistDetail);

		const view = await viewGateway().playlistView(String(playlistDetail.playlist.id), 0, 50);

		expect(view).toMatchObject({
			id: String(playlistDetail.playlist.id),
			declaredTotal: 232,
			playableTotal: 232,
			missing: 0,
		});
		expect(view.tracks).toHaveLength(50);
		expect(view.paging).toEqual({ offset: 0, limit: 50, returned: 50, hasMore: true, nextOffset: 50 });

		const body = Buffer.byteLength(JSON.stringify(view));
		expect(body).toBeLessThan(10 * 1024);
		// 上游那份 565 KB 的响应里有 privileges、每首 55 字段；投影把它压到一页几 KB。
		expect(RAW_BYTES / body).toBeGreaterThan(20);
		// 被丢掉的不是"少给几个字段"，是整类与播放无关的对象。
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("privileges");
		expect(serialized).not.toContain('"fee"');
		expect(serialized).not.toContain('"h":{"br"');
	});

	it("pages through every track exactly once in upstream order", async () => {
		serve(playlistDetail);
		const gateway = viewGateway();

		const seen: string[] = [];
		let offset: number | null = 0;
		for (let pages = 0; offset !== null && pages < 10; pages++) {
			const page = await gateway.playlistView(String(playlistDetail.playlist.id), offset, 50);
			seen.push(...page.tracks.map((track) => track.id));
			offset = page.paging.nextOffset;
		}

		// 不重不漏：既不能靠运气凑够数量，也要与上游顺序一致，否则"第 37 首"失去意义。
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual(TRACK_IDS);
	});

	it("keeps a whole projected playlist inside a single tool result", async () => {
		serve(playlistDetail);

		// 绕过分页一次取全：证明"整张歌单"本身也不需要截断。
		const view = await viewGateway().playlistView(String(playlistDetail.playlist.id), 0, 1000);

		expect(view.tracks).toHaveLength(232);
		expect(view.paging).toMatchObject({ hasMore: false, nextOffset: null });
		expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(50 * 1024);
	});

	it("returns an empty final page instead of repeating the last one", async () => {
		serve(playlistDetail);

		const view = await viewGateway().playlistView(String(playlistDetail.playlist.id), 232, 50);

		// 调用方按 nextOffset 翻页，翻过尾还必须停下来，否则就是无限循环。
		expect(view.tracks).toEqual([]);
		expect(view.paging).toEqual({ offset: 232, limit: 50, returned: 0, hasMore: false, nextOffset: null });
	});

	it("reports a declared/playable gap instead of fabricating the missing tracks", async () => {
		serve({
			code: 200,
			playlist: {
				id: 7,
				name: "Half",
				trackCount: 5,
				trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
				tracks: [
					{ id: 1, name: "A", ar: [{ name: "X" }] },
					{ id: 2, name: "B", ar: [{ name: "X" }] },
					{ id: 3, name: "C", ar: [{ name: "X" }] },
				],
			},
		});

		const view = await viewGateway().playlistView("7", 0, 50);

		expect(view).toMatchObject({ declaredTotal: 5, playableTotal: 3, missing: 2 });
		expect(view.tracks.map((track) => track.id)).toEqual(["1", "2", "3"]);
		// 翻页必须按实际曲目数算：按 trackCount 算会指向一个不存在的页，空页却报 hasMore。
		expect(view.paging).toEqual({ offset: 0, limit: 50, returned: 3, hasMore: false, nextOffset: null });
	});

	it("survives a response whose tracks are missing entirely", async () => {
		serve({ code: 200, playlist: { id: 9, name: "Empty", trackCount: 3, tracks: null } });

		const view = await viewGateway().playlistView("9");

		expect(view).toMatchObject({ declaredTotal: 3, playableTotal: 0, missing: 3, tracks: [] });
		expect(view.paging).toMatchObject({ returned: 0, hasMore: false, nextOffset: null });
	});

	it("still hands the write path every track id, including those past the first page", async () => {
		serve(playlistDetail);

		// 投影只作用于读路径。写后校验靠 trackIds 全量比对，若这里被截断，
		// "加入歌单"成功后会被判成未达预期，变成一次无谓的 unknown。
		const playlist = await viewGateway().playlistForWrite(String(playlistDetail.playlist.id));

		expect(playlist?.trackIds).toHaveLength(232);
		expect(playlist?.trackIds).toEqual(TRACK_IDS);
	});

	it("does not treat someone else's public playlist as writable", async () => {
		serve(playlistDetail);

		// 这份真实响应是别人的公开歌单：privacy 为 0，且不下发 editable。
		const playlist = await viewGateway().playlistForWrite(String(playlistDetail.playlist.id));

		expect(playlist).toMatchObject({ ownerId: "434291965", editable: false });
	});
});
