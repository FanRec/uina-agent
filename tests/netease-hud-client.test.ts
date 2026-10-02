import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastHudClient } from "../.uina/worlds/netease-jukebox/broadcast-hud-client.js";
import type { BroadcastHudSnapshot } from "../.uina/worlds/netease-jukebox/hud-protocol.js";

function snapshot(revision: number): BroadcastHudSnapshot {
	return {
		version: 1,
		sourceInstance: "instance-1",
		revision,
		updatedAt: new Date(0).toISOString(),
		source: { id: "jukebox", kind: "music" as const, label: "NeteaseJukebox" },
		connection: { status: "connected" as const, lastError: null },
		playback: {
			status: "idle" as const,
			playMode: "queue_order" as const,
			volumePercent: 80,
			currentTrack: null,
			positionMs: 0,
			durationMs: null,
		},
		lyrics: { previous: null, current: null, next: null },
		queue: { items: [], total: 0 },
		spectrum: { source: "silent" as const, bands: [0], energy: 0, beat: 0 },
	};
}

describe("BroadcastHudClient", () => {
	afterEach(() => vi.restoreAllMocks());

	it("keeps only the latest pending snapshot while a request is in flight", async () => {
		const releases: Array<(response: Response) => void> = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					releases.push(resolve);
				}),
		);
		const client = new BroadcastHudClient({ baseUrl: "http://hud.test", fetch: fetchMock });

		const first = client.publish(snapshot(1));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		const second = client.publish(snapshot(2));
		const third = client.publish(snapshot(3));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		releases[0]!(new Response("{}", { status: 200 }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		releases[1]!(new Response("{}", { status: 200 }));
		await Promise.all([first, second, third]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).revision).toBe(3);
		await client.close();
	});

	it("does not publish after close", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const client = new BroadcastHudClient({ baseUrl: "http://hud.test", fetch: fetchMock });
		await client.close();

		const result = await client.publish(snapshot(1));

		expect(result).toMatchObject({ accepted: false, reason: "unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
