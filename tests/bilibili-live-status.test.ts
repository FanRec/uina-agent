import { describe, expect, it, vi } from "vitest";
import { LiveEventBuffer } from "../.uina/worlds/bilibili-live/src/buffer.js";
import { loadConfig } from "../.uina/worlds/bilibili-live/src/config.js";
import { DanmakuWindow } from "../.uina/worlds/bilibili-live/src/danmaku.js";
import {
	applyLiveConnectionUpdate,
	BatchedNotifier,
	handleConnectAction,
	handleStatusAction,
	RoomStatusNotifier,
} from "../.uina/worlds/bilibili-live/src/index.js";
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

		const status = JSON.parse(handleStatusAction(state, buffer, new DanmakuWindow(config)).result);
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

describe("RoomStatusNotifier", () => {
	const makeNotifier = (enabled = true) => {
		const emissions: Array<{ previous: string; status: string }> = [];
		const notifier = new RoomStatusNotifier(
			() => enabled,
			(previous, status) => emissions.push({ previous, status }),
		);
		return { notifier, emissions };
	};

	it("notifies the first real online transition after the baseline was seeded from roomInfo", () => {
		// 回归：此前基线恒为 unknown，World 启动后的首次开播被吞掉
		const { notifier, emissions } = makeNotifier();
		notifier.seed("offline");
		notifier.update("online");
		expect(emissions).toEqual([{ previous: "offline", status: "online" }]);
	});

	it("notifies offline after being seeded online, so a restart mid-live still reports 下播", () => {
		const { notifier, emissions } = makeNotifier();
		notifier.seed("online");
		notifier.update("offline");
		expect(emissions).toEqual([{ previous: "online", status: "offline" }]);
	});

	it("keeps suppressing the unknown-baseline first transition to avoid spurious alerts", () => {
		const { notifier, emissions } = makeNotifier();
		notifier.update("online");
		expect(emissions).toEqual([]);
		notifier.update("offline");
		expect(emissions).toEqual([{ previous: "online", status: "offline" }]);
	});

	it("tracks the baseline while disabled and does not emit", () => {
		const { notifier, emissions } = makeNotifier(false);
		notifier.seed("offline");
		notifier.update("online");
		expect(emissions).toEqual([]);
	});

	it("ignores duplicate status and non online/offline transitions", () => {
		const { notifier, emissions } = makeNotifier();
		notifier.seed("online");
		notifier.update("online");
		notifier.update("round" as never);
		expect(emissions).toEqual([]);
	});

	it("notifies online transition when baseline was seeded from round (loop playback)", () => {
		const { notifier, emissions } = makeNotifier();
		notifier.seed("round");
		notifier.update("online");
		expect(emissions).toEqual([{ previous: "round", status: "online" }]);
	});
});

