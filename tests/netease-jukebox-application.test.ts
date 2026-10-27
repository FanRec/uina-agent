import { describe, expect, it, vi } from "vitest";
import { NeteaseRequestError } from "../.uina/worlds/netease-jukebox/api-client.js";
import { JukeboxApplication } from "../.uina/worlds/netease-jukebox/application.js";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import { SimulatedMusicPlayer } from "../.uina/worlds/netease-jukebox/player.js";

const song = { id: "1", name: "Song 1", artists: ["Artist"], durationMs: 1000 };
const playlistTracks = [
	song,
	{ id: "2", name: "Song 2", artists: ["Artist"], durationMs: 1000 },
	{ id: "3", name: "Song 3", artists: ["Artist"], durationMs: 1000 },
];

function makeApplication(queueLimit = 100) {
	const playback = new PlaybackCoordinator(new SimulatedMusicPlayer(), queueLimit);
	playback.setLoader(async (track) => ({ url: `simulated://${track.id}`, song: track }));
	const api = {
		searchSongs: vi.fn(async () => [song]),
		getSongInfo: vi.fn(async () => song),
		getSongInfos: vi.fn(async (ids: readonly string[]) => playlistTracks.filter((track) => ids.includes(track.id))),
		getSongUrl: vi.fn(async () => "https://audio.test/song"),
		getLyrics: vi.fn(async () => null),
	};
	const gateway = {
		// 与 /login/status 的真实返回一致：body 包在 data 下，uid 在 account.id。
		accountStatus: vi.fn(async () => ({
			data: { code: 200, account: { id: 42 }, profile: { userId: 42 } },
		})),
		playlistForWrite: vi.fn(async () => ({
			id: "p1",
			name: "Playlist",
			ownerId: "42",
			editable: true,
			trackIds: ["1"],
			description: "原来的简介",
			tags: ["民谣", "ACG"],
		})),
		// 与真实实现同构地切片，否则分页参数一路透传下去也测不出来。
		playlistView: vi.fn(async (_id: string, offset = 0, limit = 50) => {
			const page = playlistTracks.slice(offset, offset + limit);
			const nextOffset = offset + page.length;
			const hasMore = nextOffset < playlistTracks.length;
			return {
				id: "p1",
				name: "Playlist",
				creator: "Owner",
				declaredTotal: playlistTracks.length,
				playableTotal: playlistTracks.length,
				missing: 0,
				tracks: page,
				paging: { offset, limit, returned: page.length, hasMore, nextOffset: hasMore ? nextOffset : null },
			};
		}),
		likedSongIds: vi.fn(async () => ["1", "2", "3"]),
		playlists: vi.fn(async () => []),
		recentSongs: vi.fn(async () => []),
		addToPlaylist: vi.fn(async () => ({ code: 200 })),
		removeFromPlaylist: vi.fn(async () => ({ code: 200 })),
		updatePlaylist: vi.fn(async () => ({ code: 200 })),
	};
	const ensureService = vi.fn(async () => ({ running: true }));
	const application = new JukeboxApplication({
		api: api as never,
		gateway: gateway as never,
		playback,
		ensureService,
	});
	return { application, api, gateway, playback, ensureService };
}

