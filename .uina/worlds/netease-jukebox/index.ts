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

function createPlayer(config: JukeboxWorldConfig, mpvPath: string | null): MusicPlayer {
  if (config.simulation) return new SimulatedMusicPlayer();
  if (mpvPath) return new MpvPlayer(mpvPath);
  return new UnavailableMusicPlayer();
}

function createSpectrum(status: string, positionMs: number): BroadcastHudSnapshot["spectrum"] {
  if (status !== "playing") return { source: "silent", bands: Array(32).fill(0), energy: 0, beat: 0 };
  const bands = Array.from({ length: 32 }, (_, index) => Math.max(0, Math.min(1, 0.2 + Math.sin(positionMs / 600 + index) * 0.15)));
  return { source: "synthetic", bands, energy: 0.35, beat: 0 };
}

export function createJukeboxWorld(config?: JukeboxWorldConfig): WorldDef {
  const merged = { ...loadJukeboxConfig(), ...config };
  const api = new NeteaseApiClient(merged.apiBaseUrl ?? "http://127.0.0.1:3000");
  const gateway = new NeteaseGateway(merged.apiBaseUrl ?? "http://127.0.0.1:3000");
  const serviceManager = new CompanionManager(merged.apiEnhancedDir ?? "E:\\Uina\\ThirdParty\\api-enhanced", merged.apiPort ?? 3000);
  const mpvPath = resolveMpvPath(merged.mpvPath);
  const player = createPlayer(merged, mpvPath);
  const playback = new PlaybackCoordinator(player, merged.queueLimit ?? 100);
  const hud = new BroadcastHudClient({ baseUrl: merged.broadcastHudUrl, enabled: merged.broadcastHudMode !== "disabled" });
  const hudManager = new HudCompanionManager(merged.broadcastHudDir ?? "E:\\Uina\\ThirdParty\\broadcast-hud", Number(new URL(merged.broadcastHudUrl ?? "http://127.0.0.1:18130").port || 18130));
  const sourceInstance = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let preferenceStore: PreferencesStore | null = null;
  let revision = 0;

  const makeSnapshot = (): BroadcastHudSnapshot => {
    const state = playback.snapshot();
    return {
      version: 1, sourceInstance, revision: revision++, updatedAt: new Date().toISOString(),
      source: { id: "jukebox", kind: "music", label: "NeteaseJukebox" },
      connection: { status: state.availability === "unavailable" ? "degraded" : "connected", lastError: state.lastError },
      playback: { status: state.status, playMode: state.playMode, volumePercent: state.volume, currentTrack: state.currentSong ? toHudTrack(state.currentSong) : null, positionMs: state.positionMs, durationMs: state.durationMs },
      lyrics: { previous: null, current: null, next: null },
      queue: { items: state.queue.map(toHudTrack), total: state.queue.length },
      spectrum: createSpectrum(state.status, state.positionMs),
    };
  };
  const publish = async (): Promise<void> => { await playback.progress().catch(() => undefined); void hud.publish(makeSnapshot()); };
  let unsubscribe = (): void => undefined;
  let subscribed = false;
  const application = new JukeboxApplication({ api, gateway, playback, ensureService: async ctx => serviceManager.ensureRunning(api, 10000, ctx.signal) });
  playback.setLoader(async (song, signal) => ({ url: await api.getSongUrl(song.id, signal), song }));

  const world: WorldDef = {
    name: "jukebox",
    description: "网易云音乐点歌机：搜索、播放、队列、播放控制、歌词和账号库操作",
    defaultState: { enabled: true },
    async onStart(ctx) {
      if (!subscribed) { unsubscribe = playback.subscribe(() => { void publish(); }); subscribed = true; }
      preferenceStore = new PreferencesStore(ctx.worldDataDir ?? ".uina/world-data/jukebox");
      const saved = await preferenceStore.load();
      playback.setMode(saved.playMode);
      await playback.setVolume(saved.volume);
      if (merged.broadcastHudMode === "auto") await hudManager.ensureRunning(ctx.signal);
      await publish();
    },
    async onStop() {
      unsubscribe(); unsubscribe = (): void => undefined; subscribed = false;
      if (preferenceStore) await preferenceStore.save({ playMode: playback.mode, volume: playback.volume, queueLimit: merged.queueLimit ?? 100, broadcastHudMode: merged.broadcastHudMode ?? "manual" });
      try { await playback.stop(); } finally { await playback.close(); await serviceManager.stop(); await hudManager.stop(); }
    },
    actions: application.actions,
  };
  return world;
}

export default createJukeboxWorld();
