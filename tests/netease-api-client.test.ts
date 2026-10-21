import { afterEach, describe, expect, it, vi } from "vitest";
import { NeteaseApiClient } from "../.uina/worlds/netease-jukebox/api-client.js";

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
