import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import { VTSClient, type WebSocketLike } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { motion, track } from "../.uina/worlds/live2d/authoring/motion.js";
import { compileMOCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

function advance(director: MotionDirector, ms: number): void {
	for (let elapsed = 0; elapsed < ms; elapsed += 10) director.step(Math.min(10, ms - elapsed));
}

async function authored() {
	const rig = (await loadRig(MO_MODEL_ID))!;
	const catalog = compileMOCatalog(rig);
	const director = new MotionDirector(rig.controls, { external: rig.external, rng: () => 0 });
	director.setAuthoredIdle(true);
	return { rig, catalog, director };
}

/** 协议边界假设备，参数 ACK 由测试控制；位置请求保留可检查的轨迹。 */
class Device implements WebSocketLike {
	readyState = 1;
	bufferedAmount = 0;
	onopen: WebSocketLike["onopen"] = null;
	onclose: WebSocketLike["onclose"] = null;
	onerror: WebSocketLike["onerror"] = null;
	onmessage: WebSocketLike["onmessage"] = null;
	pose = { positionX: 0.2, positionY: -0.1, rotation: 10, size: -30 };
	moves: Record<string, number>[] = [];
	tints: Record<string, number>[] = [];
	postProcessings: Record<string, unknown>[] = [];
	ack = true;
	failMove = false;
	failTint = false;
	holdMoveAck = false;
	/** 模拟用户在 VTS 打开特效配置窗口：期间 PostProcessingUpdateRequest 一律被协议拒绝。 */
	windowOpen = false;
	postProcessingState = { active: false, activePreset: null as string | null };
	modelID = MO_MODEL_ID;
	inputs: { name: string; min: number; max: number; defaultValue: number }[] = [];
	close(): void {
		this.readyState = 3;
	}
	send(raw: string, cb?: (error?: Error) => void): void {
		const request = JSON.parse(raw);
		cb?.();
		let data: unknown = {};
		switch (request.messageType) {
			case "AuthenticationRequest":
				data = { authenticated: true };
				break;
			case "InputParameterListRequest":
				data = { defaultParameters: this.inputs };
				break;
			case "Live2DParameterListRequest":
				data = { parameters: this.inputs };
				break;
			case "CurrentModelRequest":
				data = { modelLoaded: true, modelID: this.modelID, modelPosition: this.pose };
				break;
			case "InjectParameterDataRequest":
				if (!this.ack) return;
				break;
			case "ColorTintRequest": {
				this.tints.push(request.data.colorTint);
				if (this.failTint) {
					this.failTint = false;
					this.reply(request.requestID, "APIError", { errorID: 1, message: "tint failed" });
					return;
				}
				break;
			}
			case "PostProcessingListRequest":
				data = {
					postProcessingActive: this.postProcessingState.active,
					...(this.postProcessingState.activePreset !== null
						? { activePreset: this.postProcessingState.activePreset }
						: {}),
					canSendPostProcessingUpdateRequestRightNow: !this.windowOpen,
				};
				break;
			case "PostProcessingUpdateRequest": {
				this.postProcessings.push(request.data);
				if (this.windowOpen) {
					this.reply(request.requestID, "APIError", { errorID: 229, message: "CannotUpdateRightNow" });
					return;
				}
				this.postProcessingState.active = request.data.postProcessingOn;
				if (request.data.setPostProcessingPreset) this.postProcessingState.activePreset = request.data.presetToSet;
				break;
			}
			case "MoveModelRequest": {
				this.moves.push(request.data);
				if (this.failMove) {
					this.failMove = false;
					this.reply(request.requestID, "APIError", { errorID: 1, message: "move failed" });
					return;
				}
				for (const key of Object.keys(this.pose) as (keyof typeof this.pose)[])
					if (request.data[key] !== undefined) this.pose[key] = request.data[key];
				if (this.holdMoveAck) {
					this.holdMoveAck = false;
					return;
				}
			}
		}
		this.reply(request.requestID, request.messageType.replace("Request", "Response"), data);
	}
	reply(requestID: string, messageType: string, data: unknown): void {
		this.onmessage?.({ data: JSON.stringify({ requestID, messageType, data }) });
	}
}

const clients: VTSClient[] = [];
const runtimes: Live2DRuntime[] = [];
afterEach(async () => {
 await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
	for (const client of clients.splice(0)) client.disconnect();
	vi.useRealTimers();
});

/**
 * 特效框架探针夹具：临时测试用 stunt（不依赖 MO 目录动作），两段时间轴——
 * 段1 位移+染色+滤镜进入并保持，段2 纯位移归零；效果复位由运行时守护执行。
 */
async function connectedEffects() {
	const rig = (await loadRig(MO_MODEL_ID))!;
	const catalog = compileCatalog(
		MO_MODEL_ID,
		{
			motions: {
				fx_probe: {
					description: "特效框架探针",
					motion: motion(
						620,
						track("head.yaw", [
							[0, 2],
							[620, 2],
						]),
					),
					spatial: {
						segments: [
							{
								durationMs: 120,
								holdMs: 200,
								delta: { y: 0.05 },
								effects: {
									tint: { r: 120, g: 120, b: 128 },
									postProcessing: { on: true, preset: "Grayscale", fadeTime: 0.1 },
								},
							},
							{ durationMs: 300, delta: { y: 0 } },
						],
					},
				},
				fx_plain: {
					description: "无效果对照探针",
					motion: motion(
						620,
						track("head.yaw", [
							[0, 2],
							[620, 2],
						]),
					),
					spatial: {
						segments: [
							{ durationMs: 120, holdMs: 200, delta: { y: 0.05 } },
							{ durationMs: 300, delta: { y: 0 } },
						],
					},
				},
			},
		},
		rig,
	);
	const device = new Device();
	device.inputs = [...new Set(Object.values(rig.bindings).flatMap((bindings) => bindings.map((b) => b.input)))].map(
		(name) => ({ name, min: -100, max: 100, defaultValue: 0 }),
	);
	const profile: ModelProfile = {
		modelID: rig.modelID,
		modelName: "MO fixture",
		mappings: [],
		inputs: [],
		parameterRanges: {},
		physicsOutputs: [],
		sources: [],
		activeExpressions: [],
	};
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => device,
		profileLoader: async () => profile,
	});
	clients.push(client);
	client.connect();
	device.onopen?.({});
	for (let i = 0; i < 60; i++) await Promise.resolve();
	expect(client.isConnected()).toBe(true);
	const runtime = new Live2DRuntime({ rig, catalog, client, rng: () => 0, tickIntervalMs: 1_000_000 });
 await runtime.start({} as never); runtimes.push(runtime);
	return { runtime, device, client, rig, catalog };
}

