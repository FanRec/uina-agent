import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileMotion, motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

/**
 * P2-3：runtime tick 合成接入。
 *
 * 合成推进纯函数化：composeTick(dtMs) 是注入时钟与测试的共用入口，手工步进，
 * 无真实定时器等待。客户端用鸭子类型假体——runtime 只依赖 isConnected /
 * getModelProfile / injectParameters 三个事实。
 */

interface InjectedFrame {
	id: string;
	value: number;
}

const MODEL_ID = "fixture-model";

const makeRig = (): ModelRig => ({
	version: 3,
	modelID: MODEL_ID,
	controls: {
		"head.yaw": { min: -12, max: 12, neutral: 0 },
		"torso.breath": { min: 0, max: 1, neutral: 0.5 },
	},
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
		"torso.breath": [
			{
				parameter: "ParamBreath",
				input: "FaceAngY",
				points: [
					[0, 0],
					[0.5, 0.5],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0,
			},
		],
	},
	external: { blink: "uina", breath: "vts" },
});

const makeProfile = (modelID = MODEL_ID): ModelProfile =>
	({
		modelID,
		physicsOutputs: [],
	}) as unknown as ModelProfile;

/** 鸭子类型假客户端：可手动拨动连接/身份事实，记录注入帧。 */
const makeFakeClient = (options: { connected?: boolean; modelID?: string } = {}) => {
	const state = {
		connected: options.connected ?? true,
		profile: makeProfile(options.modelID),
		injected: [] as InjectedFrame[][],
	};
	const client = {
		isConnected: () => state.connected,
		getModelProfile: () => state.profile,
		injectParameters: (frame: InjectedFrame[]) => {
			state.injected.push(frame);
		},
		setConnectionChangeListener: (_listener: (connected: boolean) => void) => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
	} as unknown as VTSClient;
	return { client, state };
};

const makeRuntime = (client: VTSClient, options: Partial<ConstructorParameters<typeof Live2DRuntime>[0]> = {}) =>
	new Live2DRuntime({ client, rig: makeRig(), ...options });

describe("live2d runtime tick 合成（P2-3）", () => {
	it("composeTick 驱动 director 合成并注入编码帧（合成推进纯函数化）", () => {
		const { client, state } = makeFakeClient();
		const rt = makeRuntime(client, { rng: () => 0.5 });
		const clip = compileMotion(
			motion(
				5000,
				track("head.yaw", [
					[0, 6],
					[5000, 6],
				]),
			),
			makeRig().controls,
		);
		rt.director!.play(clip, { category: "voluntary", fadeInMs: 0 });

		rt.composeTick(100);
		expect(state.injected).toHaveLength(1);
		const frame = state.injected[0]!;
		// 编码帧以 VTS 输入名注入，覆盖 rig 全部绑定输入，值来自 director 合成。
		expect(frame.map((p) => p.id).sort()).toEqual(["FaceAngY", "FaceAngleX"]);
		expect(frame.find((p) => p.id === "FaceAngleX")!.value).toBeCloseTo(15, 0); // 标尺：6→15（±微晃残留 <0.5）
		expect(frame.find((p) => p.id === "FaceAngY")!.value).toBe(0.5); // breath=vts 静默 → 中性

		// 时间推进由调用方 dt 决定：再推 100ms，动作仍在播放（5s），帧值不变。
		rt.composeTick(100);
		expect(state.injected).toHaveLength(2);
	});

	it("断线零输出：不合成不注入，重连后恢复", () => {
		const { client, state } = makeFakeClient({ connected: false });
		const rt = makeRuntime(client, { rng: () => 0.5 });
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);

		state.connected = true;
		rt.composeTick(16);
		expect(state.injected).toHaveLength(1);
	});

	it("身份门：VTS 当前模型与 rig 标定模型不匹配时零输出", () => {
		const { client, state } = makeFakeClient({ modelID: "another-model" });
		const rt = makeRuntime(client, { rng: () => 0.5 });
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);
	});

	it("发布门：未发布时不合成不注入（P4-6 接入验收门真值）", () => {
		const { client, state } = makeFakeClient();
		const rt = makeRuntime(client, { rng: () => 0.5, published: false });
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);
	});

	it("无 rig（装配失败降级）时零输出且 director 不存在", () => {
		const { client, state } = makeFakeClient();
		const rt = new Live2DRuntime({ client });
		expect(rt.director).toBeUndefined();
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);
	});
});
