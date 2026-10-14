import { describe, expect, it } from "vitest";
import {
	absolute,
	during,
	keys,
	mergeChannels,
	offset,
	oscillate,
	poseWindow,
	spring,
	sumOffsets,
	timeline,
	track,
} from "../.uina/worlds/live2d/authoring/curves.js";

describe("Timeline", () => {
	it("把 start/end 固定到动作边界并允许同刻 marker", () => {
		const time = timeline(1000, { look: 200, head: 200, settle: 750 });
		expect(time.at("start")).toBe(0);
		expect(time.at("look")).toBe(200);
		expect(time.at("head")).toBe(200);
		expect(time.at("end")).toBe(1000);
	});

	it("未知 marker、保留名、越界时间和非法 span 会失败", () => {
		expect(() => timeline(100, { start: 1 })).toThrow(/保留/);
		expect(() => timeline(100, { end: 99 })).toThrow(/保留/);
		expect(() => timeline(100, { before: -1 })).toThrow(/范围/);
		expect(() => timeline(100, { after: 101 })).toThrow(/范围/);
		expect(() => timeline(0)).toThrow(/时长/);
		expect(() => timeline(Number.POSITIVE_INFINITY)).toThrow(/时长/);
		const time = timeline(100, { middle: 50 });
		expect(() => time.at("missing")).toThrow(/marker/);
		expect(() => time.span("middle", "start")).toThrow(/正时长/);
		expect(() => time.span("start", "missing")).toThrow(/marker/);
	});

	it("span 保留毫秒坐标，且只允许正时长", () => {
		const span = timeline(1000, { target: 125, home: 425 }).span("target", "home");
		expect(span).toEqual({ startMs: 125, endMs: 425, durationMs: 300 });
		expect(Object.isFrozen(span)).toBe(true);
	});
});

describe("keys", () => {
	it("在端点外夹紧，并按局部毫秒插值", () => {
		const curve = keys([
			[100, -2],
			[200, 8],
		]);
		expect(curve(-50)).toBe(-2);
		expect(curve(100)).toBe(-2);
		expect(curve(150)).toBeCloseTo(3, 9);
		expect(curve(250)).toBe(8);
	});

	it("保留 linear/hold 插值选择", () => {
		const points = [
			[0, 1],
			[100, 5],
		] as const;
		expect(keys(points, "linear")(25)).toBe(2);
		expect(keys(points, "hold")(99)).toBe(1);
		expect(keys(points, "hold")(100)).toBe(5);
	});

	it("拒绝少于两个点、非有限坐标和非递增时间", () => {
		expect(() => keys([[0, 1]])).toThrow(/至少两个/);
		expect(() =>
			keys([
				[0, 1],
				[0, 2],
			]),
		).toThrow(/严格递增/);
		expect(() =>
			keys([
				[0, Number.NaN],
				[100, 1],
			]),
		).toThrow(/有限/);
	});
});

describe("poseWindow", () => {
	it("enters, holds, and exits using local milliseconds", () => {
		const curve = poseWindow(1000, {
			from: 0,
			pose: 6,
			to: -2,
			enterMs: 200,
			exitMs: 300,
			ease: "linear",
		});
		expect(curve(0)).toBe(0);
		expect(curve(100)).toBe(3);
		expect(curve(200)).toBe(6);
		expect(curve(700)).toBe(6);
		expect(curve(850)).toBe(2);
		expect(curve(1000)).toBe(-2);
	});

	it("uses smooth easing and treats zero enter/exit as instantaneous", () => {
		const eased = poseWindow(1000, { from: 0, pose: 1, to: 0, enterMs: 1000, exitMs: 0 });
		expect(eased(250)).toBeCloseTo(0.103515625, 9);
		const stepped = poseWindow(100, { from: -1, pose: 2, to: 3, enterMs: 0, exitMs: 0 });
		expect(stepped(0)).toBe(-1);
		expect(stepped(1)).toBe(2);
		expect(stepped(99)).toBe(2);
		expect(stepped(100)).toBe(3);
	});

	it("reuses only TimeSpan.durationMs and rejects invalid windows", () => {
		const span = { startMs: Number.NaN, endMs: -10, durationMs: 100 };
		const curve = poseWindow(span, { from: 0, pose: 1, to: 0, enterMs: 50, exitMs: 50 });
		expect(curve(50)).toBe(1);
		expect(() => poseWindow(0, { from: 0, pose: 1, to: 0, enterMs: 0, exitMs: 0 })).toThrow(/时长/);
		expect(() => poseWindow(100, { from: 0, pose: 1, to: 0, enterMs: -1, exitMs: 0 })).toThrow(/非负/);
		expect(() => poseWindow(100, { from: 0, pose: 1, to: 0, enterMs: 80, exitMs: 30 })).toThrow(/超过/);
		expect(() => poseWindow(100, { from: Number.NaN, pose: 1, to: 0, enterMs: 0, exitMs: 0 })).toThrow(/有限/);
	});
});

