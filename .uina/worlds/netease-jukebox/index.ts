import type { WorldDef } from "../../../src/extensions/world-framework/types.js";
import { NeteaseApiClient } from "./api-client.js";
import { JukeboxApplication } from "./application.js";
import { loadJukeboxConfig } from "./config.js";
import { SimulatedMusicPlayer, UnavailableMusicPlayer, MpvPlayer, resolveMpvPath, type MusicPlayer } from "./player.js";
import { PlaybackCoordinator } from "./playback-coordinator.js";
import { CompanionManager } from "./companion.js";
import { BroadcastHudClient } from "./broadcast-hud-client.js";
import { HudCompanionManager } from "./hud-companion-manager.js";
import { PreferencesStore } from "./preferences.js";
import { NeteaseGateway } from "./netease-gateway.js";
import { toHudTrack, type BroadcastHudSnapshot } from "./hud-protocol.js";
import type { JukeboxWorldConfig } from "./types.js";
import { LiveLyricsTracker } from "./live-lyrics.js";
import { SpectrumCapture } from "./spectrum-capture.js";

function createPlayer(config: JukeboxWorldConfig, mpvPath: string | null): MusicPlayer {
  if (config.simulation) return new SimulatedMusicPlayer();
  if (mpvPath) return new MpvPlayer(mpvPath);
  return new UnavailableMusicPlayer();
}

