import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, keys, absolute } from "../.uina/worlds/live2d/authoring/motion.js";
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
	const evidence = () => ({ accepted: true, acceptedInputs: ["FaceAngleX"], sent: 1, failed: 0, pending: 0 });
	const client = {
		isConnected: () => state.connected,
		getModelProfile: () => ({ modelID: state.modelID, physicsOutputs: [] }),
		getModelGeneration: () => state.modelGeneration,
		getInjectionStats: () => ({ generation: state.connectionGeneration }),
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
					stunt: {
						description: "stunt",
						motion: fixtureMotion(),
						spatial: {
							segments: [
								{ delta: { x: 0.1 }, durationMs: 10, effects: { tint: { r: 200, g: 200, b: 200 } } },
								{ delta: { x: 0 }, durationMs: 10 },
							],
						},
					},
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
		rng: () => 0,
		cleanupTimeoutMs: options.cleanupTimeoutMs,
	});
	await runtime.start((options.context as ServiceCompanionContext) ?? ({} as ServiceCompanionContext));
	return { runtime, ...fake };
}
