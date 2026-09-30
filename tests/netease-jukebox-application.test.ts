import { describe, expect, it, vi } from "vitest";
import { JukeboxApplication } from "../.uina/worlds/netease-jukebox/application.js";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import { SimulatedMusicPlayer } from "../.uina/worlds/netease-jukebox/player.js";

const song = { id: "1", name: "Song 1", artists: ["Artist"], durationMs: 1000 };

function makeApplication() {
  const playback = new PlaybackCoordinator(new SimulatedMusicPlayer());
  playback.setLoader(async track => ({ url: `simulated://${track.id}`, song: track }));
  const api = {
    searchSongs: vi.fn(async () => [song]),
    getSongInfo: vi.fn(async () => song),
    getSongUrl: vi.fn(async () => "https://audio.test/song"),
    getLyrics: vi.fn(async () => null),
  };
  const gateway = {
    accountStatus: vi.fn(async () => ({ profile: { userId: 42 } })),
    playlistForWrite: vi.fn(async () => ({ id: "p1", name: "Playlist", ownerId: "42", editable: true, trackIds: ["1"] })),
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
  it("resolves a search ref for playlist track writes", async () => {
    const { application, gateway } = makeApplication();
    const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
    await application.actions.search.run({ query: "song" }, ctx);
    const result = await application.actions.library.run({ operation: "playlist_track_add", playlist_id: "p1", ref: "search:0", confirm: true }, ctx);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(gateway.addToPlaylist).toHaveBeenCalledWith("p1", "1", ctx.signal);
  });

  it("does not call an external write without confirmation", async () => {
    const { application, gateway, ensureService } = makeApplication();
    const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
    const result = await application.actions.library.run({ operation: "playlist_track_remove", playlist_id: "p1", song_id: "1" }, ctx);
    expect(result).toMatchObject({ status: "failed", details: { reason: "confirmation_required" } });
    expect(gateway.removeFromPlaylist).not.toHaveBeenCalled();
    expect(ensureService).not.toHaveBeenCalled();
  });

  it("passes tags through playlist updates", async () => {
    const { application, gateway } = makeApplication();
    const ctx = { operationIdentity: "world:jukebox/library" as const, signal: new AbortController().signal };
    await application.actions.library.run({ operation: "playlist_update", playlist_id: "p1", name: "New", tags: "rock", confirm: true }, ctx);
    expect(gateway.updatePlaylist).toHaveBeenCalledWith("p1", "New", undefined, "rock", ctx.signal);
  });
});