export function createJukeboxWorld(config?: JukeboxWorldConfig): WorldDef {
  const merged = { ...loadJukeboxConfig(), ...config };
  const api = new NeteaseApiClient(merged.apiBaseUrl ?? "http://127.0.0.1:3000");
  const gateway = new NeteaseGateway(merged.apiBaseUrl ?? "http://127.0.0.1:3000");
  const serviceManager = new CompanionManager(merged.apiEnhancedDir ?? "E:\\Uina\\ThirdParty\\api-enhanced", merged.apiPort ?? 3000);
  const mpvPath = resolveMpvPath(merged.mpvPath);
  const player = createPlayer(merged, mpvPath);
  const playback = new PlaybackCoordinator(player, merged.queueLimit ?? 100);
  const hudOptions = { baseUrl: merged.broadcastHudUrl, enabled: merged.broadcastHudMode !== "disabled" };
  let hud = new BroadcastHudClient(hudOptions);
  const hudManager = new HudCompanionManager(merged.broadcastHudDir ?? "E:\\Uina\\ThirdParty\\broadcast-hud", Number(new URL(merged.broadcastHudUrl ?? "http://127.0.0.1:18130").port || 18130));
  const lyrics = new LiveLyricsTracker(api);
  const spectrum = new SpectrumCapture({ ffmpegPath: merged.ffmpegPath });
  const sourceInstance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let preferenceStore: PreferencesStore | null = null;
  let revision = 0;
  let hudHeartbeat: ReturnType<typeof setInterval> | null = null;
  let selectedLyricsSongId: string | null = null;
  let worldSignal: AbortSignal | undefined;
  let hudConnection: "connected" | "degraded" = "connected";
  const spectrumUrls = new Map<string, string>();

  const makeSnapshot = (): BroadcastHudSnapshot => {
    const state = playback.snapshot();
    return {
      version: 1, sourceInstance, revision: revision++, updatedAt: new Date().toISOString(),
      source: { id: "jukebox", kind: "music", label: "NeteaseJukebox" },
      connection: { status: state.availability === "unavailable" || hudConnection === "degraded" ? "degraded" : "connected", lastError: state.lastError },
      playback: { status: state.status, playMode: state.playMode, volumePercent: state.volume, currentTrack: state.currentSong ? toHudTrack(state.currentSong) : null, positionMs: state.positionMs, durationMs: state.durationMs },
      lyrics: lyrics.window(state.positionMs),
      queue: { items: state.queue.map(toHudTrack), total: state.queue.length },
      spectrum: spectrum.latest(state.status === "playing"),
    };
  };
  const publish = async (): Promise<void> => {
    await playback.progress().catch(() => undefined);
    void hud.publish(makeSnapshot()).then(result => {
      if (result.accepted) hudConnection = "connected";
      else if (result.reason !== "disabled" && result.reason !== "stale") hudConnection = "degraded";
    });
  };
  const startSpectrumFor = (snapshot: ReturnType<PlaybackCoordinator["snapshot"]>): void => {
    if (snapshot.status !== "playing" || !snapshot.currentSong) {
      void spectrum.stop();
      return;
    }
    const url = spectrumUrls.get(snapshot.currentSong.id);
    if (url) spectrum.start(url, snapshot.positionMs);
    else void spectrum.stop();
  };
  const handlePlaybackSnapshot = (snapshot: ReturnType<PlaybackCoordinator["snapshot"]>): void => {
    startSpectrumFor(snapshot);
    void syncLyrics(snapshot.currentSong).then(() => publish());
  };
  const syncLyrics = async (song: ReturnType<PlaybackCoordinator["snapshot"]>["currentSong"]): Promise<void> => {
    if (!song) {
      selectedLyricsSongId = null;
      lyrics.clear();
      return;
    }
    if (selectedLyricsSongId === song.id) return;
    selectedLyricsSongId = song.id;
    try {
      await lyrics.selectWithRetry(song, worldSignal);
    } catch {
      if (selectedLyricsSongId === song.id) lyrics.clear();
    }
  };
  let unsubscribe = (): void => undefined;
  let subscribed = false;
  const application = new JukeboxApplication({ api, gateway, playback, lyrics, ensureService: async ctx => serviceManager.ensureRunning(api, 10000, ctx.signal) });
  playback.setLoader(async (song, signal) => {
    const url = await api.getSongUrl(song.id, signal);
    if (url) {
      spectrumUrls.delete(song.id);
      spectrumUrls.set(song.id, url);
      while (spectrumUrls.size > 128) spectrumUrls.delete(spectrumUrls.keys().next().value!);
    }
    return { url, song };
  });

  const world: WorldDef = {
    name: "jukebox",
    description: "主体音乐能力：search→play/queue，playback 控制，lyrics 查询。library 是账号/歌单写操作，只有用户明确要求时使用；播放结果需看状态和模拟标记。",
    defaultState: { enabled: true },
    async onStart(ctx) {
      if (hud.isClosed) hud = new BroadcastHudClient(hudOptions);
      worldSignal = ctx.signal;
      if (!subscribed) {
        unsubscribe = playback.subscribe(handlePlaybackSnapshot);
        subscribed = true;
      }
      preferenceStore = new PreferencesStore(ctx.worldDataDir ?? ".uina/world-data/jukebox");
      const saved = await preferenceStore.load();
      playback.setMode(saved.playMode);
      await playback.setVolume(saved.volume);
      if (merged.broadcastHudMode === "auto") hudConnection = await hudManager.ensureRunning(ctx.signal) ? "connected" : "degraded";
      await publish();
      if (hudHeartbeat === null) hudHeartbeat = setInterval(() => { void publish(); }, 250);
    },
    async onStop() {
      if (hudHeartbeat !== null) { clearInterval(hudHeartbeat); hudHeartbeat = null; }
      unsubscribe(); unsubscribe = (): void => undefined; subscribed = false;
      worldSignal = undefined;
      hudConnection = "connected";
      selectedLyricsSongId = null;
      lyrics.clear();
      if (preferenceStore) await preferenceStore.save({ playMode: playback.mode, volume: playback.volume, queueLimit: merged.queueLimit ?? 100 });
      try { await playback.stop(); } finally { await spectrum.stop(); await playback.close(); await serviceManager.stop(); await hud.close(); await hudManager.stop(); }
    },
    actions: application.actions,
  };
  return world;
}

export default createJukeboxWorld();
