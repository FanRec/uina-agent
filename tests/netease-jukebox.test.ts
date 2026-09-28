import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { SimulatedMusicPlayer, parseMpvLine } from "../.uina/apps/netease-jukebox/player.js";
import { PlaybackSession } from "../.uina/apps/netease-jukebox/playback-session.js";
import { NeteaseApiClient } from "../.uina/apps/netease-jukebox/api-client.js";
import { CompanionManager } from "../.uina/apps/netease-jukebox/companion.js";
import { createJukeboxApp } from "../.uina/apps/netease-jukebox/index.js";
import { defineApp, loadExternalApps, AppRegistry } from "../src/extensions/app-framework/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { Tool } from "../src/tools/broker.js";

describe("SimulatedMusicPlayer", () => {
  it("should handle play, pause, resume, stop and progress", async () => {
    const player = new SimulatedMusicPlayer();
    expect(player.status).toBe("idle");
    expect(player.volume).toBe(80);

    await player.load("test://song.mp3", 10000);
    expect(player.status).toBe("playing");

    let progress = await player.progress();
    expect(progress.durationMs).toBe(10000);
    expect(progress.positionMs).toBeGreaterThanOrEqual(0);

    await player.pause();
    expect(player.status).toBe("paused");

    await player.resume();
    expect(player.status).toBe("playing");

    await player.setVolume(50);
    expect(player.volume).toBe(50);

    await player.stop();
    expect(player.status).toBe("idle");
  });

  it("should emit ended event after duration", async () => {
    vi.useFakeTimers();
    const player = new SimulatedMusicPlayer();
    const endedSpy = vi.fn();
    player.on("ended", endedSpy);

    await player.load("test://short.mp3", 100);
    expect(player.status).toBe("playing");

    vi.advanceTimersByTime(100);
    expect(endedSpy).toHaveBeenCalled();
    expect(player.status).toBe("idle");

    vi.useRealTimers();
  });
});

describe("PlaybackSession", () => {
  it("owns the current song and clears it on natural end", async () => {
    vi.useFakeTimers();
    const player = new SimulatedMusicPlayer();
    const session = new PlaybackSession(player);
    const song = { id: "1", name: "短曲", artists: ["歌手"], durationMs: 100 };

    await session.load("test://song", song);
    expect(session.snapshot().currentSong).toEqual(song);
    vi.advanceTimersByTime(100);
    expect(session.status).toBe("idle");
    expect(session.snapshot().currentSong).toBeNull();
    vi.useRealTimers();
  });

  it("serializes replacement commands", async () => {
    const player = new SimulatedMusicPlayer();
    const session = new PlaybackSession(player);
    const first = { id: "1", name: "一", artists: [], durationMs: null };
    const second = { id: "2", name: "二", artists: [], durationMs: null };

    await Promise.all([session.load("test://one", first), session.load("test://two", second)]);
    expect(session.snapshot().currentSong).toEqual(second);
    await session.stop();
    expect(session.snapshot().currentSong).toBeNull();
  });
});

describe("Mpv IPC protocol seam", () => {
  it("parses valid messages and rejects malformed lines", () => {
    expect(parseMpvLine('{"event":"end-file","reason":"eof"}')).toEqual({ event: "end-file", reason: "eof" });
    expect(parseMpvLine("not-json")).toBeNull();
  });
});

describe("NeteaseApiClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should check health correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
    }) as unknown as typeof fetch;

    const client = new NeteaseApiClient("http://localhost:3000");
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  it("should return false when health check fails or throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused")) as unknown as typeof fetch;

    const client = new NeteaseApiClient("http://localhost:3000");
    const healthy = await client.isHealthy();
    expect(healthy).toBe(false);
  });

  it("should reject a 404 health response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false }) as unknown as typeof fetch;
    const client = new NeteaseApiClient("http://localhost:3000");
    await expect(client.isHealthy()).resolves.toBe(false);
  });

  it("should parse search results correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          songs: [
            {
              id: 12345,
              name: "晴天",
              ar: [{ name: "周杰伦" }],
              dt: 269000,
              al: { name: "叶惠美" },
            },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const client = new NeteaseApiClient("http://localhost:3000");
    const songs = await client.searchSongs("晴天", 1);
    expect(songs).toHaveLength(1);
    expect(songs[0]).toEqual({
      id: "12345",
      name: "晴天",
      artists: ["周杰伦"],
      durationMs: 269000,
      album: "叶惠美",
    });
  });

  it("should get song url correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ url: "http://music.163.com/song/12345.mp3" }],
      }),
    }) as unknown as typeof fetch;

    const client = new NeteaseApiClient("http://localhost:3000");
    const url = await client.getSongUrl("12345");
    expect(url).toBe("http://music.163.com/song/12345.mp3");
  });
});

