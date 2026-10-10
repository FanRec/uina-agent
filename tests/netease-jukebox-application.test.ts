import { describe, expect, it, vi } from "vitest";
import { NeteaseRequestError } from "../.uina/worlds/netease-jukebox/api-client.js";
import { JukeboxApplication } from "../.uina/worlds/netease-jukebox/application.js";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import { SimulatedMusicPlayer } from "../.uina/worlds/netease-jukebox/player.js";

const song = { id: "1", name: "Song 1", artists: ["Artist"], durationMs: 1000 };

function makeApplication() {
	const playback = new PlaybackCoordinator(new SimulatedMusicPlayer());
	playback.setLoader(async (track) => ({ url: `simulated://${track.id}`, song: track }));
	const api = {
		searchSongs: vi.fn(async () => [song]),
		getSongInfo: vi.fn(async () => song),
		getSongUrl: vi.fn(async () => "https://audio.test/song"),
		getLyrics: vi.fn(async () => null),
	};
	const gateway = {
		accountStatus: vi.fn(async () => ({ profile: { userId: 42 } })),
		playlistForWrite: vi.fn(async () => ({
			id: "p1",
			name: "Playlist",
			ownerId: "42",
			editable: true,
			trackIds: ["1"],
		})),
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

	it("passes tags through playlist updates", async () => {
		const { application, gateway } = makeApplication();
		const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
		await application.actions.library.run(
			{ operation: "playlist_update", playlist_id: "p1", name: "New", tags: "rock", confirm: true },
			ctx,
		);
		expect(gateway.updatePlaylist).toHaveBeenCalledWith("p1", "New", undefined, "rock", ctx.signal);
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
