import { afterEach, describe, expect, it, vi } from "vitest";
import { NeteaseGateway } from "../.uina/worlds/netease-jukebox/netease-gateway.js";

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
});
