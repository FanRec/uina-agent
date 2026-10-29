import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { type CatalogSource, compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { absolute, keys, motion } from "../.uina/worlds/live2d/authoring/index.js";
import type { SpatialEffects } from "../.uina/worlds/live2d/authoring/spatial.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";

export const refactorRig = (): ModelRig => ({
	version: 3,
	modelID: "refactor-fixture",
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
	external: { blink: "none", breath: "none" },
});

export function refactorClient() {
	const state = {
		connected: true,
		modelID: "refactor-fixture",
		modelGeneration: 0,
		connectionGeneration: 0,
		pose: { positionX: 0, positionY: 0, rotation: 0, size: 0 },
		post: { active: true, activePreset: "user-preset" as string | null, canUpdateRightNow: true },
		failRead: false,
		failTintRestore: false,
		failPostRestore: false,
		moves: [] as unknown[],
		tints: [] as { r: number; g: number; b: number; a?: number }[],
		posts: [] as unknown[],
		listener: (_connected: boolean) => {},
		disconnects: 0,
	};
	const evidence = () => ({
		generation: 0,
		accepted: 1,
		acceptedInputs: ["FaceAngleX"],
		sentInputs: ["FaceAngleX"],
		sent: 1,
		failed: 0,
		dropped: 0,
		filtered: 0,
		pending: 0,
	});
	const client = {
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: state.modelID, physicsOutputs: [] }),
		getModelGeneration: () => state.modelGeneration,
		getConnectionGeneration: () => state.connectionGeneration,
		getInjectionStats: () => ({ sent: 0, accepted: 0, failed: 0, dropped: 0, filtered: 0, lastAcceptedAt: 0 }),
		getPostProcessingPresets: () => [],
		getFault: () => undefined,
		getConnectionStatus: () => ({ connected: state.connected }),
		connect: () => {},
		disconnect: () => {
			state.disconnects++;
		},
		setConnectionChangeListener: (listener: (connected: boolean) => void) => {
			state.listener = listener;
		},
		injectParameters: () => {},
		getModelPosition: async (expected?: string) => {
			if (expected && expected !== state.modelID) throw new Error("identity changed");
			return { ...state.pose };
		},
		moveModel: async (value: Record<string, unknown>) => {
			state.moves.push(value);
			Object.assign(state.pose, value);
		},
		readPostProcessing: async () => {
			if (state.failRead) throw new Error("baseline unavailable");
			return { ...state.post };
		},
		tintModel: async (value: { r: number; g: number; b: number; a?: number }) => {
			state.tints.push(value);
			if (state.failTintRestore && value.r === 255) throw new Error("tint restore failed");
		},
		updatePostProcessing: async (value: { on: boolean; preset?: string }) => {
			state.posts.push(value);
			if (state.failPostRestore && value.preset === "user-preset") throw new Error("post restore failed");
			state.post = { active: value.on, activePreset: value.preset ?? null, canUpdateRightNow: true };
		},
		findHotkey: (id: string) => ({ hotkeyID: id }),
		triggerHotkey: async () => {},
		observeMotionInjections: () => ({ snapshot: evidence, finish: async () => evidence(), close: () => {} }),
	} as unknown as VTSClient;
	return { client, state };
}

export const fixtureMotion = () =>
	motion(5, {
		"head.yaw": absolute(
			keys([
				[0, 0],
				[5, 0],
			]),
		),
	});

export const fixtureSpatialMotion = () => {
	const body = motion(1000, {
		"head.yaw": absolute(
			keys([
				[0, 0],
				[1000, 0],
			]),
		),
	});
	return (rng: () => number) => ({
		...body(rng),
		spatial: [
			{
				during: { startMs: 0, endMs: 200, durationMs: 200 },
				transform: { delta: { x: 0.1 } },
				effects: { tint: { r: 200, g: 200, b: 200 } },
			},
			{ during: { startMs: 200, endMs: 500, durationMs: 300 }, transform: { delta: { x: 0 } } },
		],
	});
};

export const fixtureEffectMotion = (effects: SpatialEffects) => {
	const body = motion(1000, {
		"head.yaw": absolute(
			keys([
				[0, 0],
				[1000, 0],
			]),
		),
	});
	return (rng: () => number) => ({ ...body(rng), spatial: [{ at: 0, effects }] });
};

/** 真实线程测试在 Worker 内创建这些函数，绝不构造默认 VTSClient。 */
export function refactorWorkerRuntime(onStatusChange: () => void) {
	const rig = refactorRig();
	const fake = refactorClient();
	const runtime = new Live2DRuntime({
		rig,
		client: fake.client,
		onStatusChange,
		catalog: compileCatalog(
			rig.modelID,
			{
				motions: {
					nod: { description: "nod", motion: fixtureMotion() },
					stunt: { description: "stunt", motion: fixtureSpatialMotion() },
				},
				postures: { lean: { description: "lean", values: { "head.yaw": 4 }, transitionMs: 10 } },
			},
			rig,
		),
	});
	return { runtime, ...fake };
}

export async function refactorRuntime(
	source: CatalogSource,
	options: { cleanupTimeoutMs?: number; context?: Partial<ServiceCompanionContext> } = {},
) {
	const rig = refactorRig();
	const fake = refactorClient();
	const runtime = new Live2DRuntime({
		rig,
		client: fake.client,
		catalog: compileCatalog(rig.modelID, source, rig),
		seed: 0,
		cleanupTimeoutMs: options.cleanupTimeoutMs,
	});
	await runtime.start((options.context as ServiceCompanionContext) ?? ({} as ServiceCompanionContext));
	return { runtime, ...fake };
}