describe("JukeboxApplication", () => {
	it("rejects the removed list_order playback mode", async () => {
		const { application } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };

		const result = await application.actions.playback.run({ operation: "mode", mode: "list_order" }, ctx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "invalid_mode" } });
	});

	it("resolves a search ref for playlist track writes", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		await application.actions.search.run({ query: "song" }, ctx);
		const result = await application.actions.library.run(
			{ operation: "playlist_track_add", playlist_id: "p1", ref: "song:1", confirm: true },
			ctx,
		);
		expect(result).toMatchObject({ status: "succeeded" });
		expect(gateway.addToPlaylist).toHaveBeenCalledWith("p1", "1", ctx.signal);
	});

	it("uses the logged-in account when no uid is given", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };

		await application.actions.library.run({ operation: "playlist_list" }, ctx);

		// uid 解析不出来时这条路径会在调用 gateway 之前就失败，所以"调用到"本身就是断言。
		expect(gateway.playlists).toHaveBeenCalledWith("42", ctx.signal);
	});

	it("refuses a write to another account's playlist", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		(gateway.playlistForWrite as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			id: "p2",
			name: "别人的",
			ownerId: "999",
			editable: false,
			trackIds: [],
		});

		const result = await application.actions.library.run(
			{ operation: "playlist_track_add", playlist_id: "p2", song_id: "1", confirm: true },
			ctx,
		);

		expect(result).toMatchObject({ status: "failed", details: { reason: "playlist_not_editable" } });
		expect(gateway.addToPlaylist).not.toHaveBeenCalled();
	});

	it("verifies a removal against the playlist read back after writing", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		// 写前有这首、写后没有——校验要按"移除后不该包含"来判断，方向反了会把成功报成 unknown。
		(gateway.playlistForWrite as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				id: "p1",
				name: "Playlist",
				ownerId: "42",
				editable: true,
				trackIds: ["1"],
				description: "",
				tags: [],
			})
			.mockResolvedValueOnce({
				id: "p1",
				name: "Playlist",
				ownerId: "42",
				editable: true,
				trackIds: [],
				description: "",
				tags: [],
			});

		const result = await application.actions.library.run(
			{ operation: "playlist_track_remove", playlist_id: "p1", song_id: "1", confirm: true },
			ctx,
		);

		expect(gateway.removeFromPlaylist).toHaveBeenCalledWith("p1", "1", ctx.signal);
		expect(result).toMatchObject({ status: "succeeded" });
		expect(String(result.result)).toContain("已从歌单移除");
	});

	it("does not call an external write without confirmation", async () => {
		const { application, gateway, ensureService } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		const result = await application.actions.library.run(
			{ operation: "playlist_track_remove", playlist_id: "p1", song_id: "1" },
			ctx,
		);
		expect(result).toMatchObject({ status: "failed", details: { reason: "confirmation_required" } });
		expect(gateway.removeFromPlaylist).not.toHaveBeenCalled();
		expect(ensureService).not.toHaveBeenCalled();
	});

	it("fills the fields a playlist update does not mention instead of clearing them", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		await application.actions.library.run(
			{ operation: "playlist_update", playlist_id: "p1", name: "New", tags: "rock", confirm: true },
			ctx,
		);
		// 上游三个字段一起提交、缺省即清空：没提简介就必须把原简介带上，否则改名会顺手清空简介。
		expect(gateway.updatePlaylist).toHaveBeenCalledWith("p1", "New", "原来的简介", "rock", ctx.signal);
	});

	it("clears the queue only after a successful replace_queue play", async () => {
		const { application, playback } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
		playback.add({ id: "0", name: "Old", artists: [], durationMs: null });

		const result = await application.actions.play.run({ song_id: "1", replace_queue: true }, ctx);

		expect(result).toMatchObject({ status: "succeeded" });
		expect(playback.snapshot()).toMatchObject({ currentSong: { id: "1" }, queue: [] });
	});

	it("preserves the queue when a replace_queue play fails to load", async () => {
		const { application, playback } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
		playback.add({ id: "0", name: "Old", artists: [], durationMs: null });
		playback.setLoader(async () => {
			throw new Error("网易云未返回该歌曲的播放地址（通常为 VIP 或版权限制）");
		});

		const result = await application.actions.play.run({ song_id: "1", replace_queue: true }, ctx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "playback_failed" } });
		expect(String(result.result)).toContain("VIP 或版权限制");
		expect(playback.snapshot().queue).toHaveLength(1);
	});

	it("keeps stable song refs valid across later searches", async () => {
		const { application, api } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
		const first = await application.actions.search.run({ query: "song one" }, ctx);
		(api.searchSongs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ ...song, id: "2", name: "Song 2" }]);
		const second = await application.actions.search.run({ query: "song two" }, ctx);

		expect(String(first.result)).toContain("ref=song:1");
		expect(String(second.result)).toContain("ref=song:2");
		const earlier = await application.actions.play.run({ ref: "song:1" }, ctx);
		const later = await application.actions.play.run({ ref: "song:2" }, ctx);

		expect(earlier).toMatchObject({ status: "succeeded" });
		expect(later).toMatchObject({ status: "succeeded" });

		const invalid = await application.actions.play.run({ ref: "song:missing" }, ctx);

		expect(invalid).toMatchObject({ status: "failed", details: { reason: "invalid_ref" } });
		expect(String(invalid.result)).toContain("song:missing");

		const missing = await application.actions.play.run({}, ctx);
		expect(missing).toMatchObject({ status: "failed", details: { reason: "invalid_song" } });
		expect(String(missing.result)).toContain("必须提供 song_id、ref 或 query");
	});

	it("returns upstream retry exhaustion as structured failure instead of inviting another tool call", async () => {
		const { application, api } = makeApplication();
		(api.searchSongs as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new NeteaseRequestError("网易云搜索失败: HTTP 502", { status: 502, attempts: 2, retryable: true }),
		);
		const ctx = { operationIdentity: "world:jukebox/search" as const, signal: new AbortController().signal };

		const result = await application.actions.search.run({ query: "song" }, ctx);

		expect(result).toMatchObject({
			status: "failed",
			details: { reason: "upstream_unavailable", httpStatus: 502, attempts: 2, retryExhausted: true },
		});
		expect(String(result.result)).toContain("停止本轮重复请求");
	});

	it("previous restarts the current song instead of faking a switch after 5 seconds", async () => {
		vi.useFakeTimers();
		try {
			const { application, api, playback } = makeApplication();
			const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
			const longSong = { ...song, id: "9", durationMs: 600000 };
			(api.getSongInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(longSong);

			await application.actions.play.run({ song_id: "9" }, ctx);
			vi.advanceTimersByTime(6000);

			const result = await application.actions.playback.run({ operation: "previous" }, ctx);

			expect(result).toMatchObject({ status: "succeeded" });
			expect(String(result.result)).toContain("已回到歌曲开头");
			expect(playback.snapshot().positionMs).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails honestly instead of fabricating a placeholder when the song id is unknown", async () => {
		const { application, api } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
		(api.getSongInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

		const result = await application.actions.play.run({ song_id: "999" }, ctx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "song_not_found" } });
		expect(String(result.result)).toContain("999");
		expect(String(result.result)).not.toContain("未知歌手");
	});

	it("fails a query-based play when nothing matches", async () => {
		const { application, api } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/playback" as const, signal: new AbortController().signal };
		(api.searchSongs as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

		const result = await application.actions.play.run({ query: "nothing" }, ctx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "song_not_found" } });
	});
});