describe("BatchedNotifier", () => {
	const makeNotifier = (enabled = true) => {
		const emissions: Array<{ id: string; text: string | null }> = [];
		let drained = 0;
		const notifier = new BatchedNotifier(
			2000,
			"bilibili:test-batch",
			() => enabled,
			() => {
				drained++;
				return drained === 1 ? "batch-text" : null;
			},
			(id, render) => emissions.push({ id, text: render() }),
		);
		return { notifier, emissions };
	};

	it("merges window arrivals into one emit and renders the drained text", () => {
		vi.useFakeTimers();
		try {
			const { notifier, emissions } = makeNotifier();
			notifier.notify();
			notifier.notify();
			notifier.notify();
			expect(notifier.pending).toBe(true);
			vi.advanceTimersByTime(2000);
			expect(emissions).toHaveLength(1);
			expect(emissions[0].id).toMatch(/^bilibili:test-batch:\d+:1$/);
			expect(emissions[0].text).toBe("batch-text");
			expect(notifier.pending).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not schedule when disabled", () => {
		vi.useFakeTimers();
		try {
			const { notifier, emissions } = makeNotifier(false);
			notifier.notify();
			vi.advanceTimersByTime(5000);
			expect(emissions).toEqual([]);
			expect(notifier.pending).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidate cancels the pending batch and kills the in-flight render", () => {
		vi.useFakeTimers();
		try {
			const { notifier, emissions } = makeNotifier();
			notifier.notify();
			notifier.invalidate();
			expect(notifier.pending).toBe(false);
			vi.advanceTimersByTime(5000);
			expect(emissions).toEqual([]);

			// 在途 render 在 invalidate 后返回 null（投递方不得渲染已失效批次）
			const holder: { render?: () => string | null } = {};
			const notifier2 = new BatchedNotifier(
				2000,
				"b",
				() => true,
				() => "t",
				(_id, render) => {
					holder.render = render;
				},
			);
			notifier2.notify();
			vi.advanceTimersByTime(2000);
			notifier2.invalidate();
			expect(holder.render?.()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips empty drains without emitting", () => {
		vi.useFakeTimers();
		try {
			let provideText = false;
			const emissions: string[] = [];
			const notifier = new BatchedNotifier(
				2000,
				"b",
				() => true,
				() => (provideText ? "text" : null),
				(id) => emissions.push(id),
			);
			notifier.notify();
			vi.advanceTimersByTime(2000);
			expect(emissions).toEqual([]);

			provideText = true;
			notifier.notify();
			vi.advanceTimersByTime(2000);
			// 空 drain 不占用序列号，首个真实投递是 b:<timestamp>:1
			expect(emissions).toHaveLength(1);
			expect(emissions[0]).toMatch(/^b:\d+:1$/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("supports drain re-arming notify, polling until the pool empties", () => {
		vi.useFakeTimers();
		try {
			// 模拟礼物池：连击跨过一次空 flush 后停手，drain 侧在池非空时续期轮询
			let hotFlushes = 1;
			const emissions: string[] = [];
			const notifier = new BatchedNotifier(
				2000,
				"b",
				() => true,
				() => {
					if (hotFlushes > 0) {
						hotFlushes--;
						notifier.notify();
						return null;
					}
					// 停手：整批上报，池空不再续期
					return "combo-total";
				},
				(id) => emissions.push(id),
			);
			notifier.notify();
			// 第一次 flush：条目仍热，无产出但续期轮询
			vi.advanceTimersByTime(2000);
			expect(emissions).toEqual([]);
			expect(notifier.pending).toBe(true);
			// 第二次 flush：连击停手，整批上报
			vi.advanceTimersByTime(2000);
			expect(emissions).toHaveLength(1);
			expect(emissions[0]).toMatch(/^b:\d+:1$/);
			// 池空后轮询自动停止
			expect(notifier.pending).toBe(false);
			vi.advanceTimersByTime(10000);
			expect(emissions).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("generates unique IDs across restarts using timestamp and monotonic sequence", () => {
		vi.useFakeTimers();
		try {
			const emissions: string[] = [];
			vi.setSystemTime(1000);
			// 运行期 1
			const run1 = new BatchedNotifier(
				2000,
				"bilibili:chat-batch",
				() => true,
				() => "batch-1",
				(id) => emissions.push(id),
			);
			run1.notify();
			vi.advanceTimersByTime(2000);

			// 模拟重启：序列号归零，但时间戳推进
			vi.setSystemTime(5000);
			const run2 = new BatchedNotifier(
				2000,
				"bilibili:chat-batch",
				() => true,
				() => "batch-2",
				(id) => emissions.push(id),
			);
			run2.notify();
			vi.advanceTimersByTime(2000);

			expect(emissions).toEqual(["bilibili:chat-batch:3000:1", "bilibili:chat-batch:7000:1"]);
			expect(emissions[0]).not.toBe(emissions[1]);
		} finally {
			vi.useRealTimers();
		}
	});
});
