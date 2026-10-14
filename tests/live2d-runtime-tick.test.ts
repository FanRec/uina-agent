import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileMotion, motion, keys, absolute } from "../.uina/worlds/live2d/authoring/motion.js";
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

/** 鸭子类型假客户端：可手动拨动连接/身份事实，记录注入帧。runtime 另读 getFault（fault getter）。 */
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
		getFault: () => undefined,
		setConnectionChangeListener: (_listener: (connected: boolean) => void) => {},
		connect: () => {},
		disconnect: () => {},
		getConnectionStatus: () => ({ connected: state.connected }),
	} as unknown as VTSClient;
	return { client, state };
};

const runtimes: Live2DRuntime[] = [];
afterEach(async () => {
	await Promise.allSettled(runtimes.splice(0).map((rt) => rt.stop()));
});
const makeRuntime = async (
	client: VTSClient,
	options: Partial<ConstructorParameters<typeof Live2DRuntime>[0]> = {},
) => {
	const rt = new Live2DRuntime({ client, rig: makeRig(), tickIntervalMs: 1_000_000, ...options });
	await rt.start({} as never);
	runtimes.push(rt);
	return rt;
};

describe("live2d runtime tick 合成（P2-3）", async () => {
	it("composeTick 驱动 director 合成并注入编码帧（合成推进纯函数化）", async () => {
		const { client, state } = makeFakeClient();
		const rt = await makeRuntime(client, { rng: () => 0.5 });
		const clip = compileMotion(
			motion(5000, {
				"head.yaw": absolute(
					keys([
						[0, 6],
						[5000, 6],
					]),
				),
			}),
			makeRig().controls,
		);
		rt.director!.play(clip, { category: "voluntary", fadeInMs: 0 });
		// 骨骼弹簧（ω=15）约 0.6s 收敛到轨迹值：逐 tick 推进 0.64s。
		for (let i = 0; i < 40; i++) rt.composeTick(16);
		expect(state.injected).toHaveLength(40);
		const frame = state.injected.at(-1)!;
		// 编码帧以 VTS 输入名注入，覆盖 rig 全部绑定输入，值来自 director 合成+管道。
		expect(frame.map((p) => p.id).sort()).toEqual(["FaceAngY", "FaceAngleX"]);
		expect(frame.find((p) => p.id === "FaceAngleX")!.value).toBeCloseTo(15, 0); // 弹簧已收敛；±微晃残留（抑制平滑 640ms 后 ~12%）<0.5
		expect(frame.find((p) => p.id === "FaceAngY")!.value).toBe(0.5); // breath=vts 静默 → 中性

		// 已收敛后再推 100ms，帧值稳定（动作仍在播放，5s；微晃低频变化 <0.3）。
		const before = frame.find((p) => p.id === "FaceAngleX")!.value;
		rt.composeTick(100);
		expect(Math.abs(state.injected.at(-1)!.find((p) => p.id === "FaceAngleX")!.value - before)).toBeLessThan(0.3);
	});

	it("断线零输出：不合成不注入，重连后恢复", async () => {
		const { client, state } = makeFakeClient({ connected: false });
		const rt = await makeRuntime(client, { rng: () => 0.5 });
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);

		state.connected = true;
		rt.composeTick(16);
		expect(state.injected).toHaveLength(1);
	});

	it("身份门：VTS 当前模型与 rig 标定模型不匹配时零输出", async () => {
		const { client, state } = makeFakeClient({ modelID: "another-model" });
		const rt = await makeRuntime(client, { rng: () => 0.5 });
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);
	});

	it("合成故障停车：网格漏检的病态曲线在运行期 NaN 时，fault 登记、播放有限结算、注入停止、工具拒绝", async () => {
		const { client, state } = makeFakeClient();
		const rt = await makeRuntime(client, { rng: () => 0.5 });
		// 病态窗口 (493,507) 恰落在 bake 探测网格点（步进 15.87ms：…492.06, 507.94…）之间——模拟网格漏检
		const clip = compileMotion(
			motion(1000, {
				"head.yaw": absolute((t) => (t > 493 && t < 507 ? Number.NaN : 0)),
			}),
			makeRig().controls,
		);
		const handle = rt.director!.play(clip, { category: "voluntary", fadeInMs: 0 });
		for (let i = 0; i < 40 && !rt.fault; i++) rt.composeTick(16);
		expect(rt.fault).toContain("身体合成失败");
		// 全部播放有限结算，不悬挂
		await expect(handle.finished).resolves.toMatchObject({ status: "cancelled", reason: "synthesis fault" });
		// 停车后不再合成注入
		const injectedCount = state.injected.length;
		rt.composeTick(16);
		expect(state.injected).toHaveLength(injectedCount);
		// 后续具身操作经 gate 以 fault 拒绝
		const rejected = await rt.state({}, {});
		expect(rejected).toMatchObject({ status: "failed", details: { reason: "fault" } });
	});

	it("无 rig（装配失败降级）时零输出且 director 不存在", async () => {
		const { client, state } = makeFakeClient();
		const rt = new Live2DRuntime({ client, tickIntervalMs: 1_000_000 });
		await rt.start({} as never);
		runtimes.push(rt);
		expect(rt.director).toBeUndefined();
		rt.composeTick(16);
		expect(state.injected).toHaveLength(0);
	});
});
