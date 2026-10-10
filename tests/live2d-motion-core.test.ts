import { compileExpression } from "../.uina/worlds/live2d/motion-library.js";
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
import { describe, expect, it, vi } from "vitest";
import { BASE_POSES } from "../.uina/worlds/live2d/motion-library.js";
import { BodyDirector } from "../.uina/worlds/live2d/body-director.js";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { ReflexDirector } from "../.uina/worlds/live2d/reflex-director.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { AudioObserver } from "../.uina/worlds/live2d/audio-observer.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { ActionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import { CHANNEL_PRIORITY } from "../.uina/worlds/live2d/types.js";

describe("Live2D motion contracts", () => {
	describe("MotionDirector", () => {
		it("should claim channels and release them cleanly (RAII)", async () => {
			const arbiter = new MotionDirector();
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);

			const lease = await arbiter.claim(["head", "gaze"]);
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);
			expect(arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.IDLE)).toBe(true);
			expect(arbiter.isChannelLocked("mouth", CHANNEL_PRIORITY.IDLE)).toBe(false);

			lease.release();
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
			expect(arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.IDLE)).toBe(false);
		});

		it("should reject lower or equal priority claims when channel is locked", async () => {
			const arbiter = new MotionDirector();
			await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION, reason: "task1" });

			// Lower priority rejected
			await expect(arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.REFLEX })).rejects.toThrow(
				/locked by active task/,
			);

			// Equal priority also rejected (no silent preemption)
			await expect(arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION, reason: "task2" })).rejects.toThrow(
				/locked by active task/,
			);
		});

		it("rejects a conflicting claim without acquiring its free channels", async () => {
			const arbiter = new MotionDirector();
			const occupied = await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });

			await expect(
				arbiter.claim(["gaze", "head"], {
					priority: CHANNEL_PRIORITY.REFLEX,
				}),
			).rejects.toThrow("locked");

			expect(arbiter.getActiveLeases()).toEqual([occupied]);
			expect(arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.IDLE)).toBe(false);
			occupied.release();
		});

		it("should auto-release lease on abort signal", async () => {
			const arbiter = new MotionDirector();
			const controller = new AbortController();

			await arbiter.claim(["torso"], { signal: controller.signal });
			expect(arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.IDLE)).toBe(true);

			controller.abort();
			expect(arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.IDLE)).toBe(false);
		});

		it("should dispatch cues to registered dispatcher", () => {
			const arbiter = new MotionDirector();
			const received: string[] = [];
			arbiter.setCueDispatcher((cueId) => received.push(cueId));

			arbiter.dispatchCue("smile");
			expect(received).toEqual(["smile"]);
		});

		it("should query active leases and force release all channels", async () => {
			const arbiter = new MotionDirector();
			const lease1 = await arbiter.claim(["head"]);
			const lease2 = await arbiter.claim(["mouth"]);

			const active = arbiter.getActiveLeases();
			expect(active.length).toBe(2);
			expect(active).toContain(lease1);
			expect(active).toContain(lease2);

			arbiter.abortAllMotions();
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
			expect(arbiter.isChannelLocked("mouth", CHANNEL_PRIORITY.IDLE)).toBe(false);
			expect(arbiter.getActiveLeases().length).toBe(0);
		});
	});

	describe("PhysiologicalNoise (Layer 0)", () => {
		it("should produce periodic breathing and body drift", () => {
			const noise = new PhysiologicalNoise();

			const t0 = noise.tick(0);
			expect(t0["torso.breath"]).toBeGreaterThanOrEqual(0);
			expect(t0["torso.breath"]).toBeLessThanOrEqual(1);

			// Advance by 900ms (1/4 of 3.6s breath cycle)
			const t1 = noise.tick(900);
			expect(t1["torso.breath"]).toBeGreaterThanOrEqual(0);
			expect(t1["torso.breath"]).toBeLessThanOrEqual(1);
			expect(t1["torso.yaw"]).toBeDefined();
			expect(t1["head.roll"]).toBeDefined();
		});

		it("should produce random blinks and micro-saccades", () => {
			const noise = new PhysiologicalNoise();
			let blinked = false;

			// Advance through 6 seconds to trigger at least one blink
			for (let i = 0; i < 300; i++) {
				const frame = noise.tick(20);
				if (frame["eyes.left.open"] < 0.9) {
					blinked = true;
				}
				expect(Math.abs(frame["gaze.x"])).toBeLessThanOrEqual(0.25);
			}

			expect(blinked).toBe(true);
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
		it("should track targets with continuous critically damped motion and clamp angular speed", () => {
			const director = new BodyDirector({ maxAngularSpeed: 17 });
			director.setTarget("head.pitch", 15);

			// Step 50ms
			const frame = director.tick(50);
			// In 50ms (0.05s) at max 17 deg/s, angle change cannot exceed ~0.85 deg
			expect(frame["head.pitch"]).toBeLessThanOrEqual(1.0);
			expect(frame["head.pitch"]).toBeGreaterThan(0);
		});

		it("should remain unconditionally stable under massive deltaMs (analytical spring)", () => {
			const director = new BodyDirector();
			director.setTarget("head.pitch", 10);

			// 模拟 1000ms 大卡顿步长
			const frame = director.tick(1000);
			// 三重实极点解析响应稳定收敛，不随大 dt 发散
			expect(frame["head.pitch"]).toBeGreaterThan(5);
			expect(frame["head.pitch"]).toBeLessThan(15);
		});
	});

	describe("MotionDirector composition", () => {
		it("should compose Layer 0 (Noise) + Layer 2 (Spring) within safety clamps", () => {
			const composer = new MotionDirector();
			composer.applyBasePose("confident");

			const frame = composer.compose(50);
			expect(frame["head.yaw"]).toBeGreaterThanOrEqual(-30);
			expect(frame["head.yaw"]).toBeLessThanOrEqual(30);
			expect(frame["torso.breath"]).toBeGreaterThanOrEqual(0);
			expect(frame["torso.breath"]).toBeLessThanOrEqual(1);
			expect(frame["eyes.left.open"]).toBeGreaterThanOrEqual(0);
			expect(frame["eyes.left.open"]).toBeLessThanOrEqual(2);
		});

		it("random idle remains visibly playful with eased entry and exit, without sudden kicks", () => {
			const composer = new MotionDirector(() => 0.5);
			composer.applyBasePose("relaxed");
			composer.compose(3000);
			const values = Array.from({ length: 3600 }, () => composer.compose(1000 / 60)["head.roll"]!);
			expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(4);
			for (let i = 1; i < values.length; i++) expect(Math.abs(values[i]! - values[i - 1]!)).toBeLessThan(0.2);
		});

		it("keeps a mid-speech pause near-still instead of idling (×0.25 ruling)", () => {
			const composer = new MotionDirector();
			for (let i = 0; i < 10; i++) composer.compose(60, { speechEnergy: 0.5 });
			// 活动度按 250ms 半衰期衰减殆尽（1.8s），此时仍在 idle 阈值（4s）之前：
			// 语流停顿必须是"归于静止"，不能被 idle 地板顶起来继续晃。
			// 放宽到 1.5°：body-director 的 呼吸与姿态漂移贡献微小残余，本断言隔离的是 idle 层不得介入
			for (let i = 0; i < 30; i++) composer.compose(60);
			const xs: number[] = [];
			for (let i = 0; i < 16; i++) {
				xs.push(composer.compose(60)["torso.yaw"]!);
			}
			expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.5);
		});

		it("crosses speech → idle → speech without amplitude pops", () => {
			const composer = new MotionDirector();
			let prev = composer.compose(60, { speechEnergy: 0.6 })["torso.yaw"]!;
			let maxJump = 0;
			for (let i = 0; i < 200; i++) {
				// 2s 说话 → 8s 长静默（idle 接管）→ 2s 说话，逐帧监测幅度跳变
				const energy = i < 33 ? 0.6 : i < 166 ? 0 : 0.6;
				const v = composer.compose(60, energy > 0 ? { speechEnergy: energy } : undefined)["torso.yaw"]!;
				maxJump = Math.max(maxJump, Math.abs(v - prev));
				prev = v;
			}
			// 语流晃动的物理帧上界 ~1.8°/60ms；idle 切入/切出不得出现超出波形的阶跃
			expect(maxJump).toBeLessThan(3);
		});

		it("should play expressive beats sequentially and support abort", async () => {
			const composer = new MotionDirector();
			const controller = new AbortController();

			const playPromise = playExpression(
				composer,
				{
					beats: [
						{ head: "tilt_left", hold_ms: 200 },
						{ head: "tilt_right", hold_ms: 200 },
					],
				},
				{ signal: controller.signal },
			);

			// Abort after 50ms
			setTimeout(() => controller.abort(), 50);
			await playPromise;

			// Check that abort finished cleanly without hanging
			expect(controller.signal.aborted).toBe(true);
		});

		it("should suppress physiological noise on channels locked by action", async () => {
			const arbiter = new MotionDirector();
			const composer = arbiter;

			// Lock 'head' channel with ACTION priority
			const lease = await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });

			// With lock, Layer 0 noise on head (ParamAngleZ) is suppressed to 0
			const frame = composer.compose(100);
			expect(frame["head.roll"]).toBe(0);

			lease.release();
			const frameAfterRelease = composer.compose(100);
			expect(frameAfterRelease["head.roll"]).not.toBe(0);
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
			const bodyXValues = frames.map((f) => f["torso.yaw"]);
			const minX = Math.min(...bodyXValues);
			const maxX = Math.max(...bodyXValues);
			expect(maxX - minX).toBeGreaterThan(0.5); // Quiet speech movement is still observable

			const bodyYValues = frames.map((f) => f["torso.pitch"]);
			const minY = Math.min(...bodyYValues);
			const maxY = Math.max(...bodyYValues);
			expect(maxY - minY).toBeGreaterThan(0.3); // Quiet pitch movement is still observable
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
				expect(f["torso.yaw"] ?? 0).toBe(0);
				expect(f["torso.pitch"] ?? 0).toBe(0);
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

	describe("Adversarial Fixes & Hardening", () => {
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
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);

				// 3. Releasing preempted lease is a safe no-op
				cueLease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);

				actionLease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
			});

			it("should abort all active leases when abortAllMotions is called", async () => {
				const arbiter = new MotionDirector();
				const lease1 = await arbiter.claim(["head"]);
				const lease2 = await arbiter.claim(["mouth"]);

				expect(lease1.signal?.aborted).toBe(false);
				expect(lease2.signal?.aborted).toBe(false);

				arbiter.abortAllMotions();

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
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);

				cue2Lease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
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
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);
				expect(arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.IDLE)).toBe(true);

				// 2. Higher priority preemption only claims 'head'
				const emergencyLease = await arbiter.claim(["head"], {
					priority: CHANNEL_PRIORITY.EMERGENCY,
					reason: "emergency_look",
				});

				// Because atomic was true, the entire atomicLease is aborted and released
				expect(atomicLease.signal?.aborted).toBe(true);
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);
				// torso was released because atomic lease was completely aborted
				expect(arbiter.isChannelLocked("torso", CHANNEL_PRIORITY.IDLE)).toBe(false);

				emergencyLease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
			});
		});

		describe("Reflex host intent", () => {
			it("onTurnStart 经注入的宿主权威入口唤醒姿态，不再直改物理层", () => {
				const composer = new MotionDirector();
				const activated: string[] = [];
				const reflex = new ReflexDirector(composer, {
					getBasePose: () => "playful",
					activateBasePose: (pose) => activated.push(pose),
				});

				reflex.onTurnStart();
				expect(activated).toEqual(["playful"]);
				// 物理层未被反射直接改写：姿态落点只能来自宿主入口
				expect(composer.getParamTarget("head.roll")).toBe(0);
			});

			it("失焦停靠中 onTurnStart 不唤醒姿态", () => {
				const composer = new MotionDirector();
				const activated: string[] = [];
				const reflex = new ReflexDirector(composer, {
					getBasePose: () => "playful",
					isPoseParked: () => true,
					activateBasePose: (pose) => activated.push(pose),
				});

				reflex.onTurnStart();
				expect(activated).toEqual([]);
			});
		});

		// 注：cue 声明与解析的一致性守卫统一由 tests/live2d-affordance.test.ts 独家持有
		//（曾在此处维护重复副本，两处同步维护的冗余成本已在实践中兑现）。

		describe("Motion dynamics", () => {
			describe("AudioObserver (Speech Onset Cadence & Refractory Period)", () => {
				// 测试统一使用生产默认参数域（2026-10-02 重标）：TTS 桥侧语音 RMS ≈ 0.0005~0.005，
				// 阈值 0.0018 / 起振差 0.0008。不再用 0.008~0.04 的旧假设域自欺。
				it("should trigger acoustic impulse on speech onset spike and suppress jitter during refractory period", () => {
					const observer = new AudioObserver();
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Frame 1: Low background noise (RMS 0.0006 < 0.0018) -> No trigger
					observer.processLevel({ rms: 0.0006 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 2: Loud speech onset (RMS 0.004, delta = 0.0034 > 0.0008) -> Triggers impulse!
					observer.processLevel({ rms: 0.004 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);

					// Frame 3-5: Sustained loud vowel over next 150ms (RMS remains 0.004) -> Cooldown suppresses repeated impulses!
					observer.tick(50);
					observer.processLevel({ rms: 0.004 });
					observer.tick(50);
					observer.processLevel({ rms: 0.004 });
					observer.tick(50);
					observer.processLevel({ rms: 0.004 });
					expect(triggerSpy).toHaveBeenCalledTimes(1); // Still 1! No continuous jitter or bobblehead nodding!

					// Advance past 220ms refractory period (remaining: 220 - 150 = 70ms; advance 100ms)
					observer.tick(100);
					// Now a dip followed by next syllable onset
					observer.processLevel({ rms: 0.0006 });
					observer.processLevel({ rms: 0.0045 }); // delta = 0.0039 > 0.0008
					expect(triggerSpy).toHaveBeenCalledTimes(2); // Second onset cleanly triggered!
				});

				it("should suppress repeated trigger during sustained vowel when slow envelope adapts", () => {
					const observer = new AudioObserver({ refractoryPeriodMs: 100 }); // Short cooldown for testing
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Initial onset triggers
					observer.processLevel({ rms: 0.004 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);

					// Speaker sustains the exact same vowel (0.004) over multiple frames totaling 200ms
					for (let i = 0; i < 8; i++) {
						observer.tick(25);
						observer.processLevel({ rms: 0.004 });
					}

					// Cooldown has long expired (200ms > 100ms), but because slow envelope adapted to 0.004,
					// effectiveOnset is near 0 and no secondary false trigger occurs!
					expect(triggerSpy).toHaveBeenCalledTimes(1);
				});
			});

			describe("BodyDirector C1 Piecewise Velocity Limiter", () => {
				it("should permit unattenuated linear acceleration in low-to-medium velocity zone", () => {
					const director = new BodyDirector({ maxAngularSpeed: 140 });
					director.setTarget("head.roll", 5.0);

					// Step with 16ms (60Hz): small displacement has effectiveSpeed well within linear zone (<= 105 deg/s)
					director.tick(16);
					const p1 = director.getParam("head.roll");
					expect(p1).toBeGreaterThan(0);
					expect(p1).toBeLessThan(5.0);
				});

				it("should smoothly saturate excessive velocities and strictly bound them within maxAngularSpeed", () => {
					const director = new BodyDirector({ maxAngularSpeed: 140 });
					// Huge step change that demands massive initial velocity
					director.setTarget("head.roll", 30.0);

					// With 10ms step, candidate displacement is large, but effectiveSpeed must be capped <= 140 deg/s
					const frame = director.tick(10);
					// Max possible displacement in 10ms at 140 deg/s is 1.4 deg
					expect(frame["head.roll"]).toBeLessThanOrEqual(1.45);
					expect(frame["head.roll"]).toBeGreaterThan(0);
				});
			});

			describe("Channel Arbiter & VOR Interaction in Compose", () => {
				it("should not apply VOR when gaze channel is claimed by a CUE lease", async () => {
					const arbiter = new MotionDirector();
					// Claim gaze with CUE priority (simulating look_away or shy gaze gesture)
					const lease = await arbiter.claim(["gaze"], {
						priority: CHANNEL_PRIORITY.CUE,
						reason: "action:cue:look_away",
					});

					// Transition head to tilt_right (ParamAngleZ = 20)
					arbiter.applyBasePose("confident");
					arbiter.compose(300);

					// Compose frame
					const frame = arbiter.compose(50);
					// Because gaze is locked by CUE, VOR should NOT modify ParamEyeBallX
					expect(frame["gaze.x"]).toBe(0);

					lease.release();
					// Now that lease is released, next compose should apply VOR
					const frameAfterRelease = arbiter.compose(50);
					expect(frameAfterRelease["gaze.x"]).not.toBe(0);
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

	it('姿态名 cue 直接切换基准姿态（<cue id="focused"/> ≙ pose 工具）', async () => {
		const runtime = createOfflineRuntime();
		expect(runtime.currentBasePose).toBe("relaxed");
		runtime.director.dispatchCue("focused");
		await Promise.resolve();
		expect(runtime.currentBasePose).toBe("focused");
		// 非 cue 名的未知姿态不误切
		runtime.director.dispatchCue("not_a_pose");
		await Promise.resolve();
		expect(runtime.currentBasePose).toBe("focused");
	});

	it("express 未知字段显式失败并给出可用值，而非静默无操作谎报成功", async () => {
		const runtime = createOfflineRuntime();
		const res = (await runtime.executeExpress(
			{ beats: [{ head: "spin_like_crazy" }] },
			fakeCtx(),
		)) as ToolExecutionResult;
		const details = res.details as { reason?: string; effectStatus?: string };
		expect(res.status).toBe("failed");
		expect(details.reason).toBe("invalid_motion");
		expect(details.effectStatus).toBe("not_started");
		expect(res.result).toContain("spin_like_crazy");
	});

	it("express 空节拍（缺少 head/gaze/face 任一内容）显式失败", async () => {
		const runtime = createOfflineRuntime();
		const res = (await runtime.executeExpress({ beats: [{}] }, fakeCtx())) as ToolExecutionResult;
		expect(res.status).toBe("failed");
		expect((res.details as { reason?: string }).reason).toBe("invalid_motion");
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

	it("失焦停靠不改变用户姿态意图，回焦恢复并冻结剩余限时", async () => {
		const runtime = createOfflineRuntime();

		await runtime.executePose("playful", 3000, fakeCtx());
		expect(runtime.currentBasePose).toBe("playful");

		// 推进物理时间：姿态限时从设置时开始推进
		for (let i = 0; i < 20; i++) runtime.director.compose(50);
		const remainingBeforePark = runtime.director.getHoldRemainingMs();
		expect(remainingBeforePark).toBeDefined();
		expect(remainingBeforePark!).toBeLessThan(3000);

		// 失焦：物理停靠到 relaxed，但权威姿态仍是用户选择的 playful
		runtime.endpoint.onFocus(false);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.getBasePoseTarget("head.roll")).toBe(BASE_POSES.relaxed["head.roll"]);
		expect(runtime.formatStatus()).toContain("失焦停靠中");

		// 停靠期间推进远超剩余保持时长：停靠姿态不携带倒计时，不得触发到期改写权威姿态
		for (let i = 0; i < 200; i++) runtime.director.compose(50);
		expect(runtime.currentBasePose).toBe("playful");

		// 回焦：恢复 playful，剩余限时冻结保持（未被停靠期流逝消耗、也未被吞掉）
		runtime.endpoint.onFocus(true);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.getBasePoseTarget("head.roll")).toBe(BASE_POSES.playful["head.roll"]);
		expect(runtime.director.getHoldRemainingMs()).toBe(remainingBeforePark);
	});

	it("停靠中经工具切换姿态只更新用户意图，物理仍呈现 relaxed", async () => {
		const runtime = createOfflineRuntime();
		runtime.endpoint.onFocus(false);

		await runtime.executePose("confident", 0, fakeCtx());
		expect(runtime.currentBasePose).toBe("confident");
		// 物理层仍是停靠的 relaxed，未被工具直接改写
		expect(runtime.director.getBasePoseTarget("head.roll")).toBe(BASE_POSES.relaxed["head.roll"]);

		runtime.endpoint.onFocus(true);
		expect(runtime.director.getBasePoseTarget("head.roll")).toBe(BASE_POSES.confident["head.roll"]);
	});

	it("VTS 离线时 cue 不写可见凭据，也不做本地表演", () => {
		const runtime = createOfflineRuntime();
		runtime.endpoint.emitCue("smile");
		expect(runtime.endpoint.lastCue).toBeUndefined();
		expect(runtime.formatStatus()).toContain("最近接收线索: 无");
	});

	it("Live2DEndpoint.supportsCue 准确判断合法与未知线索", () => {
		const runtime = createOfflineRuntime();
		expect(runtime.endpoint.supportsCue("surprise")).toBe(false);
		expect(runtime.endpoint.supportsCue("smile")).toBe(false);
		expect(runtime.endpoint.supportsCue("smile:0.8")).toBe(false);
		expect(runtime.endpoint.supportsCue("tilt_left,smile")).toBe(false);
		expect(runtime.endpoint.supportsCue("head=tilt_left,face=smug")).toBe(false);
		// 姿态名即 cue：与 BASE_POSE_NAMES 同源，必须被 supportsCue 认可
		expect(runtime.endpoint.supportsCue("focused")).toBe(true);
		expect(runtime.endpoint.supportsCue("smug_gremlin")).toBe(true);
		expect(runtime.endpoint.supportsCue("completely_invalid_garbage_cue")).toBe(false);
	});

	it("VTS 离线时姿态名 cue 仍生效（本地意图），瞬态 cue 被拦截", () => {
		const runtime = createOfflineRuntime();

		// 姿态名是本地基准姿态意图，离线与 pose 工具同口径：写入凭据并落到权威写入口
		runtime.endpoint.emitCue("focused");
		expect(runtime.endpoint.lastCue?.id).toBe("focused");
		expect(runtime.currentBasePose).toBe("focused");

		// 瞬态 cue 离线无凭据、无表演
		runtime.endpoint.emitCue("smile");
		expect(runtime.endpoint.lastCue?.id).toBe("focused");
	});

	it("Live2DEndpoint.formatStatus 成功接通 runtime.formatStatus，live2d 与 body 工具均可查询即时状态", async () => {
		const { createLive2DApp } = await import("../.uina/worlds/live2d/index.js");
		const { BodyRouter } = await import("../.uina/extensions/embodiment/body-router.js");
		const { createBodyTool } = await import("../.uina/extensions/embodiment/tools.js");

		const app = createLive2DApp();
		const fakeServiceCtx = {
			signal: new AbortController().signal,
			expose: vi.fn(),
		};

		// 1. 未启动时 status 动作报错
		const failedCheck = await app.actions.status.run({}, fakeCtx());
		expect(failedCheck).toHaveProperty("status", "failed");

		// 2. 启动后 live2d 工具 status 动作成功执行并返回完整 formatStatus
		await app.onStart?.(fakeServiceCtx as never);
		const actionResult = await app.actions.status.run({}, fakeCtx());
		expect(typeof actionResult).toBe("object");
		expect(actionResult.result).toContain("[live2d]");
		expect(actionResult.result).toContain("口型通道:");

		// 3. body 工具 status 动作附带 endpoint.formatStatus()
		const router = new BodyRouter();
		const runtime = createOfflineRuntime();
		router.registerEndpoint(runtime.endpoint);
		const bodyTool = createBodyTool(router);
		const bodyStatusResult = await bodyTool.run({ action: "status" });
		expect(bodyStatusResult.status).toBe("succeeded");
		expect(bodyStatusResult.result).toContain("[live2d]");
		expect(bodyStatusResult.result).toContain("口型通道:");

		await app.onStop?.(fakeServiceCtx as never);
	});
});
