import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseRecent } from "../.uina/worlds/live2d/authoring/selection.js";
import { SpeechBehavior } from "../.uina/worlds/live2d/speech-behavior.js";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { compileAction } from "../.uina/worlds/live2d/authoring/action.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { MO_SPEECH } from "../.uina/worlds/live2d/models/mo/speech.js";
import { Live2DRuntime, type Live2DRuntimeOptions } from "../.uina/worlds/live2d/runtime.js";
import { refactorClient, refactorRig, fixtureMotion } from "./live2d-refactor-fixture.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { absolute, offset, motion } from "../.uina/worlds/live2d/authoring/index.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function naturalHarness(seed = 42) {
	const rig = (await loadRig(MO_MODEL_ID))!;
	const fake = refactorClient();
	fake.state.modelID = MO_MODEL_ID;
	const events: Parameters<NonNullable<Live2DRuntimeOptions["onPerformanceEvent"]>>[0][] = [];
	const clips: Parameters<NonNullable<Live2DRuntimeOptions["onActionCompiled"]>>[0][] = [];
	const runtime = new Live2DRuntime({
		rig,
		client: fake.client,
		catalog: loadCatalog(MO_MODEL_ID, rig),
		speech: MO_SPEECH,
		seed,
		onPerformanceEvent: (e) => events.push(e),
		onActionCompiled: (e) => clips.push(e),
	});
	await runtime.start({} as never);
	const step = (ms: number, speaking = false) => {
		for (let t = 0; t < ms; t += 20) {
			if (speaking) runtime.levelSink!.processLevel({ rms: t % 800 < 400 ? 0.02 : 0.07 });
			runtime.composeTick(20);
		}
	};
	return { runtime, rig, fake, events, clips, step };
}

describe("natural performance integration", () => {
	it("provides distinct authored variants for all eight everyday performance families", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const catalog = loadCatalog(MO_MODEL_ID, rig)!;
		for (const name of ["nod", "shake", "curious", "glance", "chin_up", "smug_laugh", "head_toss", "close_up"])
			expect(catalog.resolve("motion", name)?.entry.variants?.length, name).toBeGreaterThanOrEqual(1);
	});
	it("snapshots and validates finite background pools", () => {
		const rig = refactorRig();
		const source: CatalogSource = { background: { phrases: { idle: [{ id: "a", motion: fixtureMotion() }] } } };
		const catalog = compileCatalog(rig.modelID, source, rig);
		expect(Object.isFrozen(catalog.background.phrases!.idle)).toBe(true);
		source.background!.phrases = { idle: [] };
		expect(catalog.background.phrases!.idle).toHaveLength(1);
		expect(() => compileCatalog(rig.modelID, source, rig)).toThrow(/不能为空/);
		source.background!.phrases = {
			idle: [
				{ id: "a", motion: fixtureMotion() },
				{ id: "a", motion: fixtureMotion() },
			],
		};
		expect(() => compileCatalog(rig.modelID, source, rig)).toThrow(/唯一/);
	});
	it("rebakes background phrases, preserves pose endpoints and reproduces seeded selection", async () => {
		const a = await naturalHarness();
		const b = await naturalHarness();
		const c = await naturalHarness(314);
		try {
			a.step(90000);
			b.step(90000);
			c.step(90000);
			expect(a.events).toEqual(b.events);
			expect(a.events).not.toEqual(c.events);
			const phrases = a.events.filter((e) => e.type === "phrase");
			expect(phrases.length).toBeGreaterThan(8);
			for (let i = 2; i < phrases.length; i++) {
				expect(phrases[i]!.phrase).not.toBe(phrases[i - 1]!.phrase);
				expect(phrases[i]!.phrase).not.toBe(phrases[i - 2]!.phrase);
			}
			const clips = a.clips.filter((c) => c.actionName === "background:idle");
			for (let i = 1; i < clips.length; i++) {
				const previous = clips[i - 1]!.clip.channels.find((c) => c.axis === "head.yaw")!;
				const next = clips[i]!.clip.channels.find((c) => c.axis === "head.yaw")!;
				expect(next.curve(0)).toBeCloseTo(previous.curve(clips[i - 1]!.clip.durationMs), 8);
				expect(clips[i]!.clip.durationMs).toBeGreaterThanOrEqual(4000);
				expect(clips[i]!.clip.durationMs).toBeLessThanOrEqual(10000);
			}
		} finally {
			await Promise.all([a.runtime.stop(), b.runtime.stop(), c.runtime.stop()]);
		}
	});
	it("keeps explicit attention/expression, suppresses accents for posture and resets across lifecycle changes", async () => {
		const h = await naturalHarness();
		try {
			h.runtime.director!.setAttention("avert_left");
			void h.runtime.director!.setExpression({ "eyes.left.open": 0, "eyes.right.open": 0 }, { durationMs: 0 });
			h.step(3000);
			expect(h.runtime.director!.currentFrame["eyes.left.open"]).toBe(0);
			expect(h.runtime.director!.getAttention()).toBe("avert_left");
			expect(h.runtime.director!.currentFrame["gaze.x"]).toBeLessThan(-0.3);
			h.step(15000, true);
			expect(
				h.events.some((e) => e.type === "accent"),
				"explicit closed eyes suppress automatic gestures",
			).toBe(false);
			void h.runtime.director!.setExpression({}, { durationMs: 0 });
			void h.runtime.director!.setPosture({ "head.pitch": -4 }, { durationMs: 0 });
			h.step(15000, true);
			expect(h.events.some((e) => e.type === "accent")).toBe(false);
			void h.runtime.director!.setPosture({}, { durationMs: 0 });
			h.step(60000, true);
			expect(h.events.some((e) => e.type === "accent")).toBe(true);
			const before = h.events.length;
			h.runtime.setFocused(false);
			h.step(3000, true);
			h.runtime.setFocused(true);
			h.step(1000);
			expect(h.events.slice(before).filter((e) => e.type === "accent")).toEqual([]);
			h.runtime.interrupt();
			h.step(1000);
			await h.runtime.safeStop();
			h.step(1000, true);
			await h.runtime.resume();
			h.step(1000);
			const from = h.events.length;
			h.fake.state.modelGeneration++;
			h.step(20);
			h.step(1000);
			expect(h.events.slice(from).filter((e) => e.type === "accent")).toEqual([]);
			expect(h.clips.at(-1)?.playIndex).toBe(0);
		} finally {
			await h.runtime.stop();
		}
	});
	it("a local foreground action leaves unrelated background axes alive", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const director = new MotionDirector(rig.controls);
		director.play(
			compileAction(motion(5000, { "head.roll": absolute(() => 2), "gaze.y": absolute(() => 0.3) }), rig.controls),
			{ category: "autonomic", background: true },
		);
		for (let i = 0; i < 100; i++) director.step(20);
		director.play(compileAction(motion(1000, { "head.pitch": absolute(() => -2) }), rig.controls), {
			category: "voluntary",
		});
		for (let i = 0; i < 25; i++) director.step(20);
		expect(director.currentFrame["gaze.y"]).toBeCloseTo(0.3, 2);
		expect(director.currentFrame["head.roll"]).toBeCloseTo(2, 1);
	});
	it("an additive foreground gesture retains the held background pose as its base", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const director = new MotionDirector(rig.controls);
		director.play(compileAction(motion(5000, { "head.pitch": absolute(() => 2) }), rig.controls), {
			category: "autonomic",
			background: true,
		});
		for (let i = 0; i < 100; i++) director.step(20);
		director.play(compileAction(motion(1000, { "head.pitch": offset(() => 0) }), rig.controls), {
			category: "voluntary",
		});
		for (let i = 0; i < 20; i++) director.step(20);
		expect(director.currentFrame["head.pitch"]).toBeCloseTo(2, 3);
	});
	it("keeps head-relative torso articulation when a background supplies an absolute torso base", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const director = new MotionDirector(rig.controls, { diagnostics: true });
		director.play(
			compileAction(
				motion(5000, { "head.roll": absolute(() => 2), "torso.roll": absolute(() => 0.4) }, "absolute"),
				rig.controls,
			),
			{ category: "autonomic", background: true },
		);
		for (let i = 0; i < 100; i++) director.step(20);
		director.play(
			compileAction(
				motion(2000, { "head.roll": offset(() => 3), "torso.roll": offset(() => -2.4) }, "head-relative"),
				rig.controls,
			),
			{ category: "voluntary", fadeInMs: 0 },
		);
		for (let i = 0; i < 60; i++) director.step(20);
		expect(director.currentFrame["torso.roll"]).toBeCloseTo(1, 2);
	});
});

