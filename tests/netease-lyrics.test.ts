import { afterEach, describe, expect, it, vi } from "vitest";
import { NeteaseApiClient } from "../.uina/worlds/netease-jukebox/api-client.js";
import { formatLyrics, parseLrc } from "../.uina/worlds/netease-jukebox/lyrics.js";
import { createJukeboxWorld } from "../.uina/worlds/netease-jukebox/index.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

describe("netease lyrics", () => {
	afterEach(() => vi.restoreAllMocks());

	it("parses timestamps, ignores metadata, sorts lines, and formats readable text", () => {
		const lines = parseLrc("[ar:歌手]\n[00:03.50]第三句\n[00:01]第一句\n[00:02.250]第二句\n");
		expect(lines).toEqual([
			{ timeMs: 1000, text: "第一句" },
			{ timeMs: 2250, text: "第二句" },
			{ timeMs: 3500, text: "第三句" },
		]);
		expect(formatLyrics(lines)).toBe("第一句\n第二句\n第三句");
	});

	it("reads lyrics from the NetEase lyric endpoint and accepts missing lyrics", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ lrc: { lyric: "[00:01.00]一句" } }), { status: 200 }),
		);
		await expect(new NeteaseApiClient("http://netease.test").getLyrics("186016")).resolves.toBe("[00:01.00]一句");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://netease.test/lyric?id=186016");

		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ lrc: {} }), { status: 200 }));
		await expect(new NeteaseApiClient("http://netease.test").getLyrics("186017")).resolves.toBeNull();
	});

	it("distinguishes HTTP failures from missing playback URLs in getSongUrl", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(new Response("server error", { status: 500 }));
		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("186016")).rejects.toThrow(
			"网易云播放地址查询失败: HTTP 500",
		);

		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: null }] }), { status: 200 }));
		await expect(new NeteaseApiClient("http://netease.test").getSongUrl("186017")).resolves.toBeNull();
	});

	it("exposes full and current lyric queries through the World tool", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/login/status")) return new Response("{}", { status: 200 });
			if (url.includes("/song/detail?ids=186016"))
				return new Response(JSON.stringify({ songs: [{ id: 186016, name: "测试歌曲", ar: [{ name: "测试歌手" }] }] }), {
					status: 200,
				});
			if (url.includes("/song/url/v1"))
				return new Response(JSON.stringify({ data: [{ url: "http://audio.test/song" }] }), { status: 200 });
			if (url.includes("/lyric?id=186016"))
				return new Response(
					JSON.stringify({ lrc: { lyric: "[00:01.00]第一句\n[00:02.00]第二句\n[00:03.00]第三句" } }),
					{ status: 200 },
				);
			throw new Error(`unexpected request: ${url}`);
		});
		const world = createJukeboxWorld({ apiBaseUrl: "http://netease.test", simulation: true });
		const tool = createWorldTool(world, { getRuntime: () => ({ definition: world, enabled: true }) });
		const full = await tool.run({ action: "lyrics", params: { song_id: "186016" } });
		expect(full.status).toBe("succeeded");
		expect(full.result).toContain("测试歌曲 - 测试歌手");
		expect(full.result).toContain("第一句\n第二句\n第三句");
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/lyric?id=186016"))).toHaveLength(1);

		const played = await tool.run({ action: "play", params: { song_id: "186016" } });
		expect(played.status).toBe("succeeded");
		const current = await tool.run({ action: "current_lyrics", params: {} });
		expect(current.status).toBe("succeeded");
		expect(current.result).toContain("当前歌曲");
		expect(current.result).toContain("第一句");
	});
});
