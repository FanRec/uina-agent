import { describe, expect, it } from "vitest";
import {
	compileMotion,
	delay,
	motion,
	parallel,
	pose,
	repeat,
	sampleLoop,
	sampleMotion,
	sequence,
	track,
	transform,
	type MotionDefinition,
} from "../.uina/worlds/live2d/motion.js";
import { AXES, NEUTRAL_AXES } from "../.uina/worlds/live2d/motion-axes.js";
import {
	AMBIENT,
	BASE_POSES,
	compileExpression,
	MOTION_NAMES,
	namedMotion,
} from "../.uina/worlds/live2d/motion-library.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";

const flush = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
const offset = (ms: number, value: number) => pose(ms, { "head.pitch": value }, "baseline-offset");

describe("motion authoring and compilation", () => {
	it("retains the complete former named performance vocabulary through the new catalog", () => {
		// Renamed performances are real definitions; the former parser and alias table stay removed.
		const performances = [
			"smile",
			"laugh",
			"curious",
			"nod",
			"double_nod",
			"shake",
			"shrug",
			"head_bop",
			"pout",
			"surprise",
			"shy",
			"look_away",
			"peek_back",
			"thinking_deep",
			"wink",
			"smug_grin",
			"sleepy_yawn",
			"sparkle",
		];
		for (const name of performances) {
			expect(MOTION_NAMES).toContain(name);
			expect(compileExpression({ motion: name })).toEqual(namedMotion(name));
		}
	});
	it("gaze leads the look-away gesture, while thinking and peeking intentionally return to the user", () => {
		const away = namedMotion("look_away");
		const start = sampleMotion(away, 250);
		expect(start["gaze.x"]! / 0.85).toBeGreaterThan(start["head.yaw"]! / 10);
		expect(sampleMotion(away, away.durationMs)["gaze.x"]).toBeGreaterThan(0.5);
		for (const name of ["thinking_deep", "peek_back"]) {
			const compiled = namedMotion(name);
			expect(sampleMotion(compiled, compiled.durationMs)["gaze.x"]).toBe(0);
		}
	});
	it("yawning visibly opens and closes the mouth, restores the eyes, and reserves optional jaw detail", () => {
		const compiled = namedMotion("sleepy_yawn");
		const peak = sampleMotion(compiled, 1850);
		expect(peak["mouth.open"]).toBeGreaterThan(0.6);
		expect(peak["eyes.left.open"]).toBeLessThan(0.3);
		expect(sampleMotion(compiled, compiled.durationMs)).toMatchObject({
			"mouth.open": 0,
			"eyes.left.open": 1,
			"eyes.right.open": 1,
			"head.pitch": 0,
		});
		expect(compiled.tracks.filter((t) => t.axis === "jaw.open").every((t) => t.optional)).toBe(true);
	});
	it("head bopping alternates and softens, while sparkle anticipates before lifting", () => {
		const bop = namedMotion("head_bop");
		expect(sampleMotion(bop, 400)["head.roll"]).toBeGreaterThan(4);
		expect(sampleMotion(bop, 1050)["head.roll"]).toBeLessThan(-3);
		expect(sampleMotion(bop, 1700)["head.roll"]).toBe(2);
		expect(sampleMotion(bop, bop.durationMs)["head.roll"]).toBe(0);
		const sparkle = namedMotion("sparkle");
		expect(sampleMotion(sparkle, 320)["head.pitch"]).toBeLessThan(0);
		expect(sampleMotion(sparkle, 1050)["head.pitch"]).toBeGreaterThan(3);
		expect(sampleMotion(sparkle, 1450)["mouth.form"]).toBeGreaterThan(0.6);
	});
	it("a wink closes one eye briefly and reopens it before the performance ends", () => {
		const compiled = namedMotion("wink");
		expect(sampleMotion(compiled, 440)["eyes.right.open"]).toBeLessThan(0.1);
		expect(compiled.axes).not.toContain("eyes.left.open");
		expect(sampleMotion(compiled, 900)["eyes.right.open"]).toBe(1);
	});
	it("random single and double blinks sample the authored curves and retain slow-frame carry", () => {
		for (const double of [false, true]) {
			const noise = new PhysiologicalNoise({ randomFn: () => 0.5 });
			const compiled = double ? AMBIENT.doubleBlink : AMBIENT.blink;
			noise.triggerBlink({ willDoubleBlink: double });
			for (let at = 10; at <= compiled.durationMs; at += 10) {
				const actual = noise.tick(10);
				const authored = sampleMotion(compiled, at);
				expect(actual["eyes.left.open"]).toBeCloseTo(authored["eyes.left.open"]!, 10);
				expect(actual["eyes.right.open"]).toBeCloseTo(authored["eyes.right.open"]!, 10);
			}
			expect(noise.getBlinkPhase()).toBe(0);
			noise.triggerBlink({ willDoubleBlink: double });
			expect(noise.tick(compiled.durationMs + 50)["eyes.left.open"]).toBe(1);
			expect(noise.getBlinkPhase()).toBe(0);
		}
	});
	it("composes reusable primitives into a complex seekable multi-axis performance", () => {
		const nod = motion(
			800,
			track(
				"head.pitch",
				[
					[0, 0],
					[300, -8],
					[800, 0],
				],
				"baseline-offset",
			),
		);
		const compiled = compileMotion(
			sequence(
				parallel(repeat(2, nod), delay(200, pose(1000, { "mouth.form": 0.6 }))),
				pose(600, { "gaze.x": 0, "gaze.y": 0 }),
			),
		);
		expect(compiled.durationMs).toBe(2200);
		expect(new Set(compiled.channels)).toEqual(new Set(["gaze", "head", "mouth"]));
		expect(sampleMotion(compiled, 300)["head.pitch"]).toBe(-8);
		expect(sampleMotion(compiled, 1100)["head.pitch"]).toBe(-8);
		expect(sampleMotion(compiled, 1800)["mouth.form"]).toBe(0.6);
		expect(sampleMotion(compiled, 2200)["gaze.x"]).toBe(0);
		// Sampling is stateless; visiting later times cannot alter a previous sample.
		expect(sampleMotion(compiled, 300)["head.pitch"]).toBe(-8);
	});
	it("holds a shorter parallel branch without a step at its end", () => {
		const compiled = compileMotion(parallel(offset(100, 1), offset(200, 2)));
		for (const at of [99, 100, 101, 199, 200]) expect(sampleMotion(compiled, at)["head.pitch"]).toBe(3);
	});
	it("a sequence branch holds axes through unwritten middle and trailing segments", () => {
		const compiled = compileMotion(
			parallel(
				sequence(offset(100, 1), pose(100, { "gaze.x": 0.2 }), offset(100, 2), pose(100, { "gaze.y": 0.3 })),
				offset(500, 5),
			),
		);
		for (const at of [99, 100, 150, 199, 200]) expect(sampleMotion(compiled, at)["head.pitch"]).toBe(6);
		for (const at of [240, 299, 300, 400, 500]) expect(sampleMotion(compiled, at)["head.pitch"]).toBe(7);
	});
	it("delayed offsets blend their own contribution without doubling another branch", () => {
		const compiled = compileMotion(parallel(offset(1000, 5), delay(500, offset(100, 2))));
		expect(sampleMotion(compiled, 499)["head.pitch"]).toBe(5);
		expect(sampleMotion(compiled, 500)["head.pitch"]).toBe(5);
		expect(sampleMotion(compiled, 520)["head.pitch"]).toBeCloseTo(6);
		for (const at of [540, 599, 600, 1000]) expect(sampleMotion(compiled, at)["head.pitch"]).toBe(7);
	});
	it("blends sequential poses from their own preceding branch", () => {
		const compiled = compileMotion(parallel(offset(1000, 5), sequence(offset(500, 1), offset(500, 2))));
		expect(sampleMotion(compiled, 499)["head.pitch"]).toBe(6);
		expect(sampleMotion(compiled, 500)["head.pitch"]).toBe(6);
		expect(sampleMotion(compiled, 590)["head.pitch"]).toBeCloseTo(6.5);
		expect(sampleMotion(compiled, 700)["head.pitch"]).toBe(7);
	});
	it("rejects ambiguous parallel ownership, invalid axes, non-finite keys and invalid timing", () => {
		expect(() => compileMotion(parallel(pose(100, { "mouth.form": 0.2 }), pose(200, { "mouth.form": 0.4 })))).toThrow(
			"Conflicting",
		);
		expect(() => compileMotion(parallel(pose(100, { "head.pitch": 1 }), offset(100, 1)))).toThrow("Conflicting");
		for (const definition of [
			motion(100, {
				axis: "not_an_axis" as never,
				keys: [
					{ atMs: 0, value: 0 },
					{ atMs: 100, value: 1 },
				],
			}),
			motion(
				100,
				track("head.pitch", [
					[0, 0],
					[100, NaN],
				]),
			),
			motion(
				100,
				track("head.pitch", [
					[0, 0],
					[50, 1],
					[50, 2],
					[100, 0],
				]),
			),
			motion(
				100,
				track("head.pitch", [
					[0, 0],
					[100, 31],
				]),
			),
			transform(transform(offset(100, 1), { durationScale: 1e-200 }), { durationScale: 1e-200 }),
			delay(1e100, offset(100, 1)),
			sequence(),
		])
			expect(() => compileMotion(definition)).toThrow();
		const cyclic = { kind: "sequence", motions: [] } as { kind: "sequence"; motions: MotionDefinition[] };
		cyclic.motions.push(cyclic);
		expect(() => compileMotion(cyclic)).toThrow("cyclic");
	});
	it("nested parallel branch order cannot change sequence entry or sum the previous pose twice", () => {
		for (const branches of [
			[delay(100, offset(100, 2)), offset(200, 3)],
			[offset(200, 2), offset(200, 3)],
		]) {
			const a = compileMotion(sequence(offset(100, 5), parallel(...branches)));
			const b = compileMotion(sequence(offset(100, 5), parallel(...branches.toReversed())));
			for (let at = 0; at <= a.durationMs; at++) expect(sampleMotion(a, at)).toEqual(sampleMotion(b, at));
			expect(sampleMotion(a, 100)["head.pitch"]).toBe(5);
			expect(sampleMotion(a, a.durationMs)["head.pitch"]).toBe(5);
		}
	});
	it("detaches compiled values and curves from mutable authoring objects", () => {
		const curve: [number, number, number, number] = [0.2, 0.1, 0.8, 0.9];
		const keys = [
			{ atMs: 0, value: 0, curve },
			{ atMs: 100, value: 10, curve },
		];
		const compiled = compileMotion(motion(100, { axis: "head.yaw", keys }));
		const before = sampleMotion(compiled, 50);
		keys[1]!.value = -20;
		curve[1] = 1;
		expect(sampleMotion(compiled, 50)).toEqual(before);
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(compiled.tracks[0]!.keys[1]!.curve)).toBe(true);
		expect(() => sampleMotion({ ...compiled }, 50)).toThrow("compiled");
	});
	it("scales absolute facial values around neutral and leaves baseline binding to playback", () => {
		const eyes = compileMotion(transform(pose(100, { "eyes.left.open": 0 }), { intensity: 0.2 }));
		expect(sampleMotion(eyes, 50)["eyes.left.open"]).toBe(0.8);
		const compiled = compileMotion(offset(100, -8));
		expect(sampleMotion(compiled, 50, { "head.pitch": 4 })["head.pitch"]).toBe(-4);
		expect(sampleMotion(compiled, 50, { "head.pitch": -2 })["head.pitch"]).toBe(-10);
	});
	it("supports authored curves and rejects sequence or delay at the independent loop entry", () => {
		const compiled = compileMotion(
			motion(
				100,
				track(
					"head.pitch",
					[
						[0, 0],
						[100, 10],
					],
					"absolute",
					[0.2, 0, 0.8, 1],
				),
			),
		);
		expect(sampleMotion(compiled, 50)["head.pitch"]).toBeCloseTo(5);
		expect(() => sampleLoop(compileMotion(delay(100, offset(200, 1))), 0)).toThrow("zero-start");
	});
	it("the full catalog compiles and produces finite in-range presentation across base poses", () => {
		for (const name of MOTION_NAMES) {
			const compiled = namedMotion(name);
			for (const baseline of Object.values(BASE_POSES))
				for (let at = 0; at <= compiled.durationMs; at += 20) {
					for (const [axis, value] of Object.entries(sampleMotion(compiled, at, baseline))) {
						expect(Number.isFinite(value), name + ": " + axis).toBe(true);
						const metadata = AXES[axis as keyof typeof AXES];
						expect(value).toBeGreaterThanOrEqual(metadata.min);
						expect(value).toBeLessThanOrEqual(metadata.max);
					}
				}
		}
	});
});

