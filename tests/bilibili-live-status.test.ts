import { describe, expect, it } from "vitest";
import {
	applyLiveConnectionUpdate,
	handleConnectAction,
	handleStatusAction,
} from "../.uina/worlds/bilibili-live/src/index.js";
import { loadConfig } from "../.uina/worlds/bilibili-live/src/config.js";
import { LiveEventBuffer } from "../.uina/worlds/bilibili-live/src/buffer.js";
import type { LiveWorldState } from "../.uina/worlds/bilibili-live/src/types.js";

describe("Bilibili live connection status", () => {
	it("reports connect as an attempt until the WebSocket is confirmed", async () => {
		const config = loadConfig({ defaultRoomId: 24194689, storage: { dataDir: "./tmp-test" } });
		const state: LiveWorldState = {
			connectionStatus: "disconnected",
			lastConnectionError: null,
			retryCount: 0,
			totalRetryCount: 0,
			lastRetryDelaySeconds: null,
			roomId: 24194689,
			roomTitle: null,
			streamerName: null,
			roomStatus: "unknown",
			popularity: 0,
			lastHeartbeatTime: 0,
		};
		const result = await handleConnectAction(
			{},
			{} as never,
			config,
			state,
			() =>
				({
					connect: async () => undefined,
				}) as never,
		);

		expect(result.result).toContain("尚未确认连接成功");
		expect(state.connectionStatus).toBe("connecting");
	});

	it("updates but does not invent room status for live status 2", () => {
		const state = {
			roomStatus: "unknown",
		} as LiveWorldState;
		applyLiveConnectionUpdate(state, { type: "roomInfo", payload: { live_status: 2 } });
		applyLiveConnectionUpdate(state, { type: "roomStatus", payload: { status: "online" } });
		expect(state.roomStatus).toBe("online");
	});

	it("shows the last transport error and retry timing in status", () => {
		const config = loadConfig({ storage: { dataDir: "./tmp-test" } });
		const buffer = new LiveEventBuffer(config);
		const state = {
			connectionStatus: "connecting",
			roomId: 24194689,
			roomTitle: null,
			streamerName: null,
			roomStatus: "unknown",
			popularity: 0,
			lastHeartbeatTime: 0,
		} as LiveWorldState;
		applyLiveConnectionUpdate(state, {
			type: "roomInfo",
			payload: { room_id: 24194689, live_status: 1, title: "live" },
		});
		applyLiveConnectionUpdate(state, { type: "error", payload: new Error("getDanmuInfo HTTP error: 403") });
		applyLiveConnectionUpdate(state, {
			type: "reconnecting",
			payload: { retryCount: 3, totalRetryCount: 3, delaySeconds: 4 },
		});

		const status = JSON.parse(handleStatusAction(state, buffer).result);
		expect(status).toMatchObject({
			connection: "reconnecting",
			roomStatus: "online",
			lastConnectionError: "getDanmuInfo HTTP error: 403",
			retryCount: 3,
			totalRetryCount: 3,
			lastRetryDelaySeconds: 4,
		});
		buffer.dispose();
	});
});