describe("CompanionManager", () => {
  it("should detect when service is already running", async () => {
    const manager = new CompanionManager("non_existent_dir", 3000);
    const mockApiClient = {
      isHealthy: vi.fn().mockResolvedValue(true),
    } as unknown as NeteaseApiClient;

    const status = await manager.ensureRunning(mockApiClient);
    expect(status.running).toBe(true);
    expect(status.spawnedByUs).toBe(false);
    expect(status.port).toBe(3000);
  });

  it("should handle non-existent directory gracefully", async () => {
    const manager = new CompanionManager("E:\\non_existent_dir_12345", 3000);
    const mockApiClient = {
      isHealthy: vi.fn().mockResolvedValue(false),
    } as unknown as NeteaseApiClient;

    const status = await manager.ensureRunning(mockApiClient);
    expect(status.running).toBe(false);
    expect(status.spawnedByUs).toBe(false);
  });
});

describe("Jukebox App Integration with AppFramework", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createMockExtensionAPI() {
    const tools = new Map<string, Tool>();
    const hooks: Record<string, Function[]> = {};
    const abortController = new AbortController();
    const errors: unknown[] = [];

    const pi = {
      signal: abortController.signal,
      registerTool: vi.fn((tool: Tool) => {
        tools.set(tool.def.function.name, tool);
        return () => {
          tools.delete(tool.def.function.name);
        };
      }),
      onHook: vi.fn((hook: string, handler: Function) => {
        if (!hooks[hook]) hooks[hook] = [];
        hooks[hook].push(handler);
        return () => {};
      }),
      reportError: vi.fn((err: unknown) => {
        errors.push(err);
      }),
    } as unknown as ExtensionAPI;

    return {
      pi,
      tools,
      hooks,
      abort: () => abortController.abort(),
      errors,
    };
  }

  it("should register jukebox app, open panel, execute actions, and render ambient & expanded views", async () => {
    // Mock fetch for health and requests so onStart is instantaneous
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ data: [{ url: "http://example.com/audio.mp3" }] }),
    }) as unknown as typeof fetch;

    const mock = createMockExtensionAPI();
    const jukeboxDef = createJukeboxApp({ simulation: true });

    const unregister = await defineApp(mock.pi, jukeboxDef);

    // Verify facade tool registered under app name "jukebox"
    const facadeTool = mock.tools.get("jukebox");
    expect(facadeTool).toBeDefined();

    // 1. Open jukebox (empty args -> surface expanded)
    const openRes = await facadeTool!.run({});
    expect(openRes.status).toBe("succeeded");
    expect(openRes.result).toContain("界面已展开");

    // Check expanded render
    const expandedRender = await jukeboxDef.render!("expanded");
    expect(expandedRender).toContain("[jukebox]");
    expect(expandedRender).toContain("状态: 空闲");

    // 2. Play a song (simulated)
    const playRes = await facadeTool!.run({
      action: "play",
      params: {
        song_id: "12345",
      },
    });
    expect(playRes.status).toBe("succeeded");

    // Check ambient render
    const ambientRender = await jukeboxDef.render!("ambient");
    expect(ambientRender).toContain("[jukebox] 正在播放");

    // 3. Set volume
    const volRes = await facadeTool!.run({
      action: "volume",
      params: { level: 60 },
    });
    expect(volRes.status).toBe("succeeded");

    // 4. Pause
    const pauseRes = await facadeTool!.run({ action: "pause" });
    expect(pauseRes.status).toBe("succeeded");

    const pausedAmbient = await jukeboxDef.render!("ambient");
    expect(pausedAmbient).toContain("[jukebox] 已暂停");

    // 5. Resume
    const resumeRes = await facadeTool!.run({ action: "resume" });
    expect(resumeRes.status).toBe("succeeded");

    // 6. Stop
    const stopRes = await facadeTool!.run({ action: "stop" });
    expect(stopRes.status).toBe("succeeded");

    const idleAmbient = await jukeboxDef.render!("ambient");
    expect(idleAmbient).toBe("");

    // 7. Status check
    const statusRes = await facadeTool!.run({ action: "status" });
    expect(statusRes.status).toBe("succeeded");
    expect(statusRes.result).toContain("状态: ⏹ 空闲");

    // 7. Context transform hook was registered
    expect(mock.hooks["turn.transformContext"]).toBeDefined();
    expect(mock.hooks["turn.transformContext"].length).toBeGreaterThan(0);

    // Teardown
    await unregister();
    expect(mock.tools.has("jukebox")).toBe(false);
  });

  it("should dynamically load external jukebox app via loadExternalApps", async () => {
    const mock = createMockExtensionAPI();
    const registry = new AppRegistry(mock.pi);
    const searchDir = join(process.cwd(), ".uina", "apps");
    const teardown = await loadExternalApps(mock.pi, registry, [searchDir]);

    expect(registry.has("jukebox")).toBe(true);
    expect(mock.tools.has("jukebox")).toBe(true);

    await teardown();
    expect(registry.has("jukebox")).toBe(false);
    expect(mock.tools.has("jukebox")).toBe(false);
  });
});
