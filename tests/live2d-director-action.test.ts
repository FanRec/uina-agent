import { describe, expect, it } from "vitest";
import { compileAction } from "../.uina/worlds/live2d/authoring/action.js";
import { absolute, smooth, timeline } from "../.uina/worlds/live2d/authoring/curves.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";

const CONTROLS = { "head.yaw": { min: -12, max: 12, neutral: 0 } };

const linearAction = (speed: number) =>
	compileAction(
		() => ({ timeline: timeline(1000), speed, channels: { "head.yaw": absolute((actionMs) => actionMs / 100) } }),
		CONTROLS,
		() => 0.5,
	);

describe("MotionDirector with CompiledAction", () => {
	it("uses speed once for action sampling and reports wall-clock handle duration", async () => {
		const director = new MotionDirector(CONTROLS, { diagnostics: true });
		const handle = director.play(linearAction(2), {
			category: "voluntary",
			fadeInMs: 0,
			fadeOutMs: 0,
		});
		expect(handle.duration).toBe(0.5);
		director.step(100);
		expect(director.clockMs).toBe(100);
		expect(handle.currentTime).toBe(0.1);
		expect(director.getActionDiagnostics()?.authoredTargets).toContainEqual(
			expect.objectContaining({ axis: "head.yaw", curveValue: 2, targetValue: 2 }),
		);
		director.step(400);
		expect(handle.status).toBe("finished");
		await expect(handle.finished).resolves.toMatchObject({ status: "completed" });
	});

	it("advances the monotonic effective clock by raw elapsed time and freezes it while unfocused", () => {
		const director = new MotionDirector(CONTROLS);
		director.step(100, 250);
		expect(director.clockMs).toBe(250);
		director.setFrozen(true);
		director.step(100, 1000);
		expect(director.clockMs).toBe(250);
		director.setFrozen(false);
		director.step(20, 40);
		expect(director.clockMs).toBe(290);
	});

	it("keeps authored targets, composed output, contributions, and clamp hits distinct", () => {
		const controls = { "eyes.left.open": { min: 0, max: 1, neutral: 1 } };
		const action = compileAction(
			() => ({ timeline: timeline(100), channels: { "eyes.left.open": absolute(() => 2) } }),
			controls,
			() => 0.5,
		);
		const director = new MotionDirector(controls, { diagnostics: true });
		const handle = director.play(action, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0 });
		director.step(0);
		const diagnostics = director.getActionDiagnostics();
		expect(diagnostics?.authoredTargets).toContainEqual(
			expect.objectContaining({ axis: "eyes.left.open", curveValue: 2, targetValue: 2 }),
		);
		expect(diagnostics?.composedFrame["eyes.left.open"]).toBe(1);
		expect(diagnostics?.clampHits).toContainEqual(
			expect.objectContaining({ axis: "eyes.left.open", requested: 2, value: 1, min: 0, max: 1 }),
		);
		expect(diagnostics?.contributions).toContainEqual(
			expect.objectContaining({ playbackId: handle.id, axes: ["eyes.left.open"] }),
		);
	});

	it("uses the same effective exit progress for handoff output and release settlement", async () => {
		const controls = { "custom.value": { min: -12, max: 12, neutral: 0 } };
		const action = compileAction(
			() => ({ timeline: timeline(2000), channels: { "custom.value": absolute(() => 10) } }),
			controls,
			() => 0.5,
		);
		const director = new MotionDirector(controls, { diagnostics: true });
		const handle = director.play(action, { category: "voluntary", fadeInMs: 0, fadeOutMs: 1000 });
		director.step(0);
		handle.stop("release");

		const halfway = director.step(250, 500);
		expect(handle.status).toBe("releasing");
		expect(halfway["custom.value"]).toBeCloseTo(5);
		expect(director.getActionDiagnostics()?.handoffs).toContainEqual(
			expect.objectContaining({ playbackId: handle.id, axis: "custom.value", progress: 0.5 }),
		);

		const settled = director.step(250, 500);
		await expect(handle.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(settled["custom.value"]).toBe(0);
	});

	it("anchors a long-tick natural exit at the authored wall end", async () => {
		const controls = { "custom.value": { min: -12, max: 12, neutral: 0 } };
		const action = compileAction(
			() => ({ timeline: timeline(1000), channels: { "custom.value": absolute(() => 10) } }),
			controls,
			() => 0.5,
		);
		const director = new MotionDirector(controls);
		const handle = director.play(action, { category: "voluntary", fadeInMs: 0, fadeOutMs: 600 });
		director.step(500);
		const halfwayThroughExit = director.step(250, 1000);

		expect(handle.status).toBe("cancelling");
		expect(halfwayThroughExit["custom.value"]).toBeCloseTo(10 * (1 - 0.9645061728395061));
		director.step(50, 100);
		await expect(handle.finished).resolves.toMatchObject({ status: "completed" });
	});

	it("starts a natural handoff from the faded authored endpoint after a long tick", () => {
		const controls = { "custom.value": { min: -12, max: 12, neutral: 0 } };
		let samples = 0;
		const action = compileAction(
			() => ({
				timeline: timeline(1000),
				channels: { "custom.value": absolute((time) => (samples++, time / 100)) },
			}),
			controls,
			() => 0.5,
		);
		samples = 0;
		const director = new MotionDirector(controls);
		director.play(action, { category: "voluntary", fadeInMs: 1000, fadeOutMs: 600 });
		director.step(500);
		expect(samples).toBe(1);

		samples = 0;
		const output = director.step(250, 1000)["custom.value"]!;
		const endpointAfterFadeIn = 10 * smooth(750 / 1000);
		expect(output).toBeCloseTo(endpointAfterFadeIn * (1 - smooth(500 / 600)));
		expect(samples).toBe(1);
	});

	it("samples each channel curve once per playback step", () => {
		const controls = {
			"custom.yaw": { min: -12, max: 12, neutral: 0 },
			"custom.pitch": { min: -12, max: 12, neutral: 0 },
		};
		let yawSamples = 0;
		let pitchSamples = 0;
		const action = compileAction(
			() => ({
				timeline: timeline(1000),
				channels: {
					"custom.yaw": absolute((time) => (yawSamples++, time / 100)),
					"custom.pitch": absolute((time) => (pitchSamples++, time / 200)),
				},
			}),
			controls,
			() => 0.5,
		);
		yawSamples = 0;
		pitchSamples = 0;
		const director = new MotionDirector(controls);
		director.play(action, { category: "voluntary", fadeInMs: 0 });

		expect(director.step(100)).toMatchObject({ "custom.yaw": 1, "custom.pitch": 0.5 });
		expect(yawSamples).toBe(1);
		expect(pitchSamples).toBe(1);
	});

	it("samples very large looping wall times without overflowing action time", () => {
		const controls = { "custom.value": { min: -12, max: 12, neutral: 0 } };
		const action = compileAction(
			() => ({ timeline: timeline(Number.MAX_VALUE), speed: 2, channels: { "custom.value": absolute(() => 1) } }),
			controls,
			() => 0.5,
		);
		const director = new MotionDirector(controls);
		director.play(action, { category: "autonomic", loop: true, fadeInMs: 0 });

		expect(() => director.step(0, 9e307)).not.toThrow();
		expect(Number.isFinite(director.currentFrame["custom.value"])).toBe(true);
	});

	it("rejects unrepresentable accumulated time without advancing the clock or looping playback", () => {
		const controls = { "custom.value": { min: -12, max: 12, neutral: 0 } };
		const action = compileAction(
			() => ({ timeline: timeline(Number.MAX_VALUE), speed: 2, channels: { "custom.value": absolute(() => 1) } }),
			controls,
			() => 0.5,
		);
		const director = new MotionDirector(controls);
		const handle = director.play(action, { category: "autonomic", loop: true, fadeInMs: 0 });
		director.step(0, 9e307);
		const previousClock = director.clockMs;
		const previousPlayTime = handle.currentTime;

		expect(() => director.step(0, 9e307)).toThrow(/累计时钟不可表示/);
		expect(director.clockMs).toBe(previousClock);
		expect(handle.currentTime).toBe(previousPlayTime);

		director.step(0, 1e307);
		expect(director.clockMs).toBe(1e308);
		expect(() => director.step(0, 1)).toThrow(/累计时钟不可表示/);
		expect(director.clockMs).toBe(1e308);
		expect(Number.isFinite(handle.currentTime)).toBe(true);
	});
});
