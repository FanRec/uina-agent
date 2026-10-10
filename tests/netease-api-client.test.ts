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
