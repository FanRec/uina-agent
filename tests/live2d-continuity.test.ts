import { compileExpression } from "../.uina/worlds/live2d/motion-library.js";
import type { ExpressParams } from "../.uina/worlds/live2d/types.js";
const playExpression = async (
	director: MotionDirector,
	params: ExpressParams,
	options?: Parameters<MotionDirector["play"]>[1],
) =>
	director.play(compileExpression(params), {
		...options,
		latch: params.latch_last ?? params.beats?.at(-1)?.latch,
		transition: params.transition,
		atomic: params.atomic,
	});
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { BodyDirector } from "../.uina/worlds/live2d/body-director.js";
import { BASE_POSES } from "../.uina/worlds/live2d/motion-library.js";
import { NEUTRAL_AXES } from "../.uina/worlds/live2d/motion-axes.js";
import { AudioObserver } from "../.uina/worlds/live2d/audio-observer.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { performModelFlip } from "../.uina/worlds/live2d/model-motion.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { VTSClient, type WebSocketLike } from "../.uina/worlds/live2d/vts-client.js";
import { compileModelAdapter } from "../.uina/worlds/live2d/model-adapter.js";
import { independentModelFixture } from "./live2d-model-fixture.js";
import { loadModelProfile, type ModelProfile } from "../.uina/worlds/live2d/model-profile.js";
import { BASE_POSE_NAMES, CHANNEL_PRIORITY } from "../.uina/worlds/live2d/types.js";
import { supportsMotion } from "../.uina/worlds/live2d/motion-library.js";

const advance = (director: MotionDirector, frames = 120, speechEnergy = 0) => {
	let frame: Record<string, number> = {};
	for (let i = 0; i < frames; i++) frame = director.compose(1000 / 60, { speechEnergy });
	return frame;
};
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const profile: ModelProfile = {
	modelID: "model",
	modelName: "fixture",
	physicsOutputs: ["ParamBodyAngleX"],
	inputs: ["FaceAngleX", "EyeOpenLeft", "EyeLeftX", "BrowLeftY", "MouthSmile", "MouthOpen"].map((name) => ({
		name,
		min: -30,
		max: 30,
		defaultValue: 0,
	})),
	parameterRanges: {
		ParamEyeLOpen: { min: 0, max: 1, defaultValue: 1 },
		ParamAngleX: { min: -30, max: 30, defaultValue: 0 },
		ParamBodyAngleX: { min: -10, max: 10, defaultValue: 0 },
		ParamEyeBallX: { min: -1, max: 1, defaultValue: 0 },
		ParamBrowLY: { min: -1, max: 1, defaultValue: 0 },
		ParamEyeLSmile: { min: 0, max: 1, defaultValue: 0 },
		ParamMouthForm: { min: -1, max: 1, defaultValue: 0 },
		ParamMouthOpenY: { min: 0, max: 1, defaultValue: 0 },
	},
	mappings: [
		{ input: "FaceAngleX", output: "ParamAngleX", inputMin: -30, inputMax: 30, outputMin: -30, outputMax: 30 },
		{ input: "FaceAngleX", output: "ParamBodyAngleX", inputMin: -30, inputMax: 30, outputMin: -10, outputMax: 10 },
		{ input: "EyeOpenLeft", output: "ParamEyeLOpen", inputMin: 0, inputMax: 0.8, outputMin: 0, outputMax: 1.9 },
		{ input: "EyeLeftX", output: "ParamEyeBallX", inputMin: -1, inputMax: 1, outputMin: 1, outputMax: -1 },
		{ input: "BrowLeftY", output: "ParamBrowLY", inputMin: 0.2, inputMax: 0.6, outputMin: -1, outputMax: 1 },
		{ input: "MouthSmile", output: "ParamEyeLSmile", inputMin: -1, inputMax: 1, outputMin: 0, outputMax: 1 },
		{ input: "MouthSmile", output: "ParamMouthForm", inputMin: -1, inputMax: 1, outputMin: -1, outputMax: 1 },
		{ input: "MouthOpen", output: "ParamMouthOpenY", inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 },
	],
};

