import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { cuteShake, cuteShakePlayfulVariant } from "../.uina/worlds/live2d/models/mo/motions/shake.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO Cute Shake Action Authoring (Procedural Physics Dynamics)", () => {
	it("compiles clean against MO rig and supports all three torso axes", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteShake, rig.controls, () => 0.5);

		expect(compiled.durationMs).toBe(2600);
		expect(compiled.channels.length).toBe(10);

		const compiledVariant = compileAction(cuteShakePlayfulVariant, rig.controls, () => 0.5);
		expect(compiledVariant.durationMs).toBe(2200);
		expect(compiledVariant.channels.length).toBe(10);
	});

	it("delivers large yaw amplitude, decoupled torso, 3D saddle motion and clean return", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const compiled = compileAction(cuteShake, rig.controls, () => 0.5);

		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		// 1. t=0: Clean start
		const t0 = sampleAction(compiled, 0, baseline);
		expect(t0["head.yaw"]).toBeCloseTo(0, 5);
		expect(t0["torso.yaw"]).toBeCloseTo(0, 5);
		expect(t0["head.roll"]).toBeCloseTo(0, 5);
		expect(t0["head.pitch"]).toBeCloseTo(0, 5);
		expect(t0["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(t0["mouth.form"]).toBeCloseTo(0, 5);

		// 2. 主摇动阶段检查 (超大行程，绝对值在 9.0° 以上，不超过极限 12°)
		let maxYaw = 0;
		for (let ms = 150; ms <= 1200; ms += 20) {
			const sample = sampleAction(compiled, ms, baseline);
			maxYaw = Math.max(maxYaw, Math.abs(sample["head.yaw"]!));
		}
		expect(maxYaw).toBeGreaterThan(9.0);
		expect(maxYaw).toBeLessThan(12.0); // 留出安全裕量防 clamp (MO rig head.yaw 极限为 ±12°)

		// 3. 头部转角最大时，身体合成值仍小于 3°。
		let peakYawTime = 180;
		let peakYawVal = 0;
		for (let ms = 150; ms <= 600; ms += 10) {
			const sample = sampleAction(compiled, ms, baseline);
			if (Math.abs(sample["head.yaw"]!) > peakYawVal) {
				peakYawVal = Math.abs(sample["head.yaw"]!);
				peakYawTime = ms;
			}
		}
		const tPeak = sampleAction(compiled, peakYawTime, baseline);
		expect(Math.abs(tPeak["torso.yaw"]! + tPeak["head.yaw"]!)).toBeLessThan(3);

		// 4. 检查眼睑娇嗔微眯
		let minEyeOpen = 1;
		for (let ms = 250; ms <= 1200; ms += 25) {
			const sample = sampleAction(compiled, ms, baseline);
			minEyeOpen = Math.min(minEyeOpen, sample["eyes.left.open"]!);
		}
		expect(minEyeOpen).toBeLessThan(0.7); // 甩头时自然微眯

		// 5. t=2600ms: Clean gentle return to neutral
		const tEnd = sampleAction(compiled, 2600, baseline);
		expect(tEnd["head.yaw"]).toBeCloseTo(0, 5);
		expect(tEnd["torso.yaw"]).toBeCloseTo(0, 5);
		expect(tEnd["head.roll"]).toBeCloseTo(0, 5);
		expect(tEnd["head.pitch"]).toBeCloseTo(0, 5);
		expect(tEnd["eyes.left.open"]).toBeCloseTo(1, 5);
		expect(tEnd["eyes.right.open"]).toBeCloseTo(1, 5);
		expect(tEnd["mouth.form"]).toBeCloseTo(0, 5);
		expect(tEnd["gaze.x"]).toBeCloseTo(0, 5);
	});

	it("keeps the final body smaller than the shake on every axis after head-follow", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		for (const author of [cuteShake, cuteShakePlayfulVariant]) {
			const clip = compileAction(author, rig.controls, () => 0.5);
			for (const direction of ["yaw", "pitch", "roll"]) {
				expect(clip.axes).toContain(`torso.${direction}`);
				let peak = 0;
				for (let at = 0; at <= clip.durationMs; at += 5) {
					const frame = sampleAction(clip, at);
					peak = Math.max(peak, Math.abs(frame[`head.${direction}`]! + frame[`torso.${direction}`]!));
				}
				expect(peak, direction).toBeGreaterThan(0.2);
				expect(peak, direction).toBeLessThan(3);
			}
		}
	});
});