describe("JukeboxApplication playlist reads", () => {
	const library = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
	const queueCtx = { operationIdentity: "world:jukebox/queue" as const, signal: new AbortController().signal };

	it("enqueues a whole playlist from a single upstream request", async () => {
		const { application, api, gateway, playback } = makeApplication();

		const result = await application.actions.queue.run({ operation: "add", playlist_id: "p1" }, queueCtx);

		expect(result).toMatchObject({ status: "succeeded", details: { effectStatus: "applied", accepted: 3 } });
		expect(String(result.result)).toContain("已加入队列 3 首");
		expect(playback.snapshot().queue.map((item) => item.id)).toEqual(["1", "2", "3"]);
		// 只发一次歌单详情；逐首查详情就是另一条把上下文和时间一起烧掉的路径。
		expect(gateway.playlistView).toHaveBeenCalledWith("p1", 0, 200, queueCtx.signal);
		expect(api.getSongInfo).not.toHaveBeenCalled();
	});

	it("fills what fits and still reports the batch as a success", async () => {
		const { application, playback } = makeApplication(2);

		const result = await application.actions.queue.run({ operation: "add", playlist_id: "p1" }, queueCtx);

		// failed 会被序列化成 is_error，模型当成硬错误重试，在不去重的前提下等于重复入队。
		expect(result).toMatchObject({ status: "succeeded", details: { accepted: 2, skippedByCapacity: 1 } });
		expect(String(result.result)).toContain("有 1 首选到了但装不下");
		expect(playback.snapshot().queue).toHaveLength(2);
	});

	it("blames the limit, not the queue, when the caller asked for fewer songs", async () => {
		const { application, playback } = makeApplication(10);

		const result = await application.actions.queue.run({ operation: "add", playlist_id: "p1", limit: 1 }, queueCtx);

		expect(result).toMatchObject({
			status: "succeeded",
			details: { accepted: 1, skippedByCapacity: 0, notFetched: 2 },
		});
		expect(String(result.result)).toContain("还有 2 首没取");
		// 队列还有空位，此时让模型去 queue clear 就是错误建议。
		expect(String(result.result)).not.toContain("queue clear");
		expect(playback.snapshot().queue).toHaveLength(1);
	});

	it("refuses the whole playlist when the queue is already full", async () => {
		const { application, playback } = makeApplication(1);
		playback.add(song);

		const result = await application.actions.queue.run({ operation: "add", playlist_id: "p1" }, queueCtx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "queue_full" } });
		expect(String(result.result)).toContain("上限 1");
		expect(playback.snapshot().queue.map((item) => item.id)).toEqual(["1"]);
	});

	it("pages a playlist open instead of dumping the whole response", async () => {
		const { application, gateway } = makeApplication();

		const result = await application.actions.library.run(
			{ operation: "playlist_open", playlist_id: "p1", offset: 1, limit: 1 },
			library,
		);

		expect(gateway.playlistView).toHaveBeenCalledWith("p1", 1, 1, library.signal);
		const payload = JSON.parse(String(result.result));
		expect(payload.tracks.map((track: { id: string }) => track.id)).toEqual(["2"]);
		expect(payload.paging).toEqual({ offset: 1, limit: 1, returned: 1, hasMore: true, nextOffset: 2 });
	});

	it("falls back to the 50-item page default because Ajv does not apply schema defaults", async () => {
		const { application, gateway } = makeApplication();

		await application.actions.library.run({ operation: "playlist_open", playlist_id: "p1" }, library);

		expect(gateway.playlistView).toHaveBeenCalledWith("p1", 0, 50, library.signal);
	});

	it("expands liked ids into readable tracks", async () => {
		const { application, api, gateway } = makeApplication();

		const result = await application.actions.library.run({ operation: "liked_list", offset: 1, limit: 1 }, library);

		expect(gateway.likedSongIds).toHaveBeenCalledWith("42", library.signal);
		// 只补当前页的详情，不是把整份红心逐首查一遍。
		expect(api.getSongInfos).toHaveBeenCalledWith(["2"], library.signal);
		const payload = JSON.parse(String(result.result));
		expect(payload).toMatchObject({ total: 3, offset: 1, limit: 1, returned: 1, hasMore: true, nextOffset: 2 });
		expect(payload.tracks.map((track: { id: string }) => track.id)).toEqual(["2"]);
	});

	it("returns an empty page when the liked offset is past the end", async () => {
		const { application } = makeApplication();

		const result = await application.actions.library.run({ operation: "liked_list", offset: 5 }, library);

		// 翻到末尾之后不该报"还有更多"，也不该凭空造出曲目。
		const payload = JSON.parse(String(result.result));
		expect(payload).toMatchObject({ total: 3, offset: 5, returned: 0, tracks: [], hasMore: false, nextOffset: null });
	});

	it("still reports the liked total when the detail lookup fails", async () => {
		const { application, api } = makeApplication();
		(api.getSongInfos as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP 502"));

		const result = await application.actions.library.run({ operation: "liked_list" }, library);

		expect(result).toMatchObject({ status: "failed", details: { reason: "song_detail_unavailable", total: 3 } });
		expect(String(result.result)).toContain("红心共 3 首");
		// 第一段已经拿到的那个事实不该跟着丢，也不该被说成"没有红心歌曲"。
		expect(String(result.result)).not.toContain("没有红心");
	});

	it("reports a full queue for a single-song add instead of throwing", async () => {
		const { application, playback } = makeApplication(1);
		playback.add({ id: "0", name: "Old", artists: [], durationMs: null });

		const result = await application.actions.queue.run({ operation: "add", song_id: "1" }, queueCtx);

		expect(result).toMatchObject({ status: "failed", details: { reason: "queue_full", songId: "1" } });
		expect(String(result.result)).toContain("上限 1");
		// 异常本身已经说了上限，外面不该再套一层"队列已满：队列已满（上限 1）"。
		expect(String(result.result)).not.toContain("队列已满：播放队列已满");
		expect(playback.snapshot().queue).toHaveLength(1);
	});

	it("clamps the unprojected list reads to 20 items so they cannot flood the context", async () => {
		const { application, gateway } = makeApplication();

		await application.actions.library.run({ operation: "recent_list", limit: 200 }, library);

		// 未投影：一条评论约 0.8 KB、一条最近播放约 1.5 KB，200 条就是 160–300 KB。
		expect(gateway.recentSongs).toHaveBeenCalledWith(20, library.signal);
	});
});