describe("Live2D regression: ownership and continuous presentation", () => {
	it("independent leased head and gaze actions coexist; partial preemption follows the live lease", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const old = await d.claim(["head", "gaze"], { priority: CHANNEL_PRIORITY.CUE });
		const first = playExpression(
			d,
			{ beats: [{ head: "tilt_left", gaze: "away_left", hold_ms: 2800 }], latch_last: true },
			{ signal: old.signal, lease: old },
		);
		const head = await d.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });
		const second = playExpression(
			d,
			{ head: "tilt_right", beats: [{ head: "tilt_right", hold_ms: 3000 }] },
			{ signal: head.signal, lease: head },
		);
		expect(old.channels).toEqual(["gaze"]);
		const frame = advance(d);
		expect(frame["head.roll"]).toBeLessThan(-10);
		expect(frame["gaze.x"]).toBeLessThan(-0.8);
		expect(d.isPlaying()).toBe(true);
		d.compose(800);
		expect(await first).toEqual({ status: "completed" });
		old.release();
		expect(d.isPlaying()).toBe(true);
		expect(advance(d, 2)["head.roll"]).toBeLessThan(-10);
		head.release();
		expect(await second).toEqual({ status: "cancelled" });
	});
	it("runtime reports same-channel preemption as cancelled, and a disjoint action never cancels head", async () => {
		vi.useFakeTimers();
		const client = new VTSClient();
		vi.spyOn(client, "isConnected").mockReturnValue(true);
		vi.spyOn(client, "getModelProfile").mockReturnValue(independentModelFixture());
		vi.spyOn(client, "validateModelFiles").mockResolvedValue(true);
		const evidence = {
			sent: 1,
			accepted: 1,
			failed: 0,
			dropped: 0,
			filtered: 0,
			lastAcceptedAt: Date.now(),
			generation: 1,
		};
		vi.spyOn(client, "getInjectionStats").mockImplementation(() => ({ ...evidence }));
		const r = new Live2DRuntime({ vtsClient: client });
		const ctx = { signal: new AbortController().signal } as never;
		const head = r.executeExpress({ head: "tilt_left", beats: [{ head: "tilt_left", hold_ms: 3000 }] }, ctx);
		await Promise.resolve();
		await Promise.resolve();
		const gaze = r.executeExpress({ gaze: "down", beats: [{ gaze: "down", hold_ms: 100 }] }, ctx);
		await flushPromises();
		r.director.compose(450);
		evidence.sent++;
		evidence.accepted++;
		expect((await gaze).status).toBe("succeeded");
		expect(r.director.getActiveLeases().some((l) => l.channels.includes("head"))).toBe(true);
		const replacement = r.executeExpress({ head: "tilt_right", beats: [{ head: "tilt_right", hold_ms: 100 }] }, ctx);
		await flushPromises();
		r.director.compose(450);
		evidence.sent++;
		evidence.accepted++;
		expect((await head).status).toBe("cancelled");
		expect((await replacement).status).toBe("succeeded");
	});
	it("zero-time lock/unlock never jumps head, torso, gaze or blinking; resumed frames have bounded motion", async () => {
		const d = new MotionDirector(() => 0.5);
		let previous = advance(d, 80, 0.7);
		d.noise.triggerBlink();
		const lease = await d.claim(["head", "torso", "eyes", "gaze"], { priority: CHANNEL_PRIORITY.ACTION });
		expect(d.compose(0, { speechEnergy: 0.7 })).toEqual(previous);
		previous = d.compose(16, { speechEnergy: 0.7 });
		lease.release();
		expect(d.compose(0, { speechEnergy: 0.7 })).toEqual(previous);
		const next = d.compose(16, { speechEnergy: 0.7 });
		for (const name of ["head.roll", "torso.yaw", "gaze.x", "eyes.left.open"])
			expect(Math.abs(next[name]! - previous[name]!)).toBeLessThan(
				name.startsWith("head.") || name.startsWith("torso.") ? 2.5 : name.endsWith(".open") ? 0.45 : 0.15,
			);
	});
	it("thinking, pose cues, wakeup and acoustic accents cannot overwrite an ACTION head or gaze", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const lease = await d.claim(["head", "gaze"]);
		const playback = playExpression(
			d,
			{ head: "turn_right", gaze: "down", beats: [{ head: "turn_right", gaze: "down", hold_ms: 3000 }] },
			{ signal: lease.signal, lease },
		);
		advance(d);
		d.showStatePose("thinking");
		d.applyBasePose("shy_side");
		d.applyBasePose("shy_side", undefined, false);
		d.triggerAcousticImpulse();
		advance(d, 8, 0.7);
		expect(d.getParamTarget("head.yaw")).toBe(12); // active intent keeps its starting baseline
		expect(d.getParamTarget("gaze.y")).toBe(-0.85);
		expect(d.getParamTarget("head.pitch")).toBe(0);
		lease.release();
		expect((await playback).status).toBe("cancelled");
	});
	it("every base-pose pair resets omitted intent fields and keeps the current frame continuous", () => {
		for (const from of BASE_POSE_NAMES)
			for (const to of BASE_POSE_NAMES) {
				const d = new MotionDirector(() => 0.5);
				d.applyBasePose(from);
				d.compose(2000);
				const previous = d.compose(0);
				d.applyBasePose(to);
				expect(d.compose(0)).toEqual(previous);
				expect(d.getBasePoseTargets()).toEqual({ ...NEUTRAL_AXES, ...BASE_POSES[to] });
				const settled = d.compose(2500);
				// Unmodulated facial fields reveal omissions; moving angular fields retain physiological motion.
				for (const name of ["face.blush", "eyes.left.smile", "eyes.right.smile", "mouth.form", "mouth.open"])
					expect(settled[name]).toBeCloseTo(d.getBasePoseTarget(name), 4);
			}
	});
	it("normalized tiny changes use a spring instead of the former 0.05-unit instant snap", () => {
		const b = new BodyDirector();
		b.setTarget("face.blush", 0.03);
		const first = b.tick(16)["face.blush"]!;
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(0.01);
		expect(b.tick(1000)["face.blush"]).toBeCloseTo(0.03, 5);
	});
	it("shocked-to-smile clears mouth opening, pout stays negative, and latch survives turn-end but yields to a new pose", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const run = async (face: string) => {
			const lease = await d.claim(["mouth", "eyes"]);
			const task = playExpression(
				d,
				{ face, latch_last: true, beats: [{ face, hold_ms: 100 }] },
				{ signal: lease.signal, lease },
			);
			advance(d);
			await vi.advanceTimersByTimeAsync(100);
			await task;
			lease.release();
		};
		await run("shocked");
		expect(advance(d)["mouth.open"]).toBeGreaterThan(0.45);
		await run("tender_smile");
		expect(advance(d)["mouth.open"]).toBeLessThan(0.001);
		await run("pout");
		d.clearStatePose();
		expect(advance(d)["mouth.form"]).toBeLessThan(-0.5);
		d.applyBasePose("relaxed");
		expect(advance(d)["mouth.form"]).toBeCloseTo(BASE_POSES.relaxed["mouth.form"]!, 3);
	});
	it("blink consumes overshoot across phases identically for fine and coarse updates", () => {
		const a = new PhysiologicalNoise({ randomFn: () => 0.5 }),
			b = new PhysiologicalNoise({ randomFn: () => 0.5 });
		a.triggerBlink({ willDoubleBlink: true });
		b.triggerBlink({ willDoubleBlink: true });
		let fine: Record<string, number> = {};
		for (let i = 0; i < 27; i++) fine = a.tick(10);
		const coarse = b.tick(270);
		expect(coarse["eyes.left.open"]).toBeCloseTo(fine["eyes.left.open"]!, 10);
		expect(a.getBlinkPhase()).toBe(b.getBlinkPhase());
	});
});

