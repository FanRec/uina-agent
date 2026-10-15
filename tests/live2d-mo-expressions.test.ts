import { beforeAll, describe, expect, it } from "vitest";
import { type ModelRig, neutralFrame } from "../.uina/worlds/live2d/adapter/rig.js";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { chinUp } from "../.uina/worlds/live2d/models/mo/motions/chin_up.js";
import { curious, curiousDoubleTiltVariant } from "../.uina/worlds/live2d/models/mo/motions/curious.js";
import { glance, glanceDoubleTakeVariant } from "../.uina/worlds/live2d/models/mo/motions/glance.js";
import { headToss, headTossPoutVariant } from "../.uina/worlds/live2d/models/mo/motions/head_toss.js";
import { panic } from "../.uina/worlds/live2d/models/mo/motions/panic.js";
import { pout } from "../.uina/worlds/live2d/models/mo/motions/pout.js";
import { sleepy } from "../.uina/worlds/live2d/models/mo/motions/sleepy.js";
import { smugLaugh } from "../.uina/worlds/live2d/models/mo/motions/smug_laugh.js";
import { surprise } from "../.uina/worlds/live2d/models/mo/motions/surprise.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

const actions = {
	curious,
	curiousDoubleTiltVariant,
	chinUp,
	headToss,
	headTossPoutVariant,
	glance,
	glanceDoubleTakeVariant,
	pout,
	surprise,
	sleepy,
	smugLaugh,
	panic,
};

let rig: ModelRig;
let baseline: Record<string, number>;
beforeAll(async () => {
	rig = (await loadRig(MO_MODEL_ID))!;
	baseline = neutralFrame(rig);
});

describe("MO expression motion continuity and articulation", () => {
	it.each(Object.entries(actions))("%s has no piecewise jumps or abrupt endpoint movement", (_name, action) => {
		const clip = compileAction(action, rig.controls, () => 0.5);
		let largestJump = { axis: "", at: 0, amount: 0 };
		for (let at = 0; at <= clip.durationMs; at++) {
			const before = sampleAction(clip, Math.max(0, at - 0.001), baseline);
			const after = sampleAction(clip, Math.min(clip.durationMs, at + 0.001), baseline);
			for (const axis of clip.axes) {
				const amount = Math.abs(after[axis]! - before[axis]!);
				if (amount > largestJump.amount) largestJump = { axis, at, amount };
			}
		}
		expect(largestJump.amount, JSON.stringify(largestJump)).toBeLessThan(0.002);
		for (const axis of clip.axes) {
			expect(sampleAction(clip, 0, baseline)[axis], `${axis} entry`).toBe(baseline[axis]);
			expect(sampleAction(clip, clip.durationMs, baseline)[axis], `${axis} exit`).toBe(baseline[axis]);
			for (const [start, end] of [
				[0, 1],
				[clip.durationMs - 1, clip.durationMs],
			])
				expect(
					Math.abs(sampleAction(clip, end!, baseline)[axis]! - sampleAction(clip, start!, baseline)[axis]!),
				).toBeLessThan(0.001);
		}
	});

	it.each(Object.entries({ curious, curiousDoubleTiltVariant, headToss, headTossPoutVariant }))(
		"%s keeps the composed torso gently opposite the tilted or turned head",
		(_name, action) => {
			const clip = compileAction(action, rig.controls, () => 0.5);
			const d = new MotionDirector(rig.controls, { external: rig.external });
			d.setAuthoredIdle(true);
			d.play(clip, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0 });
			for (let ms = 0; ms < 900; ms += 10) d.step(10);
			const axis = action === curious || action === curiousDoubleTiltVariant ? "roll" : "yaw";
			const frame = d.currentFrame;
			expect(frame[`head.${axis}`]! * frame[`torso.${axis}`]!).toBeLessThan(0);
			expect(Math.abs(frame[`torso.${axis}`]!)).toBeLessThan(3.5);
		},
	);

	it("pout keeps its puffed chest modest after head-follow composition", () => {
		const d = new MotionDirector(rig.controls, { external: rig.external });
		d.setAuthoredIdle(true);
		d.play(
			compileAction(pout, rig.controls, () => 0.5),
			{ category: "voluntary", fadeInMs: 0 },
		);
		for (let ms = 0; ms < 1000; ms += 10) d.step(10);
		expect(d.currentFrame["torso.pitch"]!).toBeGreaterThan(2);
		expect(d.currentFrame["torso.pitch"]!).toBeLessThan(4.2);
	});

	it.each(Object.entries({ glance, glanceDoubleTakeVariant }))(
		"%s lets the eyes lead the head and the torso follow later",
		(_name, action) => {
			const clip = compileAction(action, rig.controls, () => 0.5);
			const onset: Record<string, number> = {};
			for (let ms = 0; ms <= 400; ms += 5) {
				const frame = sampleAction(clip, ms, baseline);
				const values = {
					gaze: frame["gaze.x"]!,
					head: frame["head.yaw"]!,
					torso: frame["head.yaw"]! + frame["torso.yaw"]!,
				};
				for (const [axis, value] of Object.entries(values))
					if (Math.abs(value) > 0.001 && onset[axis] === undefined) onset[axis] = ms;
			}
			expect(onset.head! - onset.gaze!).toBeGreaterThanOrEqual(40);
			expect(onset.torso! - onset.head!).toBeGreaterThanOrEqual(50);
		},
	);
});
