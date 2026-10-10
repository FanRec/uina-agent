import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { ReflexDirector } from "../.uina/worlds/live2d/reflex-director.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import {
	BASE_POSES,
	compilePoseTransition,
	expressionPolicy,
	namedMotion,
} from "../.uina/worlds/live2d/motion-library.js";
import { AXES, NEUTRAL_AXES } from "../.uina/worlds/live2d/motion-axes.js";
import {
	compileMotion,
	motion,
	pose,
	projectMotionAxes,
	sampleMotion,
	sampleSpeechGain,
	sequence,
	track,
	withSpeech,
} from "../.uina/worlds/live2d/motion.js";
import { independentModelFixture } from "./live2d-model-fixture.js";

afterEach(() => vi.restoreAllMocks());

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function quietDirector(): MotionDirector {
	const director = new MotionDirector(() => 0.5);
	vi.spyOn(director.noise, "tick").mockReturnValue({});
	return director;
}

function headClip(start: number, end: number, duration = 1000) {
	return compileMotion(
		motion(
			duration,
			track(
				"head.roll",
				[
					[0, start],
					[duration, end],
				],
				"absolute",
				"linear",
			),
		),
	);
}

describe("authored pose transitions", () => {
	it("gaze leads head and torso, and the authored target arrives at the specified timeline endpoint", () => {
		const destination = { ...NEUTRAL_AXES, ...BASE_POSES.shy_side };
		const transition = compilePoseTransition(NEUTRAL_AXES, destination, 800);
		const early = sampleMotion(transition, 80);
		expect(early["gaze.x"]).toBeGreaterThan(0);
		expect(early["head.roll"]).toBe(0);
		expect(early["torso.yaw"]).toBe(0);
		expect(sampleMotion(transition, 800)).toEqual(destination);
	});
	it("a mid-transition retarget preserves the current target and renders identically with coarse or fine clocks", () => {
		const a = quietDirector(),
			b = quietDirector();
		for (const d of [a, b]) {
			d.applyBasePose("playful", { transitionMs: 800 });
			d.compose(230);
			const target = d.getParamTarget("head.roll");
			d.applyBasePose("shy_side", { transitionMs: 900 });
			d.compose(0);
			expect(d.getParamTarget("head.roll")).toBe(target);
		}
		a.compose(900);
		for (let i = 0; i < 90; i++) b.compose(10);
		expect(a.getParamTarget("head.roll")).toBe(5);
		expect(a.getParamTarget("torso.yaw")).toBeCloseTo(-2.5, 10);
		expect(Math.abs(a.getParam("head.roll") - b.getParam("head.roll"))).toBeLessThan(0.15);
	});
});