describe("eyelid and timed-pose response", () => {
	it("a normal blink really closes the eye instead of being filtered into a weak squint", () => {
		const d = new MotionDirector(() => 0.5);
		advance(d, 180);
		d.noise.triggerBlink();
		const opens: number[] = [];
		for (let i = 0; i < 20; i++) opens.push(d.compose(1000 / 60)["eyes.left.open"]!);
		expect(Math.min(...opens)).toBeLessThan(0.2);
		expect(opens.at(-1)).toBeGreaterThan(0.95);
	});
	it("a delayed composed frame matches explicit expiration splits while an ACTION retains its entire head", async () => {
		vi.useFakeTimers();
		const make = async () => {
			const r = new Live2DRuntime();
			await r.executePose("playful", 1000, { signal: new AbortController().signal } as never);
			const lease = await r.director.claim(["head"]);
			const task = playExpression(
				r.director,
				{ head: "turn_right", beats: [{ head: "turn_right", hold_ms: 3000 }] },
				{ lease },
			);
			return { r, lease, task };
		};
		const a = await make(),
			b = await make();
		const large = a.r.director.compose(1080);
		b.r.director.compose(1000);
		const split = b.r.director.compose(80);
		for (const name of ["head.yaw", "head.pitch", "head.roll"]) expect(large[name]).toBeCloseTo(split[name]!, 7);
		expect(a.r.currentBasePose).toBe("relaxed");
		expect(a.r.director.getParamTarget("head.yaw")).toBe(10); // playful baseline -2 + turn 12
		expect(a.r.director.getParamTarget("head.roll")).toBe(7);
		a.lease.release();
		b.lease.release();
		await Promise.all([a.task, b.task]);
	});
});

describe("Live2D regression: actual playback envelope", () => {
	it("holds steady samples between updates without sawtooth; reset and stale streams smoothly close", () => {
		const audio = new AudioObserver({ gain: 10 });
		const samples: number[] = [];
		for (let i = 0; i < 300; i++) {
			if (i % 3 === 0) audio.processLevel({ rms: 0.05 });
			audio.tick(16);
			if (i > 100) samples.push(audio.getMouthOpenY());
		}
		expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(0.0001);
		const before = audio.getMouthOpenY();
		audio.reset();
		expect(audio.getMouthOpenY()).toBe(before);
		audio.tick(16);
		expect(audio.getMouthOpenY()).toBeGreaterThan(0);
		expect(audio.getMouthOpenY()).toBeLessThan(before);
		audio.tick(2000);
		expect(audio.getMouthOpenY()).toBe(0);
		audio.processLevel({ rms: 0.08 });
		audio.tick(16);
		audio.tick(2000);
		expect(audio.getMouthOpenY()).toBe(0);
	});
	it("sustained loud audio produces one onset; silence and a new onset produce another", () => {
		const audio = new AudioObserver(),
			d = new MotionDirector();
		audio.setDirector(d);
		const pulse = vi.spyOn(d, "triggerAcousticImpulse");
		for (let i = 0; i < 120; i++) {
			audio.processLevel({ rms: 0.08 });
			audio.tick(50);
		}
		expect(pulse).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 20; i++) {
			audio.processLevel({ rms: 0 });
			audio.tick(50);
		}
		audio.processLevel({ rms: 0.08 });
		expect(pulse).toHaveBeenCalledTimes(2);
	});
});

