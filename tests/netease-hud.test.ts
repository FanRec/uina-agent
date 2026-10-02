import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJukeboxWorld } from "../.uina/worlds/netease-jukebox/index.js";

describe("netease jukebox HUD heartbeat", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("continues publishing snapshots after the initial world snapshot", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const worldDataDir = await mkdtemp(join(tmpdir(), "uina-hud-test-"));
		const world = createJukeboxWorld({
			apiBaseUrl: "http://netease.test",
			broadcastHudMode: "manual",
			broadcastHudUrl: "http://hud.test",
			simulation: true,
		});

		await world.onStart?.({ signal: new AbortController().signal, worldDataDir });
		await vi.advanceTimersByTimeAsync(0);
		const initialPublishes = fetchMock.mock.calls.filter(([input]) => String(input) === "http://hud.test/state").length;
		expect(initialPublishes).toBeGreaterThan(0);

		await vi.advanceTimersByTimeAsync(4000);

		expect(fetchMock.mock.calls.filter(([input]) => String(input) === "http://hud.test/state").length).toBeGreaterThan(
			initialPublishes,
		);
		await world.onStop?.({ signal: new AbortController().signal, worldDataDir });
		await rm(worldDataDir, { recursive: true, force: true });
	});

	it("publishes the active LRC line in HUD snapshots after a song starts", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === "http://hud.test/state") return new Response("{}", { status: 200 });
			if (url.endsWith("/login/status")) return new Response("{}", { status: 200 });
			if (url.includes("/song/detail"))
				return new Response(
					JSON.stringify({ songs: [{ id: 1, name: "Song", ar: [{ name: "Artist" }], dt: 10_000 }] }),
					{ status: 200 },
				);
			if (url.includes("/song/url/v1"))
				return new Response(JSON.stringify({ data: [{ url: "https://audio.test/song" }] }), { status: 200 });
			if (url.includes("/lyric?id=1"))
				return new Response(JSON.stringify({ lrc: { lyric: "[00:00.00]hello\n[00:03.00]world" } }), { status: 200 });
			throw new Error(`unexpected request: ${url}`);
		});
		const worldDataDir = await mkdtemp(join(tmpdir(), "uina-hud-lyrics-test-"));
		const world = createJukeboxWorld({
			apiBaseUrl: "http://netease.test",
			broadcastHudMode: "manual",
			broadcastHudUrl: "http://hud.test",
			apiEnhancedDir: "E:\\missing",
			simulation: true,
		});
		const signal = new AbortController().signal;

		await world.onStart?.({ signal, worldDataDir });
		const playResult = await world.actions.play!.run(
			{ song_id: "1" },
			{ operationIdentity: "world:jukebox/play", signal },
		);
		expect(playResult).toContain("正在播放");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const snapshots = fetchMock.mock.calls
			.filter(([input]) => String(input) === "http://hud.test/state")
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { lyrics: { current: string | null } });
		expect(snapshots.some((snapshot) => snapshot.lyrics.current === "hello")).toBe(true);

		await world.onStop?.({ signal, worldDataDir });
		await rm(worldDataDir, { recursive: true, force: true });
	});
});
