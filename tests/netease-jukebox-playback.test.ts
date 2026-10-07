import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PlaybackCoordinator } from "../.uina/worlds/netease-jukebox/playback-coordinator.js";
import type { MusicPlayer, PlayerProgress } from "../.uina/worlds/netease-jukebox/player.js";
import type { SongInfo } from "../.uina/worlds/netease-jukebox/types.js";

class FakePlayer extends EventEmitter implements MusicPlayer {
	readonly isSimulated = false;
	readonly availability = "real" as const;
	private statusValue: "idle" | "playing" | "paused" = "idle";
	private volumeValue = 80;
	private readonly failingUrls = new Set<string>();
	readonly seekCalls: number[] = [];
	progressPositionMs = 8000;

	get status() {
		return this.statusValue;
	}

	get volume() {
		return this.volumeValue;
	}

	failUrl(url: string): void {
		this.failingUrls.add(url);
	}

	async load(url: string): Promise<void> {
		if (this.failingUrls.has(url)) throw new Error(`load failed: ${url}`);
		this.statusValue = "playing";
	}

	async pause(): Promise<void> {
		this.statusValue = "paused";
	}

	async resume(): Promise<void> {
		this.statusValue = "playing";
	}

	async stop(): Promise<void> {
		this.statusValue = "idle";
	}

	async setVolume(volumePercent: number): Promise<void> {
		this.volumeValue = Math.round(volumePercent);
	}

	async progress(): Promise<PlayerProgress> {
		return { positionMs: this.statusValue === "idle" ? 0 : this.progressPositionMs, durationMs: null };
	}

	async seek(positionMs: number): Promise<void> {
		this.seekCalls.push(positionMs);
	}

	async close(): Promise<void> {}

	emitEnded(): void {
		this.emit("ended");
	}
}

function makeSong(id: string): SongInfo {
	return { id, name: `Song ${id}`, artists: ["A"], durationMs: 1000 };
}

function makeCoordinator(player: FakePlayer): PlaybackCoordinator {
	const coordinator = new PlaybackCoordinator(player);
	coordinator.setLoader(async (song) => ({ url: `https://audio.test/${song.id}`, song }));
	return coordinator;
}

describe("PlaybackCoordinator", () => {
	it("previous 在已播超过 5 秒时回到曲目开头且不弹历史", async () => {
		const player = new FakePlayer();
		const coordinator = makeCoordinator(player);
		await coordinator.loadSong(makeSong("1"));

		const outcome = await coordinator.previous();

		expect(outcome).toEqual({ song: makeSong("1"), restarted: true });
		expect(player.seekCalls).toEqual([0]);
		expect(coordinator.snapshot().positionMs).toBe(0);
		expect(coordinator.snapshot().currentSong?.id).toBe("1");
	});

	it("previous 在未超过 5 秒时回退历史", async () => {
		const player = new FakePlayer();
		const coordinator = makeCoordinator(player);
		player.progressPositionMs = 4000;
		await coordinator.loadSong(makeSong("1"));
		await coordinator.loadSong(makeSong("2"));

		const outcome = await coordinator.previous();

		expect(outcome).toEqual({ song: makeSong("1"), restarted: false });
		expect(player.seekCalls).toEqual([]);
		expect(coordinator.snapshot().currentSong?.id).toBe("1");
	});

	it("playNext 加载失败时将该曲移出队列", async () => {
		const player = new FakePlayer();
		const coordinator = makeCoordinator(player);
		player.failUrl("https://audio.test/b1");
		coordinator.add(makeSong("b1"));
		coordinator.add(makeSong("g1"));

		await expect(coordinator.playNext()).rejects.toThrow("load failed");

		const state = coordinator.snapshot();
		expect(state.queue).toHaveLength(1);
		expect(state.queue[0]?.id).toBe("g1");
		expect(state.lastError).toContain("load failed");
	});

	it("自动续播跳过失败曲目继续播放下一首", async () => {
		const player = new FakePlayer();
		const coordinator = makeCoordinator(player);
		player.failUrl("https://audio.test/b1");
		await coordinator.loadSong(makeSong("s0"));
		coordinator.add(makeSong("b1"));
		coordinator.add(makeSong("g1"));

		player.emitEnded();

		await vi.waitFor(() => expect(coordinator.snapshot().currentSong?.id).toBe("g1"));
		expect(coordinator.snapshot().queue).toHaveLength(0);
	});

	it("连续 3 次失败后停止并保留剩余队列", async () => {
		const player = new FakePlayer();
		const coordinator = makeCoordinator(player);
		for (const id of ["b1", "b2", "b3"]) player.failUrl(`https://audio.test/${id}`);
		await coordinator.loadSong(makeSong("s0"));
		for (const id of ["b1", "b2", "b3", "g1"]) coordinator.add(makeSong(id));

		player.emitEnded();

		await vi.waitFor(() => expect(coordinator.snapshot().queue).toHaveLength(1));
		expect(coordinator.snapshot().currentSong).toBeNull();
		expect(coordinator.snapshot().lastError).toContain("load failed");
	});
});