describe("VTS real saved mapping", () => {
	it("inverts independent mappings, preserves eyelid default and rejects coupled head/face instead of choosing an authority", () => {
		const program = compileModelAdapter(profile);
		const values = Object.fromEntries(
			program.encode({ "eyes.left.open": 1, "gaze.x": 0.75, "brows.left": 0 }).values.map((p) => [p.id, p.value]),
		);
		expect(values.FaceAngleX).toBeUndefined();
		expect(values.MouthSmile).toBeUndefined();
		expect(values.EyeOpenLeft).toBeCloseTo(0.8 / 1.9);
		expect(values.EyeLeftX).toBe(-0.75);
		expect(values.BrowLeftY).toBeCloseTo(0.4);
		expect(values.MouthOpen).toBe(0);
		expect(program.capabilities["head.yaw"].available).toBe(false);
		expect(program.capabilities["head.yaw"].reasons.join()).toContain("共用 FaceAngleX");
		expect(Object.fromEntries(program.encode({ "mouth.open": 0.5 }).values.map((p) => [p.id, p.value])).MouthOpen).toBe(
			0.5,
		);
	});
	it("loads the matching model and physics from disk, ignores an unrelated malformed file, and rejects unknown model IDs", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-model-test-"));
		try {
			await mkdir(join(root, "bad"));
			await writeFile(join(root, "bad", "bad.vtube.json"), "bad");
			await mkdir(join(root, "avatar"));
			await writeFile(
				join(root, "avatar", "m.vtube.json"),
				JSON.stringify({
					ModelID: "model",
					FileReferences: { Model: "m.model3.json" },
					PhysicsSettings: { Use: true },
					ParameterSettings: [
						{
							Input: "FaceAngleX",
							OutputLive2D: "head.yaw",
							InputRangeLower: -30,
							InputRangeUpper: 30,
							OutputRangeLower: -15,
							OutputRangeUpper: 15,
						},
					],
				}),
			);
			await writeFile(
				join(root, "avatar", "m.model3.json"),
				JSON.stringify({ FileReferences: { Physics: "m.physics3.json" } }),
			);
			await writeFile(
				join(root, "avatar", "m.physics3.json"),
				JSON.stringify({ PhysicsSettings: [{ Output: [{ Destination: { Id: "torso.yaw" } }] }] }),
			);
			const p = await loadModelProfile("model", root);
			expect(p.mappings[0]!.outputMax).toBe(15);
			expect(p.physicsOutputs).toEqual(["torso.yaw"]);
			await expect(loadModelProfile("missing", root)).rejects.toThrow("找不到当前 VTS 模型");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

class Socket implements WebSocketLike {
	readyState = 1;
	bufferedAmount = 0;
	onopen: WebSocketLike["onopen"] = null;
	onclose: WebSocketLike["onclose"] = null;
	onerror: WebSocketLike["onerror"] = null;
	onmessage: WebSocketLike["onmessage"] = null;
	requests: Array<{ requestID: string; messageType: string; data: Record<string, unknown> }> = [];
	failedRequest?: string;
	holdSubscription = false;
	send(raw: string, cb?: (error?: Error) => void) {
		const request = JSON.parse(raw);
		this.requests.push(request);
		cb?.();
		const data =
			request.messageType === "AuthenticationRequest"
				? { authenticated: true }
				: request.messageType === "InputParameterListRequest"
					? { defaultParameters: profile.mappings.map((m) => ({ name: m.input })) }
					: request.messageType === "Live2DParameterListRequest"
						? { parameters: Object.entries(profile.parameterRanges!).map(([name, range]) => ({ name, ...range })) }
						: request.messageType === "CurrentModelRequest"
							? { modelLoaded: true, modelID: "model" }
							: { availableHotkeys: [] };
		if (
			request.messageType === "InjectParameterDataRequest" ||
			(this.holdSubscription && request.messageType === "EventSubscriptionRequest")
		)
			return;
		const failed = request.messageType === this.failedRequest;
		this.respond(
			request.requestID,
			failed ? "APIError" : `${request.messageType}Response`,
			failed ? { errorID: 999, message: "query unavailable" } : data,
		);
	}
	respond(requestID: string, messageType: string, data: unknown) {
		this.onmessage?.({ data: JSON.stringify({ requestID, messageType, data }) });
	}
	close() {
		this.readyState = 3;
		this.onclose?.({});
	}
}
const flushPromises = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
describe("VTS readiness, backpressure and recovery", () => {
	it("a companion created around an already-ready client reports its real state without needing another callback", async () => {
		const socket = new Socket();
		const client = new VTSClient({
			token: "fixture",
			webSocketFactory: () => socket,
			profileLoader: async () => profile,
		});
		client.connect();
		socket.onopen?.({});
		await flushPromises();
		const runtime = new Live2DRuntime({ vtsClient: client });
		expect(runtime.endpoint.state().online).toBe(true);
		expect(runtime.formatStatus()).toContain("可控制(VTS)");
		client.disconnect();
		expect(runtime.endpoint.state().online).toBe(false);
	});
	it("an open API waiting for model initialization is shown as connected but not controllable", async () => {
		const socket = new Socket();
		socket.holdSubscription = true;
		const client = new VTSClient({
			token: "fixture",
			webSocketFactory: () => socket,
			profileLoader: async () => profile,
		});
		const runtime = new Live2DRuntime({ vtsClient: client });
		client.connect();
		socket.onopen?.({});
		await flushPromises();
		expect(client.getConnectionStatus()).toMatchObject({
			apiConnected: true,
			authenticated: true,
			ready: false,
			stage: "订阅模型切换",
		});
		expect(runtime.formatStatus()).toContain("API 已连接，控制未就绪");
		expect(runtime.formatStatus()).not.toContain("离线(VTS)");
		client.disconnect();
		await flushPromises();
	});
	it("failed and stalled handshakes expose the cause and retry instead of remaining stuck in connecting", async () => {
		vi.useFakeTimers();
		const socket = new Socket();
		socket.readyState = 0;
		const client = new VTSClient({ token: "fixture", webSocketFactory: () => socket });
		client.connect();
		socket.onerror?.({ message: "ECONNREFUSED" });
		expect(client.getFault()).toContain("ECONNREFUSED");
		await vi.advanceTimersByTimeAsync(5000);
		expect(socket.readyState).toBe(3);
		expect(client.getConnectionStatus()).toMatchObject({ apiConnected: false, ready: false, stage: "等待重连" });
		expect(client.getFault()).toContain("ECONNREFUSED");
		client.disconnect();
	});
	it("waits for complete setup; allows only one unacknowledged injection and drops stale frames under socket backpressure", async () => {
		vi.useFakeTimers();
		const s = new Socket();
		s.holdSubscription = true;
		const client = new VTSClient({ token: "fixture", webSocketFactory: () => s, profileLoader: async () => profile });
		const state = vi.fn();
		client.setConnectionChangeListener(state);
		client.connect();
		s.onopen?.({});
		await flushPromises();
		expect(client.isConnected()).toBe(false);
		client.injectParameters([{ id: "MouthOpen", value: 0 }]);
		expect(s.requests.some((r) => r.messageType === "InjectParameterDataRequest")).toBe(false);
		const subscription = s.requests.at(-1)!;
		s.respond(subscription.requestID, "EventSubscriptionResponse", {});
		await flushPromises();
		expect(client.isConnected()).toBe(true);
		client.injectParameters([{ id: "MouthOpen", value: 0.5 }]);
		client.injectParameters([{ id: "MouthOpen", value: 0.7 }]);
		expect(s.requests.filter((r) => r.messageType === "InjectParameterDataRequest")).toHaveLength(1);
		const request = s.requests.at(-1)!;
		s.respond(request.requestID, "InjectParameterDataResponse", {});
		s.bufferedAmount = 10;
		client.injectParameters([{ id: "MouthOpen", value: 0.8 }]);
		expect(s.requests.at(-1)).toBe(request);
		s.bufferedAmount = 0;
		client.injectParameters([{ id: "MouthOpen", value: 0 }]);
		expect(s.requests.at(-1)!.data.parameterValues).toEqual([{ id: "MouthOpen", value: 0 }]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(client.isConnected()).toBe(false);
		expect(client.getFault()).toContain("确认超时");
		expect(state).toHaveBeenLastCalledWith(false);
		client.disconnect();
	});
	it("never injects after a failed parameter list, reloads on model change, and can restart after disposal", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const sockets: Socket[] = [];
		const loader = vi.fn(async () => profile);
		const client = new VTSClient({
			token: "fixture",
			webSocketFactory: () => {
				const s = new Socket();
				sockets.push(s);
				return s;
			},
			profileLoader: loader,
		});
		client.connect();
		sockets[0]!.failedRequest = "InputParameterListRequest";
		sockets[0]!.onopen?.({});
		await flushPromises();
		expect(client.isConnected()).toBe(false);
		expect(loader).not.toHaveBeenCalled();
		client.disconnect();
		client.connect();
		sockets[1]!.onopen?.({});
		await flushPromises();
		expect(client.isConnected()).toBe(true);
		sockets[1]!.onmessage?.({ data: JSON.stringify({ messageType: "ModelLoadedEvent", data: {} }) });
		expect(client.isConnected()).toBe(false);
		expect(client.getModelProfile()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1000);
		sockets[2]!.onopen?.({});
		await flushPromises();
		expect(client.isConnected()).toBe(true);
		expect(loader).toHaveBeenCalledTimes(2);
		client.disconnect();
	});
	it("a failed hotkey query fails initialization without reporting a ready model", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const socket = new Socket();
		socket.failedRequest = "HotkeysInCurrentModelRequest";
		const client = new VTSClient({
			token: "fixture",
			webSocketFactory: () => socket,
			profileLoader: async () => profile,
		});
		const ready = vi.fn();
		client.setConnectionChangeListener(ready);
		try {
			client.connect();
			socket.onopen?.({});
			await flushPromises();
			expect(client.isConnected()).toBe(false);
			expect(client.getModelProfile()).toBeUndefined();
			expect(client.getFault()).toContain("读取模型热键");
			expect(client.getFault()).toContain("query unavailable");
			expect(ready).not.toHaveBeenCalledWith(true);
			client.injectParameters([{ id: "MouthOpen", value: 0.5 }]);
			expect(socket.requests.some((r) => r.messageType === "InjectParameterDataRequest")).toBe(false);
		} finally {
			client.disconnect();
		}
	});
	it("late profile completion from an old connection cannot resurrect it", async () => {
		vi.useFakeTimers();
		const s = new Socket();
		let finish!: (p: ModelProfile) => void;
		const client = new VTSClient({
			token: "fixture",
			webSocketFactory: () => s,
			profileLoader: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		client.connect();
		s.onopen?.({});
		await flushPromises();
		client.disconnect();
		finish(profile);
		await flushPromises();
		expect(client.isConnected()).toBe(false);
		expect(client.getModelProfile()).toBeUndefined();
	});
});

describe("Flip restores the original physical transform", () => {
	it.each([false, true])(
		"uses absolute targets and verifies original position/rotation/size after cancellation=%s",
		async (cancel) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
			const client = new VTSClient();
			const original = { positionX: 0.2, positionY: -0.3, rotation: 27, size: 12 };
			const read = vi.spyOn(client, "getModelPosition").mockResolvedValue(original);
			vi.spyOn(client, "getModelProfile").mockReturnValue(profile);
			vi.spyOn(client, "isConnected").mockReturnValue(true);
			const move = vi.spyOn(client, "moveModel").mockResolvedValue({});
			const controller = new AbortController();
			const result = performModelFlip(client, controller.signal);
			await vi.advanceTimersByTimeAsync(300);
			if (cancel) controller.abort();
			await vi.advanceTimersByTimeAsync(1100);
			expect(await result).toEqual({ aborted: cancel, cleanupFailed: false });
			expect(read).toHaveBeenCalledTimes(2);
			expect(move.mock.calls.every(([v]) => v.valuesAreRelativeToModel === false)).toBe(true);
			expect(move).toHaveBeenLastCalledWith({ ...original, timeInSeconds: 0.15, valuesAreRelativeToModel: false });
		},
	);
	it("does not claim restoration when readback disagrees", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const client = new VTSClient();
		vi.spyOn(client, "isConnected").mockReturnValue(true);
		vi.spyOn(client, "getModelProfile").mockReturnValue(profile);
		vi.spyOn(client, "moveModel").mockResolvedValue({});
		vi.spyOn(client, "getModelPosition")
			.mockResolvedValueOnce({ positionX: 0, positionY: 0, rotation: 25, size: 0 })
			.mockResolvedValue({ positionX: 0, positionY: 0.1, rotation: 0, size: 0 });
		const result = performModelFlip(client);
		await vi.advanceTimersByTimeAsync(1300);
		expect((await result).cleanupFailed).toBe(true);
	});
});

describe("second review: one compositor and one owner", () => {
	it("a lease alone cancels playback on release, including a pre-aborted lease", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const lease = await d.claim(["head"]);
		const task = playExpression(d, { head: "tilt_left" }, { lease });
		d.compose(300);
		expect(d.getParamTarget("head.roll")).toBe(12);
		lease.release();
		expect(await task).toEqual({ status: "cancelled" });
		expect(d.isPlaying()).toBe(false);
		expect(await playExpression(d, { head: "tilt_right", latch_last: true }, { lease })).toEqual({
			status: "cancelled",
		});
		d.compose(300);
		expect(d.getParamTarget("head.roll")).toBeGreaterThan(0);
	});
	it("direct playback claims only its channels and cannot bypass another ACTION", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const head = await d.claim(["head"], { reason: "physical" });
		await expect(playExpression(d, { head: "nod" })).rejects.toThrow("locked");
		const gaze = playExpression(d, { gaze: "down", beats: [{ gaze: "down", hold_ms: 100 }] });
		await flushPromises();
		expect(d.getActiveLeases().map((l) => [...l.channels])).toEqual([["head"], ["gaze"]]);
		d.compose(50);
		expect(d.getParamTarget("gaze.y")).toBe(-0.85);
		d.compose(400);
		expect(await gaze).toEqual({ status: "completed" });
		expect(d.getActiveLeases()).toEqual([head]);
		head.release();
	});
	it("disjoint direct playback coexists and overlapping direct playback uses lease preemption", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const head = playExpression(d, { head: "tilt_left" });
		await flushPromises();
		const gaze = playExpression(d, { gaze: "away_left" });
		await flushPromises();
		expect(d.getActiveLeases()).toHaveLength(2);
		d.compose(300);
		expect(d.getParamTarget("head.roll")).toBe(12);
		expect(d.getParamTarget("gaze.x")).toBe(-0.95);
		const replacement = playExpression(d, { head: "tilt_right" });
		await flushPromises();
		expect(await head).toEqual({ status: "cancelled" });
		expect(d.getActiveLeases()).toHaveLength(2);
		d.abortAllMotions();
		expect(await gaze).toEqual({ status: "cancelled" });
		expect(await replacement).toEqual({ status: "cancelled" });
	});
	it("intent changes do not write springs between frames; ACTION without beats freezes its target through pose expiry", async () => {
		const r = new Live2DRuntime();
		const d = r.director;
		const ctx = { signal: new AbortController().signal } as never;
		await r.executePose("focused", 1000, ctx);
		d.compose(300);
		const target = d.getParamTarget("head.pitch");
		const lease = await d.claim(["head"]);
		d.showStatePose("thinking");
		expect(d.getParamTarget("head.pitch")).toBe(target);
		d.clearStatePose();
		d.compose(1000);
		expect(r.currentBasePose).toBe("relaxed");
		expect(d.getParamTarget("head.pitch")).toBe(target);
		lease.release();
		d.compose(16);
		expect(Math.abs(d.getParamTarget("head.pitch") - target)).toBeLessThan(0.1);
		d.compose(1200);
		expect(d.getParamTarget("head.pitch")).toBeLessThan(-1);
	});
	it("repeated focus notifications neither erase a timed pose nor reset its countdown", async () => {
		const r = new Live2DRuntime();
		await r.executePose("focused", 2500, { signal: new AbortController().signal } as never);
		r.director.compose(300);
		const remaining = r.director.getHoldRemainingMs();
		r.endpoint.onFocus(true);
		expect(r.director.getHoldRemainingMs()).toBe(remaining);
		r.endpoint.onFocus(false);
		r.endpoint.onFocus(false);
		r.director.compose(3000);
		r.endpoint.onFocus(true);
		r.endpoint.onFocus(true);
		expect(r.director.getHoldRemainingMs()).toBe(remaining);
		r.director.compose(remaining! + 100);
		expect(r.currentBasePose).toBe("relaxed");
	});
	it("normal idle reaches the real Cubism open default rather than the exaggerated saved mapping endpoint", () => {
		const d = new MotionDirector(() => 0.5),
			retargeter = compileModelAdapter(profile);
		d.applyBasePose("relaxed");
		const frame = d.compose(2000);
		expect(frame["eyes.left.open"]).toBeCloseTo(1, 5);
		const eye = (openness: number) =>
			retargeter.encode({ "eyes.left.open": openness }).values.find((p) => p.id === "EyeOpenLeft")!.value;
		expect(eye(frame["eyes.left.open"]!)).toBeCloseTo(0.8 / 1.9);
		expect(eye(0.5)).toBeCloseTo(0.4 / 1.9);
		expect(eye(0)).toBe(0);
	});
	it.each([15, 90])(
		"flip uses native fades with 15-degree ordered targets even with %s ms request latency",
		async (latency) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
			const client = new VTSClient();
			vi.spyOn(client, "isConnected").mockReturnValue(true);
			vi.spyOn(client, "getModelProfile").mockReturnValue(profile);
			vi.spyOn(client, "getModelPosition").mockResolvedValue({
				positionX: 0,
				positionY: -0.3,
				rotation: 350,
				size: -60,
			});
			const move = vi.spyOn(client, "moveModel").mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, latency));
			});
			const result = performModelFlip(client);
			await vi.advanceTimersByTimeAsync(4000);
			expect(await result).toEqual({ aborted: false, cleanupFailed: false });
			const commands = move.mock.calls.slice(0, -1).map(([v]) => v);
			expect(commands).toHaveLength(24);
			let previous = 350,
				total = 0;
			for (const command of commands) {
				expect(command.timeInSeconds).toBe(0.08);
				const arc = (command.rotation! - previous + 360) % 360;
				expect(arc).toBeCloseTo(15);
				total += arc;
				previous = command.rotation!;
			}
			expect(total).toBeCloseTo(360);
		},
	);
});

