import { afterEach, describe, expect, it, vi } from "vitest";
import { NeteaseApiClient, projectSong } from "../.uina/worlds/netease-jukebox/api-client.js";

describe("NeteaseApiClient transient read failures", () => {
	afterEach(() => vi.restoreAllMocks());

	it("retries a transient search 502 once and returns the recovered results", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ result: { songs: [{ id: 42, name: "Song", ar: [{ name: "Artist" }] }] } }), {
					status: 200,
				}),
			);

		await expect(new NeteaseApiClient("http://netease.test").searchSongs("song")).resolves.toMatchObject([
			{ id: "42", name: "Song", artists: ["Artist"] },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a transient playback URL 502 once", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ url: "https://audio.test/song" }] }), { status: 200 }),
			);

		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("42")).resolves.toBe("https://audio.test/song");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("stops after one retry when search keeps returning 502", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("upstream unavailable", { status: 502 }));

		const request = new NeteaseApiClient("http://netease.test").searchSongs("song");
		await expect(request).rejects.toMatchObject({
			name: "NeteaseRequestError",
			status: 502,
			attempts: 2,
			retryable: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a non-transient HTTP error", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));

		await expect(new NeteaseApiClient("http://netease.test").searchSongs("song")).rejects.toMatchObject({
			status: 401,
			attempts: 1,
			retryable: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not continue a scheduled retry after caller cancellation", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("upstream unavailable", { status: 502 }));
		const controller = new AbortController();
		const request = new NeteaseApiClient("http://netease.test").searchSongs("song", 10, controller.signal);
		setTimeout(() => controller.abort(new Error("test cancelled")), 20);

		await expect(request).rejects.toThrow("test cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("NeteaseApiClient 404 semantics", () => {
	afterEach(() => vi.restoreAllMocks());

	it("falls back to the weapi channel when the xeapi channel reports a synthesized 404", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, msg: "Not Found" }), { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ url: "https://audio.test/song" }] }), { status: 200 }),
			);

		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("42")).resolves.toBe("https://audio.test/song");
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
			"http://netease.test/song/url/v1?id=42&level=standard",
			"http://netease.test/song/url/v1?id=42&level=standard&crypto=weapi",
		]);
	});

	it("stops after one weapi fallback when the channel stays broken", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response(JSON.stringify({ code: 404, msg: "Not Found" }), { status: 404 }));

		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("42")).rejects.toMatchObject({
			name: "NeteaseRequestError",
			status: 404,
			attempts: 1,
			retryable: false,
			synthesized404: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry an upstream 404 and surfaces the upstream message", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ code: 404, msg: "歌曲不存在" }), { status: 404 }));

		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("42")).rejects.toMatchObject({
			name: "NeteaseRequestError",
			status: 404,
			attempts: 1,
			retryable: false,
			message: expect.stringContaining("歌曲不存在"),
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("projectSong", () => {
	it("maps the playlist dialect onto SongInfo and leaves the other fifty fields behind", () => {
		const projected = projectSong({
			id: 3358787335,
			name: "如生之不竭",
			ar: [
				{ id: 1, name: "HOYO-MiX" },
				{ id: 2, name: "" },
			],
			al: { id: 3, name: "原神-朔望凝待之庭", picUrl: "http://p3.music.126.net/x.jpg" },
			dt: 162534,
			fee: 0,
			pop: 95,
			h: { br: 320000 },
			mv: 0,
		});

		expect(projected).toEqual({
			id: "3358787335",
			name: "如生之不竭",
			artists: ["HOYO-MiX"],
			durationMs: 162534,
			album: "原神-朔望凝待之庭",
		});
	});

	it("accepts the search dialect so three endpoints share one mapping", () => {
		expect(projectSong({ id: "42", name: "Song", artists: [{ name: "A" }], duration: 1000, album: "Album" })).toEqual({
			id: "42",
			name: "Song",
			artists: ["A"],
			durationMs: 1000,
			album: "Album",
		});
	});

	it("returns null rather than inventing a placeholder for an entry without an id", () => {
		expect(projectSong({ name: "no id" })).toBeNull();
		expect(projectSong({ id: null, name: "null id" })).toBeNull();
		expect(projectSong(null)).toBeNull();
		expect(projectSong("song")).toBeNull();
	});

	it("keeps a song usable when upstream omits the album", () => {
		expect(projectSong({ id: 7, name: "Bare" })).toEqual({ id: "7", name: "Bare", artists: [], durationMs: null });
	});
});

describe("NeteaseApiClient song detail batching", () => {
	afterEach(() => vi.restoreAllMocks());

	it("batches ids in chunks of 100 instead of one request per song", async () => {
		const ids = Array.from({ length: 250 }, (_, index) => `s${index}`);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const requested = (new URL(String(input)).searchParams.get("ids") ?? "").split(",").filter(Boolean);
			return new Response(
				JSON.stringify({ songs: requested.map((id) => ({ id, name: `Song ${id}`, ar: [{ name: "A" }], dt: 1000 })) }),
				{ status: 200 },
			);
		});

		const songs = await new NeteaseApiClient("http://netease.test").getSongInfos(ids);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		const chunkSizes = fetchMock.mock.calls.map(
			([input]) => (new URL(String(input)).searchParams.get("ids") ?? "").split(",").filter(Boolean).length,
		);
		expect(chunkSizes).toEqual([100, 100, 50]);
		// 顺序必须跟着入参走：调用方靠这个把 id 页对应回曲目页。
		expect(songs.map((song) => song.id)).toEqual(ids);
	});

	it("skips the request entirely when there is nothing to look up", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(new NeteaseApiClient("http://netease.test").getSongInfos(["", "  "])).resolves.toEqual([]);

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