describe("spring", () => {
	it("reaches exact endpoints, clamps outside its local duration, and overshoots the target", () => {
		const curve = spring(1000, { from: 0, to: 8, peak: 1.4, bounces: 1 });
		expect(curve(-1)).toBe(0);
		expect(curve(1000)).toBe(8);
		expect(curve(1001)).toBe(8);
		expect(curve(900)).toBeGreaterThan(8);
	});

	it("successive return bounces decay and all samples stay finite", () => {
		const curve = spring(1000, { from: 0, to: 0, peak: 10, bounces: 2 });
		const middle = Math.abs(curve(500));
		const later = Math.abs(curve(700));
		const last = Math.abs(curve(900));
		expect(middle).toBeGreaterThan(later);
		expect(later).toBeGreaterThan(last);
		for (let at = 0; at <= 1000; at += 7) expect(Number.isFinite(curve(at))).toBe(true);
	});

	it("rejects nonpositive duration, nonfinite endpoints, and invalid bounce counts", () => {
		expect(() => spring(0, { from: 0, to: 1 })).toThrow(/时长/);
		expect(() => spring(100, { from: Number.NaN, to: 1 })).toThrow(/有限/);
		expect(() => spring(100, { from: 0, to: 1, peak: Number.POSITIVE_INFINITY })).toThrow(/有限/);
		expect(() => spring(100, { from: 0, to: 1, bounces: 0 })).toThrow(/正整数/);
		expect(() => spring(100, { from: 0, to: 1, bounces: 1.5 })).toThrow(/正整数/);
	});
});

describe("oscillate", () => {
	it("uses amplitude, cycles, and radian phase in local time", () => {
		const curve = oscillate(1000, { amplitude: 2, cycles: 1, phase: Math.PI / 2 });
		expect(curve(0)).toBeCloseTo(2, 9);
		expect(curve(250)).toBeCloseTo(0, 9);
		expect(curve(500)).toBeCloseTo(-2, 9);
	});

	it("fades oscillation to zero at configured endpoints", () => {
		const curve = oscillate(1000, { amplitude: 2, cycles: 2, phase: Math.PI / 2, fadeInMs: 200, fadeOutMs: 200 });
		expect(curve(0)).toBe(0);
		expect(curve(1000)).toBe(0);
		expect(Math.abs(curve(1))).toBeLessThan(0.001);
		expect(Math.abs(curve(999))).toBeLessThan(0.001);
	});

	it("rejects invalid values, periods, and overlapping fades", () => {
		expect(() => oscillate(0, { amplitude: 1, cycles: 1 })).toThrow(/时长/);
		expect(() => oscillate(100, { amplitude: Number.NaN, cycles: 1 })).toThrow(/有限/);
		expect(() => oscillate(100, { amplitude: 1, cycles: 0 })).toThrow(/周期/);
		expect(() => oscillate(100, { amplitude: 1, cycles: 1, phase: Number.NaN })).toThrow(/有限/);
		expect(() => oscillate(100, { amplitude: 1, cycles: 1, fadeInMs: 80, fadeOutMs: 30 })).toThrow(/超过/);
	});
});

