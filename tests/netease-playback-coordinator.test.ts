import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import { type MusicPlayer, SimulatedMusicPlayer } from "../.uina/worlds/netease-jukebox/player.js";

const song = (id: string) => ({ id, name: `Song ${id}`, artists: ["Artist"], durationMs: null });

class EndedPlayer extends EventEmitter implements MusicPlayer {
	readonly availability = "simulation" as const;
	readonly isSimulated = true;
	status: MusicPlayer["status"] = "playing";
	volume = 80;
	async load(): Promise<void> {
		this.status = "playing";
	}
	async pause(): Promise<void> {
		this.status = "paused";
	}
	async resume(): Promise<void> {
		this.status = "playing";
	}
	async stop(): Promise<void> {
		this.status = "idle";
	}
	async setVolume(volume: number): Promise<void> {
		this.volume = volume;
	}
	async progress(): Promise<{ positionMs: number; durationMs: number | null }> {
		return { positionMs: 0, durationMs: null };
	}
	async seek(_positionMs: number): Promise<void> {}
	async close(): Promise<void> {
		this.status = "idle";
	}
}

describe("PlaybackCoordinator", () => {
	it("emits paused and resumed snapshots with the current position", async () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
		await coordinator.load("simulated://current", { ...song("current"), durationMs: 1000 });
		const snapshots: string[] = [];
		coordinator.subscribe((snapshot) => snapshots.push(snapshot.status));

		await coordinator.pause();
		await coordinator.resume();

		expect(snapshots).toEqual(["paused", "playing"]);
		await coordinator.close();
	});

	it("keeps an idle snapshot free of the previous duration", async () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
		await coordinator.load("simulated://current", { ...song("current"), durationMs: 1000 });
		await coordinator.stop();
		await coordinator.progress();

		expect(coordinator.snapshot()).toMatchObject({
			status: "idle",
			currentSong: null,
			positionMs: 0,
			durationMs: null,
		});
		await coordinator.close();
	});

	it("does not advance the queue for an explicit stop event", async () => {
		const player = new EndedPlayer();
		const coordinator = new PlaybackCoordinator(player);
		coordinator.setLoader(async (track) => ({ url: `simulated://${track.id}`, song: track }));
		await coordinator.load("simulated://current", song("current"));
		coordinator.add(song("next"));

		player.status = "idle";
		player.emit("ended", { reason: "stop", trackId: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(coordinator.snapshot()).toMatchObject({ currentSong: song("current"), queue: [song("next")] });
		await coordinator.close();
	});

	it("enforces queue limit and supports reorder/shuffle operations", () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 2);
		coordinator.add(song("1"));
		coordinator.add(song("2"));
		expect(() => coordinator.add(song("3"))).toThrow("上限 2");
		expect(coordinator.move(0, 1)).toBe(true);
		expect(coordinator.snapshot().queue.map((item) => item.id)).toEqual(["2", "1"]);
		coordinator.shuffle();
		expect(coordinator.snapshot().queue).toHaveLength(2);
	});

	it("records history when a song is replaced and returns the previous song", async () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
		await coordinator.load("simulated://1", song("1"));
		await coordinator.load("simulated://2", song("2"));
		coordinator.setLoader(async (track) => ({ url: `simulated://${track.id}`, song: track }));
		expect(coordinator.snapshot().history.map((item) => item.id)).toEqual(["1"]);
		expect(await coordinator.previous()).toEqual({ song: song("1"), restarted: false });
		await coordinator.close();
	});

	it("consumes a queued song when its loader fails so auto-advance is not stuck", async () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer());
		coordinator.add(song("next"));
		coordinator.add(song("after"));
		coordinator.setLoader(async (track) => {
			if (track.id === "next") throw new Error("url unavailable");
			return { url: `simulated://${track.id}`, song: track };
		});
		await expect(coordinator.playNext()).rejects.toThrow("url unavailable");
		expect(coordinator.snapshot().queue.map((item) => item.id)).toEqual(["after"]);
		await coordinator.close();
	});

	it("automatically advances to the queued song after eof", async () => {
		const player = new SimulatedMusicPlayer();
		const coordinator = new PlaybackCoordinator(player);
		coordinator.setLoader(async (track) => ({ url: `simulated://${track.id}`, song: track }));
		await coordinator.load("simulated://current", { ...song("current"), durationMs: 15 });
		coordinator.add({ ...song("next"), durationMs: 1000 });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(coordinator.snapshot().currentSong?.id).toBe("next");
		await coordinator.close();
	});
});

describe("PlaybackCoordinator.addMany", () => {
	it("fills the queue up to its limit and reports what did not fit", () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 3);

		const outcome = coordinator.addMany([song("1"), song("2"), song("3"), song("4"), song("5")]);

		expect(outcome).toEqual({ accepted: 3, skipped: 2, capacity: 3, remaining: 0 });
		expect(coordinator.snapshot().queue.map((item) => item.id)).toEqual(["1", "2", "3"]);
	});

	it("accepts nothing when the queue is already full", () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 1);
		coordinator.add(song("0"));

		const outcome = coordinator.addMany([song("1"), song("2")]);

		expect(outcome).toEqual({ accepted: 0, skipped: 2, capacity: 1, remaining: 0 });
		expect(coordinator.snapshot().queue.map((item) => item.id)).toEqual(["0"]);
	});

	it("emits one snapshot for the whole batch", () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 10);
		const snapshots: number[] = [];
		coordinator.subscribe((snapshot) => snapshots.push(snapshot.queue.length));

		coordinator.addMany([song("1"), song("2"), song("3")]);

		// 一首一次 emit 会把 HUD 广播打成三条，批量入队就白做了。
		expect(snapshots).toEqual([3]);
	});

	it("stays silent when the batch changes nothing", () => {
		const coordinator = new PlaybackCoordinator(new SimulatedMusicPlayer(), 1);
		coordinator.add(song("0"));
		const snapshots: number[] = [];
		coordinator.subscribe((snapshot) => snapshots.push(snapshot.queue.length));

		coordinator.addMany([song("1")]);

		expect(snapshots).toEqual([]);
	});
});
