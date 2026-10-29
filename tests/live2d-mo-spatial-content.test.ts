import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { closeUp } from "../.uina/worlds/live2d/models/mo/motions/close_up.js";
import { edgePeek } from "../.uina/worlds/live2d/models/mo/motions/edge_peek.js";
import { joyHop } from "../.uina/worlds/live2d/models/mo/motions/joy_hop.js";
import { petrify } from "../.uina/worlds/live2d/models/mo/motions/petrify.js";
import { spin } from "../.uina/worlds/live2d/models/mo/motions/spin.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO 空间动作的表演衔接", () => {
	it.each([
		["贴脸呼吸退场", closeUp, "head.pitch", 3800],
		["探头视线退场", edgePeek, "gaze.y", 4000],
		["石化视线入场", petrify, "gaze.y", 0],
		["石化震颤入场", petrify, "head.roll", 150],
	] as const)("%s 不在段界突然跳变", async (_name, authoring, axis, boundary) => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([name, c]) => [name, c.neutral]));
		const clip = compileAction(authoring, rig.controls, () => 0.5);
		const before = sampleAction(clip, Math.max(0, boundary - 0.1), baseline)[axis]!;
		const after = sampleAction(clip, boundary + 0.1, baseline)[axis]!;
		expect(Math.abs(after - before)).toBeLessThan(0.01);
	});

	it("转圈的离心摆动平顺进入和结束，不突然改变头部速度", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([name, c]) => [name, c.neutral]));
		const clip = compileAction(spin, rig.controls, () => 0.5);
		for (const boundary of [420, 1800]) {
			for (const axis of ["head.pitch", "head.roll"]) {
				const at = sampleAction(clip, boundary, baseline)[axis]!;
				const enterSpeed = at - sampleAction(clip, boundary - 1, baseline)[axis]!;
				const exitSpeed = sampleAction(clip, boundary + 1, baseline)[axis]! - at;
				expect(Math.abs(exitSpeed - enterSpeed), `${axis} at ${boundary}`).toBeLessThan(0.002);
			}
		}
	});

	it("雀跃的身体有可见支撑并稍晚于头部回弹，腾空阶段与位移同步", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const clip = compileAction(joyHop, rig.controls, () => 0.5);
		const director = new MotionDirector(rig.controls);
		director.play(clip, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false });
		let headPeak = { value: 0, at: 0 };
		let bodyPeak = { value: 0, at: 0 };
		for (let at = 10; at < 750; at += 10) {
			const frame = director.step(10);
			if (frame["head.pitch"]! > headPeak.value) headPeak = { value: frame["head.pitch"]!, at };
			if (frame["torso.pitch"]! > bodyPeak.value) bodyPeak = { value: frame["torso.pitch"]!, at };
		}
		expect(bodyPeak.value / headPeak.value).toBeGreaterThan(0.2);
		expect(bodyPeak.value / headPeak.value).toBeLessThan(0.45);
		expect(bodyPeak.at - headPeak.at).toBeGreaterThanOrEqual(30);
		const flight = clip.spatial.find((event) => event.transform?.delta?.y === 0.1)!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([name, c]) => [name, c.neutral]));
		expect(sampleAction(clip, flight.span!.endMs, baseline)["head.pitch"]).toBeGreaterThan(7);
	});

	it("探头停留时有轻微观察动作，保持探头姿态", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([name, c]) => [name, c.neutral]));
		const clip = compileAction(edgePeek, rig.controls, () => 0.5);
		const samples = [1100, 1600, 2200, 2700].map((ms) => sampleAction(clip, ms, baseline)["head.roll"]!);
		expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.1);
		expect(samples.every((value) => value < -7 && value >= -10)).toBe(true);
	});
});
