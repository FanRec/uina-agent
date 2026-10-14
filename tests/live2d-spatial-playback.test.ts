import { describe, expect, it } from "vitest";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileAction } from "../.uina/worlds/live2d/authoring/action.js";
import { absolute, timeline } from "../.uina/worlds/live2d/authoring/curves.js";
import type { SpatialEvent } from "../.uina/worlds/live2d/authoring/spatial.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { ExternalActions } from "../.uina/worlds/live2d/external-actions.js";
import { unconfirmedInjections } from "./live2d-injection-fixture.js";

const MODEL_ID = "spatial-action-fixture";
const RIG: ModelRig = {
	version: 3,
	modelID: MODEL_ID,
	controls: { "head.yaw": { min: -12, max: 12, neutral: 0 } },
	bindings: {
		"head.yaw": [
			{
				parameter: "ParamAngleX",
				input: "FaceAngleX",
				points: [
					[-12, -30],
					[0, 0],
					[12, 30],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
	},
	external: { blink: "vts", breath: "vts" },
};

interface Pose {
	positionX: number;
	positionY: number;
	rotation: number;
	size: number;
}

function createHarness(
	options: {
		tintDelayMs?: number;
		firstRotationAckDelayMs?: number;
		manualPoseChangeOnRead?: { read: number; pose: Partial<Pose> };
		manualPoseChangeAfterTintAck?: Partial<Pose>;
		firstAbsoluteMovePoseFraction?: number;
		firstAbsoluteMovePose?: Partial<Pose>;
		unsettledPoseReadAfterMove?: { moveIndex: number; reads: number; rotationOffset: number };
		failTintR?: number;
	} = {},
) {
	const state = {
		pose: { positionX: 0, positionY: 0, rotation: 12, size: 1 } as Pose,
		moveRequests: [] as Array<Record<string, unknown>>,
		tintRequests: [] as Array<Record<string, unknown>>,
		moveIndex: 0,
		positionReads: 0,
	};
	let unsettledPoseReads = options.unsettledPoseReadAfterMove?.reads ?? 0;
	const client = {
		...unconfirmedInjections(),
		isConnected: () => true,
		getModelProfile: () => ({ modelID: MODEL_ID }),
		getModelPosition: async () => {
			state.positionReads++;
			if (state.positionReads === options.manualPoseChangeOnRead?.read)
				Object.assign(state.pose, options.manualPoseChangeOnRead.pose);
			const observed = { ...state.pose };
			if (state.moveIndex === options.unsettledPoseReadAfterMove?.moveIndex && unsettledPoseReads > 0) {
				unsettledPoseReads--;
				observed.rotation += options.unsettledPoseReadAfterMove.rotationOffset;
			}
			return observed;
		},
		moveModel: async (request: Record<string, unknown>) => {
			state.moveRequests.push({ ...request });
			state.moveIndex++;
			if (request.valuesAreRelativeToModel === true && request.rotation !== undefined)
				if (options.firstRotationAckDelayMs && state.moveIndex === 1) {
					await new Promise((resolve) => setTimeout(resolve, options.firstRotationAckDelayMs));
					state.pose.rotation += request.rotation as number;
				} else state.pose.rotation += request.rotation as number;
			else if (request.valuesAreRelativeToModel === false) {
				if (state.moveIndex === 1 && options.firstAbsoluteMovePose)
					Object.assign(state.pose, options.firstAbsoluteMovePose);
				else {
					const fraction = state.moveIndex === 1 ? (options.firstAbsoluteMovePoseFraction ?? 1) : 1;
					for (const axis of ["positionX", "positionY", "rotation", "size"] as const)
						if (request[axis] !== undefined)
							state.pose[axis] += ((request[axis] as number) - state.pose[axis]) * fraction;
				}
			}
		},
		tintModel: async (tint: Record<string, unknown>) => {
			state.tintRequests.push({ ...tint });
			if (state.tintRequests.length === 1 && options.tintDelayMs) {
				await new Promise((resolve) => setTimeout(resolve, options.tintDelayMs));
				if (options.manualPoseChangeAfterTintAck) Object.assign(state.pose, options.manualPoseChangeAfterTintAck);
			}
			if (tint.r === options.failTintR) throw new Error("tint dispatch failed");
		},
		updatePostProcessing: async () => {},
		readPostProcessing: async () => ({ active: false, activePreset: null }),
		getPostProcessingPresets: () => [],
		getFault: () => undefined,
	} as unknown as VTSClient;
	const director = new MotionDirector(RIG.controls);
	const actions = new ExternalActions({
		client,
		rig: RIG,
		director,
		getCatalogGeneration: () => 0,
		isFocused: () => true,
		cleanupTimeoutMs: 1000,
	});
	let previous = performance.now();
	const clock = setInterval(() => {
		const now = performance.now();
		director.step(Math.min(now - previous, 50), now - previous);
		previous = now;
	}, 8);
	return { state, director, actions, stopClock: () => clearInterval(clock) };
}

const compileSpatial = (spatial: readonly SpatialEvent[], options: { durationMs?: number; speed?: number } = {}) => {
	const durationMs = options.durationMs ?? 800;
	return compileAction(
		() => ({
			timeline: timeline(durationMs),
			speed: options.speed,
			channels: { "head.yaw": absolute(() => 0) },
			spatial,
		}),
		RIG.controls,
		() => 0.5,
	);
};

describe("ExternalActions absolute spatial schedule", () => {
	it("uses ActionPlan spans, speed, and one event clock, and emits ACK diagnostics", async () => {
		const h = createHarness();
		const trace: unknown[] = [];
		const clip = compileSpatial(
			[{ during: { startMs: 100, endMs: 400, durationMs: 300 }, transform: { delta: { x: 0.3 } } }],
			{ durationMs: 500, speed: 2 },
		);
		try {
			const result = await h.actions.runSpatial(clip, {
				category: "voluntary",
				fadeInMs: 0,
				fadeOutMs: 0,
				description: "timed movement",
				onTrace: (event) => trace.push(event),
			});
			expect(result.status).toBe("unknown"); // fake VTS never confirms parameter injection
			const movement = h.state.moveRequests.find((request) => request.timeInSeconds !== 0)!;
			expect(movement.positionX).toBeCloseTo(0.3, 6);
			expect(movement.timeInSeconds).toBeGreaterThan(0);
			expect(movement.timeInSeconds).toBeLessThanOrEqual(0.15);
			expect(trace).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						phase: "baseline",
						modelID: MODEL_ID,
						basePose: { positionX: 0, positionY: 0, rotation: 12, size: 1 },
					}),
					expect.objectContaining({ phase: "dispatch", request: "moveModel", plannedAtMs: 100 }),
					expect.objectContaining({ phase: "ack", request: "moveModel", plannedAtMs: 100 }),
				]),
			);
		} finally {
			h.stopClock();
		}
	});

	it("does not dispatch a pose after effect ACK consumes the useful movement window", async () => {
		const h = createHarness({ tintDelayMs: 250 });
		const clip = compileSpatial([
			{
				during: { startMs: 0, endMs: 300, durationMs: 300 },
				transform: { delta: { x: 0.4 } },
				effects: { tint: { r: 255, g: 30, b: 20 } },
			},
		]);
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "late effect" });
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("spatial_window_missed");
			expect(h.state.moveRequests).toEqual([]);
		} finally {
			h.stopClock();
		}
	});

	it("does not dispatch attached effects when a transform window is already too short", async () => {
		const h = createHarness();
		const clip = compileSpatial([
			{
				during: { startMs: 0, endMs: 80, durationMs: 80 },
				transform: { delta: { x: 0.4 } },
				effects: { tint: { r: 255, g: 30, b: 20 } },
			},
		]);
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "short pose window" });
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("spatial_window_missed");
			expect(h.state.tintRequests).toEqual([]);
		} finally {
			h.stopClock();
		}
	});

	it("keeps marker effects active and applies later effect markers until the body finishes", async () => {
		const h = createHarness();
		const clip = compileSpatial(
			[
				{ at: 0, effects: { tint: { r: 255, g: 30, b: 20 } } },
				{ at: 100, effects: { tint: { r: 20, g: 30, b: 255 } } },
			],
			{ durationMs: 500 },
		);
		let finished = false;
		try {
			const running = h.actions
				.runSpatial(clip, { category: "voluntary", description: "persistent marker effect" })
				.then((result) => {
					finished = true;
					return result;
				});
			await new Promise((resolve) => setTimeout(resolve, 180));
			expect(finished).toBe(false);
			expect(h.state.tintRequests).toEqual([
				{ r: 255, g: 30, b: 20 },
				{ r: 20, g: 30, b: 255 },
			]);
			const result = await running;
			expect(result.status).toBe("unknown");
			expect(h.state.tintRequests).toEqual([
				{ r: 255, g: 30, b: 20 },
				{ r: 20, g: 30, b: 255 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
		} finally {
			h.stopClock();
		}
	});

	it("keeps an attached effect through its transform span and restores it only after body playback", async () => {
		const h = createHarness();
		const clip = compileSpatial(
			[
				{
					during: { startMs: 0, endMs: 200, durationMs: 200 },
					transform: { delta: { x: 0.3 } },
					effects: { tint: { r: 255, g: 30, b: 20 } },
				},
			],
			{ durationMs: 700 },
		);
		let finished = false;
		try {
			const running = h.actions
				.runSpatial(clip, { category: "voluntary", description: "attached effect lifetime" })
				.then((result) => {
					finished = true;
					return result;
				});
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(finished).toBe(false);
			expect(h.state.tintRequests).toEqual([{ r: 255, g: 30, b: 20 }]);
			const result = await running;
			expect(result.status).toBe("unknown");
			expect(h.state.tintRequests).toEqual([
				{ r: 255, g: 30, b: 20 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
		} finally {
			h.stopClock();
		}
	});

	it("preserves a same-model manual pose change and reports pose cleanup as unknown", async () => {
		const h = createHarness({
			manualPoseChangeOnRead: { read: 4, pose: { positionX: 2 } },
		});
		const clip = compileSpatial([
			{
				during: { startMs: 0, endMs: 250, durationMs: 250 },
				transform: { delta: { x: 0.3 } },
				effects: { tint: { r: 255, g: 30, b: 20 } },
			},
			{ during: { startMs: 300, endMs: 500, durationMs: 200 }, transform: { delta: { x: 0.7 } } },
		]);
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "manual pose change" });
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("external_pose_changed");
			expect((result.details as { cleanup?: { pose?: string } } | undefined)?.cleanup?.pose).toBe("unknown");
			expect(h.state.pose.positionX).toBe(2);
			expect(h.state.moveRequests).toHaveLength(1);
			expect(h.state.moveRequests[0]?.positionX).toBeCloseTo(0.3, 6);
			expect(h.state.tintRequests).toEqual([
				{ r: 255, g: 30, b: 20 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
		} finally {
			h.stopClock();
		}
	});

	it("rechecks pose after a delayed attached effect ACK before moving the model", async () => {
		const h = createHarness({
			tintDelayMs: 120,
			manualPoseChangeAfterTintAck: { positionX: 2 },
		});
		const clip = compileSpatial([
			{
				during: { startMs: 0, endMs: 500, durationMs: 500 },
				transform: { delta: { x: 0.3 } },
				effects: { tint: { r: 255, g: 30, b: 20 } },
			},
		]);
		try {
			const result = await h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "pose changed during tint ACK",
			});
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("external_pose_changed");
			expect(h.state.pose.positionX).toBe(2);
			expect(h.state.moveRequests).toEqual([]);
			expect((result.details as { cleanup?: { pose?: string } } | undefined)?.cleanup?.pose).toBe("unknown");
		} finally {
			h.stopClock();
		}
	});

	it("marks pose cleanup unknown when drift is found at the first event boundary", async () => {
		const h = createHarness({
			manualPoseChangeOnRead: { read: 2, pose: { positionX: 2 } },
		});
		const clip = compileSpatial([
			{
				during: { startMs: 0, endMs: 300, durationMs: 300 },
				transform: { delta: { x: 0.3 } },
				effects: { tint: { r: 255, g: 30, b: 20 } },
			},
		]);
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "initial boundary drift" });
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("external_pose_changed");
			expect((result.details as { cleanup?: { pose?: string } } | undefined)?.cleanup?.pose).toBe("unknown");
			expect(h.state.pose.positionX).toBe(2);
			expect(h.state.moveRequests).toEqual([]);
		} finally {
			h.stopClock();
		}
	});

	it("continues the body and later effect events after an effect dispatch failure", async () => {
		const h = createHarness({ failTintR: 50 });
		const clip = compileSpatial(
			[
				{ at: 0, effects: { tint: { r: 50, g: 30, b: 20 } } },
				{ at: 100, effects: { tint: { r: 60, g: 30, b: 20 } } },
			],
			{ durationMs: 500 },
		);
		const startedAt = Date.now();
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "effect failure" });
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
			expect(h.state.tintRequests).toEqual([
				{ r: 50, g: 30, b: 20 },
				{ r: 60, g: 30, b: 20 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("spatial_effect_unconfirmed");
		} finally {
			h.stopClock();
		}
	});

	it("cleans effects promptly when the body ActionPlan is cancelled", async () => {
		const h = createHarness();
		const controller = new AbortController();
		const clip = compileSpatial([{ at: 0, effects: { tint: { r: 255, g: 30, b: 20 } } }], { durationMs: 800 });
		const startedAt = Date.now();
		try {
			const running = h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "cancelled effect",
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			const result = await running;
			expect(Date.now() - startedAt).toBeLessThan(600);
			expect(result.status).toBe("cancelled");
			expect(h.state.tintRequests).toEqual([
				{ r: 255, g: 30, b: 20 },
				{ r: 255, g: 255, b: 255, a: 255 },
			]);
		} finally {
			h.stopClock();
		}
	});

	it("restores the baseline when cancelled during its own acknowledged VTS interpolation", async () => {
		const h = createHarness({ firstAbsoluteMovePoseFraction: 0.5 });
		const controller = new AbortController();
		const clip = compileSpatial(
			[{ during: { startMs: 0, endMs: 800, durationMs: 800 }, transform: { delta: { x: 0.4 } } }],
			{ durationMs: 900 },
		);
		try {
			const running = h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "cancelled interpolation",
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(h.state.pose.positionX).toBeCloseTo(0.2, 6);
			controller.abort();
			const result = await running;
			expect(result.status).toBe("cancelled");
			expect((result.details as { cleanup?: { pose?: string } } | undefined)?.cleanup?.pose).toBe("confirmed");
			expect(h.state.pose.positionX).toBe(0);
			expect(h.state.moveRequests).toHaveLength(2);
			expect(h.state.moveRequests[1]).toMatchObject({
				positionX: 0,
				timeInSeconds: 0.25,
				valuesAreRelativeToModel: false,
			});
		} finally {
			h.stopClock();
		}
	});

	it("preserves an off-path same-model pose change during an acknowledged interpolation", async () => {
		const h = createHarness({ firstAbsoluteMovePose: { positionX: 0.2, positionY: 0 } });
		const controller = new AbortController();
		const clip = compileSpatial(
			[{ during: { startMs: 0, endMs: 800, durationMs: 800 }, transform: { delta: { x: 0.4, y: 0.4 } } }],
			{ durationMs: 900 },
		);
		try {
			const running = h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "off-path manual pose",
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 80));
			controller.abort();
			const result = await running;
			expect(result.status).toBe("unknown");
			expect((result.details as { reason?: string } | undefined)?.reason).toBe("external_pose_changed");
			expect((result.details as { cleanup?: { pose?: string } } | undefined)?.cleanup?.pose).toBe("unknown");
			expect(h.state.pose).toMatchObject({ positionX: 0.2, positionY: 0 });
			expect(h.state.moveRequests).toHaveLength(1);
		} finally {
			h.stopClock();
		}
	});

	it.each([90, -90])("restores an owned exact 180 degree interpolation with %s degree progress", async (midpoint) => {
		const h = createHarness({ firstAbsoluteMovePose: { rotation: 12 + midpoint } });
		const controller = new AbortController();
		const clip = compileSpatial(
			[{ during: { startMs: 0, endMs: 800, durationMs: 800 }, transform: { delta: { rotation: 180 } } }],
			{ durationMs: 900 },
		);
		try {
			const running = h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "half turn interpolation",
				signal: controller.signal,
			});
			await new Promise((resolve) => setTimeout(resolve, 80));
			controller.abort();
			const result = await running;
			expect(result.status).toBe("cancelled");
			expect((result.details as { restored?: boolean } | undefined)?.restored).toBe(true);
			expect(h.state.pose.rotation).toBe(12);
		} finally {
			h.stopClock();
		}
	});

	it("uses the latest settled read when deciding whether another baseline move is needed", async () => {
		const h = createHarness({ unsettledPoseReadAfterMove: { moveIndex: 2, reads: 1, rotationOffset: 5 } });
		const clip = compileSpatial(
			[
				{ during: { startMs: 0, endMs: 300, durationMs: 300 }, transform: { delta: { x: 0.3 } } },
				{ during: { startMs: 300, endMs: 600, durationMs: 300 }, transform: { delta: { x: 0 } } },
			],
			{ durationMs: 700 },
		);
		try {
			const result = await h.actions.runSpatial(clip, { category: "voluntary", description: "settled baseline" });
			expect(result.status).toBe("unknown");
			expect((result.details as { restored?: boolean } | undefined)?.restored).toBe(true);
			expect(h.state.pose.positionX).toBe(0);
			expect(h.state.moveRequests).toHaveLength(2);
		} finally {
			h.stopClock();
		}
	});

	it("keeps delayed relative-rotation requests below the VTS shortest-arc limit", async () => {
		const h = createHarness({ firstRotationAckDelayMs: 350 });
		const trace: Array<Record<string, unknown>> = [];
		const clip = compileSpatial(
			[{ during: { startMs: 0, endMs: 600, durationMs: 600 }, transform: { relativeRotation: 359 } }],
			{ durationMs: 700 },
		);
		try {
			await h.actions.runSpatial(clip, {
				category: "voluntary",
				description: "relative rotation",
				onTrace: (event) => trace.push(event as unknown as Record<string, unknown>),
			});
			const increments = h.state.moveRequests
				.filter((request) => request.valuesAreRelativeToModel === true)
				.map((request) => Math.abs(request.rotation as number));
			expect(increments.length).toBeGreaterThan(2);
			expect(Math.max(...increments)).toBeLessThan(180);
			const firstAckIndex = trace.findIndex((event) => event.phase === "ack" && event.request === "moveModel");
			const firstAck = trace[firstAckIndex];
			const nextDispatch = trace
				.slice(firstAckIndex + 1)
				.find((event) => event.phase === "dispatch" && event.request === "moveModel");
			expect(firstAck?.lateByMs).toBeGreaterThan(100);
			expect(nextDispatch?.lateByMs).toBeLessThan(20);
			expect(nextDispatch?.eventLateByMs).toBeLessThan(20);
		} finally {
			h.stopClock();
		}
	});
});
