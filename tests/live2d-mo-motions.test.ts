import { describe, expect, it } from "vitest";
import { compileAction, sampleAction } from "../.uina/worlds/live2d/authoring/action.js";
import { absolute, during, keys, timeline } from "../.uina/worlds/live2d/authoring/curves.js";
import { createSeededRandom } from "../.uina/worlds/live2d/authoring/random.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { chinUp } from "../.uina/worlds/live2d/models/mo/motions/chin_up.js";
import { closeUp } from "../.uina/worlds/live2d/models/mo/motions/close_up.js";
import { curious, curiousDoubleTiltVariant } from "../.uina/worlds/live2d/models/mo/motions/curious.js";
import { edgePeek } from "../.uina/worlds/live2d/models/mo/motions/edge_peek.js";
import { glance, glanceDoubleTakeVariant } from "../.uina/worlds/live2d/models/mo/motions/glance.js";
import { headToss, headTossPoutVariant } from "../.uina/worlds/live2d/models/mo/motions/head_toss.js";
import { cuteIdle } from "../.uina/worlds/live2d/models/mo/motions/idle.js";
import { joyHop } from "../.uina/worlds/live2d/models/mo/motions/joy_hop.js";
import { panic } from "../.uina/worlds/live2d/models/mo/motions/panic.js";
import { petrify } from "../.uina/worlds/live2d/models/mo/motions/petrify.js";
import { pout } from "../.uina/worlds/live2d/models/mo/motions/pout.js";
import { sleepy } from "../.uina/worlds/live2d/models/mo/motions/sleepy.js";
import { smugLaugh } from "../.uina/worlds/live2d/models/mo/motions/smug_laugh.js";
import { spin } from "../.uina/worlds/live2d/models/mo/motions/spin.js";
import { surprise } from "../.uina/worlds/live2d/models/mo/motions/surprise.js";
import {
	swayChaoticBouncyVariant,
	swayClassic,
	swayCornerPeekVariant,
	swayVShapeVariant,
} from "../.uina/worlds/live2d/models/mo/motions/sway.js";
import { cuteThinking } from "../.uina/worlds/live2d/models/mo/motions/thinking.js";
import { cuteWinkDoubleVariant } from "../.uina/worlds/live2d/models/mo/motions/wink.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO Authoring Motions Test Suite", () => {
	it("compiles all actions cleanly on MO rig without exceeding control boundaries", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const motions = [
			{ name: "curious", fn: curious, duration: 3800 },
			{ name: "chin_up", fn: chinUp, duration: 2700 },
			{ name: "head_toss", fn: headToss, duration: 3000 },
			{ name: "surprise", fn: surprise, duration: 2500 },
			{ name: "glance", fn: glance, duration: 1200 },
			{ name: "joy_hop", fn: joyHop, duration: 1350 },
			{ name: "petrify", fn: petrify, duration: 4600 },
			{ name: "close_up", fn: closeUp, duration: 4600 },
			{ name: "edge_peek", fn: edgePeek, duration: 4800 },
			{ name: "spin", fn: spin, duration: 2800 },
			{ name: "pout", fn: pout, duration: 2800 },
			{ name: "panic", fn: panic, duration: 2200 },
			{ name: "sleepy", fn: sleepy, duration: 3400 },
			{ name: "smug_laugh", fn: smugLaugh, duration: 2600 },
		];

		for (const { name, fn, duration } of motions) {
			const compiled = compileAction(fn, rig.controls, () => 0.5);
			expect(compiled.durationMs, `${name} duration`).toBe(duration);
			expect(compiled.channels.length, `${name} channels`).toBeGreaterThan(0);

			// torso offset 是修正量；应检查 head-follow、弹簧等合成后的实际输出和 clamp 诊断。
			const director = new MotionDirector(rig.controls, { diagnostics: true });
			director.play(compiled, { category: "voluntary", atomic: false, fadeInMs: 0, fadeOutMs: 250 });
			let clamps = 0;
			for (let t = 20; t <= duration + 400; t += 20) {
				director.step(20);
				clamps += director.getActionDiagnostics()!.clampHits.length;
			}
			expect(clamps, `${name} composed control boundaries`).toBe(0);
		}
	});

	it("verifies curious motion features cat-tilt roll and gaze elevation", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(curious, rig.controls, () => 0.5);
		const peak = sampleAction(compiled, 500, baseline);
		expect(Math.abs(peak["head.roll"]!)).toBeGreaterThan(7.5);
		expect(Math.abs(peak["head.roll"]!)).toBeLessThanOrEqual(10.0);
		expect(peak["gaze.y"]!).toBeGreaterThan(0.6);
		// Torso roll decoupling opposes head roll
		expect(peak["torso.roll"]! * peak["head.roll"]!).toBeLessThan(0);
	});

	it("verifies chin_up motion features high pitch and fox squint", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(chinUp, rig.controls, () => 0.5);
		const peak = sampleAction(compiled, 600, baseline);
		expect(peak["head.pitch"]!).toBeGreaterThan(8.0);
		expect(peak["eyes.left.open"]!).toBeLessThan(0.5);
		expect(peak["mouth.form"]!).toBeGreaterThan(0.85);
		expect(peak["torso.pitch"]!).toBeLessThan(-6.5);
	});

	it("verifies head_toss motion features turn and reverse glance peek", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(headToss, rig.controls, () => 0.5);
		// Peak toss
		const toss = sampleAction(compiled, 500, baseline);
		expect(Math.abs(toss["head.yaw"]!)).toBeGreaterThan(9.5);

		// Reverse peek at t=1200ms
		const peek = sampleAction(compiled, 1200, baseline);
		expect(Math.abs(peek["head.yaw"]!)).toBeGreaterThan(9.0);
		// gaze opposes head yaw
		expect(peek["gaze.x"]! * peek["head.yaw"]!).toBeLessThan(0);
		expect(Math.abs(peek["gaze.x"]!)).toBeGreaterThan(0.7);
	});

	it("verifies spatial motions (joy_hop, petrify, close_up, edge_peek, spin)", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;

		// joy_hop: vertical jumping
		const cJoyHop = compileAction(joyHop, rig.controls, () => 0.5);
		expect(cJoyHop.spatial.length).toBe(5);
		expect(cJoyHop.spatial.some((e) => e.transform?.delta?.y === 0.1)).toBe(true);

		// petrify: tint effects
		const cPetrify = compileAction(petrify, rig.controls, () => 0.5);
		expect(cPetrify.spatial.length).toBe(2);
		expect(cPetrify.spatial[0]?.effects?.tint).toEqual({ r: 110, g: 115, b: 125 });
		expect(cPetrify.spatial[1]?.effects?.tint).toEqual({ r: 255, g: 255, b: 255 });

		// close_up: camera push and retreat
		const cCloseUp = compileAction(closeUp, rig.controls, () => 0.5);
		expect(cCloseUp.spatial.length).toBe(3);
		expect(cCloseUp.spatial[1]?.transform?.delta).toEqual({ size: 40, y: -1.7, rotation: 1.5 });
		expect(cCloseUp.spatial[2]?.transform?.delta).toEqual({ size: 0, y: 0, rotation: 0 });

		// edge_peek: offscreen peek and return
		const cEdgePeek = compileAction(edgePeek, rig.controls, () => 0.5);
		expect(cEdgePeek.spatial.length).toBe(2);
		expect(cEdgePeek.spatial[0]?.transform?.delta).toEqual({ x: -0.78, y: -0.16, rotation: 24 });
		expect(cEdgePeek.spatial[1]?.transform?.delta).toEqual({ x: 0, y: 0, rotation: 0 });

		// spin: 359 relativeRotation
		const cSpin = compileAction(spin, rig.controls, () => 0.5);
		expect(cSpin.spatial.length).toBe(5);
		expect(cSpin.spatial[2]?.transform?.relativeRotation).toBe(359);
	});

	it("cuteIdle keeps perceptible gentle movement between gestures, with a smooth loop seam", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([axis, c]) => [axis, c.neutral]));
		const compiled = compileAction(cuteIdle, rig.controls, () => 0.5);
		let draw = 0;
		const opposite = compileAction(cuteIdle, rig.controls, () => (draw++ === 0 ? 0 : 0.5));
		const quietPeaks: Record<string, number> = {};
		for (const [start, end] of [
			[800, 4500],
			[10000, 14500],
			[20500, 24500],
			[28500, 31500],
		]) {
			const ranges: Record<string, number[]> = {};
			for (let ms = start!; ms <= end!; ms += 20) {
				const frame = sampleAction(compiled, ms, baseline);
				for (const axis of ["head.yaw", "head.roll", "head.pitch"]) {
					(ranges[axis] ??= []).push(frame[axis]!);
					quietPeaks[axis] = Math.max(quietPeaks[axis] ?? 0, Math.abs(frame[axis]!));
				}
				expect(frame["mouth.form"]!, `quiet smile at ${ms}`).toBeLessThan(0.02);
			}
			for (const [axis, minimumChange] of [
				["head.yaw", 0.3],
				["head.roll", 0.35],
				["head.pitch", 0.45],
			] as const)
				expect(
					Math.max(...ranges[axis]!) - Math.min(...ranges[axis]!),
					`${axis} quiet movement at ${start}`,
				).toBeGreaterThan(minimumChange);
		}
		expect(quietPeaks["head.yaw"]).toBeGreaterThan(1.5);
		expect(quietPeaks["head.yaw"]).toBeLessThanOrEqual(2.6);
		expect(quietPeaks["head.roll"]).toBeGreaterThan(1.5);
		expect(quietPeaks["head.roll"]).toBeLessThanOrEqual(2.4);
		expect(quietPeaks["head.pitch"]).toBeGreaterThanOrEqual(0.6);
		expect(quietPeaks["head.pitch"]).toBeLessThanOrEqual(1.4);
		for (const [start, end, axis, minimum] of [
			[5000, 9000, "head.yaw", 1.5],
			[15000, 20000, "head.roll", 2.5],
			[25000, 28000, "mouth.form", 0.15],
		] as const) {
			let peak = 0;
			for (let ms = start; ms <= end; ms += 20) {
				const value = sampleAction(compiled, ms, baseline)[axis]!;
				const eventValue = axis === "mouth.form" ? value : (value - sampleAction(opposite, ms, baseline)[axis]!) / 2;
				peak = Math.max(peak, Math.abs(eventValue));
			}
			expect(peak, axis).toBeGreaterThanOrEqual(minimum);
		}
		for (const axis of compiled.axes) {
			const first = sampleAction(compiled, 0, baseline)[axis]!;
			const last = sampleAction(compiled, compiled.durationMs, baseline)[axis]!;
			expect(first, `${axis} loop value`).toBeCloseTo(last, 8);
			expect(Math.abs(sampleAction(compiled, 10, baseline)[axis]! - first), `${axis} entry speed`).toBeLessThan(0.0001);
			expect(
				Math.abs(last - sampleAction(compiled, compiled.durationMs - 10, baseline)[axis]!),
				`${axis} exit speed`,
			).toBeLessThan(0.0001);
		}
	});

	it("cuteIdle has visible head and torso movement in the first second after startup", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		for (const seed of [0, 7, 42]) {
			const director = new MotionDirector(rig.controls, {
				external: rig.external,
				rng: createSeededRandom(1),
				diagnostics: true,
			});
			director.setAuthoredIdle(true);
			director.play(compileAction(cuteIdle, rig.controls, createSeededRandom(seed)), {
				category: "autonomic",
				loop: true,
				background: true,
				atomic: false,
				fadeInMs: 450,
			});
			let headMovement = 0;
			let bodyMovement = 0;
			for (let elapsed = 20; elapsed <= 1000; elapsed += 20) {
				const frame = director.step(20);
				headMovement = Math.max(headMovement, Math.abs(frame["head.yaw"]!), Math.abs(frame["head.roll"]!));
				bodyMovement = Math.max(bodyMovement, Math.abs(frame["torso.yaw"]!), Math.abs(frame["torso.roll"]!));
			}
			expect(headMovement, `head startup seed ${seed}`).toBeGreaterThan(1);
			expect(bodyMovement, `body startup seed ${seed}`).toBeGreaterThan(0.35);
		}
	});

	it("cuteIdle varies its baked timing and amplitudes without consuming randomness while sampling", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([axis, c]) => [axis, c.neutral]));
		let draws = 0;
		const rng = createSeededRandom(42);
		const first = compileAction(cuteIdle, rig.controls, () => {
			draws++;
			return rng();
		});
		const bakedDraws = draws;
		const same = compileAction(cuteIdle, rig.controls, createSeededRandom(42));
		const other = compileAction(cuteIdle, rig.controls, createSeededRandom(7));
		const times = [5300, 6100, 7600, 15500, 16800, 18100, 25500, 26700];
		const samples = times.map((ms) => sampleAction(first, ms, baseline));
		expect(samples).toEqual(times.map((ms) => sampleAction(same, ms, baseline)));
		expect(samples).not.toEqual(times.map((ms) => sampleAction(other, ms, baseline)));
		expect(draws).toBe(bakedDraws);
	});

	it("cuteIdle lets the eyes lead and the composed torso follow the head later", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline = Object.fromEntries(Object.entries(rig.controls).map(([axis, c]) => [axis, c.neutral]));
		const makeClip = (firstDraw: number) => {
			let first = true;
			return compileAction(cuteIdle, rig.controls, () => {
				if (!first) return 0.5;
				first = false;
				return firstDraw;
			});
		};
		const left = makeClip(0.25);
		const right = makeClip(0.75);
		const onset: Record<string, number> = {};
		// Only event direction differs: subtract the two real plans to remove their shared breathing/drift.
		for (let ms = 4800; ms < 7500; ms += 10) {
			const a = sampleAction(left, ms, baseline);
			const b = sampleAction(right, ms, baseline);
			const values = {
				gaze: a["gaze.x"]! - b["gaze.x"]!,
				head: a["head.yaw"]! - b["head.yaw"]!,
				torso: a["head.yaw"]! + a["torso.yaw"]! - b["head.yaw"]! - b["torso.yaw"]!,
			};
			for (const [axis, value] of Object.entries(values))
				if (Math.abs(value) > 0.001 && onset[axis] === undefined) onset[axis] = ms;
		}
		expect(onset.head! - onset.gaze!).toBeGreaterThanOrEqual(100);
		expect(onset.torso! - onset.head!).toBeGreaterThanOrEqual(150);
	});

	it("cuteIdle runs two production background loops without clamps and yields to a foreground gesture", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const clip = compileAction(cuteIdle, rig.controls, createSeededRandom(42));
		const makeDirector = () => {
			const d = new MotionDirector(rig.controls, {
				external: rig.external,
				rng: createSeededRandom(1),
				diagnostics: true,
			});
			d.setAuthoredIdle(true);
			d.play(clip, {
				category: "autonomic",
				loop: true,
				background: true,
				atomic: false,
				fadeInMs: 450,
				fadeOutMs: 450,
			});
			return d;
		};
		const director = makeDirector();
		const reference = makeDirector();
		const gestureTime = timeline(1200);
		const gesture = compileAction(
			() => ({
				timeline: gestureTime,
				channels: {
					"head.yaw": absolute(
						during(
							gestureTime.span("start", "end"),
							keys([
								[0, 7],
								[1200, 7],
							]),
						),
					),
				},
			}),
			rig.controls,
		);
		let clamps = 0;
		let largestStep = 0;
		const quietRanges: Record<string, number[]> = {};
		let previous: Readonly<Record<string, number>> | undefined;
		for (let ms = 20; ms <= 66000; ms += 20) {
			if (ms === 16000) director.play(gesture, { category: "voluntary", atomic: false, fadeInMs: 120, fadeOutMs: 250 });
			const frame = director.step(20);
			const expected = reference.step(20);
			clamps += director.getActionDiagnostics()!.clampHits.length;
			if (ms >= 10000 && ms <= 14000)
				for (const axis of ["head.yaw", "head.roll", "head.pitch"]) (quietRanges[axis] ??= []).push(frame[axis]!);
			expect(Math.abs(frame["head.yaw"]!)).toBeLessThanOrEqual(ms >= 16000 && ms <= 18500 ? 7.2 : 6);
			expect(Math.abs(frame["head.roll"]!)).toBeLessThanOrEqual(6.5);
			if (ms === 16600) expect(frame["head.yaw"]).toBeGreaterThan(6.5);
			if (ms >= 20000)
				for (const axis of ["head.yaw", "head.roll", "torso.yaw", "torso.roll"])
					expect(frame[axis]).toBeCloseTo(expected[axis]!, 3);
			if (previous && ms > 20000)
				for (const axis of ["head.yaw", "head.pitch", "head.roll", "torso.yaw", "torso.pitch", "torso.roll"])
					largestStep = Math.max(largestStep, Math.abs(frame[axis]! - previous[axis]!));
			previous = frame;
		}
		expect(clamps).toBe(0);
		for (const [axis, minimumChange] of [
			["head.yaw", 0.3],
			["head.roll", 0.35],
			["head.pitch", 0.45],
		] as const)
			expect(
				Math.max(...quietRanges[axis]!) - Math.min(...quietRanges[axis]!),
				`${axis} composed quiet movement`,
			).toBeGreaterThan(minimumChange);
		expect(largestStep).toBeLessThan(0.15);
		expect(director.currentFrame["mouth.open"]).toBe(0);
	});

	it("verifies cuteThinking motion features high-frequency ergonomic design, upward gaze, and seamless loop", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(cuteThinking, rig.controls, () => 0.5);
		expect(compiled.durationMs).toBe(4000);

		// Seamless loop continuity: sample at t=0 and t=4000ms
		const tStart = sampleAction(compiled, 0, baseline);
		const tEnd = sampleAction(compiled, 4000, baseline);
		for (const axis of compiled.axes) {
			expect(tStart[axis]!, `${axis} start vs end continuity`).toBeCloseTo(tEnd[axis]!, 3);
		}

		// Thinking posture: cute upward gaze, head tilt, slightly narrowed focused eyes
		const tMid = sampleAction(compiled, 2000, baseline);
		expect(tMid["gaze.y"]!).toBeGreaterThan(0.25);
		expect(Math.abs(tMid["head.roll"]!)).toBeGreaterThan(3.5);
		expect(tMid["head.pitch"]!).toBeGreaterThan(1.2);
		expect(tMid["eyes.left.open"]!).toBeLessThan(0.9);
		expect(tMid["mouth.form"]!).toBeGreaterThan(0.18);

		// Torso decoupling
		expect(tMid["torso.roll"]! * tMid["head.roll"]!).toBeLessThan(0);
	});

	it("verifies signature sway motions: classic hyper pendulum, corner inspection, and chaotic bouncy", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		// 1. Classic Organic Pendulum
		const cClassic = compileAction(swayClassic, rig.controls, () => 0.5);
		expect(cClassic.durationMs).toBe(3600);
		const classicPeak = sampleAction(cClassic, 450, baseline);
		// Head amplitude is organic and visible (5.0°~6.0°)
		expect(Math.abs(classicPeak["head.roll"]!)).toBeGreaterThan(5.0);
		expect(Math.abs(classicPeak["head.roll"]!)).toBeLessThanOrEqual(6.0);
		// Torso roll offset is decoupled for head-follow (around -1.8°)
		expect(Math.abs(classicPeak["torso.roll"]!)).toBeGreaterThan(1.5);
		expect(Math.abs(classicPeak["torso.roll"]!)).toBeLessThan(2.5);
		// Gaze counter-locks to camera
		expect(classicPeak["gaze.x"]! * classicPeak["head.roll"]!).toBeLessThan(0);

		// Check all points for zero clamp
		for (let ms = 0; ms <= 3600; ms += 200) {
			const s = sampleAction(cClassic, ms, baseline);
			for (const [axis, val] of Object.entries(s)) {
				const ctrl = rig.controls[axis]!;
				expect(val).toBeGreaterThanOrEqual(ctrl.min);
				expect(val).toBeLessThanOrEqual(ctrl.max);
			}
		}

		// 2. Corner Inspection Peek
		const cCorner = compileAction(swayCornerPeekVariant, rig.controls, () => 0.5);
		expect(cCorner.durationMs).toBe(3600);
		const cornerPeak = sampleAction(cCorner, 1000, baseline);
		expect(cornerPeak["gaze.y"]!).toBeGreaterThan(0.15);
		expect(Math.abs(cornerPeak["gaze.x"]!)).toBeGreaterThan(0.25);
		expect(cornerPeak["head.pitch"]!).toBeGreaterThan(1.5);
		expect(Math.abs(cornerPeak["head.roll"]!)).toBeGreaterThan(4.5);

		// 3. Cheerful Bouncy
		const cBouncy = compileAction(swayChaoticBouncyVariant, rig.controls, () => 0.5);
		expect(cBouncy.durationMs).toBe(3600);
		const bouncyPeak1 = sampleAction(cBouncy, 380, baseline);
		const bouncyPeak2 = sampleAction(cBouncy, 1150, baseline);
		expect(Math.abs(bouncyPeak1["head.roll"]!)).toBeGreaterThan(4.8);
		expect(Math.abs(bouncyPeak2["head.roll"]!)).toBeGreaterThan(4.8);
		expect(bouncyPeak1["head.roll"]! * bouncyPeak2["head.roll"]!).toBeLessThan(0);

		// 4. V-Shape Plunge & Leap
		const cVShape = compileAction(swayVShapeVariant, rig.controls, () => 0.5);
		expect(cVShape.durationMs).toBe(3600);
		// Left/Right apex: high pitch (> +0.8°)
		const vApex = sampleAction(cVShape, 450, baseline);
		expect(vApex["head.pitch"]!).toBeGreaterThan(0.8);
		// Center dip: valley pitch (< -0.8°)
		const vDip = sampleAction(cVShape, 900, baseline);
		expect(vDip["head.pitch"]!).toBeLessThan(-0.8);
		// V-depth plunge exceeds 1.8 degrees comfortably
		expect(vApex["head.pitch"]! - vDip["head.pitch"]!).toBeGreaterThan(1.8);
		// Gaze uplook in the valley
		expect(vDip["gaze.y"]!).toBeGreaterThan(0.12);
	});

	it("verifies pout motion features puffed chest, sullen gaze and beak mouth", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(pout, rig.controls, () => 0.5);
		expect(compiled.durationMs).toBe(2800);
		const dwell = sampleAction(compiled, 1000, baseline);
		expect(Math.abs(dwell["head.yaw"]!)).toBeGreaterThan(5.5);
		expect(dwell["head.pitch"]!).toBeGreaterThan(2.5);
		const director = new MotionDirector(rig.controls);
		director.play(compiled, { category: "voluntary", fadeInMs: 0, atomic: false });
		for (let t = 0; t < 1000; t += 20) director.step(20);
		expect(director.currentFrame["torso.pitch"]!).toBeGreaterThan(2.0);
		expect(director.currentFrame["torso.pitch"]!).toBeLessThan(4.5); // 胸部目标不再与头部重复叠加。
		expect(dwell["mouth.open"]!).toBeGreaterThan(0.1);
		expect(dwell["mouth.form"]!).toBeGreaterThan(0.1);
		// Gaze opposes head yaw (glaring sideways)
		expect(dwell["gaze.x"]! * dwell["head.yaw"]!).toBeLessThan(0);
	});

	it("verifies panic motion features swirling eyes, rattle wobble and wavy mouth", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(panic, rig.controls, () => 0.5);
		expect(compiled.durationMs).toBe(2200);
		const mid = sampleAction(compiled, 800, baseline);
		// Swirling eyes: magnitude is around 0.6
		const eyeRadius = Math.hypot(mid["gaze.x"]!, mid["gaze.y"]!);
		expect(eyeRadius).toBeGreaterThan(0.45);
		expect(eyeRadius).toBeLessThanOrEqual(1.0);
		expect(mid["mouth.open"]!).toBeGreaterThan(0.25);
	});

	it("verifies sleepy motion features heavy nod-off, jolt awake and blink recovery", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(sleepy, rig.controls, () => 0.5);
		expect(compiled.durationMs).toBe(3400);
		// Asleep phase at 1800ms
		const asleep = sampleAction(compiled, 1800, baseline);
		expect(asleep["head.pitch"]!).toBeLessThan(-7.0);
		expect(asleep["eyes.left.open"]!).toBeCloseTo(0, 5); // fully closed

		// Jolt awake at 2200ms
		const jolt = sampleAction(compiled, 2200, baseline);
		expect(jolt["head.pitch"]!).toBeGreaterThan(5.0);
		expect(jolt["eyes.left.open"]!).toBeGreaterThan(0.8);
	});

	it("verifies smug_laugh motion features ojou-sama pitch, staccato laugh pulses and condescending gaze", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		const compiled = compileAction(smugLaugh, rig.controls, () => 0.5);
		expect(compiled.durationMs).toBe(2600);
		const peak = sampleAction(compiled, 800, baseline);
		expect(peak["head.pitch"]!).toBeGreaterThan(7.0);
		expect(peak["gaze.y"]!).toBeLessThan(-0.3); // Condescending downward look
		expect(peak["eyes.left.open"]!).toBeLessThan(0.4); // Fox squint
		expect(peak["mouth.form"]!).toBeGreaterThan(0.85); // Big triumphant grin
	});

	it("verifies motion variants: curiousDoubleTilt, glanceDoubleTake, and cuteWinkDouble", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const baseline: Record<string, number> = {};
		for (const [axis, c] of Object.entries(rig.controls)) baseline[axis] = c.neutral;

		// 1. curiousDoubleTiltVariant
		const cCuriousDouble = compileAction(curiousDoubleTiltVariant, rig.controls, () => 0.5);
		expect(cCuriousDouble.durationMs).toBe(3600);
		const tilt1 = sampleAction(cCuriousDouble, 800, baseline);
		const tilt2 = sampleAction(cCuriousDouble, 2400, baseline);
		expect(tilt1["head.roll"]! * tilt2["head.roll"]!).toBeLessThan(0); // tilts to opposite shoulders

		// 2. glanceDoubleTakeVariant
		const cGlanceDouble = compileAction(glanceDoubleTakeVariant, rig.controls, () => 0.5);
		expect(cGlanceDouble.durationMs).toBe(2400);
		const peek1 = sampleAction(cGlanceDouble, 250, baseline);
		const midPause = sampleAction(cGlanceDouble, 800, baseline);
		const peek2 = sampleAction(cGlanceDouble, 1400, baseline);
		expect(Math.abs(peek1["gaze.x"]!)).toBeGreaterThan(0.5);
		expect(Math.abs(midPause["gaze.x"]!)).toBeLessThan(0.1); // returned to center
		expect(Math.abs(peek2["gaze.x"]!)).toBeGreaterThan(0.7); // double-take snap!

		// 3. cuteWinkDoubleVariant
		const cWinkDouble = compileAction(cuteWinkDoubleVariant, rig.controls, () => 0.5);
		expect(cWinkDouble.durationMs).toBe(2000);
		const winkRight = sampleAction(cWinkDouble, 300, baseline);
		const winkLeft = sampleAction(cWinkDouble, 1000, baseline);
		expect(winkRight["eyes.right.open"]!).toBeCloseTo(0, 5); // right eye winks first
		expect(winkLeft["eyes.left.open"]!).toBeCloseTo(0, 5); // left eye winks second

		// 4. headTossPoutVariant
		const cHeadTossPout = compileAction(headTossPoutVariant, rig.controls, () => 0.5);
		expect(cHeadTossPout.durationMs).toBe(3000);
		const poutToss = sampleAction(cHeadTossPout, 1000, baseline);
		expect(Math.abs(poutToss["head.yaw"]!)).toBeGreaterThan(9.0);
		expect(poutToss["mouth.open"]!).toBeGreaterThan(0.1);
	});
});
