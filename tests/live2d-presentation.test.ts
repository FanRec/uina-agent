import { compileExpression, MOTION_NAMES, namedMotion } from "../.uina/worlds/live2d/motion-library.js";
import { AXES } from "../.uina/worlds/live2d/motion-axes.js";
import type { ExpressParams } from "../.uina/worlds/live2d/types.js";
const playExpression = (
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
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { BodyDirector } from "../.uina/worlds/live2d/body-director.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { BASE_POSES } from "../.uina/worlds/live2d/motion-library.js";
import { BASE_POSE_NAMES } from "../.uina/worlds/live2d/types.js";
import { FACE_EXPRESSIONS } from "../.uina/worlds/live2d/motion-library.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};
const frames = (d: MotionDirector, ms: number, name: string) =>
	Array.from({ length: Math.ceil(ms / 10) }, () => d.compose(10)[name]!);

describe("comfortable authored motion", () => {
	it("every named performance renders bounded frame changes and finishes its exit without a leftover lease", async () => {
		for (const name of MOTION_NAMES) {
			const director = new MotionDirector(() => 0.5);
			const resting = new MotionDirector(() => 0.5);
			const compiled = namedMotion(name);
			const task = director.play(compiled);
			await flush();
			let previous = director.compose(0);
			for (let at = 0; at < compiled.durationMs + 350; at += 1000 / 60) {
				const frame = director.compose(1000 / 60);
				resting.compose(1000 / 60);
				for (const axis of compiled.axes) {
					const metadata = AXES[axis];
					expect(frame[axis]).toBeGreaterThanOrEqual(metadata.min);
					expect(frame[axis]).toBeLessThanOrEqual(metadata.max);
					let limit = 0.13;
					if (metadata.angular) limit = 0.8;
					else if (axis.startsWith("eyes.") && axis.endsWith(".open")) limit = 0.16;
					expect(Math.abs(frame[axis]! - previous[axis]!)).toBeLessThan(limit);
				}
				previous = frame;
			}
			expect(await task).toEqual({ status: "completed" });
			expect(director.getActiveLeases()).toEqual([]);
			// Allow continuous dynamics to settle; ordinary ambient motion and gaze compensation remain active.
			director.compose(1500);
			resting.compose(1500);
			for (const axis of compiled.axes)
				expect(director.getParamTarget(axis), `${name}: ${axis}`).toBeCloseTo(
					resting.getParamTarget(axis),
					axis.startsWith("gaze.") ? 3 : 8,
				);
		}
	});
	it("retargeting preserves acceleration, rather than just position and velocity", () => {
		const a = new BodyDirector(),
			b = new BodyDirector();
		a.setTarget("head.roll", 12);
		b.setTarget("head.roll", 12);
		a.tick(180);
		b.tick(180);
		a.setTarget("head.roll", -12);
		const reversed = a.tick(0.1)["head.roll"]!,
			continued = b.tick(0.1)["head.roll"]!;
		// A second-order spring changes displacement by O(dt²); C2 dynamics changes it by O(dt³).
		expect(Math.abs(reversed - continued)).toBeLessThan(1e-8);
	});
	it("a stationary facial transition approaches without an overshoot or a bounce", () => {
		const body = new BodyDirector();
		body.setTarget("mouth.form", 0.6);
		const values = Array.from({ length: 200 }, () => body.tick(10)["mouth.form"]!);
		for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
		expect(Math.max(...values)).toBeLessThanOrEqual(0.6);
		expect(values.at(-1)).toBeCloseTo(0.6, 5);
	});
	it("wall-clock delay cannot consume the timeline; coarse rendering agrees with fine rendering", async () => {
		vi.useFakeTimers();
		const d = new MotionDirector(() => 0.5);
		const reference = new MotionDirector(() => 0.5);
		const expression = {
			beats: [
				{ head: "tilt_left", hold_ms: 500 },
				{ head: "tilt_right", hold_ms: 500 },
			],
		};
		const task = playExpression(d, expression);
		const referenceTask = playExpression(reference, expression);
		await flush();
		const finished = vi.fn();
		void task.then(finished);
		await vi.advanceTimersByTimeAsync(5000);
		expect(finished).not.toHaveBeenCalled();
		for (const elapsed of [400, 450, 750]) {
			d.compose(elapsed);
			for (let i = 0; i < elapsed / 10; i++) reference.compose(10);
			expect(d.getParamTarget("head.roll")).toBeCloseTo(reference.getParamTarget("head.roll"), 8);
			// Dynamics samples targets at at most 60 Hz; the 100 Hz reference has a small integration difference.
			expect(Math.abs(d.getParam("head.roll") - reference.getParam("head.roll"))).toBeLessThan(0.2);
		}
		expect(await task).toEqual({ status: "completed" });
		expect(await referenceTask).toEqual({ status: "completed" });
	});
	it("step boundary has a comfortable target ramp, and the lease remains during exit", async () => {
		const d = new MotionDirector(() => 0.5);
		const task = playExpression(d, {
			beats: [
				{ head: "tilt_left", hold_ms: 600 },
				{ head: "tilt_right", hold_ms: 600 },
			],
		});
		await flush();
		d.compose(590);
		const before = d.getParamTarget("head.roll");
		d.compose(20);
		expect(Math.abs(d.getParamTarget("head.roll") - before)).toBeLessThan(0.2);
		d.compose(590);
		expect(d.getActiveLeases()).toHaveLength(1);
		const exit = frames(d, 320, "head.roll");
		expect(await task).toEqual({ status: "completed" });
		expect(d.getActiveLeases()).toHaveLength(0);
		for (let i = 1; i < exit.length; i++) expect(Math.abs(exit[i]! - exit[i - 1]!)).toBeLessThan(0.6);
	});
	it("a double nod contains two visible down/return gestures, rather than extreme down/up poses", async () => {
		const d = new MotionDirector(() => 0.5);
		const task = playExpression(d, { motion: "double_nod" });
		await flush();
		const values = frames(d, 2000, "head.pitch");
		const troughs = values
			.slice(1, -1)
			.filter((value, index) => value < -2 && value < values[index]! && value <= values[index + 2]!);
		expect(troughs).toHaveLength(2);
		expect(Math.min(...values)).toBeGreaterThan(-9);
		expect(values.at(-1)).toBeGreaterThan(-0.6);
		expect(await task).toEqual({ status: "completed" });
	});
	it("shake visits both yaw directions with a stable roll and returns", async () => {
		const d = new MotionDirector(() => 0.5);
		const task = playExpression(d, { motion: "shake" });
		await flush();
		const yaw = frames(d, 2200, "head.yaw");
		expect(Math.min(...yaw)).toBeLessThan(-2);
		expect(Math.max(...yaw)).toBeGreaterThan(2);
		expect(d.getParam("head.roll")).toBeLessThan(1);
		expect(Math.abs(yaw.at(-1)!)).toBeLessThan(0.4);
		await task;
	});
	it("all resting poses retain gesture headroom; all faces remain distinct without additive saturation", async () => {
		for (const pose of BASE_POSE_NAMES) {
			for (const name of ["head.yaw", "head.pitch", "head.roll"] as const)
				expect(Math.abs(BASE_POSES[pose][name] ?? 0)).toBeLessThanOrEqual(7);
			const signatures = new Set<string>();
			for (const face of FACE_EXPRESSIONS) {
				const d = new MotionDirector(() => 0.5);
				d.applyBasePose(pose);
				d.compose(2000);
				const task = playExpression(d, { face, latch_last: true });
				await flush();
				d.compose(1000);
				await task;
				const names = ["eyes.left.open", "eyes.right.open", "brows.left", "brows.right", "mouth.form", "face.blush"];
				const values = names.map((name) => d.getParamTarget(name));
				expect(values.every(Number.isFinite)).toBe(true);
				expect(Math.max(...values)).toBeLessThanOrEqual(1);
				expect(Math.min(...values)).toBeGreaterThan(-0.7);
				signatures.add(JSON.stringify(values));
			}
			expect(signatures.size).toBe(FACE_EXPRESSIONS.length);
		}
	});
});

describe("blink admission does not create an ownership twitch", () => {
	it("a suppressed blink never resumes from its middle when eyes are released", () => {
		const noise = new PhysiologicalNoise({ randomFn: () => 0.5 });
		expect(noise.tick(4040, { allowBlink: false })["eyes.left.open"]).toBe(1);
		expect(noise.tick(30, { allowBlink: true })["eyes.left.open"]).toBe(1);
	});
	it("an admitted blink completes identically even when an action takes the eyes mid-blink", async () => {
		const a = new MotionDirector(() => 0.5),
			b = new MotionDirector(() => 0.5);
		a.noise.triggerBlink();
		b.noise.triggerBlink();
		a.compose(20);
		b.compose(20);
		const lease = await a.claim(["eyes"]);
		for (let i = 0; i < 30; i++)
			expect(a.compose(10)["eyes.left.open"]).toBeCloseTo(b.compose(10)["eyes.left.open"]!, 10);
		lease.release();
		expect(a.compose(0)["eyes.left.open"]).toBeCloseTo(1, 10);
	});
});