describe("during", () => {
	it("places a LocalCurve at absolute action times and holds endpoint values", () => {
		const part = timeline(1000, { begin: 200, finish: 500 }).span("begin", "finish");
		const curve = during(
			part,
			keys([
				[0, -2],
				[300, 7],
			]),
		);
		expect(curve(100)).toBe(-2);
		expect(curve(200)).toBe(-2);
		expect(curve(350)).toBeCloseTo(2.5, 9);
		expect(curve(500)).toBe(7);
		expect(curve(900)).toBe(7);
	});

	it("accepts explicit constants outside the active window", () => {
		const curve = during(
			{ startMs: 100, endMs: 200, durationMs: 100 },
			keys([
				[0, 1],
				[100, 4],
			]),
			{
				before: -3,
				after: 9,
			},
		);
		expect(curve(99)).toBe(-3);
		expect(curve(200)).toBe(9);
	});

	it("rejects malformed windows and nonlocal curves", () => {
		expect(() =>
			during(
				{ startMs: -1, endMs: 10, durationMs: 11 },
				keys([
					[0, 0],
					[11, 1],
				]),
			),
		).toThrow(/span/);
		expect(() =>
			during(
				{ startMs: 0, endMs: 11, durationMs: 10 },
				keys([
					[0, 0],
					[10, 1],
				]),
			),
		).toThrow(/span/);
		expect(() =>
			during({ startMs: 0, endMs: 10, durationMs: 10 }, Number.NaN as unknown as (t: number) => number),
		).toThrow(/曲线/);
		expect(() => during({ startMs: 0, endMs: 10, durationMs: 10 }, (t) => t, { before: Number.NaN })).toThrow(/有限/);
	});
});

describe("track", () => {
	const first = {
		span: { startMs: 100, endMs: 200, durationMs: 100 },
		curve: keys([
			[0, 0],
			[100, 10],
		]),
	};
	const second = {
		span: { startMs: 300, endMs: 400, durationMs: 100 },
		curve: keys([
			[0, -2],
			[100, -6],
		]),
	};

	it("holds gaps and endpoint values without introducing a crossfade", () => {
		const curve = track([first, second]);
		expect(curve(50)).toBe(0);
		expect(curve(100)).toBe(0);
		expect(curve(200)).toBe(10);
		expect(curve(250)).toBe(10);
		expect(curve(300)).toBe(-2);
		expect(curve(400)).toBe(-6);
		expect(curve(500)).toBe(-6);
	});

	it("allows explicit before, gap, and after constants", () => {
		const curve = track([first, second], { before: -1, gap: 4, after: 8 });
		expect(curve(99)).toBe(-1);
		expect(curve(250)).toBe(4);
		expect(curve(450)).toBe(8);
	});

	it("rejects empty, unsorted, overlapping, or malformed spans", () => {
		expect(() => track([])).toThrow(/非空/);
		expect(() => track([second, first])).toThrow(/排序/);
		expect(() => track([first, { ...second, span: { startMs: 150, endMs: 250, durationMs: 100 } }])).toThrow(/重叠/);
		expect(() => track([{ ...first, span: { startMs: 100, endMs: 200, durationMs: 99 } }])).toThrow(/span/);
		expect(() => track([first], { gap: Number.NaN })).toThrow(/有限/);
	});
});

describe("channel composition", () => {
	it("sums only baseline offsets and rejects known Local/Action domain mixing", () => {
		const localA = offset(
			keys([
				[0, 1],
				[100, 2],
			]),
		);
		const localB = offset(
			keys([
				[0, -3],
				[100, -1],
			]),
		);
		expect(sumOffsets(localA, localB).curve(50)).toBeCloseTo(-0.5, 9);
		const action = offset(
			during(
				{ startMs: 0, endMs: 100, durationMs: 100 },
				keys([
					[0, 1],
					[100, 2],
				]),
			),
		);
		expect(() => sumOffsets(localA, action)).toThrow(/时间域/);
		expect(() =>
			sumOffsets(
				absolute(
					keys([
						[0, 0],
						[100, 1],
					]),
				) as unknown as typeof localA,
			),
		).toThrow(/baseline-offset/);
		expect(() => sumOffsets()).toThrow(/至少/);
	});

	it("merges distinct axis maps and rejects duplicate axes", () => {
		const merged = mergeChannels(
			{
				"head.yaw": offset(
					keys([
						[0, 0],
						[100, 1],
					]),
				),
			},
			{
				"gaze.x": absolute(
					keys([
						[0, 0],
						[100, 1],
					]),
				),
			},
		);
		expect(Object.keys(merged)).toEqual(["head.yaw", "gaze.x"]);
		expect(() =>
			mergeChannels(
				{
					"head.yaw": offset(
						keys([
							[0, 0],
							[100, 1],
						]),
					),
				},
				{
					"head.yaw": offset(
						keys([
							[0, 1],
							[100, 2],
						]),
					),
				},
			),
		).toThrow(/重复.*head\.yaw/);
	});
});
