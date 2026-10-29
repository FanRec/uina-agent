import { describe, expect, it, vi } from "vitest";
import { encodeFrame, type ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { MO_SPEECH } from "../.uina/worlds/live2d/models/mo/speech.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { type SpeechConfig, SpeechInput } from "../.uina/worlds/live2d/speech-level.js";

const SPEECH: SpeechConfig = {
	points: [
		[0, 0],
		[0.02, 0.25],
		[0.06, 0.7],
		[0.15, 1],
	],
	staleMs: 120,
};

describe("live2d 声学电平链路（P3-2）", () => {
	it("MO 低中电平经真实 rig 编码后明显张嘴，并保留强弱变化", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const d = new MotionDirector(rig.controls);
		const input = new SpeechInput(MO_SPEECH, d);
		const encoded: number[] = [];
		for (const rms of [0.006, 0.01, 0.02, 0.04, 0.06, 0.08]) {
			input.processLevel({ rms });
			input.tick(16);
			encoded.push(encodeFrame(rig, d.step(16)).find((p) => p.id === "MouthOpen")!.value);
		}

		// 消费边界上的开度要求：轻声已可见，中等电平明显张嘴，较响时仍留动态余量。
		expect(encoded[1]!).toBeGreaterThanOrEqual(0.18);
		expect(encoded[2]!).toBeGreaterThanOrEqual(0.4);
		expect(encoded[3]!).toBeGreaterThanOrEqual(0.6);
		expect(encoded[4]!).toBeGreaterThan(0.7);
		expect(encoded.every((value, index) => index === 0 || value > encoded[index - 1]!)).toBe(true);
		expect(encoded.every((value) => value >= 0 && value <= 0.8)).toBe(true);
		expect(encoded.at(-1)!).toBeCloseTo(0.8, 6);
	});

	it("MO 静音和死区保持闭嘴，语音失联后仍按 120ms 守卫和 50ms 释放归零", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const d = new MotionDirector(rig.controls);
		const input = new SpeechInput(MO_SPEECH, d);
		const sample = (dt: number): number => {
			input.tick(dt);
			return encodeFrame(rig, d.step(dt)).find((p) => p.id === "MouthOpen")!.value;
		};
		for (const rms of [0, 0.002, 0.004]) {
			input.processLevel({ rms, peak: 1 });
			expect(sample(16)).toBe(0);
		}

		input.processLevel({ rms: 0.08 });
		const open = sample(16);
		for (let i = 0; i < 6; i++) sample(16); // 最后一次电平之后 112ms，仍在守卫内。
		expect(encodeFrame(rig, d.currentFrame).find((p) => p.id === "MouthOpen")!.value).toBe(open);
		expect(sample(16)).toBeLessThan(open); // 128ms 后开始释放。
		for (let i = 0; i < 3; i++) sample(16);
		expect(encodeFrame(rig, d.currentFrame).find((p) => p.id === "MouthOpen")!.value).toBe(0);
	});

	it("作者映射：rms 0.06 → 0.7；分段线性内插与端点钳制正确", () => {
		const d = new MotionDirector({ "mouth.open": { min: 0, max: 1, neutral: 0 } });
		const input = new SpeechInput(SPEECH, d);
		input.processLevel({ rms: 0.06 });
		input.tick(16);
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBe(0.7); // 引擎包络快攻：立即跟随

		input.processLevel({ rms: 0.04 }); // 0.02~0.06 段线性内插 → 0.475；电平下降经引擎包络短滞回
		input.tick(16);
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBeCloseTo(0.475, 1);

		input.processLevel({ rms: 0.9 }); // 升高立即跟随；超出末端 → 钳制 1
		input.tick(16);
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBe(1);
	});

	it("失联守卫：超过 staleMs 无新测量即视为静音，经引擎包络 50ms 释放回零", () => {
		const d = new MotionDirector({ "mouth.open": { min: 0, max: 1, neutral: 0 } });
		const input = new SpeechInput(SPEECH, d);
		input.processLevel({ rms: 0.15 });
		input.tick(16);
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBe(1);

		// 静默：stale 120ms 内目标保持；越线后目标归零 → 引擎 50ms 线性释放。
		// 首次 tick 后 age=16，再 6 次 → age=112，恰好仍未失联（守卫条件为 age > 120）。
		for (let i = 0; i < 6; i++) {
			input.tick(16);
			d.step(16);
		}
		expect(d.currentFrame["mouth.open"]).toBe(1); // age=112 仍未失联
		input.tick(16); // age=128 > 120 → 目标 0
		const samples: number[] = [];
		for (let i = 0; i < 6; i++) samples.push(d.step(10)["mouth.open"]!);
		expect(samples[0]!).toBeLessThan(1);
		expect(samples.every((v, i) => i === 0 || v <= samples[i - 1]!)).toBe(true); // 单调下降
		expect(d.currentFrame["mouth.open"]).toBe(0); // 60ms > 50ms 释放完成
	});

	it("reset()：声学输入立即清零，口型经引擎 50ms 释放回零（不永久张嘴）", () => {
		const d = new MotionDirector({ "mouth.open": { min: 0, max: 1, neutral: 0 } });
		const input = new SpeechInput(SPEECH, d);
		input.processLevel({ rms: 0.15 });
		input.tick(16);
		d.step(16);
		input.reset();
		input.tick(16); // age=∞ → 目标 0
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBeLessThan(1);
		for (let i = 0; i < 6; i++) d.step(10);
		expect(d.currentFrame["mouth.open"]).toBe(0);
	});

	it("边界 #6 口型兜底：reset 后下一合成帧的包络目标即 0（50ms 释放的规范依据，§4 reset 三层语义第一层）", () => {
		const d = new MotionDirector({ "mouth.open": { min: 0, max: 1, neutral: 0 } });
		const spy = vi.spyOn(d, "setSpeechLevel");
		const input = new SpeechInput(SPEECH, d);
		input.processLevel({ rms: 0.15 });
		input.tick(16);
		expect(spy).toHaveBeenLastCalledWith(1);
		input.reset();
		input.tick(16); // 下一帧：目标 0——包络不再有任何声学输入支撑
		expect(spy).toHaveBeenLastCalledWith(0);
	});

	it("runtime 集成：电平按 20ms 窗连续投递驱动张嘴；未发布时电平丢弃", async () => {
		const rig: ModelRig = {
			version: 3,
			modelID: "fixture",
			controls: { "mouth.open": { min: 0, max: 1, neutral: 0 } },
			bindings: {
				"mouth.open": [
					{
						parameter: "ParamMouthOpenY",
						input: "MouthOpen",
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
		};
		const fakeClient = {
			isConnected: () => true,
			getModelProfile: () => ({ modelID: "fixture" }),
			injectParameters: () => {},
			setConnectionChangeListener: () => {},
			connect: () => {},
			disconnect: () => {},
			getConnectionStatus: () => ({ connected: true }),
		} as unknown as VTSClient;
		const rt = new Live2DRuntime({ client: fakeClient, rig, speech: SPEECH, tickIntervalMs: 1_000_000 });
		await rt.start({} as never);
		expect(rt.levelSink).toBeDefined();

		// TTS 按 ~20ms 窗连续投递（seams 契约）；帧步长 16ms，隔帧投递即维持新鲜。
		rt.levelSink!.processLevel({ rms: 0.06 });
		for (let i = 0; i < 40; i++) {
			if (i % 2 === 1) rt.levelSink!.processLevel({ rms: 0.06 });
			rt.composeTick(16);
		}
		expect(rt.director!.currentFrame["mouth.open"]).toBeCloseTo(0.7, 1);

		// 停止投递：失联守卫（120ms）+ 引擎释放（50ms）→ 回零，不永久张嘴。
		for (let i = 0; i < 15; i++) rt.composeTick(16);
		expect(rt.director!.currentFrame["mouth.open"]).toBe(0);
		await rt.stop();
	});
});