describe("recent performance selection", () => {
	it("excludes the last two, relaxing oldest history only when necessary", () => {
		expect(chooseRecent([1, 1, 1], [0, 1], () => 0)).toBe(2);
		expect(chooseRecent([1, 1], [0, 1], () => 0)).toBe(0);
		expect(chooseRecent([1], [0], () => 0)).toBe(0);
	});
	it("uses the whole pool on the first selection and respects weights", () => {
		expect(chooseRecent([4, 1, 1, 1, 1], [], () => 0.49)).toBe(0);
		expect(chooseRecent([4, 1, 1, 1, 1], [], () => 0.99)).toBe(4);
	});
});

describe("speech body behavior", () => {
	it("requires sustained speech, never follows every energy peak, and observes cooldown", () => {
		const behavior = new SpeechBehavior(() => 0, 120);
		const hits: number[] = [];
		for (let t = 0; t < 10000; t += 20) {
			behavior.processLevel({ rms: t % 800 < 400 ? 0.02 : 0.08 });
			if (behavior.step(20, false)) hits.push(t);
		}
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]).toBeGreaterThanOrEqual(500);
		for (let i = 1; i < hits.length; i++) expect(hits[i]! - hits[i - 1]!).toBeGreaterThanOrEqual(2500);
	});
	it("drops suppressed candidates and resets on stale audio or explicit reset", () => {
		const behavior = new SpeechBehavior(() => 0, 120);
		for (let i = 0; i < 100; i++) {
			behavior.processLevel({ rms: 0.05 });
			expect(behavior.step(20, true)).toBe(false);
		}
		behavior.step(200, false);
		expect(behavior.step(20, false)).toBe(false);
		behavior.reset();
		behavior.processLevel({ rms: 0.08 });
		expect(behavior.step(20, false)).toBe(false);
	});
	it("silent, invalid and rejected candidates cannot create gestures", () => {
		const behavior = new SpeechBehavior(() => 0.99, 120);
		for (let t = 0; t < 5000; t += 20) {
			behavior.processLevel({ rms: t % 1000 < 500 ? 0.03 : 0.08 });
			expect(behavior.step(20, false)).toBe(false);
		}
		behavior.processLevel({ rms: Number.NaN });
		expect(behavior.step(1000, false)).toBe(false);
	});
});