describe("moving handoffs and live exits", () => {
	it("the outgoing clip keeps advancing during a handoff, instead of fading a frozen old target", async () => {
		const d = quietDirector();
		const old = d.play(headClip(0, 20));
		await flush();
		d.compose(400);
		expect(d.getParamTarget("head.roll")).toBe(8);
		const next = d.play(headClip(0, 0));
		await flush();
		expect(await old).toEqual({ status: "cancelled" });
		d.compose(90);
		// At half the 180ms handoff, the old clip has reached 9.8°, not its previous 8°.
		expect(d.getParamTarget("head.roll")).toBeCloseTo(4.9, 8);
		d.compose(1500);
		expect(await next).toEqual({ status: "completed" });
		expect(d.getPresentationState()).toMatchObject({ active: 0, fading: 0 });
	});
	it("exit converges to the currently active thinking layer before releasing ownership", async () => {
		const d = quietDirector();
		d.showStatePose("thinking");
		d.compose(800);
		const task = d.play(headClip(-8, -8, 500));
		await flush();
		d.compose(819);
		expect(d.getParamTarget("head.roll")).toBeCloseTo(5, 4);
		const before = d.getParamTarget("head.roll");
		d.compose(1);
		expect(Math.abs(d.getParamTarget("head.roll") - before)).toBeLessThan(0.001);
		expect(await task).toEqual({ status: "completed" });
	});
	it("rapid repeated interruptions preserve bounded frames without accumulating an obsolete blend graph", async () => {
		const d = quietDirector();
		const clips = [headClip(-12, -12), headClip(12, 12)];
		const tasks = [];
		let previous = d.compose(0)["head.roll"]!;
		for (let i = 0; i < 500; i++) {
			tasks.push(d.play(clips[i % 2]!));
			await flush();
			const frame = d.compose(20)["head.roll"]!;
			expect(Math.abs(frame - previous)).toBeLessThan(1.4);
			expect(d.getPresentationState().fading).toBeLessThanOrEqual(2);
			previous = frame;
		}
		d.compose(1500);
		const outcomes = await Promise.all(tasks);
		expect(outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(1);
		expect(d.getPresentationState()).toMatchObject({ active: 0, fading: 0 });
		expect(d.getActiveLeases()).toEqual([]);
	});
	it("a safe stop discards all handoff tails and an unrendered cancelled claim leaves no ghost", async () => {
		const d = quietDirector();
		const first = d.play(headClip(10, 10));
		await flush();
		d.compose(300);
		const second = d.play(headClip(-10, -10));
		await flush();
		d.compose(30);
		d.abortAllMotions();
		await Promise.all([first, second]);
		expect(d.getPresentationState()).toMatchObject({ active: 0, fading: 0 });
		const lease = await d.claim(["head"]);
		lease.release();
		expect(d.getPresentationState().fading).toBe(0);
	});
});

describe("persistent reflex intent", () => {
	it("clearing a reflex during entry releases its current contribution instead of deepening the cancelled gesture", () => {
		const d = quietDirector();
		d.showStatePose("thinking");
		d.compose(250);
		let previous = d.getParamTarget("head.roll");
		expect(previous).toBeGreaterThan(0);
		d.clearStatePose();
		for (let i = 0; i < 42; i++) {
			d.compose(10);
			const target = d.getParamTarget("head.roll");
			expect(target).toBeLessThanOrEqual(previous + 1e-10);
			previous = target;
		}
		expect(previous).toBeCloseTo(0, 8);
	});
	it("thinking received behind a physical hold reveals itself without another event and without an abrupt target restoration", async () => {
		const d = quietDirector();
		const reflex = new ReflexDirector(d, { getBasePose: () => "relaxed", activateBasePose: () => {} });
		const lease = await d.claim(["head", "gaze"]);
		reflex.onThinking();
		d.compose(1000);
		expect(d.getPresentationState().reflex).toBe("thinking");
		expect(d.getParamTarget("head.roll")).toBe(0);
		lease.release();
		d.compose(16);
		expect(d.getParamTarget("head.roll")).toBeLessThan(0.02);
		d.compose(400);
		expect(d.getParamTarget("head.roll")).toBe(5);
		reflex.onSpeakingContent();
		d.compose(0);
		expect(d.getParamTarget("head.roll")).toBe(5);
		d.compose(500);
		expect(d.getParamTarget("head.roll")).toBe(0);
	});
	it("a hidden reflex cleared before release never plays late", async () => {
		const d = quietDirector();
		const lease = await d.claim(["head", "gaze"]);
		d.showStatePose("thinking");
		d.compose(800);
		d.clearStatePose();
		d.compose(500);
		lease.release();
		d.compose(500);
		expect(d.getParamTarget("head.roll")).toBe(0);
	});
	it("focus masking preserves the thinking intent and smoothly reveals it on return", () => {
		const d = quietDirector();
		d.showStatePose("thinking");
		d.compose(800);
		d.setReflexVisible(false);
		d.compose(400);
		expect(d.getParamTarget("head.roll")).toBe(0);
		expect(d.getPresentationState().reflex).toBe("thinking");
		d.setReflexVisible(true);
		d.compose(16);
		expect(d.getParamTarget("head.roll")).toBeLessThan(0.02);
		d.compose(400);
		expect(d.getParamTarget("head.roll")).toBe(5);
	});
});

describe("speech belongs to composition", () => {
	it("authored speech policy follows each beat, including a smooth release into the next mouth pose", () => {
		const compiled = compileMotion(
			sequence(withSpeech(pose(500, { "mouth.open": 0.6 }), "exclusive"), pose(500, { "mouth.open": 0 })),
		);
		expect(sampleSpeechGain(compiled, 400)).toBe(0);
		expect(sampleSpeechGain(compiled, 500)).toBe(0);
		expect(sampleSpeechGain(compiled, 590)).toBeCloseTo(0.5, 8);
		expect(sampleSpeechGain(compiled, 700)).toBe(1);
		expect(sampleSpeechGain(namedMotion("sleepy_yawn"), 1200)).toBe(0);
		expect(sampleSpeechGain(projectMotionAxes(compiled, ["mouth.open"]), 590)).toBeCloseTo(0.5, 8);
		expect(() => compileMotion(withSpeech(pose(500, { "mouth.open": 0.6 }), "wrong" as never))).toThrow(
			"speech policy",
		);
	});
	it("speech blends before dynamics, and exclusive mouth choreography fades speech out and back in", async () => {
		const d = quietDirector();
		const clip = compileMotion(
			motion(
				1000,
				track("mouth.open", [
					[0, 0.4],
					[1000, 0.4],
				]),
			),
		);
		const blend = d.play(clip);
		await flush();
		d.compose(300, { mouthOpen: 0.6 });
		expect(d.getParamTarget("mouth.open")).toBeCloseTo(0.76, 8);
		const exclusive = d.play(clip, { speech: "exclusive" });
		await flush();
		const before = d.compose(0, { mouthOpen: 0.6 })["mouth.open"];
		expect(d.compose(0, { mouthOpen: 0.6 })["mouth.open"]).toBe(before);
		d.compose(300, { mouthOpen: 0.6 });
		expect(d.getParamTarget("mouth.open")).toBe(0.4);
		d.compose(1100, { mouthOpen: 0.6 });
		expect(d.getParamTarget("mouth.open")).toBe(0.6);
		await Promise.all([blend, exclusive]);
	});
	it("physical mouth ownership prevents speech from bypassing its captured target", async () => {
		const d = quietDirector();
		d.compose(300, { mouthOpen: 0.8 });
		const captured = d.getParamTarget("mouth.open");
		const lease = await d.claim(["mouth"]);
		d.compose(300, { mouthOpen: 0.2 });
		expect(d.getParamTarget("mouth.open")).toBe(captured);
		lease.release();
		d.compose(400, { mouthOpen: 0.2 });
		expect(d.getParamTarget("mouth.open")).toBe(0.2);
	});
	it("ordinary lip onset responds promptly while remaining bounded", () => {
		const d = quietDirector();
		const frame = d.compose(50, { mouthOpen: 0.8 });
		expect(frame["mouth.open"]).toBeGreaterThan(0.3);
		expect(frame["mouth.open"]).toBeLessThan(0.8);
	});
});

describe("production policy and composition combinations", () => {
	it("named performances are coherent by default, while explicit fragment and speech choices remain available", () => {
		expect(expressionPolicy({ motion: "sleepy_yawn" }).atomic).toBe(true);
		expect(expressionPolicy({ motion: "nod", atomic: false, speech: "exclusive" })).toEqual({
			atomic: false,
			speech: "exclusive",
		});
		expect(expressionPolicy({ head: "nod" })).toEqual({ atomic: false, speech: undefined });
	});
	it("the actual runtime wires named coherence and yawn speech policy into playback", async () => {
		const r = new Live2DRuntime();
		vi.spyOn(r.vtsClient, "isConnected").mockReturnValue(true);
		vi.spyOn(r.vtsClient, "getModelProfile").mockReturnValue(independentModelFixture());
		vi.spyOn(r.vtsClient, "validateModelFiles").mockResolvedValue(true);
		const pending = r.executeExpress({ motion: "sleepy_yawn" }, { signal: new AbortController().signal } as never);
		await flush();
		r.director.compose(1000, { mouthOpen: 0.8 });
		expect(r.director.getParamTarget("mouth.open")).toBeCloseTo(
			sampleMotion(namedMotion("sleepy_yawn"), 1000)["mouth.open"]!,
			8,
		);
		expect(r.director.getActiveLeases()[0]!.atomic).toBe(true);
		const replacement = await r.director.claim(["head"], { priority: 100 });
		expect((await pending).status).toBe("cancelled");
		expect(r.director.getActiveLeases()).toEqual([replacement]);
		r.director.abortAllMotions();
	});
	it("a moving pose, thinking, speech, blink and interrupted named performances remain in range with bounded angular steps", async () => {
		const d = new MotionDirector(() => 0.5);
		d.applyBasePose("playful");
		d.showStatePose("thinking");
		const first = d.play(namedMotion("head_bop"));
		await flush();
		let previous = d.compose(0);
		let second: ReturnType<MotionDirector["play"]> | undefined;
		for (let i = 0; i < 240; i++) {
			if (i === 25) d.applyBasePose("shy_side");
			if (i === 45) {
				second = d.play(namedMotion("sparkle"));
				await flush();
			}
			if (i === 60) d.clearStatePose();
			if (i === 85) d.noise.triggerBlink();
			const frame = d.compose(1000 / 60, { speechEnergy: 0.7, mouthOpen: 0.45 });
			for (const [axis, metadata] of Object.entries(AXES)) {
				expect(frame[axis]).toBeGreaterThanOrEqual(metadata.min);
				expect(frame[axis]).toBeLessThanOrEqual(metadata.max);
				if (metadata.angular) expect(Math.abs(frame[axis]! - previous[axis]!)).toBeLessThan(0.9);
			}
			previous = frame;
		}
		await Promise.all([first, second]);
		expect(d.getPresentationState()).toMatchObject({ active: 0, fading: 0 });
	});
});