describe("composed expressive intent", () => {
	it.each([
		["focused", { head: "lowered" }, "head.pitch", -5],
		["shy_side", { head: "tilt_left", intensity: 0.6 }, "head.roll", 12.2],
		["playful", { head: "tilt_left" }, "head.roll", 19],
		["playful", { face: "tender_smile" }, "face.blush", 0.18],
		["playful", { face: "laugh" }, "eyes.left.open", 0.06],
	] as const)("%s composes %o into %s=%s without mutating its base", async (pose, beat, name, target) => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		vi.spyOn(d.noise, "tick").mockReturnValue({});
		d.applyBasePose(pose);
		d.compose(100);
		const baseline = { ...d.getBasePoseTargets() };
		const task = playExpression(d, { beats: [{ ...beat, hold_ms: 1000 }] });
		await flushPromises();
		d.compose(300);
		expect(d.getParamTarget(name)).toBeCloseTo(target, 8);
		expect(d.getBasePoseTargets()).toEqual(baseline);
		d.compose(1100);
		await task;
		d.compose(0);
		expect(d.getParamTarget(name)).toBeCloseTo(baseline[name]!, 8);
	});
	it("safe stop cancels a direct playback still awaiting its claim and releases physical owners", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector();
		const physical = await d.claimAllChannels("flip");
		d.abortAllMotions();
		expect(physical.signal.aborted).toBe(true);
		const pending = playExpression(d, { head: "nod" });
		d.abortAllMotions();
		expect(await pending).toEqual({ status: "cancelled" });
		expect(d.getActiveLeases()).toEqual([]);
	});
});

