import { describe, expect, it } from "vitest";
import {
	type ActionAuthoring,
	type ActionPlan,
	compileAction,
	isCompiledAction,
	motion,
	sampleAction,
	sampleSpeechGain,
	withSpeech,
} from "../.uina/worlds/live2d/authoring/action.js";
import {
	absolute,
	during,
	getActionCurveSpans,
	keys,
	offset,
	timeline,
	track,
} from "../.uina/worlds/live2d/authoring/curves.js";
import type { SpatialEvent } from "../.uina/worlds/live2d/authoring/spatial.js";

const CONTROLS = {
	"head.yaw": { min: -12, max: 12, neutral: 0 },
	"mouth.open": { min: 0, max: 1, neutral: 0 },
};

const planAuthoring =
	(plan: ActionPlan): ActionAuthoring =>
	() =>
		plan;

describe("motion shortcut and ActionPlan Bake", () => {
	it("maps local curves to [0,duration] and samples offsets from the baseline", () => {
		let randomDraws = 0;
		const authoring = motion(500, (rng) => {
			const gain = 0.5 + rng();
			return {
				"head.yaw": offset(
					keys([
						[0, 0],
						[500, 10 * gain],
					]),
				),
			};
		});
		const plan = authoring(() => {
			randomDraws++;
			return 0.5;
		});
		const channel = plan.channels["head.yaw"] as { space: string; curve: (timeMs: number) => number };
		expect(plan.timeline.durationMs).toBe(500);
		expect(channel.space).toBe("baseline-offset");
		expect(channel.curve(0)).toBe(0);
		expect(channel.curve(250)).toBeCloseTo(5, 9);
		expect(channel.curve(500)).toBe(10);
		expect(randomDraws).toBe(1);
	});

	it("invokes the author factory once and freezes a pure compiled sampler", () => {
		let factoryCalls = 0;
		const authoring: ActionAuthoring = (rng) => {
			factoryCalls++;
			const end = 4 + rng() * 2;
			return {
				timeline: timeline(1000),
				channels: {
					"head.yaw": offset(
						during(
							{ startMs: 0, endMs: 1000, durationMs: 1000 },
							keys([
								[0, 0],
								[1000, end],
							]),
						),
					),
				},
			};
		};
		const compiled = compileAction(authoring, CONTROLS, () => 0.5);
		expect(factoryCalls).toBe(1);
		expect(isCompiledAction(compiled)).toBe(true);
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(compiled.channels)).toBe(true);
		expect(sampleAction(compiled, 500, { "head.yaw": 2 })["head.yaw"]).toBeCloseTo(4.5, 9);
		expect(sampleAction(compiled, -5)["head.yaw"]).toBe(0);
		expect(sampleAction(compiled, 2000)["head.yaw"]).toBe(5);
	});

	it("uses a deterministic midpoint stream for standalone compiles without a supplied RNG", () => {
		const authoring = motion(100, (rng) => {
			const value = rng() * 10;
			return { "head.yaw": absolute(() => value) };
		});
		const first = compileAction(authoring, CONTROLS);
		const replay = compileAction(authoring, CONTROLS);
		expect(sampleAction(first, 50)["head.yaw"]).toBe(5);
		expect(sampleAction(replay, 50)).toEqual(sampleAction(first, 50));
	});

	it("keeps during and track spans stable when callers mutate their original spans", () => {
		const span = { startMs: 20, endMs: 80, durationMs: 60 };
		const local = keys(
			[
				[0, 0],
				[60, 6],
			],
			"linear",
		);
		const duringCurve = during(span, local);
		span.endMs = 30;
		span.durationMs = 10;
		expect(duringCurve(50)).toBe(3);
		expect(getActionCurveSpans(duringCurve)).toEqual([{ startMs: 20, endMs: 80, durationMs: 60 }]);

		const trackSpan = { startMs: 20, endMs: 80, durationMs: 60 };
		const trackCurve = track([{ span: trackSpan, curve: local }]);
		trackSpan.startMs = 50;
		trackSpan.endMs = 90;
		trackSpan.durationMs = 40;
		expect(trackCurve(25)).toBe(0.5);
		expect(getActionCurveSpans(trackCurve)).toEqual([{ startMs: 20, endMs: 80, durationMs: 60 }]);
	});

	it("rejects inconsistent helper spans even when their absolute timestamps are large", () => {
		const span = { startMs: 1_000_000_000_000, endMs: 1_000_000_005_000, durationMs: 4000 };
		const local = keys(
			[
				[0, 0],
				[4000, 1],
			],
			"linear",
		);
		expect(() => during(span, local)).toThrow(/span/);
		expect(() => track([{ span, curve: local }])).toThrow(/span/);
	});

	it("rejects a span mismatch at a large timestamp when absolute tolerance hides the VTS cap", () => {
		const startMs = 1e16;
		const span = { startMs, endMs: startMs + 2, durationMs: 1 };
		const local = keys(
			[
				[0, 0],
				[1, 1],
			],
			"linear",
		);
		expect(() => during(span, local)).toThrow(/span/);
		expect(() => track([{ span, curve: local }])).toThrow(/span/);

		const authoring = planAuthoring({
			timeline: timeline(startMs + 2),
			channels: { "head.yaw": absolute(() => 0) },
			spatial: [{ during: span, transform: { delta: { x: 1 } } }],
			speed: 0.00075,
		});
		expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/span/);
	});

	it("rejects inconsistent helper spans near zero instead of using an absolute tolerance floor", () => {
		const span = { startMs: 0, endMs: 8e-16, durationMs: 1e-20 };
		const local = keys(
			[
				[0, 0],
				[1e-20, 1],
			],
			"linear",
		);
		expect(() => during(span, local)).toThrow(/span/);
		expect(() => track([{ span, curve: local }])).toThrow(/span/);
	});

	it("draws randomized authoring parameters once and never during curve sampling", () => {
		let randomDraws = 0;
		const authoring = motion(100, (rng) => {
			const draw = rng();
			return { "head.yaw": absolute(() => draw * 10) };
		});
		const compiled = compileAction(authoring, CONTROLS, () => {
			randomDraws++;
			return 0.25;
		});
		expect(sampleAction(compiled, 50)["head.yaw"]).toBe(2.5);
		expect(sampleAction(compiled, 75)["head.yaw"]).toBe(2.5);
		expect(randomDraws).toBe(1);
	});

	it("rejects wall durations that overflow or underflow after speed conversion", () => {
		for (const [durationMs, speed] of [
			[Number.MAX_VALUE, Number.MIN_VALUE],
			[Number.MIN_VALUE, Number.MAX_VALUE],
		] as const) {
			const authoring = planAuthoring({
				timeline: timeline(durationMs),
				channels: { "head.yaw": absolute(() => 0) },
				speed,
			});
			expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/wall duration|wall 时长/i);
		}
		const veryLong = compileAction(
			planAuthoring({
				timeline: timeline(Number.MAX_VALUE),
				channels: {
					"head.yaw": absolute((actionMs) => {
						if (!Number.isFinite(actionMs)) throw new Error("sample time must stay finite");
						return 0;
					}),
				},
				speed: Number.MAX_VALUE,
			}),
			CONTROLS,
			() => 0.5,
		);
		expect(veryLong.durationMs).toBe(Number.MAX_VALUE);
	});

	it("applies speech policy to mouth.open without changing other channels", () => {
		const authoring = withSpeech(
			motion(100, {
				"head.yaw": absolute((t) => t / 100),
				"mouth.open": absolute((t) => t / 100),
			}),
			"exclusive",
		);
		const compiled = compileAction(authoring, CONTROLS, () => 0.5);
		expect(sampleSpeechGain(compiled, 50)).toBe(0);
		expect(sampleAction(compiled, 50)["head.yaw"]).toBe(0.5);
		expect(sampleAction(compiled, 50)["mouth.open"]).toBe(0.5);
	});

	it("rejects invalid speed, empty/unknown channels, and LocalCurves used as ActionCurves", () => {
		const empty = planAuthoring({ timeline: timeline(100), channels: {} });
		expect(() => compileAction(empty, CONTROLS, () => 0.5)).toThrow(/至少需要一个通道/);
		const unknown = planAuthoring({ timeline: timeline(100), channels: { "head.roll": absolute((t) => t) } });
		expect(() => compileAction(unknown, CONTROLS, () => 0.5)).toThrow(/未知轴/);
		const badSpeed = planAuthoring({ timeline: timeline(100), channels: { "head.yaw": (t) => t }, speed: 0 });
		expect(() => compileAction(badSpeed, CONTROLS, () => 0.5)).toThrow(/speed/);
		const localAsAction = planAuthoring({
			timeline: timeline(100),
			channels: {
				"head.yaw": absolute(
					keys([
						[0, 0],
						[100, 1],
					]),
				),
			},
		});
		expect(() => compileAction(localAsAction, CONTROLS, () => 0.5)).toThrow(/during|track/);
	});

	it("rejects nonfinite sample values that fall between the probe points", () => {
		const authoring = planAuthoring({
			timeline: timeline(1000),
			channels: { "head.yaw": (t) => (t > 500 ? Number.NaN : 0) },
		});
		expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/非有限/);
	});

	it("checks helper spans against the current ActionPlan without storing Timeline identity", () => {
		const tooLong = planAuthoring({
			timeline: timeline(100),
			channels: {
				"head.yaw": offset(
					during(
						{ startMs: 0, endMs: 101, durationMs: 101 },
						keys([
							[0, 0],
							[101, 1],
						]),
					),
				),
			},
		});
		expect(() => compileAction(tooLong, CONTROLS, () => 0.5)).toThrow(/超出 ActionPlan/);

		const firstTimeline = timeline(100);
		const equivalentSpan = firstTimeline.span("start", "end");
		const otherTimeline = timeline(100, { halfway: 50 });
		const sameNumbers = planAuthoring({
			timeline: otherTimeline,
			channels: {
				"head.yaw": offset(
					during(
						equivalentSpan,
						keys([
							[0, 0],
							[100, 1],
						]),
					),
				),
			},
		});
		expect(
			sampleAction(
				compileAction(sameNumbers, CONTROLS, () => 0.5),
				100,
			)["head.yaw"],
		).toBe(1);
	});
});

