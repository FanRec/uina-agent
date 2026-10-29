import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { cuteNod, cuteNodCheerfulVariant } from "../.uina/worlds/live2d/models/mo/motions/nod.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO Procedural Cute Nod Action (Pure Physics Dynamics)", () => {
	it("compiles clean against MO rig and stays within 1800ms-2100ms", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteNod, rig.controls, () => 0.5);

		expect(compiled.durationMs).toBe(1950);
		expect(compiled.durationMs).toBeGreaterThanOrEqual(1800);
		expect(compiled.durationMs).toBeLessThanOrEqual(2100);
		expect(compiled.channels.length).toBe(10);

		const compiledVariant = compileAction(cuteNodCheerfulVariant, rig.controls, () => 0.5);
		expect(compiledVariant.durationMs).toBe(1880);
		expect(compiledVariant.durationMs).toBeGreaterThanOrEqual(1800);
		expect(compiledVariant.durationMs).toBeLessThanOrEqual(2100);
	});

	it("delivers procedural tension, deep dive, decoupled torso, and damped spring bounce", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteNod, rig.controls, () => 0.5);

		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		// 1. t=0: Clean start
		const t0 = sampleAction(compiled, 0, baseline);
		expect(t0["head.pitch"]).toBeCloseTo(0, 5);
		expect(t0["torso.pitch"]).toBeCloseTo(0, 5);
		expect(t0["head.roll"]).toBeCloseTo(0, 5);
		expect(t0["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(t0["mouth.form"]).toBeCloseTo(0, 5);

		// 2. t=320ms: Anticipation / Inhale wave peak (高阶光滑吸气微仰蓄力)
		const tAnticipate = sampleAction(compiled, 320, baseline);
		expect(tAnticipate["head.pitch"]!).toBeGreaterThan(2.8);
		expect(tAnticipate["head.pitch"]!).toBeLessThan(3.8);
		expect(tAnticipate["mouth.form"]!).toBeGreaterThan(0.2);
		expect(tAnticipate["gaze.y"]!).toBeLessThan(-0.15);

		// 3. t=650ms: Deep Drop Dwell (物理下潜驻留：头低得极深至 -9.0° 以下，笑眼微闭仅剩 <0.1，歪头萌感拉满)
		const tDeep = sampleAction(compiled, 650, baseline);
		expect(tDeep["head.pitch"]!).toBeLessThan(-9.0);
		expect(tDeep["head.pitch"]!).toBeGreaterThan(-10.0); // 逼近极限但不撞 -10 clamp
		expect(tDeep["eyes.left.open"]!).toBeLessThan(0.12); // 月牙笑眼
		expect(tDeep["eyes.right.open"]!).toBeLessThan(0.12);
		expect(tDeep["mouth.form"]!).toBeGreaterThan(0.8); // 灿烂治愈微笑
		expect(Math.abs(tDeep["head.roll"]!)).toBeGreaterThan(4.0); // 显著侧倾

		// 4. 头部底动加回 offset 后，身体只保留小幅支撑。
		expect(Math.abs(tDeep["head.pitch"]! + tDeep["torso.pitch"]!)).toBeLessThan(2.3);

		// 5. t=1050ms: Damped Harmonic Oscillator Peak (Q弹回弹高超调：冲过中线超过 +3.5°，双眼清澈大睁)
		const tRebound = sampleAction(compiled, 1050, baseline);
		expect(tRebound["head.pitch"]!).toBeGreaterThan(3.5);
		expect(tRebound["head.pitch"]!).toBeLessThan(5.0);
		expect(tRebound["eyes.left.open"]!).toBeCloseTo(1.0, 1);

		// 6. t=1950ms: Clean gentle return to neutral
		const tEnd = sampleAction(compiled, 1950, baseline);
		expect(tEnd["head.pitch"]).toBeCloseTo(0, 5);
		expect(tEnd["torso.pitch"]).toBeCloseTo(0, 5);
		expect(tEnd["head.roll"]).toBeCloseTo(0, 5);
		expect(tEnd["head.yaw"]).toBeCloseTo(0, 5);
		expect(tEnd["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(tEnd["eyes.right.open"]).toBeCloseTo(1, 5);
		expect(tEnd["mouth.form"]).toBeCloseTo(0, 5);
		expect(tEnd["gaze.y"]).toBeCloseTo(0, 5);
	});

	it("keeps both nods continuous at the lean accents and bounce handoff, with supported body axes", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		for (const [author, joins] of [
			[cuteNod, [200, 620, 700, 1500]],
			[cuteNodCheerfulVariant, [180, 560, 640, 1400]],
		] as const) {
			const clip = compileAction(author, rig.controls, () => 0.5);
			expect(clip.axes).toEqual(expect.arrayContaining(["torso.pitch", "torso.roll", "torso.yaw"]));
			for (const at of joins) {
				const before = sampleAction(clip, at - 0.01);
				const after = sampleAction(clip, at + 0.01);
				for (const axis of clip.axes)
					expect(Math.abs(after[axis]! - before[axis]!), `${axis} at ${at}`).toBeLessThan(0.01);
				const leftVelocity =
					(sampleAction(clip, at)["head.pitch"]! - sampleAction(clip, at - 0.1)["head.pitch"]!) * 10000;
				const rightVelocity =
					(sampleAction(clip, at + 0.1)["head.pitch"]! - sampleAction(clip, at)["head.pitch"]!) * 10000;
				expect(Math.abs(leftVelocity - rightVelocity), `pitch velocity at ${at}`).toBeLessThan(1);
			}
			for (const at of [0, clip.durationMs]) {
				const adjacent = sampleAction(clip, at === 0 ? 0.01 : at - 0.01);
				const endpoint = sampleAction(clip, at);
				expect(Math.abs(adjacent["eyes.left.open"]! - endpoint["eyes.left.open"]!)).toBeLessThan(0.0001);
			}
		}
	});
});