describe("second review: arbitration authority", () => {
	it("a foreign lease cannot write through another director's locked channels", async () => {
		const a = new MotionDirector(),
			b = new MotionDirector();
		const lease = await a.claim(["head"]);
		await b.claim(["head"], { reason: "physical" });
		await expect(playExpression(b, { head: "nod" }, { lease })).rejects.toThrow("does not belong");
		expect(a.getActiveLeases()).toEqual([lease]);
		a.abortAllMotions();
		b.abortAllMotions();
	});
	it("one lease cannot run two competing sequences; replacement stays active when old cleanup resolves", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const lease = await d.claim(["head"]);
		const first = playExpression(d, { head: "tilt_left" }, { lease });
		const second = playExpression(d, { head: "tilt_right" }, { lease });
		expect(await first).toEqual({ status: "cancelled" });
		d.compose(300);
		expect(d.getParamTarget("head.roll")).toBe(-12);
		expect(lease.signal.aborted).toBe(false);
		d.abortAllMotions();
		await second;
	});
	it("a replaced model receives no old trajectory or restoration command", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const client = new VTSClient();
		vi.spyOn(client, "isConnected").mockReturnValue(true);
		const model = vi.spyOn(client, "getModelProfile").mockReturnValue(profile);
		vi.spyOn(client, "getModelPosition").mockResolvedValue({ positionX: 0, positionY: 0, rotation: 20, size: 0 });
		const move = vi.spyOn(client, "moveModel").mockImplementation(async () => {
			model.mockReturnValue({ ...profile });
		});
		const task = performModelFlip(client);
		const rejected = expect(task).rejects.toThrow("model changed during flip");
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
		expect(move).toHaveBeenCalledTimes(1);
	});
});

describe("motion input is data, not an object-prototype lookup", () => {
	it.each(["constructor", "toString", "__proto__"])("%s never resolves as a cue or a head action", async (name) => {
		expect(supportsMotion(name)).toBe(false);
		expect(supportsMotion(`head=${name},gaze=${name}`)).toBe(false);
		expect(() => compileExpression({ head: name })).toThrow();
		const d = new MotionDirector();
		await expect(playExpression(d, { head: name })).rejects.toThrow("Unknown motion");
		expect(d.getActiveLeases()).toEqual([]);
	});
	it("non-finite numeric intent cannot poison springs or retain an empty ownership claim", async () => {
		const d = new MotionDirector();
		await expect(playExpression(d, { head: "nod", intensity: NaN })).rejects.toThrow("finite");
		await expect(playExpression(d, { beats: [{ head: "nod", hold_ms: Infinity }] })).rejects.toThrow("finite");
		await expect(playExpression(d, {})).rejects.toThrow("Empty expression");
		expect(d.getActiveLeases()).toEqual([]);
		expect(Object.values(d.compose(100)).every(Number.isFinite)).toBe(true);
	});
});
