import { describe, expect, it } from "vitest";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import { SimulatedMusicPlayer } from "../.uina/worlds/netease-jukebox/player.js";

const song = (id: string) => ({ id, name: `Song ${id}`, artists: ["Artist"], durationMs: null });

describe("PlaybackCoordinator", () => {
  it("enforces queue limit and supports reorder/shuffle operations", () => {
    const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 2);
    coordinator.add(song("1")); coordinator.add(song("2"));
    expect(() => coordinator.add(song("3"))).toThrow("上限 2");
    expect(coordinator.move(0, 1)).toBe(true);
    expect(coordinator.snapshot().queue.map(item => item.id)).toEqual(["2", "1"]);
    coordinator.shuffle();
    expect(coordinator.snapshot().queue).toHaveLength(2);
  });

  it("records history when a song is replaced and returns the previous song", async () => {
    const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
    await coordinator.load("simulated://1", song("1"));
    await coordinator.load("simulated://2", song("2"));
    coordinator.setLoader(async track => ({ url: `simulated://${track.id}`, song: track }));
    expect(coordinator.snapshot().history.map(item => item.id)).toEqual(["1"]);
    expect(await coordinator.playPrevious()).toEqual(song("1"));
    await coordinator.close();
  });

  it("does not consume a queued song when its loader fails", async () => {
    const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
    coordinator.add(song("next"));
    coordinator.setLoader(async () => { throw new Error("url unavailable"); });
    await expect(coordinator.playNext()).rejects.toThrow("url unavailable");
    expect(coordinator.snapshot().queue.map(item => item.id)).toEqual(["next"]);
    await coordinator.close();
  });
});