describe("compiled production playback", () => {
	it("a representable subnormal duration never introduces a NaN during admission", async () => {
		const director = new MotionDirector();
		const result = director.play(
			compileMotion(
				motion(
					Number.MIN_VALUE,
					track("head.pitch", [
						[0, 0],
						[Number.MIN_VALUE, 1],
					]),
				),
			),
			{ latch: true },
		);
		await flush();
		expect(Object.values(director.compose(0)).every(Number.isFinite)).toBe(true);
		director.compose(1);
		expect(await result).toEqual({ status: "completed" });
	});
	it("a new complex authored action runs without teaching its name to the director", async () => {
		const director = new MotionDirector(() => 0.5);
		const compiled = compileMotion(
			sequence(
				parallel(
					motion(
						600,
						track(
							"head.roll",
							[
								[0, 0],
								[250, 8],
								[600, 0],
							],
							"baseline-offset",
						),
					),
					delay(100, pose(500, { "gaze.x": -0.4 })),
				),
				pose(300, { "mouth.form": 0.5 }),
			),
		);
		const result = director.play(compiled);
		await flush();
		const frames = Array.from({ length: 130 }, () => director.compose(10));
		expect(Math.max(...frames.map((f) => f["head.roll"]!))).toBeGreaterThan(1);
		expect(Math.min(...frames.map((f) => f["gaze.x"]!))).toBeLessThan(-0.1);
		expect(await result).toEqual({ status: "completed" });
		expect(director.getActiveLeases()).toEqual([]);
	});
	it("an atomic multi-channel action is cancelled as a whole when one channel is preempted", async () => {
		const d = new MotionDirector();
		const result = d.play(compileExpression({ head: "nod", gaze: "down" }), { atomic: true });
		await flush();
		await d.claim(["head"], { priority: 100 });
		expect(await result).toEqual({ status: "cancelled" });
		expect(d.getActiveLeases().flatMap((l) => l.channels)).toEqual(["head"]);
		d.abortAllMotions();
	});
	it("coarse and fine frames traverse the same authored trajectory and retain ownership during exit", async () => {
		const a = new MotionDirector(() => 0.5),
			b = new MotionDirector(() => 0.5);
		const compiled = namedMotion("celebrate");
		const first = a.play(compiled),
			second = b.play(compiled);
		await flush();
		a.compose(1000);
		for (let i = 0; i < 60; i++) b.compose(1000 / 60);
		for (const axis of compiled.axes) expect(a.getParam(axis)).toBeCloseTo(b.getParam(axis), 8);
		a.compose(compiled.durationMs - 1000);
		expect(a.getActiveLeases()).toHaveLength(1);
		a.compose(320);
		b.compose(compiled.durationMs - 1000 + 320);
		expect(await first).toEqual({ status: "completed" });
		expect(await second).toEqual({ status: "completed" });
	});
	it("invalid expressions acquire no lease and cannot pollute the resting frame", async () => {
		const runtime = new Live2DRuntime();
		for (const args of [
			{ motion: "constructor" },
			{ motion: "nod", head: "nod" },
			{ head: "nod", intensity: NaN },
			{},
		]) {
			const result = await runtime.executeExpress(args, { signal: new AbortController().signal } as never);
			expect(result).toMatchObject({ status: "failed", details: { effectStatus: "not_started" } });
		}
		expect(runtime.director.getActiveLeases()).toEqual([]);
		expect(Object.values(runtime.director.compose(0))).toEqual(Object.values(NEUTRAL_AXES));
	});
	it("atomic admission acquires all channels or leaves existing ownership untouched", async () => {
		const runtime = new Live2DRuntime();
		const occupied = await runtime.director.claim(["head"], { priority: 100 });
		const result = await runtime.executeExpress({ head: "nod", gaze: "down", atomic: true }, {
			signal: new AbortController().signal,
		} as never);
		expect(result).toMatchObject({ status: "failed", details: { effectStatus: "not_started" } });
		expect(runtime.director.getActiveLeases()).toEqual([occupied]);
		expect(occupied.signal.aborted).toBe(false);
		occupied.release();
	});
});
