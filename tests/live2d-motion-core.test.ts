import { describe, expect, it, vi } from "vitest";
import { BodyDirector } from "../.uina/worlds/live2d/body-director.js";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { ReflexDirector } from "../.uina/worlds/live2d/reflex-director.js";
import {
	CUE_ALIASES,
	CANONICAL_CUE_IDS,
	getChannelsForBeats,
	resolveBeatToParams,
	resolveCueToBeat,
} from "../.uina/worlds/live2d/parameter-mapper.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { AudioObserver } from "../.uina/worlds/live2d/audio-observer.js";
import { live2dAffordance, Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { ActionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import { CHANNEL_PRIORITY } from "../.uina/worlds/live2d/types.js";
import { VTSParameterRetargeter } from "../.uina/worlds/live2d/vts-retargeter.js";

describe("Live2D Phase 3: Motion Core & Channel Arbiter", () => {
	describe("MotionDirector", () => {
		it("should claim channels and release them cleanly (RAII)", async () => {
			const arbiter = new MotionDirector();
			expect(arbiter.isChannelLocked("head")).toBe(false);

			const lease = await arbiter.claim(["head", "gaze"]);
			expect(arbiter.isChannelLocked("head")).toBe(true);
			expect(arbiter.isChannelLocked("gaze")).toBe(true);
			expect(arbiter.isChannelLocked("mouth")).toBe(false);

			arbiter.release(lease);
			expect(arbiter.isChannelLocked("head")).toBe(false);
			expect(arbiter.isChannelLocked("gaze")).toBe(false);
		});

		it("should reject lower or equal priority claims when channel is locked", async () => {
			const arbiter = new MotionDirector();
			await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION, reason: "task1" });

			// Lower priority rejected
			await expect(
				arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.REFLEX }),
			).rejects.toThrow(/locked by active task/);

			// Equal priority also rejected (no silent preemption)
			await expect(
				arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION, reason: "task2" }),
			).rejects.toThrow(/locked by active task/);
		});

		it("should allow degradation when requested channel is locked", async () => {
			const arbiter = new MotionDirector();
			await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });

			// Request ["head", "gaze"] with allowDegrade
			const lease = await arbiter.claim(["head", "gaze"], {
				priority: CHANNEL_PRIORITY.REFLEX,
				allowDegrade: true,
			});

			expect(lease.channels).toEqual(["gaze"]);
			expect(arbiter.isChannelLocked("gaze")).toBe(true);
			lease.release();
		});

		it("should auto-release lease on abort signal", async () => {
			const arbiter = new MotionDirector();
			const controller = new AbortController();

			await arbiter.claim(["torso"], { signal: controller.signal });
			expect(arbiter.isChannelLocked("torso")).toBe(true);

			controller.abort();
			expect(arbiter.isChannelLocked("torso")).toBe(false);
		});

		it("should dispatch cues to registered dispatcher", () => {
			const arbiter = new MotionDirector();
			const received: string[] = [];
			arbiter.setCueDispatcher((cueId) => received.push(cueId));

			arbiter.dispatchCue("warm_smile");
			expect(received).toEqual(["warm_smile"]);
		});

		it("should query active leases and force release all channels", async () => {
			const arbiter = new MotionDirector();
			const lease1 = await arbiter.claim(["head"]);
			const lease2 = await arbiter.claim(["mouth"]);

			const active = arbiter.getActiveLeases();
			expect(active.length).toBe(2);
			expect(active).toContain(lease1);
			expect(active).toContain(lease2);

			arbiter.releaseAll();
			expect(arbiter.isChannelLocked("head")).toBe(false);
			expect(arbiter.isChannelLocked("mouth")).toBe(false);
			expect(arbiter.getActiveLeases().length).toBe(0);
		});
	});

	describe("PhysiologicalNoise (Layer 0)", () => {
		it("should produce periodic breathing and body drift", () => {
			const noise = new PhysiologicalNoise();

			const t0 = noise.tick(0);
			expect(t0.ParamBreath).toBeGreaterThanOrEqual(0);
			expect(t0.ParamBreath).toBeLessThanOrEqual(1);

			// Advance by 900ms (1/4 of 3.6s breath cycle)
			const t1 = noise.tick(900);
			expect(t1.ParamBreath).toBeGreaterThanOrEqual(0);
			expect(t1.ParamBreath).toBeLessThanOrEqual(1);
			expect(t1.ParamBodyAngleX).toBeDefined();
			expect(t1.ParamAngleZ).toBeDefined();
		});

		it("should produce random blinks and micro-saccades", () => {
			const noise = new PhysiologicalNoise();
			let blinked = false;

			// Advance through 6 seconds to trigger at least one blink
			for (let i = 0; i < 300; i++) {
				const frame = noise.tick(20);
				if (frame.ParamEyeLOpen < 0.9) {
					blinked = true;
				}
				expect(Math.abs(frame.ParamEyeBallX)).toBeLessThanOrEqual(0.25);
			}

			expect(blinked).toBe(true);
		});

		it("should advance through explicit BlinkPhase states", () => {
			const noise = new PhysiologicalNoise();
			expect(noise.getBlinkPhase()).toBe(0); // BlinkPhase.IDLE

			// Force trigger blink by advancing past max interval
			noise.tick(6000);
			expect(noise.getBlinkPhase()).not.toBe(0);

			noise.reset();
			expect(noise.getBlinkPhase()).toBe(0);
		});

		it("should deterministically traverse all 6 double-blink phases", () => {
			const noise = new PhysiologicalNoise();
			noise.triggerBlink({ willDoubleBlink: true });
			expect(noise.getBlinkPhase()).toBe(1); // CLOSING_1

			noise.tick(60);
			expect(noise.getBlinkPhase()).toBe(2); // OPENING_1

			noise.tick(100);
			expect(noise.getBlinkPhase()).toBe(3); // DOUBLE_BLINK_PAUSE

			noise.tick(50);
			expect(noise.getBlinkPhase()).toBe(4); // CLOSING_2

			noise.tick(50);
			expect(noise.getBlinkPhase()).toBe(5); // OPENING_2

			noise.tick(80);
			expect(noise.getBlinkPhase()).toBe(0); // IDLE
		});
	});

	describe("BodyDirector (Layer 2)", () => {
		it("should track targets with underdamped spring and clamp angular speed", () => {
			const director = new BodyDirector({ maxAngularSpeed: 17 });
			director.setTarget("ParamAngleY", 15);

			// Step 50ms
			const frame = director.tick(50);
			// In 50ms (0.05s) at max 17 deg/s, angle change cannot exceed ~0.85 deg
			expect(frame.ParamAngleY).toBeLessThanOrEqual(1.0);
			expect(frame.ParamAngleY).toBeGreaterThan(0);
		});

		it("should transition between active and relaxed poses using smootherstep", () => {
			const director = new BodyDirector();
			director.transitionToActivePose();

			// Initial step
			const start = director.tick(100);
			expect(start.ParamEyeLOpen).toBeGreaterThan(0);

			// Step to 800ms (completed transition)
			const end = director.tick(800);
			expect(end.ParamEyeLOpen).toBeCloseTo(1.0, 2);
			expect(end.ParamBodyAngleY).toBeCloseTo(8.0, 2);
			expect(end.ParamAngleY).toBeCloseTo(12.0, 2);

			// 切换到 relaxed（失焦停靠的物理呈现由上层指定，本层只管姿态切换）
			director.applyBasePose("relaxed", 800);
			director.tick(900);
			expect(director.getParam("ParamEyeLOpen")).toBeCloseTo(0.70, 2);
			expect(director.getParam("ParamBodyAngleY")).toBeCloseTo(-6.0, 2);
			expect(director.getParam("ParamAngleY")).toBeCloseTo(-10.0, 2);
		});

		it("should hold pose and notify expiry via onBasePoseExpired instead of clearing targets", () => {
			const director = new BodyDirector();
			// 到期语义由上层决定：如 runtime 会切回 relaxed 待机
			let expiredCount = 0;
			director.setOnBasePoseExpired(() => {
				expiredCount++;
				director.applyBasePose("relaxed", { transitionMs: 600 });
			});
			director.applyBasePose("playful", { transitionMs: 800, holdMs: 3000 });

			// Transition phase (800ms)
			director.tick(800);
			expect(director.getParam("ParamAngleZ")).toBeCloseTo(18.0, 1);

			// Hold phase (2000ms)
			director.tick(2000);
			expect(director.getParam("ParamAngleZ")).toBeCloseTo(18.0, 1);
			expect(expiredCount).toBe(0);

			// Expire hold (remaining 1000ms + margin)：到期回调触发切回 relaxed
			director.tick(1100);
			expect(expiredCount).toBe(1);

			// 基准目标已是 relaxed（ParamAngleZ = -8.0），而非清零回零位
			for (let i = 0; i < 50; i++) {
				director.tick(50);
			}
			expect(director.getParam("ParamAngleZ")).toBeCloseTo(-8.0, 1);
			expect(director.getHoldRemainingMs()).toBeUndefined();
		});

		it("should not freeze hold countdown while unrelated channels transition", () => {
			const director = new BodyDirector();
			director.applyBasePose("playful", { transitionMs: 0, holdMs: 1000 });
			director.tick(1); // 基准姿态过渡立即完成，进入保持计时

			// 无关通道（头部俯仰，不属于 playful 基准参数）持续过渡期间，保持计时必须继续走
			for (let i = 0; i < 30; i++) {
				director.transitionTargets([{ name: "ParamAngleY", value: -i * 0.5 }], 250);
				director.tick(50);
			}
			// 1500ms > 1000ms 保持期：即便该通道从未停止过渡，到期也已触发
			expect(director.getHoldRemainingMs()).toBeUndefined();
		});

		it("should dampen smoothly to neutral", () => {
			const director = new BodyDirector();
			director.setTarget("ParamAngleX", 20);
			director.tick(500);

			director.dampenToNeutral();
			// Advance time to settle
			for (let i = 0; i < 50; i++) {
				director.tick(50);
			}
			expect(Math.abs(director.getParam("ParamAngleX"))).toBeLessThan(0.05);
		});

		it("should retain base pose targets after dampenToNeutral", () => {
			const director = new BodyDirector();
			director.setBasePose({ ParamAngleZ: 5.0, ParamBodyAngleX: 2.0 });
			director.tick(900);
			expect(director.getParam("ParamAngleZ")).toBeCloseTo(5.0, 1);

			// Overlay an expressive transient tilt
			director.setTarget("ParamAngleZ", -14.0);
			director.tick(500);
			expect(director.getParam("ParamAngleZ")).toBeLessThan(0);

			// Dampen to neutral - should return to base pose (5.0), not 0
			director.dampenToNeutral();
			for (let i = 0; i < 50; i++) {
				director.tick(50);
			}
			expect(director.getParam("ParamAngleZ")).toBeCloseTo(5.0, 1);
			expect(director.getParam("ParamBodyAngleX")).toBeCloseTo(2.0, 1);
		});

		it("should remain unconditionally stable under massive deltaMs (analytical spring)", () => {
			const director = new BodyDirector();
			director.setTarget("ParamAngleY", 10);

			// 模拟 1000ms 大卡顿步长
			const frame = director.tick(1000);
			// 欠阻尼解析解稳定趋向目标，绝不产生欧拉发散爆炸
			expect(frame.ParamAngleY).toBeGreaterThan(5);
			expect(frame.ParamAngleY).toBeLessThan(15);
		});

		it("should apply velocity impulse and produce physical underdamped oscillation and rebound", () => {
			const director = new BodyDirector();
			director.applyVelocityImpulse("ParamAngleY", -100);

			// Step 50ms: fast downward nod
			const f1 = director.tick(50);
			expect(f1.ParamAngleY).toBeLessThan(-2.5);

			// Step to 250ms (300ms total): underdamped rebound creates positive overshoot
			const f2 = director.tick(250);
			expect(f2.ParamAngleY).toBeGreaterThan(0.2);

			// Step to 600ms total: settles back to resting target
			director.tick(300);
			expect(Math.abs(director.getParam("ParamAngleY"))).toBeLessThan(0.2);

			// Dampen completely to 0 and verify resetVelocity prevents impulse movement
			director.dampenToNeutral();
			for (let i = 0; i < 20; i++) director.tick(50);
			expect(Math.abs(director.getParam("ParamAngleY"))).toBeLessThan(0.001);

			director.applyVelocityImpulse("ParamAngleY", 80);
			director.resetVelocity("ParamAngleY");
			const f4 = director.tick(50);
			expect(Math.abs(f4.ParamAngleY)).toBeLessThan(0.001);
		});
	});

	describe("ParameterMapper", () => {
		it("should resolve semantic beats to Cubism parameters with intensity", () => {
			const targets = resolveBeatToParams({
				head: "tilt_right",
				gaze: "side_peek",
				face: "shy",
			}, 0.8);

			const paramMap = Object.fromEntries(targets.map((t) => [t.name, t.value]));
			expect(paramMap.ParamAngleZ).toBeCloseTo(-18.0 * 0.8, 2);
			expect(paramMap.ParamEyeBallX).toBeCloseTo(0.85 * 0.8, 2);
			expect(paramMap.ParamEyeBallY).toBeCloseTo(-0.2 * 0.8, 2);
			expect(paramMap.ParamCheek).toBeCloseTo(0.95 * 0.8, 2);
		});

		it("should resolve cues and aliases including smile, nod, shy and fuzzy inputs", () => {
			// Direct match
			const direct = resolveCueToBeat("warm_smile");
			expect(direct).toBeDefined();

			// Aliases
			const smile = resolveCueToBeat("smile");
			expect(smile).toEqual(direct);

			const nod = resolveCueToBeat("nod");
			expect(nod).toEqual(resolveCueToBeat("affirmative_nod"));

			const shy = resolveCueToBeat("shy");
			expect(shy).toBeDefined();
			expect(shy![0]!.face).toBe("tender_smile");
			expect(shy![0]!.gaze).toBe("away_left");

			// Fuzzy normalized
			const fuzzy = resolveCueToBeat("WARM-SMILE");
			expect(fuzzy).toEqual(direct);
		});

		it("should resolve all gaze directions, head poses, and face expressions", () => {
			// Test remaining gaze directions
			const g1 = resolveBeatToParams({ gaze: "away_right" });
			expect(g1.find((p) => p.name === "ParamEyeBallX")?.value).toBeGreaterThan(0);

			const g2 = resolveBeatToParams({ gaze: "away_left" });
			expect(g2.find((p) => p.name === "ParamEyeBallX")?.value).toBeLessThan(0);

			const g3 = resolveBeatToParams({ gaze: "down" });
			expect(g3.find((p) => p.name === "ParamEyeBallY")?.value).toBeLessThan(0);

			const g4 = resolveBeatToParams({ gaze: "user" });
			expect(g4.find((p) => p.name === "ParamEyeBallX")?.value).toBe(0);
			expect(g4.find((p) => p.name === "ParamEyeBallY")?.value).toBe(0);

			// Test remaining head poses
			const h1 = resolveBeatToParams({ head: "tilt_left" });
			expect(h1.find((p) => p.name === "ParamAngleZ")?.value).toBeGreaterThan(0);

			const h2 = resolveBeatToParams({ head: "nod" });
			expect(h2.find((p) => p.name === "ParamAngleY")?.value).toBeLessThan(0);

			const h3 = resolveBeatToParams({ head: "shake" });
			expect(h3.find((p) => p.name === "ParamAngleX")?.value).toBeGreaterThan(0);

			const h4 = resolveBeatToParams({ head: "lowered" });
			expect(h4.find((p) => p.name === "ParamAngleY")?.value).toBeLessThan(0);

			const h5 = resolveBeatToParams({ head: "lifted" });
			expect(h5.find((p) => p.name === "ParamAngleY")?.value).toBeGreaterThan(0);

			// Test remaining face expressions
			const f1 = resolveBeatToParams({ face: "smug" });
			expect(f1.find((p) => p.name === "ParamMouthForm")?.value).toBeGreaterThan(0);

			const f2 = resolveBeatToParams({ face: "pout" });
			expect(f2.find((p) => p.name === "ParamMouthForm")?.value).toBeLessThan(0);

			const f3 = resolveBeatToParams({ face: "sparkle" });
			expect(f3.find((p) => p.name === "ParamEyeLOpen")?.value).toBeGreaterThan(0);

			const f4 = resolveBeatToParams({ face: "shocked" });
			expect(f4.find((p) => p.name === "ParamMouthOpenY")?.value).toBeGreaterThan(0);

			const f5 = resolveBeatToParams({ face: "tender_smile" });
			expect(f5.find((p) => p.name === "ParamEyeLSmile")?.value).toBeGreaterThan(0);
		});

		it("should map all semantic cues to express beats", () => {
			const allCues = [
				"warm_smile",
				"happy_laugh",
				"curious_tilt",
				"affirmative_nod",
				"double_nod",
				"shake_head",
				"shrug",
				"head_bop",
				"playful_pout",
				"surprised_gasp",
				"shy",
				"look_away",
				"peek_back",
				"thinking_deep",
				"winking",
				"smug_grin",
				"sleepy_yawn",
			];

			for (const cue of allCues) {
				const beats = resolveCueToBeat(cue);
				expect(beats).not.toBeNull();
				expect(beats!.length).toBeGreaterThan(0);
				for (const beat of beats!) {
					expect(beat.hold_ms).toBeGreaterThan(0);
				}
			}

			const invalid = resolveCueToBeat("unknown_cue");
			expect(invalid).toBeNull();
		});

		it("should support all 6 base poses and apply them cleanly", () => {
			const director = new BodyDirector();
			const poses = ["playful", "focused", "relaxed", "shy_side", "confident", "listening"] as const;

			for (const p of poses) {
				director.applyBasePose(p, 100);
				director.tick(100);
				expect(director.getBasePoseTarget("ParamEyeLOpen")).toBeGreaterThan(0);
			}
		});

		it("should produce dynamic living hold micro-drifts rather than frozen static targets", () => {
			const director = new BodyDirector();
			director.applyBasePose("playful", { transitionMs: 100, holdMs: 2000 });
			director.tick(100); // finish transition

			// Sample target during hold at different phases
			const val1 = director.getParam("ParamAngleZ");
			director.tick(500);
			const val2 = director.getParam("ParamAngleZ");

			expect(val1).toBeGreaterThan(15);
			expect(val2).toBeGreaterThan(15);
			// Living hold introduces small dynamic modulation
			expect(val1).toBeDefined();
			expect(val2).toBeDefined();
		});
	});

	describe("MotionDirector (4-Layer Composer)", () => {
		it("should compose Layer 0 (Noise) + Layer 2 (Spring) within safety clamps", () => {
			const composer = new MotionDirector();
			composer.bodyDirector.setTarget("ParamAngleX", 25);

			const frame = composer.compose(50);
			expect(frame.ParamAngleX).toBeGreaterThanOrEqual(-30);
			expect(frame.ParamAngleX).toBeLessThanOrEqual(30);
			expect(frame.ParamBreath).toBeGreaterThanOrEqual(0);
			expect(frame.ParamBreath).toBeLessThanOrEqual(1);
			expect(frame.ParamEyeLOpen).toBeGreaterThanOrEqual(0);
			expect(frame.ParamEyeLOpen).toBeLessThanOrEqual(2);
		});

		it("should trigger physical acoustic velocity impulse and exhibit underdamped bounce", () => {
			const composer = new MotionDirector();
			composer.triggerAcousticImpulse(1.0);

			const f1 = composer.compose(10);
			expect(f1.ParamAngleY).toBeLessThan(-1.0); // Downward nod impulse

			// Advance by 300ms, impulse should have decayed and bounced past neutral
			const f2 = composer.compose(300);
			expect(f2.ParamAngleY).toBeGreaterThan(-0.5);
		});

		it("should suppress acoustic velocity impulse when head channel is locked by cue or action", async () => {
			const arbiter = new MotionDirector();
			const composer = arbiter;

			const lease = await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.CUE });
			composer.triggerAcousticImpulse(1.0);

			// Because head is locked, impulse should have been ignored
			expect(composer.bodyDirector.getParam("ParamAngleY")).toBe(0);

			lease.release();
			composer.triggerAcousticImpulse(1.0);
			const f = composer.compose(10);
			expect(f.ParamAngleY).toBeLessThan(-1.0);
		});

		it("should play expressive beats sequentially and support abort", async () => {
			const composer = new MotionDirector();
			const controller = new AbortController();

			const playPromise = composer.playExpressiveBeats({
				beats: [
					{ head: "tilt_left", hold_ms: 200 },
					{ head: "tilt_right", hold_ms: 200 },
				],
			}, controller.signal);

			// Abort after 50ms
			setTimeout(() => controller.abort(), 50);
			await playPromise;

			// Check that abort finished cleanly without hanging
			expect(controller.signal.aborted).toBe(true);
		});

		it("should preempt previous expressive beats when a new sequence begins", async () => {
			const composer = new MotionDirector();
			const firstPlay = composer.playExpressiveBeats({
				beats: [{ head: "nod", hold_ms: 1000 }],
			});

			// Start second sequence shortly after
			await new Promise((r) => setTimeout(r, 50));
			const secondPlay = composer.playExpressiveBeats({
				beats: [{ head: "lifted", hold_ms: 200 }],
			});

			await Promise.all([firstPlay, secondPlay]);
			expect(composer.bodyDirector.getParam("ParamAngleY")).toBeDefined();
		});

		it("should abort all motions and dampen to neutral on emergency safeStop", () => {
			const composer = new MotionDirector();
			composer.triggerAcousticImpulse(1.0);
			composer.bodyDirector.setTarget("ParamAngleX", 20);

			composer.abortAllMotions();
			expect(composer.bodyDirector.getParam("ParamAngleX")).toBeDefined();
		});

		it("should suppress physiological noise on channels locked by action", async () => {
			const arbiter = new MotionDirector();
			const composer = arbiter;

			// Lock 'head' channel with ACTION priority
			const lease = await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });

			// With lock, Layer 0 noise on head (ParamAngleZ) is suppressed to 0
			const frame = composer.compose(100);
			expect(frame.ParamAngleZ).toBe(0);

			lease.release();
			const frameAfterRelease = composer.compose(100);
			expect(frameAfterRelease.ParamAngleZ).not.toBe(0);
		});

		it("should continuously drive cyclical torso and head sway during active speech", () => {
			const composer = new MotionDirector();
			expect(composer.getSpeechActivity()).toBe(0);

			// First tick with speech energy
			composer.compose(50, { speechEnergy: 0.6 });
			expect(composer.getSpeechActivity()).toBeGreaterThan(0);

			// Advance frames to let speech cadence develop
			const frames: Array<Record<string, number>> = [];
			for (let i = 0; i < 20; i++) {
				frames.push(composer.compose(50, { speechEnergy: 0.6 }));
			}

			// Verify that ParamBodyAngleX and ParamBodyAngleY oscillate smoothly
			const bodyXValues = frames.map((f) => f.ParamBodyAngleX);
			const minX = Math.min(...bodyXValues);
			const maxX = Math.max(...bodyXValues);
			expect(maxX - minX).toBeGreaterThan(1.5); // Clear dynamic sway amplitude

			const bodyYValues = frames.map((f) => f.ParamBodyAngleY);
			const minY = Math.min(...bodyYValues);
			const maxY = Math.max(...bodyYValues);
			expect(maxY - minY).toBeGreaterThan(1.0); // Clear dynamic pitch amplitude
		});

		it("should smoothly decay speech cadence to neutral when speech stops", () => {
			const composer = new MotionDirector();
			// Ramp up speech activity
			for (let i = 0; i < 10; i++) {
				composer.compose(50, { speechEnergy: 0.8 });
			}
			expect(composer.getSpeechActivity()).toBeGreaterThan(0.5);

			// Speech stops (speechEnergy: 0)
			for (let i = 0; i < 20; i++) {
				composer.compose(50, { speechEnergy: 0 });
			}
			expect(composer.getSpeechActivity()).toBeCloseTo(0, 1);
		});

		it("should suppress torso speech sway when torso channel is locked by Action or Cue", async () => {
			const arbiter = new MotionDirector();
			const composer = arbiter;

			// Lock torso channel
			const lease = await arbiter.claim(["torso"], { priority: CHANNEL_PRIORITY.ACTION });

			// Run speech frames
			const frames: Array<Record<string, number>> = [];
			for (let i = 0; i < 10; i++) {
				frames.push(composer.compose(50, { speechEnergy: 0.8 }));
			}

			// ParamBodyAngleX and ParamBodyAngleY should not receive speech sway
			for (const f of frames) {
				expect(f.ParamBodyAngleX ?? 0).toBe(0);
				expect(f.ParamBodyAngleY ?? 0).toBe(0);
			}

			lease.release();
		});

		it("should immediately reset speech activity and phase on abortAllMotions", () => {
			const composer = new MotionDirector();
			for (let i = 0; i < 10; i++) {
				composer.compose(50, { speechEnergy: 0.8 });
			}
			expect(composer.getSpeechActivity()).toBeGreaterThan(0.5);

			composer.abortAllMotions();
			expect(composer.getSpeechActivity()).toBe(0);
		});
	});

	describe("Additive Motion Blending (相对叠加混合)", () => {
		it("should additively offset head angles on top of active base pose targets", async () => {
			const composer = new MotionDirector();
			// 1. 设置 focused 专注基准姿态 (ParamAngleY: 12.0)
			composer.bodyDirector.applyBasePose("focused", 50);
			composer.bodyDirector.tick(50);
			expect(composer.bodyDirector.getBasePoseTarget("ParamAngleY")).toBe(12.0);

			// 2. 触发点头动作 (nod: -20.0，满强度 intensity: 1.0)
			const playPromise = composer.playExpressiveBeats({
				head: "nod",
				intensity: 1.0,
			});

			// 相对叠加后目标为 12.0 + (-20.0) = -8.0，而非绝对值 -20.0
			expect(composer.bodyDirector.getParamTarget("ParamAngleY")).toBeCloseTo(-8.0, 2);

			// 3. 等待播放完成
			await playPromise;

			// 4. 播放完毕后平滑恢复至 basePose 目标 12.0
			expect(composer.bodyDirector.getParamTarget("ParamAngleY")).toBeCloseTo(12.0, 2);
		});

		it("should accentuate head tilts on asymmetric base poses (shy_side)", async () => {
			const composer = new MotionDirector();
			// shy_side: ParamAngleZ = 14.0
			composer.bodyDirector.applyBasePose("shy_side", 50);
			composer.bodyDirector.tick(50);
			expect(composer.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(14.0);

			// tilt_left: +18.0 * 0.6 = +10.8
			const playPromise = composer.playExpressiveBeats({
				head: "tilt_left",
				intensity: 0.6,
			});

			// 相对叠加后应强化偏头角：14.0 + 10.8 = 24.8，绝不反向回落至 10.8
			expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBeCloseTo(24.8, 2);

			await playPromise;
			expect(composer.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(14.0);
		});

		it("should clamp additive targets to safe hardware limits to prevent joint explosion", async () => {
			const composer = new MotionDirector();
			// playful: ParamAngleZ = 18.0
			composer.bodyDirector.applyBasePose("playful", 50);
			composer.bodyDirector.tick(50);

			// tilt_left: +18.0 (满强度 1.0) -> 原值相加为 36.0，超出 [-30, 30]
			const playPromise = composer.playExpressiveBeats({
				head: "tilt_left",
				intensity: 1.0,
			});

			// 必须严格被 clampLive2DParam 限制在 30.0
			expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(30.0);

			await playPromise;
		});

		it("should additively blend facial accents like cheek blush onto base pose", async () => {
			const composer = new MotionDirector();
			// playful: ParamCheek = 0.5
			composer.bodyDirector.applyBasePose("playful", 50);
			composer.bodyDirector.tick(50);
			expect(composer.bodyDirector.getBasePoseTarget("ParamCheek")).toBe(0.5);

			// tender_smile: ParamCheek mult = 0.4 (intensity 1.0)
			const playPromise = composer.playExpressiveBeats({
				face: "tender_smile",
				intensity: 1.0,
			});

			// 相对叠加腮红：0.5 + 0.4 = 0.9
			expect(composer.bodyDirector.getParamTarget("ParamCheek")).toBeCloseTo(0.9, 2);

			await playPromise;
		});

		it("should preserve override semantics for fixed expressions like wink or laugh", async () => {
			const composer = new MotionDirector();
			composer.bodyDirector.applyBasePose("playful", 50);
			composer.bodyDirector.tick(50);

			// laugh 表情强制闭眼：ParamEyeLOpen mult = 0.05, fixed: true
			const playPromise = composer.playExpressiveBeats({
				face: "laugh",
			});

			// fixed 参数不叠加，直接覆盖为 0.05 闭眼
			expect(composer.bodyDirector.getParamTarget("ParamEyeLOpen")).toBe(0.05);

			await playPromise;
		});

		it("should behave identically to neutral delta when no base pose is active", async () => {
			const composer = new MotionDirector();
			// 无基准姿态时，basePoseTarget 为 0
			expect(composer.bodyDirector.getBasePoseTarget("ParamAngleY")).toBe(0);

			const playPromise = composer.playExpressiveBeats({
				head: "nod",
				intensity: 1.0,
			});

			// 0 + (-20.0) = -20.0，与原有中性位逻辑 100% 保持一致
			expect(composer.bodyDirector.getParamTarget("ParamAngleY")).toBeCloseTo(-20.0, 2);

			await playPromise;
		});
	});

	describe("Adversarial Fixes & Hardening", () => {
		describe("Channel Mapping & Least Privilege (Occam's Razor)", () => {
			it("should extract minimal required channels for beat sequences", () => {
				const headOnlyBeats = [{ head: "nod" as const, hold_ms: 300 }];
				expect(getChannelsForBeats(headOnlyBeats)).toEqual(["head"]);

				const headAndGazeBeats = [{ head: "tilt_left" as const, gaze: "away_right" as const, hold_ms: 300 }];
				expect(getChannelsForBeats(headAndGazeBeats)).toEqual(["head", "gaze"]);

				const mouthAndEyesBeats = [{ face: "shocked" as const, hold_ms: 400 }]; // shocked uses ParamMouthOpenY and ParamEyeLOpen
				expect(getChannelsForBeats(mouthAndEyesBeats)).toContain("mouth");
				expect(getChannelsForBeats(mouthAndEyesBeats)).toContain("eyes");

				// Gaze-only beat
				const gazeBeats = [{ gaze: "away_left" as const, hold_ms: 300 }];
				expect(getChannelsForBeats(gazeBeats)).toEqual(["gaze"]);
			});
		});

		describe("MotionDirector Lease Abort Signals & Preemption", () => {
			it("should provide an AbortSignal on lease and abort it when evicted by higher priority", async () => {
				const arbiter = new MotionDirector();

				// 1. Claim channel at CUE priority
				const cueLease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.CUE,
					reason: "test:cue",
				});

				expect(cueLease.signal).toBeDefined();
				expect(cueLease.signal!.aborted).toBe(false);

				const abortSpy = vi.fn();
				cueLease.signal!.addEventListener("abort", abortSpy);

				// 2. High-priority ACTION claims the same channel -> preemption
				const actionLease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.ACTION,
					reason: "test:action",
				});

				expect(cueLease.signal!.aborted).toBe(true);
				expect(abortSpy).toHaveBeenCalled();
				expect(arbiter.isChannelLocked("head")).toBe(true);

				// 3. Releasing preempted lease is a safe no-op
				cueLease.release();
				expect(arbiter.isChannelLocked("head")).toBe(true);

				actionLease.release();
				expect(arbiter.isChannelLocked("head")).toBe(false);
			});

			it("should abort all active leases when releaseAll is called", async () => {
				const arbiter = new MotionDirector();
				const lease1 = await arbiter.claim(["head"]);
				const lease2 = await arbiter.claim(["mouth"]);

				expect(lease1.signal?.aborted).toBe(false);
				expect(lease2.signal?.aborted).toBe(false);

				arbiter.releaseAll();

				expect(lease1.signal?.aborted).toBe(true);
				expect(lease2.signal?.aborted).toBe(true);
				expect(arbiter.getActiveLeases()).toHaveLength(0);
			});

			it("should allow consecutive cues at same priority to preempt earlier cues when preemptSamePriority is enabled", async () => {
				const arbiter = new MotionDirector();

				// 1. Claim channel at CUE priority for cue 1
				const cue1Lease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.CUE,
					reason: "cue:cue_1",
					preemptSamePriority: true,
				});
				expect(cue1Lease.signal?.aborted).toBe(false);

				// 2. Claim same channel at same CUE priority for cue 2
				const cue2Lease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.CUE,
					reason: "cue:cue_2",
					preemptSamePriority: true,
				});

				// Earlier cue must be aborted and preempted smoothly
				expect(cue1Lease.signal?.aborted).toBe(true);
				expect(cue2Lease.signal?.aborted).toBe(false);
				expect(arbiter.isChannelLocked("head")).toBe(true);

				cue2Lease.release();
				expect(arbiter.isChannelLocked("head")).toBe(false);
			});

			it("should abort the entire lease when atomic is true and any channel is preempted", async () => {
				const arbiter = new MotionDirector();

				// 1. Claim compound channels with atomic: true
				const atomicLease = await arbiter.claim(["head", "torso"], {
					priority: CHANNEL_PRIORITY.ACTION,
					reason: "compound_motion",
					atomic: true,
				});

				expect(atomicLease.signal?.aborted).toBe(false);
				expect(arbiter.isChannelLocked("head")).toBe(true);
				expect(arbiter.isChannelLocked("torso")).toBe(true);

				// 2. Higher priority preemption only claims 'head'
				const emergencyLease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.EMERGENCY,
					reason: "emergency_look",
				});

				// Because atomic was true, the entire atomicLease is aborted and released
				expect(atomicLease.signal?.aborted).toBe(true);
				expect(arbiter.isChannelLocked("head")).toBe(true);
				// torso was released because atomic lease was completely aborted
				expect(arbiter.isChannelLocked("torso")).toBe(false);

				emergencyLease.release();
				expect(arbiter.isChannelLocked("head")).toBe(false);
			});
		});

		describe("MotionDirector Selective Channel Filtering", () => {
			it("should only modify allowedChannels when specified", async () => {
				const composer = new MotionDirector();
				// Base head at 0, face at 0
				expect(composer.bodyDirector.getParam("ParamAngleZ")).toBe(0);

				// Play beat with head and gaze, but allowedChannels is only gaze
				await composer.playExpressiveBeats(
					{
						beats: [{ head: "tilt_left", gaze: "away_right", hold_ms: 100 }],
					},
					{ allowedChannels: ["gaze"] },
				);

				// Head angle was NOT altered because head channel was not in allowedChannels
				expect(composer.bodyDirector.getParam("ParamAngleZ")).toBe(0);
			});
		});

		describe("BodyDirector & ReflexDirector Selective Dampening", () => {
			it("should preserve exempt parameter targets during dampenToNeutral", () => {
				const director = new BodyDirector();
				director.setTarget("ParamAngleZ", 15);
				director.setTarget("ParamEyeBallY", 0.8);

				// Dampen to neutral with ParamAngleZ exempt
				director.dampenToNeutral(["ParamAngleZ"]);

				expect(director.getParamTarget("ParamAngleZ")).toBe(15);
				expect(director.getParamTarget("ParamEyeBallY")).toBe(0);
			});

			it("should protect ongoing expressive beats in ReflexDirector.onTurnEnd", async () => {
				const composer = new MotionDirector();
			const reflex = new ReflexDirector(composer);

				// Set thinking pose
				await reflex.onThinking();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(10.0);

				// Start playing expressive beats
				const beatsPromise = composer.playExpressiveBeats({
					beats: [{ head: "tilt_right", hold_ms: 500 }],
				});

				expect(composer.isPlayingExpressiveBeats()).toBe(true);

				// Turn end arrives while beats are playing
				await reflex.onTurnEnd();

				// ParamAngleZ is active in the beat, so its target is preserved (-18 * 0.6 intensity = -10.8)
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBeCloseTo(-18.0 * 0.6, 1);

				await beatsPromise;
			});

			it("should selectively dampen only specified parameters with dampenParams", () => {
				const director = new BodyDirector();
				director.setTarget("ParamAngleZ", 12);
				director.setTarget("ParamAngleX", 8);
				director.setTarget("ParamEyeBallY", 0.7);

				// Only dampen ParamAngleZ and ParamEyeBallY
				director.dampenParams(["ParamAngleZ", "ParamEyeBallY"]);

				expect(director.getParamTarget("ParamAngleZ")).toBe(0);
				expect(director.getParamTarget("ParamEyeBallY")).toBe(0);
				// ParamAngleX must remain unchanged
				expect(director.getParamTarget("ParamAngleX")).toBe(8);
			});

			it("should reset thinking pose targets when ReflexDirector.onSpeakingContent is invoked", async () => {
				const composer = new MotionDirector();
			const reflex = new ReflexDirector(composer);

				await reflex.onThinking();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(10.0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0.6);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(-0.4);

				// When content speaking begins, thinking pose must be cleanly dampened back to neutral
				reflex.onSpeakingContent();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(0);
			});
		});

		describe("Cue Affordance & Parameter Mapping Invariants", () => {
			it("每个规范 id 都被声明且附带非空说明", () => {
				expect(CANONICAL_CUE_IDS.length).toBeGreaterThan(0);
				expect(live2dAffordance.cues.map((c) => c.id).sort()).toEqual(
					[...CANONICAL_CUE_IDS].sort(),
				);
				for (const cue of live2dAffordance.cues) {
					expect(cue.description.trim(), `cue "${cue.id}" 缺少说明`).not.toBe("");
				}
			});

			it("每条对外声明的 cue id 都能被派发层解析", () => {
				for (const cue of live2dAffordance.cues) {
					expect(resolveCueToBeat(cue.id), `规范 id "${cue.id}" 解析失败`).not.toBeNull();
				}
			});

			it("声明的别名都能被派发层解析", () => {
				for (const cue of live2dAffordance.cues) {
					for (const alias of cue.aliases ?? []) {
						expect(resolveCueToBeat(alias), `别名 "${alias}"→${cue.id} 解析失败`).not.toBeNull();
					}
				}
			});

			it("别名表无孤儿：每个别名指向的规范 id 都在规范表中", () => {
				for (const [, canonical] of Object.entries(CUE_ALIASES)) {
					expect(CANONICAL_CUE_IDS).toContain(canonical);
				}
			});
		});

		describe("Neuro-sama Dynamic Liveliness & Hardened Motion Mechanics", () => {
			describe("AudioObserver (Speech Onset Cadence & Refractory Period)", () => {
				// 测试统一使用生产默认参数域：真实 16-bit PCM 对话 RMS 约 0.008~0.04，
				// 阈值 0.018 / 起振差 0.008。不再用 0.30/0.15 的旧参数域自欺。
				it("should trigger acoustic impulse on speech onset spike and suppress jitter during refractory period", () => {
					const observer = new AudioObserver();
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Frame 1: Low background noise (RMS 0.006 < 0.018) -> No trigger
					observer.processLevel({ rms: 0.006 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 2: Loud speech onset (RMS 0.04, delta = 0.034 > 0.008) -> Triggers impulse!
					observer.processLevel({ rms: 0.04 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);

					// Frame 3-5: Sustained loud vowel over next 150ms (RMS remains 0.04) -> Cooldown suppresses repeated impulses!
					observer.tick(50);
					observer.processLevel({ rms: 0.04 });
					observer.tick(50);
					observer.processLevel({ rms: 0.04 });
					observer.tick(50);
					observer.processLevel({ rms: 0.04 });
					expect(triggerSpy).toHaveBeenCalledTimes(1); // Still 1! No continuous jitter or bobblehead nodding!

					// Advance past 220ms refractory period (remaining: 220 - 150 = 70ms; advance 100ms)
					observer.tick(100);
					// Now a dip followed by next syllable onset
					observer.processLevel({ rms: 0.006 });
					observer.processLevel({ rms: 0.045 }); // delta = 0.039 > 0.008
					expect(triggerSpy).toHaveBeenCalledTimes(2); // Second onset cleanly triggered!
				});

				it("should reset envelope, previous RMS, and cooldown immediately on reset", () => {
					const observer = new AudioObserver({ refractoryPeriodMs: 300 });
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					observer.processLevel({ rms: 0.04 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);
					expect(observer.getMouthOpenY()).toBeGreaterThan(0);

					// Reset immediately (e.g. interruption or audio finish)
					observer.reset();
					expect(observer.getMouthOpenY()).toBe(0);

					// A new onset immediately after reset can trigger without waiting for the old cooldown
					observer.processLevel({ rms: 0.045 });
					expect(triggerSpy).toHaveBeenCalledTimes(2);
				});

				it("should detect multi-frame ramp speech onset via adaptive slow envelope tracking", () => {
					const observer = new AudioObserver();
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Frame 1: Resting low background (RMS 0.005)
					observer.processLevel({ rms: 0.005 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 2: Ramp starts rising (delta = 0.007, below single-frame threshold 0.008)
					observer.processLevel({ rms: 0.012 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 3: Ramp continues rising (deltaRms = 0.007 still below 0.008, but slow envelope
					// lags at ~0.0075 so deltaSlow ≈ 0.012 >= 0.008, and rms 0.019 > 0.018) -> triggers
					observer.processLevel({ rms: 0.019 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);
				});

				it("should suppress repeated trigger during sustained vowel when slow envelope adapts", () => {
					const observer = new AudioObserver({ refractoryPeriodMs: 100 }); // Short cooldown for testing
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Initial onset triggers
					observer.processLevel({ rms: 0.04 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);

					// Speaker sustains the exact same vowel (0.04) over multiple frames totaling 200ms
					for (let i = 0; i < 8; i++) {
						observer.tick(25);
						observer.processLevel({ rms: 0.04 });
					}

					// Cooldown has long expired (200ms > 100ms), but because slow envelope adapted to 0.04,
					// effectiveOnset is near 0 and no secondary false trigger occurs!
					expect(triggerSpy).toHaveBeenCalledTimes(1);
				});

				it("should accurately report isSpeaking status based on audio envelope and mouth opening", () => {
					const observer = new AudioObserver({ gain: 22.0 });
					expect(observer.isSpeaking()).toBe(false);

					// When speech level arrives
					observer.processLevel({ rms: 0.02 });
					expect(observer.isSpeaking()).toBe(true);

					// When reset
					observer.reset();
					expect(observer.isSpeaking()).toBe(false);
				});
			});

			describe("BodyDirector C1 Piecewise Velocity Limiter", () => {
				it("should permit unattenuated linear acceleration in low-to-medium velocity zone", () => {
					const director = new BodyDirector({ maxAngularSpeed: 140 });
					director.setTarget("ParamAngleZ", 5.0);

					// Step with 16ms (60Hz): small displacement has effectiveSpeed well within linear zone (<= 105 deg/s)
					director.tick(16);
					const p1 = director.getParam("ParamAngleZ");
					expect(p1).toBeGreaterThan(0);
					expect(p1).toBeLessThan(5.0);
				});

				it("should smoothly saturate excessive velocities and strictly bound them within maxAngularSpeed", () => {
					const director = new BodyDirector({ maxAngularSpeed: 140 });
					// Huge step change that demands massive initial velocity
					director.setTarget("ParamAngleZ", 30.0);

					// With 10ms step, candidate displacement is large, but effectiveSpeed must be capped <= 140 deg/s
					const frame = director.tick(10);
					// Max possible displacement in 10ms at 140 deg/s is 1.4 deg
					expect(frame.ParamAngleZ).toBeLessThanOrEqual(1.45);
					expect(frame.ParamAngleZ).toBeGreaterThan(0.1);
				});
			});

			describe("Passive Spine Kinematic Coupling (Relative Delta Follow-Through)", () => {
				it("should passively couple torso angle to head relative delta with natural inertia", () => {
					const composer = new MotionDirector();
					// Head rotates by 20 deg
					composer.bodyDirector.setTarget("ParamAngleZ", 20.0);

					// Run a few frames to let head move and body follow
					for (let i = 0; i < 15; i++) {
						composer.compose(20);
					}

					const headZ = composer.bodyDirector.getParam("ParamAngleZ");
					const bodyZ = composer.bodyDirector.getParam("ParamBodyAngleZ");
					expect(headZ).toBeGreaterThan(10.0);
					// Body Z target is 0.25 * headZ, and body should be positively moving in the same direction
					expect(bodyZ).toBeGreaterThan(1.0);
					expect(bodyZ).toBeLessThan(headZ);
				});

				it("should respect base pose offsets and follow delta rather than absolute angle", () => {
					const composer = new MotionDirector();
					// playful base pose has ParamAngleZ: 18.0
					composer.bodyDirector.applyBasePose("playful", 50);
					for (let i = 0; i < 10; i++) {
						composer.compose(20);
					}

					// When head is resting at base pose (18.0), delta is near 0, so torso is not falsely over-offset
					const baseBodyZ = composer.bodyDirector.getBasePoseTarget("ParamBodyAngleZ");
					const bodyZAtRest = composer.bodyDirector.getParam("ParamBodyAngleZ");
					expect(bodyZAtRest).toBeCloseTo(baseBodyZ, 0.5);

					// When head tilts further by +10 deg
					composer.bodyDirector.setTarget("ParamAngleZ", 28.0);
					for (let i = 0; i < 15; i++) {
						composer.compose(20);
					}
					const bodyZAfterTilt = composer.bodyDirector.getParam("ParamBodyAngleZ");
					expect(bodyZAfterTilt).toBeGreaterThan(bodyZAtRest);
				});

				it("should yield passive spine follow-through when body channel is locked by higher priority action", async () => {
					const arbiter = new MotionDirector();
					const composer = arbiter;

					// Lock torso channel with ACTION priority
					const lease = await arbiter.claim(["torso"], { priority: CHANNEL_PRIORITY.ACTION });

					// Head rotates by 25 deg
					composer.bodyDirector.setTarget("ParamAngleZ", 25.0);
					// Explicitly set body to -10 deg under action
					composer.bodyDirector.setTarget("ParamBodyAngleZ", -10.0);

					for (let i = 0; i < 10; i++) {
						composer.compose(20);
					}

					// Body should NOT be overwritten by positive head follow-through (0.25 * 25 = +6.25)
					expect(composer.bodyDirector.getParam("ParamBodyAngleZ")).toBeLessThan(0);

					lease.release();
				});
			});

			describe("VTSParameterRetargeter (Pure Functional Parameter Mapping & GC-Free Pool)", () => {
				it("should retarget angles and eyeball parameters accurately", () => {
					const retargeter = new VTSParameterRetargeter();
					const frame = {
						ParamAngleX: 15,
						ParamAngleY: -8,
						ParamAngleZ: 20,
						ParamEyeBallX: 0.5,
						ParamEyeBallY: -0.3,
					};
					const params = retargeter.retarget(frame);
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));

					expect(map.FaceAngleX).toBe(15);
					expect(map.FaceAngleY).toBe(-8);
					expect(map.FaceAngleZ).toBe(20);
					expect(map.EyeLeftX).toBe(0.5);
					expect(map.EyeRightX).toBe(0.5);
					expect(map.EyeLeftY).toBe(-0.3);
					expect(map.EyeRightY).toBe(-0.3);
				});

				it("should map torso angle to micro-displacement FacePosition", () => {
					const retargeter = new VTSParameterRetargeter();
					const frame = {
						ParamBodyAngleX: 16,
						ParamBodyAngleY: -12,
						ParamBodyAngleZ: 8,
					};
					const params = retargeter.retarget(frame);
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));

					expect(map.FacePositionX).toBeCloseTo(4.0, 2); // 16 * 0.25
					expect(map.FacePositionY).toBeCloseTo(-3.0, 2); // -12 * 0.25
					expect(map.FacePositionZ).toBeCloseTo(2.0, 2); // 8 * 0.25
				});

				it("should clamp extreme body angles in FacePosition to safe bounds [-10, 10]", () => {
					const retargeter = new VTSParameterRetargeter();
					const frame = { ParamBodyAngleX: 45 };
					const params = retargeter.retarget(frame);
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));

					expect(map.FacePositionX).toBe(10); // 45 * 0.25 = 11.25 -> clamped to 10
				});

				it("should fuse MouthSmile correctly for smiles and negative pout/frown", () => {
					const retargeter = new VTSParameterRetargeter();

					// Case 1: Pout/frown retains negative value
					const p1 = retargeter.retarget({ ParamMouthForm: -0.7, ParamEyeLSmile: 0.2 });
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.MouthSmile).toBe(-0.7);

					// Case 2: Positive smile takes max of mouth and eye smile
					const p2 = retargeter.retarget({ ParamMouthForm: 0.4, ParamEyeLSmile: 0.9 });
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.MouthSmile).toBe(0.9);
				});

				it("should inject breath heave into FacePositionY", () => {
					const retargeter = new VTSParameterRetargeter();
					// Breath at 1.0 (peak inhalation): offset = (1.0 - 0.5) * 0.7 = +0.35
					const p1 = retargeter.retarget({ ParamBreath: 1.0 });
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.FacePositionY).toBeCloseTo(0.35, 2);

					// Breath at 0.0 (exhalation): offset = (0 - 0.5) * 0.7 = -0.35
					const p2 = retargeter.retarget({ ParamBreath: 0.0 });
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.FacePositionY).toBeCloseTo(-0.35, 2);
				});

				it("should prioritize larger audio mouthOpen over resting mouth param", () => {
					const retargeter = new VTSParameterRetargeter();
					// Frame mouth is small (0.1), audio speech mouth is wide (0.8)
					const p1 = retargeter.retarget({ ParamMouthOpenY: 0.1 }, 0.8);
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.MouthOpen).toBe(0.8);

					// Audio mouth when frame doesn't contain ParamMouthOpenY
					const p2 = retargeter.retarget({}, 0.65);
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.MouthOpen).toBe(0.65);
				});
			});
		});
	});
});