describe("spatial events in the ActionPlan", () => {
	it("sorts by absolute action time and preserves declaration order at equal times", () => {
		const spatial: readonly SpatialEvent[] = [
			{ at: 200, effects: { tint: { r: 255, g: 220, b: 180 } } },
			{ during: { startMs: 200, endMs: 600, durationMs: 400 }, transform: { delta: { x: 0.2, y: 0.1 } } },
			{ at: 200, effects: { postProcessing: { on: true, values: [{ id: "ColorGrading_Saturation", value: -20 }] } } },
			{ at: 700, effects: { tint: { r: 255, g: 255, b: 255 } } },
		];
		const compiled = compileAction(
			planAuthoring({
				timeline: timeline(1000),
				channels: { "head.yaw": absolute(() => 0) },
				spatial,
			}),
			CONTROLS,
			() => 0.5,
		);
		expect(compiled.spatial.map(({ atMs, order }) => [atMs, order])).toEqual([
			[200, 0],
			[200, 1],
			[200, 2],
			[700, 3],
		]);
		expect(compiled.spatial[1]!.span).toEqual({ startMs: 200, endMs: 600, durationMs: 400 });
	});

	it("allows a VTS move span above two seconds only when speed scales it to two seconds", () => {
		const define = (speed: number): ActionAuthoring =>
			planAuthoring({
				timeline: timeline(4000),
				channels: { "head.yaw": absolute(() => 0) },
				spatial: [{ during: { startMs: 0, endMs: 4000, durationMs: 4000 }, transform: { delta: { y: 0.1 } } }],
				speed,
			});
		expect(compileAction(define(2), CONTROLS, () => 0.5).spatial).toHaveLength(1);
		expect(() => compileAction(define(1), CONTROLS, () => 0.5)).toThrow(/2 秒/);
	});

	it("rejects a spatial span whose scaled wall duration underflows to zero", () => {
		const authoring = planAuthoring({
			timeline: timeline(1),
			channels: { "head.yaw": absolute(() => 0) },
			spatial: [
				{
					during: { startMs: 0, endMs: Number.MIN_VALUE, durationMs: Number.MIN_VALUE },
					transform: { delta: { x: 1 } },
				},
			],
			speed: Number.MAX_VALUE,
		});
		expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/wall duration/);
	});

	it("rejects an inconsistent spatial span that would exceed the VTS duration limit", () => {
		const span = { startMs: 1_000_000_000_000, endMs: 1_000_000_005_000, durationMs: 4000 };
		const authoring = planAuthoring({
			timeline: timeline(1_000_000_005_000),
			channels: { "head.yaw": absolute(() => 0) },
			spatial: [{ during: span, transform: { delta: { x: 1 } } }],
			speed: 2,
		});
		expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/span/);
	});

	it("rejects tiny inconsistent spatial spans that would exceed the VTS duration limit", () => {
		const authoring = planAuthoring({
			timeline: timeline(8e-16),
			channels: { "head.yaw": absolute(() => 0) },
			spatial: [{ during: { startMs: 0, endMs: 8e-16, durationMs: 1e-20 }, transform: { delta: { x: 1 } } }],
			speed: 5e-24,
		});
		expect(() => compileAction(authoring, CONTROLS, () => 0.5)).toThrow(/span/);
	});

	it("rejects expired markers, out-of-range or overlapping transforms, and empty effects", () => {
		const make = (events: readonly SpatialEvent[]): ActionAuthoring =>
			planAuthoring({ timeline: timeline(1000), channels: { "head.yaw": () => 0 }, spatial: events });
		const effect = { tint: { r: 1, g: 2, b: 3 } };
		expect(() => compileAction(make([{ at: 1000, effects: effect }]), CONTROLS, () => 0.5)).toThrow(/marker/);
		expect(() =>
			compileAction(
				make([{ during: { startMs: 0, endMs: 1001, durationMs: 1001 }, transform: { delta: { x: 0.1 } } }]),
				CONTROLS,
				() => 0.5,
			),
		).toThrow(/超出/);
		expect(() =>
			compileAction(
				make([
					{ during: { startMs: 0, endMs: 400, durationMs: 400 }, transform: { delta: { x: 0.1 } } },
					{ during: { startMs: 300, endMs: 700, durationMs: 400 }, transform: { delta: { y: 0.1 } } },
				]),
				CONTROLS,
				() => 0.5,
			),
		).toThrow(/重叠/);
		expect(() => compileAction(make([{ at: 100, effects: {} }]), CONTROLS, () => 0.5)).toThrow(/effect/);
	});

	it("validates transform and effect payloads before playback", () => {
		const make = (event: SpatialEvent): ActionAuthoring =>
			planAuthoring({ timeline: timeline(1000), channels: { "head.yaw": () => 0 }, spatial: [event] });
		expect(() =>
			compileAction(
				make({ during: { startMs: 0, endMs: 100, durationMs: 100 }, transform: { delta: { z: 1 } as never } }),
				CONTROLS,
				() => 0.5,
			),
		).toThrow(/空间偏移非法/);
		expect(() =>
			compileAction(
				make({ during: { startMs: 0, endMs: 100, durationMs: 100 }, transform: { relativeRotation: 0 } }),
				CONTROLS,
				() => 0.5,
			),
		).toThrow(/relativeRotation/);
		expect(() =>
			compileAction(make({ at: 100, effects: { tint: { r: 256, g: 0, b: 0 } } }), CONTROLS, () => 0.5),
		).toThrow(/0-255/);
	});

	it("rejects inherited spatial delta keys and copies valid axes without a prototype", () => {
		const make = (delta: Record<string, number>): ActionAuthoring =>
			planAuthoring({
				timeline: timeline(1000),
				channels: { "head.yaw": () => 0 },
				spatial: [
					{
						during: { startMs: 0, endMs: 100, durationMs: 100 },
						transform: { delta } as never,
					},
				],
			});
		for (const axis of ["constructor", "toString", "__proto__"]) {
			const delta = JSON.parse(`{"${axis}":1}`) as Record<string, number>;
			expect(() => compileAction(make(delta), CONTROLS, () => 0.5)).toThrow(/空间偏移非法/);
		}
		const compiled = compileAction(make({ x: 1 }), CONTROLS, () => 0.5);
		expect(Object.getPrototypeOf(compiled.spatial[0]!.transform!.delta)).toBeNull();
	});
});