async function connected(tickIntervalMs = 1_000_000) {
	const { rig, catalog } = await authored();
	const device = new Device();
	device.inputs = [...new Set(Object.values(rig.bindings).flatMap((bindings) => bindings.map((b) => b.input)))].map(
		(name) => ({ name, min: -100, max: 100, defaultValue: 0 }),
	);
	const profile: ModelProfile = {
		modelID: rig.modelID,
		modelName: "MO fixture",
		mappings: [],
		inputs: [],
		parameterRanges: {},
		physicsOutputs: [],
		sources: [],
		activeExpressions: [],
	};
	const client = new VTSClient({
		token: "fixture",
		webSocketFactory: () => device,
		profileLoader: async () => profile,
	});
	clients.push(client);
	client.connect();
	device.onopen?.({});
	for (let i = 0; i < 60; i++) await Promise.resolve();
	expect(client.isConnected()).toBe(true);
	const runtime = new Live2DRuntime({ rig, catalog, client, rng: () => 0, tickIntervalMs });
 await runtime.start({} as never); runtimes.push(runtime);
	return { runtime, device, client, rig, catalog };
}

describe("MO 表演实际合成与执行", () => {
	it("Wink 在生理眨眼到点时仍单侧闭合，结束回到半眯表情且恢复眨眼", async () => {
		const { director, catalog } = await authored();
		const smirk = catalog.resolve("expression", "smirk")!.entry;
		const setting = director.setExpression(smirk.values, { durationMs: 0 });
		advance(director, 1900);
		await setting;
		const wink = catalog.resolve("motion", "wink")!.entry;
		const handle = director.play(wink.motion, { category: "voluntary", ...wink.playback });
		advance(director, 210);
		expect(director.currentFrame["eyes.left.open"]).toBe(0);
		expect(director.currentFrame["eyes.right.open"]).toBeGreaterThan(0.85);
		advance(director, 400);
		const beforeRelease = director.currentFrame["eyes.right.open"]!;
		director.step(10);
		expect(Math.abs(director.currentFrame["eyes.right.open"]! - beforeRelease)).toBeLessThan(0.03);
		advance(director, 500);
		await handle.finished;
		expect(director.currentFrame["eyes.left.open"]).toBeCloseTo(0.55);
		expect(director.currentFrame["eyes.right.open"]).toBeCloseTo(0.55);
		let blink = false;
		for (let i = 0; i < 300; i++) {
			director.step(10);
			blink ||= director.currentFrame["eyes.left.open"]! < 0.3;
		}
		expect(blink).toBe(true);
	});

	it("偷瞄退出从当前眼球平滑交还，使用动作期间新设置的目标", async () => {
		const { director, catalog } = await authored();
		director.setAttention("user");
		director.play(catalog.resolve("motion", "glance")!.entry.motion, { category: "voluntary" });
		advance(director, 790);
		const before = director.currentFrame["gaze.x"]!;
		director.setAttention("avert_left");
		director.step(10);
		expect(Math.abs(director.currentFrame["gaze.x"]! - before)).toBeLessThan(0.04);
		advance(director, 500);
		expect(director.getAttention()).toBe("avert_left");
		expect(director.currentFrame["gaze.x"]).toBeCloseTo(-0.8, 1);
	});

	it("背景跨周期、冻结、遮挡和恢复保持同一实例与连续相位", async () => {
		const { director, catalog } = await authored();
		const idle = director.play(catalog.background.idle!, {
			category: "autonomic",
			loop: true,
			background: true,
			atomic: false,
		});
		advance(director, 4900);
		expect(idle.status).toBe("playing");
		expect(director.currentFrame["head.roll"]).toBeGreaterThan(2.5);
		const phase = idle.currentTime;
		director.setFrozen(true);
		advance(director, 1000);
		expect(idle.currentTime).toBe(phase);
		director.setFrozen(false);
		director.play(catalog.resolve("motion", "curious")!.entry.motion, { category: "voluntary" });
		advance(director, 600);
		expect(director.frameContributions.has(idle.id)).toBe(false);
		advance(director, 1300);
		expect(idle.status).toBe("playing");
		expect(idle.currentTime).toBeCloseTo(((4900 + 1900) % 3800) / 1000);
		expect(director.frameContributions.has(idle.id)).toBe(true);
		idle.stop("cut");
		await expect(idle.finished).resolves.toMatchObject({ status: "cancelled" });
	});

	it("思考入场被迅速结束时从当前贡献收势，不跳到完整姿势", async () => {
		const { director, catalog } = await authored();
		const thinking = director.play(catalog.background.thinking!, {
			category: "transition",
			loop: true,
			background: true,
			fadeInMs: 350,
			fadeOutMs: 450,
		});
		advance(director, 80);
		thinking.stop("release");
		advance(director, 120);
		expect(director.currentFrame["head.roll"]).toBeLessThan(0.6);
		advance(director, 500);
		await thinking.finished;
	});

	it("头部余量同比缩小增量，临时张嘴保留讲话口型", async () => {
		const { director, catalog } = await authored();
		const setting = director.setPosture({ "head.pitch": -8 }, { durationMs: 0 });
		advance(director, 800);
		await setting;
		director.play(catalog.resolve("motion", "nod")!.entry.motion, { category: "voluntary" });
		advance(director, 330);
		expect(director.currentFrame["head.pitch"]).toBeGreaterThanOrEqual(-10);
		advance(director, 800);
		director.setSpeechLevel(0.8);
		director.play(catalog.resolve("motion", "surprise")!.entry.motion, { category: "voluntary" });
		advance(director, 500);
		expect(director.currentFrame["mouth.open"]).toBeGreaterThan(0.8);
	});

	it.each(["surprise", "startle"])("%s 入场与收势只混合一次语音口型", async (name) => {
		const { director, catalog } = await authored();
		director.setSpeechLevel(0.65);
		advance(director, 300);
		const entry = catalog.resolve("motion", name)!.entry;
		const handle = director.play(entry.motion, { category: "voluntary", ...entry.playback });
		// 两个动作在最初 150ms 都没有作者张嘴，输出应保持语音开度。
		for (let elapsed = 0; elapsed < 150; elapsed += 10) {
			director.step(10);
			expect(director.currentFrame["mouth.open"]).toBeCloseTo(0.65, 10);
		}
		advance(director, entry.motion.durationMs - 160);
		let previous = director.currentFrame["mouth.open"]!;
		// 作者张嘴已经归零：自然退场不能再次增加开度。
		for (let elapsed = 0; elapsed < 500; elapsed += 10) {
			director.step(10);
			const current = director.currentFrame["mouth.open"]!;
			expect(current).toBeLessThanOrEqual(previous + 1e-10);
			previous = current;
		}
		await handle.finished;
		expect(previous).toBeCloseTo(0.65, 3);
	});

	it("真实注入观察器按本次贡献结算；前次接受不能证明完全遮挡的新动作", async () => {
		const { runtime, catalog } = await connected();
		const entry = catalog.resolve("motion", "wink")!.entry;
		const first = runtime.express({ motion: "wink" }, {});
		for (let i = 0; i < 100; i++) runtime.composeTick(10);
		await expect(first).resolves.toMatchObject({ status: "succeeded", details: { verification: "input_accepted" } });
		const newer = runtime.express({ motion: "wink", atomic: false }, {});
		runtime.director!.play(entry.motion, { category: "reflex", inhibitAdditives: true });
		for (let i = 0; i < 100; i++) runtime.composeTick(10);
		await expect(newer).resolves.toMatchObject({ status: "unknown" });
	});

	it("思考保持超过原短片段，反复通知不会重启，暂停后继续有效状态", async () => {
		const { runtime } = await connected();
		runtime.setThinking(true);
		for (let i = 0; i < 800; i++) runtime.composeTick(10);
		expect(runtime.director!.currentFrame["gaze.y"]).toBeGreaterThan(0.25);
		const time = runtime.director!.currentFrame["head.roll"];
		runtime.setThinking(true);
		runtime.composeTick(0);
		expect(runtime.director!.currentFrame["head.roll"]).toBe(time);
		const nod = runtime.express({ motion: "nod" }, {});
		for (let i = 0; i < 35; i++) runtime.composeTick(10);
		expect(Math.abs(runtime.director!.currentFrame["gaze.y"]!)).toBeLessThan(0.08);
		for (let i = 0; i < 100; i++) runtime.composeTick(10);
		await nod;
		expect(runtime.director!.currentFrame["gaze.y"]).toBeGreaterThan(0.25);
		await runtime.safeStop();
		await runtime.resume();
		for (let i = 0; i < 60; i++) runtime.composeTick(10);
		expect(runtime.director!.currentFrame["gaze.y"]).toBeGreaterThan(0.25);
		runtime.setThinking(false);
		for (let i = 0; i < 100; i++) runtime.composeTick(10);
		expect(Math.abs(runtime.director!.currentFrame["gaze.y"]!)).toBeLessThan(0.1);
	});

	it("雀跃完整执行五段，参数输入接受与空间归位分别核实", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connected();
		const base = { ...device.pose };
		const run = runtime.express({ motion: "joy_hop" }, {});
		for (let i = 0; i < 140; i++) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(run).resolves.toMatchObject({
			status: "succeeded",
			details: { restored: true, verification: "input_accepted" },
		});
		expect(device.moves.map((m) => m.positionY)).toEqual([
			expect.closeTo(-0.115),
			expect.closeTo(-0.02),
			expect.closeTo(-0.1),
			expect.closeTo(-0.08),
			expect.closeTo(-0.1),
		]);
		expect(device.pose).toEqual(base);
	});

	it.each(["moving", "pending_ack", "settling"] as const)("雀跃 %s 时失焦取消并归位，回焦可再次执行", async (phase) => {
		vi.useFakeTimers();
		const { runtime, device } = await connected();
		const base = { ...device.pose };
		device.holdMoveAck = phase === "pending_ack";
		const run = runtime.express({ motion: "joy_hop" }, {});
		const elapsedMs = phase === "settling" ? 1200 : 30;
		for (let elapsed = 0; elapsed < elapsedMs; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		const moves = device.moves.length;
		runtime.setFocused(false);
		const frame = { ...runtime.director!.currentFrame };
		for (let elapsed = 0; elapsed < 400; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(run).resolves.toMatchObject({ status: "cancelled", details: { restored: true } });
		expect(device.moves).toHaveLength(moves + 1);
		expect(device.moves.at(-1)?.timeInSeconds).toBe(0.25);
		expect(device.pose).toEqual(base);
		expect(runtime.director!.currentFrame).toEqual(frame);
		// 失焦期间新请求也不能发送空间移动（unfocused → failed，非 cancelled）。
		await expect(runtime.express({ motion: "joy_hop" }, {})).resolves.toMatchObject({
			status: "failed",
			details: { effectStatus: "not_started", reason: "unfocused" },
		});
		expect(device.moves).toHaveLength(moves + 1);
		runtime.setFocused(true);
		const next = runtime.express({ motion: "joy_hop" }, {});
		for (let elapsed = 0; elapsed < 1400; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(next).resolves.toMatchObject({ status: "succeeded", details: { restored: true } });
		expect(device.pose).toEqual(base);
	});

	it.each(["cancel", "error", "model"] as const)("雀跃 %s 后不再推进；旧模型位姿不写入新模型", async (mode) => {
		vi.useFakeTimers();
		const { runtime, device, client } = await connected();
		const base = { ...device.pose };
		const run = runtime.express({ motion: "joy_hop" }, {});
		await vi.advanceTimersByTimeAsync(30);
		if (mode === "error") device.failMove = true;
		if (mode === "model") {
			device.modelID = "another-model";
			vi.spyOn(client, "getModelProfile").mockReturnValue({ ...client.getModelProfile()!, modelID: device.modelID });
		}
		const stopped = mode === "cancel" ? runtime.safeStop() : undefined;
		await vi.advanceTimersByTimeAsync(1500);
		const result = await run;
		if (stopped) await stopped;
		expect(result.status).toBe(mode === "error" ? "unknown" : "cancelled");
		if (mode === "model") expect(device.moves).toHaveLength(1);
		else {
			expect(device.pose).toEqual(base);
			expect(device.moves.at(-1)?.timeInSeconds).toBe(0.25);
		}
	});

	it("已连接客户端启动后会驱动实际注入时钟", async () => {
		vi.useFakeTimers();
		const { runtime } = await connected(1000 / 60);
		await runtime.start({ expose: () => () => {} } as never);
		const run = runtime.express({ motion: "nod" }, {});
		await vi.advanceTimersByTimeAsync(1200);
		await expect(run).resolves.toMatchObject({ status: "succeeded", details: { verification: "input_accepted" } });
		await runtime.stop();
	});

	it("雀跃移动 ACK 未到时也能立即取消等待并以归位覆盖在途运动", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connected();
		const base = { ...device.pose };
		device.holdMoveAck = true;
		const run = runtime.express({ motion: "joy_hop" }, {});
		await vi.advanceTimersByTimeAsync(30);
		const stopped = runtime.safeStop();
		await vi.advanceTimersByTimeAsync(400);
		await stopped;
		await expect(run).resolves.toMatchObject({ status: "cancelled", details: { restored: true } });
		expect(device.moves).toHaveLength(2);
		expect(device.pose).toEqual(base);
	});

	it("回合打断立即停止雀跃后续段；设备身份回读与缓存不符时不向新模型归位", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connected();
		const run = runtime.express({ motion: "joy_hop" }, {});
		await vi.advanceTimersByTimeAsync(30);
		runtime.interrupt();
		await vi.advanceTimersByTimeAsync(400);
		await expect(run).resolves.toMatchObject({ status: "cancelled", details: { restored: true } });
		expect(device.moves).toHaveLength(2);

		const switched = runtime.express({ motion: "joy_hop" }, {});
		await vi.advanceTimersByTimeAsync(30);
		device.modelID = "new-device-model";
		await vi.advanceTimersByTimeAsync(1500);
		await expect(switched).resolves.toMatchObject({ status: "unknown", details: { restored: false } });
		expect(device.moves).toHaveLength(3);
	});

	it("特效用例 A：染色与滤镜按段生效，播完归位白并恢复进入时滤镜状态", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connectedEffects();
		// 用户进入前已开启自己的滤镜：归位必须恢复该状态而非无脑关闭。
		device.postProcessingState = { active: true, activePreset: "user_fx" };
		const run = runtime.express({ motion: "fx_probe" }, {});
		for (let elapsed = 0; elapsed < 200; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		expect(device.tints).toEqual([{ colorR: 120, colorG: 120, colorB: 128, colorA: 255 }]);
		expect(device.postProcessings[0]).toMatchObject({
			postProcessingOn: true,
			setPostProcessingPreset: true,
			presetToSet: "Grayscale",
		});
		for (let elapsed = 0; elapsed < 1500; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(run).resolves.toMatchObject({
			status: "succeeded",
			details: { restored: true, restoredEffects: { tint: true, post: true } },
		});
		expect(device.tints.at(-1)).toEqual({ colorR: 255, colorG: 255, colorB: 255, colorA: 255 });
		expect(device.postProcessings.at(-1)).toMatchObject({
			postProcessingOn: true,
			setPostProcessingPreset: true,
			presetToSet: "user_fx",
		});
		expect(device.pose).toEqual({ positionX: 0.2, positionY: -0.1, rotation: 10, size: -30 });
	});

	it("特效用例 B：中途取消立即三路归位，后续段与残留效果为零", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connectedEffects();
		const run = runtime.express({ motion: "fx_probe" }, {});
		for (let elapsed = 0; elapsed < 150; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		expect(device.tints).toHaveLength(1);
		runtime.setFocused(false);
		for (let elapsed = 0; elapsed < 600; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(run).resolves.toMatchObject({
			status: "cancelled",
			details: { restored: true, restoredEffects: { tint: true, post: true } },
		});
		// 段2 未派发；效果归位恰为一次白 + 一次滤镜恢复。
		expect(device.tints).toHaveLength(2);
		expect(device.tints.at(-1)).toEqual({ colorR: 255, colorG: 255, colorB: 255, colorA: 255 });
		expect(device.postProcessings).toHaveLength(2);
		expect(device.postProcessings.at(-1)?.postProcessingOn).toBe(false);
		expect(device.moves.at(-1)?.timeInSeconds).toBe(0.25);
		expect(device.pose).toEqual({ positionX: 0.2, positionY: -0.1, rotation: 10, size: -30 });
	});

	it("特效用例 C：染色分发失败如实 unknown，段序列与全量归位仍继续", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connectedEffects();
		device.failTint = true; // 仅段1 染色请求报错
		const run = runtime.express({ motion: "fx_probe" }, {});
		for (let elapsed = 0; elapsed < 1800; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		const result = await run;
		expect(result.status).toBe("unknown");
		expect(result.result).toContain("未完整");
		expect(result.result).toContain("tint failed");
		expect(result.details).toMatchObject({ restored: true, restoredEffects: { tint: true, post: true } });
		// 失败的染色请求之后，段2 照常派发，归位白仍执行。
		expect(device.postProcessings.at(-1)?.postProcessingOn).toBe(false);
		expect(device.tints.at(-1)).toEqual({ colorR: 255, colorG: 255, colorB: 255, colorA: 255 });
	});

	it("特效用例 D：VTS 特效窗口打开时恢复被拒，restoredEffects 分项如实 unknown", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connectedEffects();
		device.postProcessingState = { active: true, activePreset: "user_fx" };
		const run = runtime.express({ motion: "fx_probe" }, {});
		for (let elapsed = 0; elapsed < 150; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		device.windowOpen = true; // 恢复窗口期协议拒绝
		for (let elapsed = 0; elapsed < 1800; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		const result = await run;
		expect(result.status).toBe("unknown");
		expect(result.result).toContain("滤镜归位未确认");
		expect(result.details).toMatchObject({ restored: true, restoredEffects: { tint: true, post: false } });
	});

	it("特效用例 E：无 effects 的空间特技不触碰用户染色与滤镜（所有权守护）", async () => {
		vi.useFakeTimers();
		const { runtime, device } = await connectedEffects();
		device.postProcessingState = { active: true, activePreset: "user_fx" };
		const run = runtime.express({ motion: "fx_plain" }, {});
		for (let elapsed = 0; elapsed < 1800; elapsed += 10) {
			await vi.advanceTimersByTimeAsync(10);
			runtime.composeTick(10);
		}
		await expect(run).resolves.toMatchObject({
			status: "succeeded",
			details: { restored: true, restoredEffects: { tint: true, post: true } },
		});
		// 守护缺位时这里会多出白染色与滤镜复位请求，踩掉用户自有特效状态。
		expect(device.tints).toHaveLength(0);
		expect(device.postProcessings).toHaveLength(0);
	});
});