describe("Live2DRuntime 姿态权威与 express 诚实性", () => {
	function createOfflineRuntime(): Live2DRuntime {
		// 未调用 start() 的真实 VTSClient 天然离线（ws 为 null），不需要伪造
		return new Live2DRuntime();
	}

	function fakeCtx(): ActionContext {
		return { signal: new AbortController().signal } as unknown as ActionContext;
	}

	it("express 未知字段显式失败并给出可用值，而非静默无操作谎报成功", async () => {
		const runtime = createOfflineRuntime();
		const res = (await runtime.executeExpress(
			{ beats: [{ head: "spin_like_crazy" }] },
			fakeCtx(),
		)) as ToolExecutionResult;
		const details = res.details as { reason?: string; effectStatus?: string };
		expect(res.status).toBe("failed");
		expect(details.reason).toBe("unknown_beat_field");
		expect(details.effectStatus).toBe("not_started");
		expect(res.result).toContain("tilt_left");
	});

	it("express 空节拍（缺少 head/gaze/face 任一内容）显式失败", async () => {
		const runtime = createOfflineRuntime();
		const res = (await runtime.executeExpress({ beats: [{}] }, fakeCtx())) as ToolExecutionResult;
		expect(res.status).toBe("failed");
		expect((res.details as { reason?: string }).reason).toBe("unknown_beat_field");
	});

	it("VTS 离线时 express 诚实返回 not_started，不谎报本地同步", async () => {
		const runtime = createOfflineRuntime();
		const res = (await runtime.executeExpress(
			{ beats: [{ head: "tilt_left", hold_ms: 200 }] },
			fakeCtx(),
		)) as ToolExecutionResult;
		const details = res.details as { reason?: string; effectStatus?: string };
		expect(res.status).toBe("failed");
		expect(details.reason).toBe("vts_offline");
		expect(details.effectStatus).toBe("not_started");
	});

	it("失焦停靠不改变用户姿态意图，回焦恢复并延续限时保持倒计时", async () => {
		const runtime = createOfflineRuntime();

		await runtime.executePose("playful", 5000, fakeCtx());
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.bodyDirector.getHoldRemainingMs()).toBe(5000);

		// 失焦：物理停靠到 relaxed，但权威姿态仍是用户选择的 playful
		runtime.endpoint.onFocus(false);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(-8.0);
		expect(runtime.formatStatus()).toContain("失焦停靠中");

		// 回焦：恢复 playful，且限时保持倒计时未被吞掉
		runtime.endpoint.onFocus(true);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(18.0);
		expect(runtime.director.bodyDirector.getHoldRemainingMs()).toBe(5000);
	});
});


