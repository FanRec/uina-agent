import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import {
	cuteWink,
	cuteWinkCheerfulVariant,
	cuteWinkDoubleVariant,
} from "../.uina/worlds/live2d/models/mo/motions/wink.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO Cute Wink Action Authoring (Procedural Physics Dynamics)", () => {
	it("compiles clean against MO rig and has 9 channels", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteWink, rig.controls, () => 0.5);

		expect(compiled.durationMs).toBe(1500);
		expect(compiled.channels.length).toBe(9);

		const compiledVariant = compileAction(cuteWinkCheerfulVariant, rig.controls, () => 0.5);
		expect(compiledVariant.durationMs).toBe(1420);
		expect(compiledVariant.channels.length).toBe(9);
	});

	it("delivers full single-eye closure, clear peak hold, tilt, decoupled torso and clean return", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteWink, rig.controls, () => 0.5);

		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		// 1. t=0: Clean start
		const t0 = sampleAction(compiled, 0, baseline);
		expect(t0["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(t0["eyes.right.open"]).toBeCloseTo(1, 5);
		expect(t0["head.roll"]).toBeCloseTo(0, 5);
		expect(t0["mouth.form"]).toBeCloseTo(0, 5);

		// 2. 检查饱满定格期 (320~560ms：持续 240ms 闭紧，确保观众能看清)
		for (let ms = 320; ms <= 560; ms += 40) {
			const sample = sampleAction(compiled, ms, baseline);
			expect(sample["eyes.left.open"]).toBeCloseTo(0, 5); // 左眼完全闭合
			expect(sample["eyes.right.open"]!).toBeGreaterThanOrEqual(1.0); // 右眼神采大睁
			expect(sample["head.roll"]!).toBeGreaterThan(4.0); // 娇俏歪头
			expect(sample["head.roll"]!).toBeLessThan(5.6);
			expect(sample["mouth.form"]!).toBeGreaterThan(0.7); // 甜美大微笑
		}

		// 3. 身体保留小幅自然传导，避免僵直或随头整身侧倒。
		const tPeak = sampleAction(compiled, 450, baseline);
		expect(Math.abs(tPeak["head.roll"]! + tPeak["torso.roll"]!)).toBeGreaterThan(0.8);
		expect(Math.abs(tPeak["head.roll"]! + tPeak["torso.roll"]!)).toBeLessThan(1.6);

		// 4. t=1500ms: Clean gentle return to neutral
		const tEnd = sampleAction(compiled, 1500, baseline);
		expect(tEnd["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(tEnd["eyes.right.open"]).toBeCloseTo(1, 5);
		expect(tEnd["head.roll"]).toBeCloseTo(0, 5);
		expect(tEnd["head.pitch"]).toBeCloseTo(0, 5);
		expect(tEnd["head.yaw"]).toBeCloseTo(0, 5);
		expect(tEnd["torso.roll"]).toBeCloseTo(0, 5);
		expect(tEnd["mouth.form"]).toBeCloseTo(0, 5);
		expect(tEnd["gaze.x"]).toBeCloseTo(0, 5);
		expect(tEnd["gaze.y"]).toBeCloseTo(0, 5);
	});

	it("lets each wink hold flow into its soft recoil without an angular velocity snap", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		for (const [author, joins] of [
			[cuteWink, [320, 620]],
			[cuteWinkCheerfulVariant, [280, 560]],
			[cuteWinkDoubleVariant, [850, 1400]],
		] as const) {
			const clip = compileAction(author, rig.controls, () => 0.5);
			for (const at of joins) {
				const center = sampleAction(clip, at)["head.roll"]!;
				const leftVelocity = (center - sampleAction(clip, at - 0.1)["head.roll"]!) * 10000;
				const rightVelocity = (sampleAction(clip, at + 0.1)["head.roll"]! - center) * 10000;
				expect(Math.abs(leftVelocity - rightVelocity), `roll velocity at ${at}`).toBeLessThan(0.2);
			}
		}
	});
});
