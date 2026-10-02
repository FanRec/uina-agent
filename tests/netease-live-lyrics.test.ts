import { describe, expect, it, vi } from "vitest";
import { LiveLyricsTracker } from "../.uina/worlds/netease-jukebox/live-lyrics.js";

const song = { id: "song-1", name: "Song", artists: ["Artist"], durationMs: 10_000 };

describe("LiveLyricsTracker", () => {
	it("selects a new song after a previous retrying selection", async () => {
		const tracker = new LiveLyricsTracker({ getLyrics: async (id) => `[00:00.00]${id}` });
		await tracker.selectWithRetry(song);
		await tracker.selectWithRetry({ ...song, id: "new" });
		expect(tracker.window(0).current).toBe("new");
	});

	it("cancels backoff immediately on clear without reselecting the stopped song", async () => {
		vi.useFakeTimers();
		try {
			const api = {
				getLyrics: vi.fn(async () => {
					throw new Error("offline");
				}),
			};
			const tracker = new LiveLyricsTracker(api);
			const selection = tracker.selectWithRetry(song).catch(() => undefined);
			await vi.advanceTimersByTimeAsync(0);
			tracker.clear();
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
			await selection;
			await vi.advanceTimersByTimeAsync(14000);
			expect(api.getLyrics).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a transient lyric failure with bounded backoff", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const api = {
			getLyrics: vi.fn(async () => {
				attempts++;
				if (attempts === 1) throw new Error("temporary failure");
				return "[00:01.00]recovered";
			}),
		};
		const tracker = new LiveLyricsTracker(api as never);
		const pending = tracker.selectWithRetry(song);

		await vi.advanceTimersByTimeAsync(0);
		expect(api.getLyrics).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		await pending;

		expect(api.getLyrics).toHaveBeenCalledTimes(2);
		expect(tracker.window(1500).current).toBe("recovered");
		vi.useRealTimers();
	});

	it("returns the previous, current, and next LRC lines for playback position", async () => {
		const api = { getLyrics: vi.fn(async () => "[00:01.00]one\n[00:03.00]two\n[00:05.00]three") };
		const tracker = new LiveLyricsTracker(api as never);

		await tracker.select(song);

		expect(tracker.window(0)).toEqual({ previous: null, current: null, next: "one" });
		expect(tracker.window(3500)).toEqual({ previous: "one", current: "two", next: "three" });
		expect(tracker.window(7000)).toEqual({ previous: "two", current: "three", next: null });
	});

	it("does not let an older lyric request replace the selected song", async () => {
		let resolveOld!: (value: string) => void;
		const oldLyrics = new Promise<string>((resolve) => {
			resolveOld = resolve;
		});
		const api = { getLyrics: vi.fn((id: string) => (id === "old" ? oldLyrics : Promise.resolve("[00:01.00]new"))) };
		const tracker = new LiveLyricsTracker(api as never);

		const oldSong = { ...song, id: "old" };
		const newSong = { ...song, id: "new" };
		const oldSelection = tracker.select(oldSong);
		await tracker.select(newSong);
		resolveOld("[00:01.00]old");
		await oldSelection;

		expect(tracker.window(1500)).toEqual({ previous: null, current: "new", next: null });
	});

	it("evicts the oldest lyric cache entries", async () => {
		let calls = 0;
		const api = {
			getLyrics: vi.fn(async () => {
				calls += 1;
				return "[00:01.00]line";
			}),
		};
		const tracker = new LiveLyricsTracker(api as never);
		for (let index = 0; index < 129; index += 1) await tracker.getLines({ ...song, id: String(index) });
		await tracker.getLines({ ...song, id: "0" });

		expect(calls).toBe(130);
	});
});
