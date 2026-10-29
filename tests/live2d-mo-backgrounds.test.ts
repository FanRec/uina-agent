import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { createSeededRandom } from "../.uina/worlds/live2d/authoring/random.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import {
	swayChaoticBouncyVariant,
	swayClassic,
	swayCornerPeekVariant,
	swayVShapeVariant,
} from "../.uina/worlds/live2d/models/mo/motions/sway.js";
import { cuteThinking } from "../.uina/worlds/live2d/models/mo/motions/thinking.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO background gesture continuity", () => {
	it("makes the corner glance lead the head and body, with smooth breathing joins", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const clip = compileAction(swayCornerPeekVariant, rig.controls, () => 0.5);
		const onset: Record<string, number> = {};
		for (let at = 0; at < 600; at += 5) {
			const frame = sampleAction(clip, at);
			const values = {
				gaze: frame["gaze.x"]!,
				head: frame["head.roll"]!,
				body: frame["head.roll"]! + frame["torso.roll"]!,
			};
			for (const [axis, value] of Object.entries(values))
				if (Math.abs(value) > 0.001 && onset[axis] === undefined) onset[axis] = at;
		}
		expect(onset.head! - onset.gaze!).toBeGreaterThanOrEqual(40);
		expect(onset.body! - onset.head!).toBeGreaterThanOrEqual(40);
		for (const at of [600, 2400]) {
			const middle = sampleAction(clip, at)["head.pitch"]!;
			const left = (middle - sampleAction(clip, at - 0.1)["head.pitch"]!) * 10000;
			const right = (sampleAction(clip, at + 0.1)["head.pitch"]! - middle) * 10000;
			expect(Math.abs(left - right), `breathing velocity at ${at}`).toBeLessThan(0.05);
		}
	});

	it("keeps every sway variant and thinking seeded, neutral at loop seams, and unclamped in two background loops", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		for (const author of [
			swayClassic,
			swayCornerPeekVariant,
			swayChaoticBouncyVariant,
			swayVShapeVariant,
			cuteThinking,
		]) {
			let draws = 0;
			const rng = createSeededRandom(42);
			const clip = compileAction(author, rig.controls, () => {
				draws++;
				return rng();
			});
			const bakedDraws = draws;
			const director = new MotionDirector(rig.controls, { diagnostics: true });
			director.play(clip, { category: "autonomic", background: true, loop: true, atomic: false, fadeInMs: 450 });
			for (let at = 10; at <= clip.durationMs * 2; at += 10) {
				director.step(10);
				expect(director.getActionDiagnostics()!.clampHits).toEqual([]);
			}
			for (const axis of clip.axes) {
				const first = sampleAction(clip, 0)[axis]!;
				const last = sampleAction(clip, clip.durationMs)[axis]!;
				expect(first).toBeCloseTo(last, 8);
				expect(Math.abs(sampleAction(clip, 0.1)[axis]! - first)).toBeLessThan(0.0001);
				expect(Math.abs(sampleAction(clip, clip.durationMs - 0.1)[axis]! - last)).toBeLessThan(0.0001);
			}
			expect(draws).toBe(bakedDraws);
		}
	});
});
