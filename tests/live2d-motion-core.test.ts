import { describe, expect, it, vi } from "vitest";
import { BodyDirector } from "../.uina/worlds/live2d/body-director.js";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { ReflexDirector } from "../.uina/worlds/live2d/reflex-director.js";
import {
	computeVORCompensation,
	getChannelsForBeats,
	resolveBeatToParams,
	resolveCueToBeat,
} from "../.uina/worlds/live2d/parameter-mapper.js";
import { PhysiologicalNoise } from "../.uina/worlds/live2d/physiological-noise.js";
import { AudioObserver } from "../.uina/worlds/live2d/audio-observer.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { ActionContext } from "../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../src/tools/broker.js";
import { CHANNEL_PRIORITY } from "../.uina/worlds/live2d/types.js";
import { VTSParameterRetargeter } from "../.uina/worlds/live2d/vts-retargeter.js";

describe("Live2D Phase 3: Motion Core & Channel Arbiter", () => {
	describe("MotionDirector", () => {
		it("should claim channels and release them cleanly (RAII)", async () => {
			const arbiter = new MotionDirector();
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);

			const lease = await arbiter.claim(["head", "gaze"]);
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);
			expect(arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.IDLE)).toBe(true);
			expect(arbiter.isChannelLocked("mouth", CHANNEL_PRIORITY.IDLE)).toBe(false);

			arbiter.release(lease);
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

		it("should allow degradation when requested channel is locked", async () => {
			const arbiter = new MotionDirector();
			await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.ACTION });

			// Request ["head", "gaze"] with allowDegrade
			const lease = await arbiter.claim(["head", "gaze"], {
				priority: CHANNEL_PRIORITY.REFLEX,
				allowDegrade: true,
			});

			expect(lease.channels).toEqual(["gaze"]);
			expect(arbiter.isChannelLocked("gaze", CHANNEL_PRIORITY.IDLE)).toBe(true);
			lease.release();
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
			expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
			expect(arbiter.isChannelLocked("mouth", CHANNEL_PRIORITY.IDLE)).toBe(false);
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

		it("should transition between active and relaxed poses via damped spring", () => {
			const director = new BodyDirector();
			director.applyBasePose("focused", 800);

			// Initial step
			const start = director.tick(100);
			expect(start.ParamEyeLOpen).toBeGreaterThan(0);

			// Step to 3100ms (ω=10 欠阻尼收敛：~1.8s 进入 ±0.05，3.1s 残余 <0.01)
			const end = director.tick(3000);
			expect(end.ParamEyeLOpen).toBeCloseTo(1.0, 1);
			expect(end.ParamBodyAngleY).toBeCloseTo(8.0, 1);
			expect(end.ParamAngleY).toBeCloseTo(12.0, 1);

			// 切换到 relaxed（失焦停靠的物理呈现由上层指定，本层只管姿态切换）
			director.applyBasePose("relaxed", 800);
			director.tick(3000);
			expect(director.getParam("ParamEyeLOpen")).toBeCloseTo(0.7, 1);
			expect(director.getParam("ParamBodyAngleY")).toBeCloseTo(-6.0, 1);
			expect(director.getParam("ParamAngleY")).toBeCloseTo(-10.0, 1);
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

			// Transition phase (弹簧落位 ~450ms @ ω×1.0)
			director.tick(800);
			// 落位后 living drift（目标 ±10%）开始调制；断言落在漂移带宽内而非精确值
			const z1 = director.getParam("ParamAngleZ");
			expect(z1).toBeGreaterThan(16);
			expect(z1).toBeLessThan(20);

			// Hold phase (2000ms)
			director.tick(2000);
			const z2 = director.getParam("ParamAngleZ");
			expect(z2).toBeGreaterThan(16);
			expect(z2).toBeLessThan(20);
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
				director.setTarget("ParamAngleY", -i * 0.5);
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
			director.setBasePoseTargets({ ParamAngleZ: 5.0, ParamBodyAngleX: 2.0 });
			director.tick(1500); // ω=10 下 95% 收敛 ~0.94s，1.5s 后残差 < ±0.05
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

			// Step to 500ms total: underdamped rebound creates positive overshoot
			// (ω=10 半周期 ~331ms，正峰在 ~3/4 周期 ≈ 500ms 处)
			const f2 = director.tick(450);
			expect(f2.ParamAngleY).toBeGreaterThan(0.2);

			// Step to 1500ms total: settles back to resting target (95% 收敛 ~0.94s)
			director.tick(1000);
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
			const targets = resolveBeatToParams(
				{
					head: "tilt_right",
					gaze: "side_peek",
					face: "shy",
				},
				0.8,
			);

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
			// 落位后再采样：18° 位移受速度封顶（MAX_PEAK_SPEED）约束，100ms 快切语义
			// 被压到 ~0.9s 收敛——封顶是全局物理上限，基准姿态大位移同样不猛冲
			director.tick(1400);

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

		it("fires occasional spring-carried idle posture shifts during prolonged silence with still windows between", () => {
			// 注入确定性随机（gap 恒 10s、bodyX、offset +8°、hold 2.3s）——时序可精确推演：
			// 事件在静默 14s（采样 5s 处）触发，弹簧滑入 ~0.8s + 保持 2.3s + 滑回 ~0.8s。
			// 必须设置基准姿态（实机形态）：头部/躯干参数的弹簧状态存在时被动脊柱
			// 耦合每帧运行——曾缺所有权守卫，把 idle 躯干 additive 目标逐帧拉回
			// 基准，实机换姿无效（range 2.4°）而本测试因形态盲区全绿
			const composer = new MotionDirector(() => 0.5);
			composer.bodyDirector.setBasePoseTargets({
				ParamAngleX: 0,
				ParamAngleY: -10,
				ParamAngleZ: -8,
				ParamBodyAngleX: 0,
				ParamBodyAngleY: -6,
				ParamBodyAngleZ: 0,
			});
			for (let i = 0; i < 150; i++) composer.compose(60); // 9s 静默：跨过 4s 阈值
			const xs: number[] = [];
			for (let i = 0; i < 200; i++) xs.push(composer.compose(60).ParamBodyAngleX!);
			// 事件性证据：12s 采样内既有含换姿的动作窗（+8° 弹簧滑入），也有纯 drift 静止窗
			let maxRange = 0;
			let minRange = Infinity;
			for (let start = 0; start + 33 <= xs.length; start++) {
				const w = xs.slice(start, start + 33);
				const range = Math.max(...w) - Math.min(...w);
				maxRange = Math.max(maxRange, range);
				minRange = Math.min(minRange, range);
			}
			expect(maxRange).toBeGreaterThan(3);
			expect(minRange).toBeLessThan(1);
			// 顺畅度证据：弹簧承载的逐帧变化有上界（峰值速度 ~28°/s → <2°/60ms），
			// 运动学脉冲/阶跃注入都会被此断言拒绝（"生硬"反馈的回归钉）
			let maxJump = 0;
			for (let i = 1; i < xs.length; i++) {
				maxJump = Math.max(maxJump, Math.abs(xs[i]! - xs[i - 1]!));
			}
			expect(maxJump).toBeLessThan(3);
		});

		it("yields the head-tilt idle shift while a reflex state pose occupies ParamAngleZ", () => {
			// thinking 反射把 ParamAngleZ 摆到 14° 且不占通道租约——idle 事件
			// 不得与之互踩：参数目标已有主动意图时歪头事件让位等待。
			// 证据口径用 target（噪声层 ±3° 头部分量会让合成值波动，不能作判据；
			// idle 若触发会把 target 从 14 改写为 base+offset=-3.1）
			const composer = new MotionDirector(() => 0.3); // 强制歪头分支（0.3 < 0.4）
			composer.bodyDirector.setBasePoseTargets({
				ParamAngleX: 0,
				ParamAngleY: -10,
				ParamAngleZ: -8,
				ParamBodyAngleX: 0,
				ParamBodyAngleY: -6,
				ParamBodyAngleZ: 0,
			});
			composer.showStatePose("thinking"); // ParamAngleZ → 14
			for (let i = 0; i < 150; i++) composer.compose(60);
			for (let i = 0; i < 200; i++) composer.compose(60);
			// 21s 静默期（远超 4s 阈值 + 6~14s 间隔）内 target 恒为反射值：idle 让位
			expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(14);
			// 反射清除后（目标回归基准）idle 恢复触发能力：target 被 idle 改写
			composer.clearStatePose();
			let fired = false;
			for (let i = 0; i < 250; i++) {
				composer.compose(60);
				const t = composer.bodyDirector.getParamTarget("ParamAngleZ");
				if (Math.abs(t - -8) > 2) fired = true; // -3.1 = base(-8) + offset(+4.9)
			}
			expect(fired).toBe(true);
		});

		it("keeps a mid-speech pause near-still instead of idling (×0.25 ruling)", () => {
			const composer = new MotionDirector();
			for (let i = 0; i < 10; i++) composer.compose(60, { speechEnergy: 0.5 });
			// 活动度按 250ms 半衰期衰减殆尽（1.8s），此时仍在 idle 阈值（4s）之前：
			// 语流停顿必须是"归于静止"，不能被 idle 地板顶起来继续晃。
			// 放宽到 1.5°：body-director 的 living-hold 呼吸漂移（±10%，2s 循环，
			// 既有特性）贡献 ~0.75°，本断言隔离的是 idle 层不得介入
			for (let i = 0; i < 30; i++) composer.compose(60);
			const xs: number[] = [];
			for (let i = 0; i < 16; i++) {
				xs.push(composer.compose(60).ParamBodyAngleX!);
			}
			expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.5);
		});

		it("crosses speech → idle → speech without amplitude pops", () => {
			const composer = new MotionDirector();
			let prev = composer.compose(60, { speechEnergy: 0.6 }).ParamBodyAngleX!;
			let maxJump = 0;
			for (let i = 0; i < 200; i++) {
				// 2s 说话 → 8s 长静默（idle 接管）→ 2s 说话，逐帧监测幅度跳变
				const energy = i < 33 ? 0.6 : i < 166 ? 0 : 0.6;
				const v = composer.compose(60, energy > 0 ? { speechEnergy: energy } : undefined).ParamBodyAngleX!;
				maxJump = Math.max(maxJump, Math.abs(v - prev));
				prev = v;
			}
			// 语流晃动的物理帧上界 ~1.8°/60ms；idle 切入/切出不得出现超出波形的阶跃
			expect(maxJump).toBeLessThan(3);
		});

		it("restarts the silence clock on abort so the body is still before idle sway ramps back", () => {
			// 确定随机 gap=13.2s。初始 gap 硬编码 6s 会让 12s 预热必含在途事件
			// （10s 触发），其急停收势回程会污染采样窗——先 abort 一次重排间隔，
			// 使预热与采样两个窗口都确定落在事件间隙内。
			// 注意：本测试在上一提交（110d18d）的 Math.random 版本下实为必红
			// （在途换姿回程 range ~9° >> 1.5°），当时"107 全绿"的门禁记录失实
			const composer = new MotionDirector(() => 0.9);
			composer.abortAllMotions(); // 重排事件间隔 → 13.2s
			for (let i = 0; i < 200; i++) composer.compose(60); // 12s 预热：无 idle 事件
			composer.abortAllMotions();
			// 急停后 2.4s 采样（< 4s 阈值，idle 必然未介入；窗口与停顿测试同量级
			// ——噪声层底色在 ~4s 满呼吸周期窗口 range 可达 2.4°，1.5° 阈值只对
			// 短窗口成立）
			const xs: number[] = [];
			for (let i = 0; i < 40; i++) {
				xs.push(composer.compose(60).ParamBodyAngleX!);
			}
			expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.5);
		});

		it("should trigger acoustic pulse on onset and exhibit dive-and-rebound envelope", () => {
			// 双实例同相位对比：PhysiologicalNoise 的呼吸联动对 ParamAngleY 有 ±1.5°
			// 确定性叠加，同 deltaMs 序列下两实例噪声完全相同——帧值差即纯脉冲贡献
			const baseline = new MotionDirector();
			const pulsed = new MotionDirector();
			pulsed.triggerAcousticImpulse(1.0);

			// 峰值在 t≈130ms（sin(π/2)），下潜幅度 -3.5×e^-1 ≈ -1.3
			const f1 = pulsed.compose(130);
			const b1 = baseline.compose(130);
			expect(f1.ParamAngleY! - b1.ParamAngleY!).toBeLessThan(-1.0); // Downward nod pulse

			// Advance past the 260ms pulse window: fully rebounded back to baseline
			const f2 = pulsed.compose(300);
			const b2 = baseline.compose(300);
			expect(f2.ParamAngleY! - b2.ParamAngleY!).toBeGreaterThan(-0.5);
		});

		it("should halve acoustic pulse when head channel is locked by cue instead of dropping it", async () => {
			// 同相位双实例对比，隔离噪声叠加（见上一用例注释）
			const arbiter = new MotionDirector();
			const composer = arbiter;
			const baseline = new MotionDirector();

			const lease = await arbiter.claim(["head"], { priority: CHANNEL_PRIORITY.CUE });
			composer.triggerAcousticImpulse(1.0);

			// Head locked: pulse is halved, not dropped——
			// 重音点头是语流的一部分，"说话+表情"并存时不应消失
			const lockedPeak = composer.compose(130);
			const lockedBase = baseline.compose(130);
			const lockedDelta = lockedPeak.ParamAngleY! - lockedBase.ParamAngleY!;
			expect(lockedDelta).toBeLessThan(0);

			lease.release();
			composer.triggerAcousticImpulse(1.0);
			const fullPeak = composer.compose(130);
			const fullBase = baseline.compose(130);
			const fullDelta = fullPeak.ParamAngleY! - fullBase.ParamAngleY!;

			// 同相位下确定性：锁定恰为全幅 ×0.5（gate 乘法），且全幅明显可读
			expect(lockedDelta).toBeCloseTo(fullDelta * 0.5, 5);
			expect(fullDelta).toBeLessThan(-2.0);
		});

		it("should play expressive beats sequentially and support abort", async () => {
			const composer = new MotionDirector();
			const controller = new AbortController();

			const playPromise = composer.playExpressiveBeats(
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
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);

				// 3. Releasing preempted lease is a safe no-op
				cueLease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(true);

				actionLease.release();
				expect(arbiter.isChannelLocked("head", CHANNEL_PRIORITY.IDLE)).toBe(false);
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
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(0);
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

			it("showStatePose 不写入已被占用通道的参数", async () => {
				const composer = new MotionDirector();
				const lease = await composer.claim(["head"], {
					priority: CHANNEL_PRIORITY.CUE,
					reason: "test:head-busy",
				});
				try {
					composer.showStatePose("thinking");
					// head 被 CUE 级占用：ParamAngleZ 不得被反射覆盖
					expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(0);
					// gaze 空闲：视线照常落下
					expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0.6);
					expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(-0.4);
				} finally {
					composer.release(lease);
				}
			});

			it("should protect ongoing expressive beats in ReflexDirector.onTurnEnd", async () => {
				const composer = new MotionDirector();
				const reflex = new ReflexDirector(composer, {
					getBasePose: () => "relaxed",
					activateBasePose: () => {},
				});

				// Set thinking pose
				reflex.onThinking();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(14.0);

				// Start playing expressive beats
				const beatsPromise = composer.playExpressiveBeats({
					beats: [{ head: "tilt_right", hold_ms: 500 }],
				});

				expect(composer.isPlayingExpressiveBeats()).toBe(true);

				// Turn end arrives while beats are playing
				reflex.onTurnEnd();

				// ParamAngleZ is active in the beat, so its target is preserved (-18 * 默认强度 1.0 = -18.0)
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBeCloseTo(-18.0, 1);

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

			it("should reset thinking pose targets when ReflexDirector.onSpeakingContent is invoked", () => {
				const composer = new MotionDirector();
				const reflex = new ReflexDirector(composer, {
					getBasePose: () => "relaxed",
					activateBasePose: () => {},
				});

				reflex.onThinking();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(14.0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0.6);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(-0.4);

				// When content speaking begins, thinking pose must be cleanly dampened back to neutral
				reflex.onSpeakingContent();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(0);
			});

			it("thinking -> content 的复位不截断正在播放的节拍", async () => {
				const composer = new MotionDirector();
				const reflex = new ReflexDirector(composer, {
					getBasePose: () => "relaxed",
					activateBasePose: () => {},
				});

				reflex.onThinking();
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBe(14.0);

				// 头部节拍开始播放：ParamAngleZ 归节拍持有（-18 × 默认强度 1.0）
				const beats = composer.playExpressiveBeats(
					{ beats: [{ head: "tilt_right", hold_ms: 600 }] },
					{ allowedChannels: ["head"] as const },
				);
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBeCloseTo(-18.0, 2);

				reflex.onSpeakingContent();

				// 节拍持有的 ParamAngleZ 不被拽回基准；反射自己占用的视线参数照常回归
				expect(composer.bodyDirector.getParamTarget("ParamAngleZ")).toBeCloseTo(-18.0, 2);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallY")).toBe(0);
				expect(composer.bodyDirector.getParamTarget("ParamEyeBallX")).toBe(0);

				await beats;
			});
		});

		// 注：cue 声明与解析的一致性守卫统一由 tests/live2d-affordance.test.ts 独家持有
		//（曾在此处维护重复副本，两处同步维护的冗余成本已在实践中兑现）。

		describe("Neuro-sama Dynamic Liveliness & Hardened Motion Mechanics", () => {
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

				it("should reset envelope, previous RMS, and cooldown immediately on reset", () => {
					const observer = new AudioObserver({ refractoryPeriodMs: 300 });
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					observer.processLevel({ rms: 0.004 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);
					expect(observer.getMouthOpenY()).toBeGreaterThan(0);

					// Reset immediately (e.g. interruption or audio finish)
					observer.reset();
					expect(observer.getMouthOpenY()).toBe(0);

					// A new onset immediately after reset can trigger without waiting for the old cooldown
					observer.processLevel({ rms: 0.0045 });
					expect(triggerSpy).toHaveBeenCalledTimes(2);
				});

				it("should detect multi-frame ramp speech onset via adaptive slow envelope tracking", () => {
					const observer = new AudioObserver();
					const composer = new MotionDirector();
					const triggerSpy = vi.spyOn(composer, "triggerAcousticImpulse");
					observer.setDirector(composer);

					// Frame 1: Resting low background (RMS 0.0005)
					observer.processLevel({ rms: 0.0005 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 2: Ramp starts rising (delta = 0.0007, below single-frame threshold 0.0008)
					observer.processLevel({ rms: 0.0012 });
					expect(triggerSpy).not.toHaveBeenCalled();

					// Frame 3: Ramp continues rising (deltaRms = 0.0007 still below 0.0008, but slow envelope
					// lags at ~0.00075 so deltaSlow ≈ 0.0012 >= 0.0008, and rms 0.0019 > 0.0018) -> triggers
					observer.processLevel({ rms: 0.0019 });
					expect(triggerSpy).toHaveBeenCalledTimes(1);
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
					// 30×20ms：头部落位后，被动耦合的躯干滞后量也收敛回基准附近
					for (let i = 0; i < 30; i++) {
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

				it("should map torso angle directly to same-named ParamBodyAngle parameters", () => {
					const retargeter = new VTSParameterRetargeter();
					const frame = {
						ParamBodyAngleX: 16,
						ParamBodyAngleY: -12,
						ParamBodyAngleZ: 8,
					};
					const params = retargeter.retarget(frame);
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));

					expect(map.ParamBodyAngleX).toBe(16);
					expect(map.ParamBodyAngleY).toBe(-12);
					expect(map.ParamBodyAngleZ).toBe(8);
					expect(map.FacePositionX).toBeUndefined();
					expect(map.FacePositionY).toBeUndefined();
					expect(map.FacePositionZ).toBeUndefined();
				});

				it("should clamp extreme body angles to safe bounds [-30, 30]", () => {
					const retargeter = new VTSParameterRetargeter();
					const frame = { ParamBodyAngleX: 45, ParamBodyAngleY: -40 };
					const params = retargeter.retarget(frame);
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));

					expect(map.ParamBodyAngleX).toBe(30);
					expect(map.ParamBodyAngleY).toBe(-30);
				});

				it("should route EyeSmile to same-named custom params and preserve MouthSmile from ParamMouthForm", () => {
					const retargeter = new VTSParameterRetargeter();

					// Case 1: Pout/frown retains negative value, ParamEyeLSmile routes to same-named custom
					// （VTS 内置清单无 EyeSmile 类输入——探针实锤；同名 custom 是唯一可达通道）
					const p1 = retargeter.retarget({ ParamMouthForm: -0.7, ParamEyeLSmile: 0.2 });
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.MouthSmile).toBe(-0.7);
					expect(m1.ParamEyeLSmile).toBe(0.2);

					// Case 2: Positive smile routes to MouthSmile and both eye-smile customs without cross-contamination
					const p2 = retargeter.retarget({ ParamMouthForm: 0.4, ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.85 });
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.MouthSmile).toBe(0.4);
					expect(m2.ParamEyeLSmile).toBe(0.9);
					expect(m2.ParamEyeRSmile).toBe(0.85);

					// Case 3: When ParamMouthForm is absent, EyeSmile links to MouthSmile to drive crescent eyes on VTS models
					const p3 = retargeter.retarget({ ParamEyeLSmile: 0.8, ParamEyeRSmile: 0.75 });
					const m3 = Object.fromEntries(p3.map((p) => [p.id, p.value]));
					expect(m3.MouthSmile).toBe(0.8);
					expect(m3.ParamEyeLSmile).toBe(0.8);
					expect(m3.ParamEyeRSmile).toBe(0.75);
				});

				it("should perform kinematic upper-body fusion into FaceAngleX/Y/Z when ParamBodyAngle is present", () => {
					const retargeter = new VTSParameterRetargeter();

					// Head + Torso yaw fusion
					const p1 = retargeter.retarget({ ParamAngleX: 10, ParamBodyAngleX: 8 });
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.FaceAngleX).toBe(16); // 10 + 8 * 0.75
					expect(m1.ParamBodyAngleX).toBe(8);

					// Forward lean pitch fusion into FaceAngleY with clamp [-20, 20]
					const p2 = retargeter.retarget({ ParamAngleY: 10, ParamBodyAngleY: 16 });
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.FaceAngleY).toBe(20); // 10 + 16 * 0.75 = 22 -> clamped to 20
					expect(m2.ParamBodyAngleY).toBe(16);

					// Side lean roll fusion into FaceAngleZ with clamp [-25, 25]
					const p3 = retargeter.retarget({ ParamAngleZ: 14, ParamBodyAngleZ: 6 });
					const m3 = Object.fromEntries(p3.map((p) => [p.id, p.value]));
					expect(m3.FaceAngleZ).toBe(18.5); // 14 + 6 * 0.75
					expect(m3.ParamBodyAngleZ).toBe(6);
				});

				it("should map ParamBreath to same-named custom param without elevator displacement", () => {
					const retargeter = new VTSParameterRetargeter();
					const p1 = retargeter.retarget({ ParamBreath: 1.0 });
					const m1 = Object.fromEntries(p1.map((p) => [p.id, p.value]));
					expect(m1.ParamBreath).toBe(1.0);
					expect(m1.FacePositionY).toBeUndefined();

					const p2 = retargeter.retarget({ ParamBreath: 0.2 });
					const m2 = Object.fromEntries(p2.map((p) => [p.id, p.value]));
					expect(m2.ParamBreath).toBe(0.2);
					expect(m2.FacePositionY).toBeUndefined();
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

				it("should average Brows symmetrically when both ParamBrowLY and ParamBrowRY are present", () => {
					const retargeter = new VTSParameterRetargeter();
					const params = retargeter.retarget({ ParamBrowLY: 0.4, ParamBrowRY: 0.8 });
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));
					expect(map.Brows).toBeCloseTo(0.6, 2);
					expect(map.BrowLeftY).toBe(0.4);
					expect(map.BrowRightY).toBe(0.8);
				});

				it("should map ParamCheek to CheekPuff, ParamCheek, Cheek, and Blush aliases", () => {
					const retargeter = new VTSParameterRetargeter();
					const params = retargeter.retarget({ ParamCheek: 0.85 });
					const map = Object.fromEntries(params.map((p) => [p.id, p.value]));
					expect(map.CheekPuff).toBe(0.85);
					expect(map.ParamCheek).toBe(0.85);
					expect(map.Cheek).toBe(0.85);
					expect(map.Blush).toBe(0.85);
				});

				it("should generate expressive eyebrows, eyelids, and eye smile for tender_smile, shy, and pout", () => {
					const smileTargets = resolveBeatToParams({ face: "tender_smile" });
					const smileMap = Object.fromEntries(smileTargets.map((t) => [t.name, t.value]));
					expect(smileMap.ParamEyeLSmile).toBeGreaterThan(0.5);
					expect(smileMap.ParamEyeRSmile).toBeGreaterThan(0.5);
					expect(smileMap.ParamBrowLY).toBeGreaterThan(0.1);
					expect(smileMap.ParamBrowRY).toBeGreaterThan(0.1);
					expect(smileMap.ParamEyeLOpen).toBeLessThan(1.0); // soft smiling eyelid

					const shyTargets = resolveBeatToParams({ face: "shy", intensity: 1.0 });
					const shyMap = Object.fromEntries(shyTargets.map((t) => [t.name, t.value]));
					expect(shyMap.ParamBrowLY).toBeLessThan(0); // troubled/shy inner brow tilt
					expect(shyMap.ParamEyeLOpen).toBeLessThan(0.85); // lowered shy eyes
					expect(shyMap.ParamCheek).toBeGreaterThan(0.8); // blush

					const poutTargets = resolveBeatToParams({ face: "pout" });
					const poutMap = Object.fromEntries(poutTargets.map((t) => [t.name, t.value]));
					expect(poutMap.ParamBrowLY).toBeLessThan(-0.3); // furrowed angry brows
					expect(poutMap.ParamMouthForm).toBeLessThan(-0.5); // pout mouth
				});
			});

			describe("Vestibulo-Ocular Reflex (VOR) & Gaze Locking", () => {
				it("should compute zero VOR compensation at neutral head angles", () => {
					const { vorX, vorY } = computeVORCompensation(0, 0, 0);
					expect(vorX).toBe(0);
					expect(vorY).toBe(0);
				});

				it("should compensate yaw counter-rotation and pitch nod accurately", () => {
					// Head turned right (X = 20): eye moves left (vorX < 0) to maintain eye contact
					const r1 = computeVORCompensation(20, 0, 0);
					expect(r1.vorX).toBeLessThan(0);
					expect(r1.vorY).toBe(0);

					// Head tilted down / nodding (Y = -15): eyes look up (vorY > 0)
					const r2 = computeVORCompensation(0, -15, 0);
					expect(r2.vorY).toBeGreaterThan(0);
				});

				it("should clamp VOR compensation to safe bounds [-0.6, 0.6]", () => {
					const extreme = computeVORCompensation(100, 100, 100);
					expect(extreme.vorX).toBe(-0.6);
					expect(extreme.vorY).toBe(-0.6);

					const extremeOpposite = computeVORCompensation(-100, -100, -100);
					expect(extremeOpposite.vorX).toBe(0.6);
					expect(extremeOpposite.vorY).toBe(0.6);
				});
			});

			describe("Refactored Cue Expression Parser (resolveCueToBeat)", () => {
				it("should parse canonical cues and aliases", () => {
					const b1 = resolveCueToBeat("warm_smile");
					expect(b1).toBeDefined();
					expect(b1![0]?.face).toBe("tender_smile");

					const b2 = resolveCueToBeat("smile");
					expect(b2).toBeDefined();
					expect(b2![0]?.face).toBe("tender_smile");

					const b3 = resolveCueToBeat("nod");
					expect(b3).toBeDefined();
					expect(b3![0]?.head).toBe("nod");
				});

				it("should parse colon modifiers for intensity and hold_ms", () => {
					// Intensity modifier: float <= 1.0
					const b1 = resolveCueToBeat("smile:0.8");
					expect(b1).toBeDefined();
					expect(b1![0]?.intensity).toBe(0.8);

					// Hold_ms modifier: integer >= 50
					const b2 = resolveCueToBeat("warm_smile:1500");
					expect(b2).toBeDefined();
					expect(b2![0]?.hold_ms).toBe(1500);

					// Compound modifier: intensity and hold_ms
					const b3 = resolveCueToBeat("curious_tilt:0.9:1200");
					expect(b3).toBeDefined();
					expect(b3![0]?.intensity).toBe(0.9);
					expect(b3![0]?.hold_ms).toBe(1200);
				});

				it("should parse atomic poses and shortcuts directly", () => {
					const b1 = resolveCueToBeat("tilt_left");
					expect(b1).toEqual([{ head: "tilt_left", gaze: "user", hold_ms: 1000 }]);

					const b2 = resolveCueToBeat("sparkle");
					expect(b2).toEqual([{ face: "sparkle", gaze: "user", hold_ms: 1000 }]);

					const b3 = resolveCueToBeat("side_peek");
					expect(b3).toEqual([{ gaze: "side_peek", hold_ms: 1000 }]);
				});

				it("should parse shorthand and compound multi-token expressions", () => {
					// Comma separated atomic shortcut: head + face
					const b1 = resolveCueToBeat("tilt_left, sparkle");
					expect(b1).toBeDefined();
					expect(b1![0]?.head).toBe("tilt_left");
					expect(b1![0]?.face).toBe("sparkle");
					expect(b1![0]?.gaze).toBe("user");

					// Comma separated shorthand: head + alias
					const b2 = resolveCueToBeat("tilt_left, smile");
					expect(b2).toBeDefined();
					expect(b2![0]?.head).toBe("tilt_left");
					expect(b2![0]?.face).toBe("tender_smile");

					// 回归钉：复合段第二项带冒号修饰（此前第二段被静默丢弃，只剩 head）
					const b4 = resolveCueToBeat("tilt_left, smile:0.8");
					expect(b4).toBeDefined();
					expect(b4![0]?.head).toBe("tilt_left");
					expect(b4![0]?.face).toBe("tender_smile");
					expect(b4![0]?.intensity).toBe(0.8);

					// Key-value syntax
					const b3 = resolveCueToBeat("head=tilt_right, face=smug, hold=1200, latch=true, intensity=0.75");
					expect(b3).toEqual([
						{
							head: "tilt_right",
							face: "smug",
							gaze: "user",
							hold_ms: 1200,
							latch: true,
							intensity: 0.75,
						},
					]);
				});

				it("should honor beat-level intensity in resolveBeatToParams", () => {
					const beatWithIntensity = { face: "tender_smile", intensity: 0.2 };
					const targets = resolveBeatToParams(beatWithIntensity, 0.9); // default 0.9 should be overridden by 0.2
					const cheek = targets.find((t) => t.name === "ParamCheek");
					expect(cheek).toBeDefined();
					// tender_smile ParamCheek mult is 0.4. With intensity 0.2 -> 0.08
					expect(cheek!.value).toBeCloseTo(0.08, 2);
				});

				it("should return null for unrecognized invalid cues", () => {
					expect(resolveCueToBeat("not_a_valid_expression_at_all")).toBeNull();
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
					arbiter.bodyDirector.setTarget("ParamAngleZ", 20);
					arbiter.bodyDirector.tick(300);

					// Compose frame
					const frame = arbiter.compose(50);
					// Because gaze is locked by CUE, VOR should NOT modify ParamEyeBallX
					expect(frame.ParamEyeBallX).toBe(0);

					arbiter.release(lease);
					// Now that lease is released, next compose should apply VOR
					const frameAfterRelease = arbiter.compose(50);
					expect(frameAfterRelease.ParamEyeBallX).not.toBe(0);
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

	it("失焦停靠不改变用户姿态意图，回焦恢复并冻结剩余限时", async () => {
		const runtime = createOfflineRuntime();

		await runtime.executePose("playful", 3000, fakeCtx());
		expect(runtime.currentBasePose).toBe("playful");

		// 推进物理时间：800ms 过渡完成后才开始消耗保持时长
		for (let i = 0; i < 20; i++) runtime.director.bodyDirector.tick(50);
		const remainingBeforePark = runtime.director.bodyDirector.getHoldRemainingMs();
		expect(remainingBeforePark).toBeDefined();
		expect(remainingBeforePark!).toBeLessThan(3000);

		// 失焦：物理停靠到 relaxed，但权威姿态仍是用户选择的 playful
		runtime.endpoint.onFocus(false);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(-8.0);
		expect(runtime.formatStatus()).toContain("失焦停靠中");

		// 停靠期间推进远超剩余保持时长：停靠姿态不携带倒计时，不得触发到期改写权威姿态
		for (let i = 0; i < 200; i++) runtime.director.bodyDirector.tick(50);
		expect(runtime.currentBasePose).toBe("playful");

		// 回焦：恢复 playful，剩余限时冻结保持（未被停靠期流逝消耗、也未被吞掉）
		runtime.endpoint.onFocus(true);
		expect(runtime.currentBasePose).toBe("playful");
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(18.0);
		expect(runtime.director.bodyDirector.getHoldRemainingMs()).toBe(remainingBeforePark);
	});

	it("停靠中经工具切换姿态只更新用户意图，物理仍呈现 relaxed", async () => {
		const runtime = createOfflineRuntime();
		runtime.endpoint.onFocus(false);

		await runtime.executePose("confident", 0, fakeCtx());
		expect(runtime.currentBasePose).toBe("confident");
		// 物理层仍是停靠的 relaxed，未被工具直接改写
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(-8.0);

		runtime.endpoint.onFocus(true);
		expect(runtime.director.bodyDirector.getBasePoseTarget("ParamAngleZ")).toBe(-4.0);
	});

	it("VTS 离线时 cue 不写可见凭据，也不做本地表演", () => {
		const runtime = createOfflineRuntime();
		runtime.endpoint.emitCue("warm_smile");
		expect(runtime.endpoint.lastCue).toBeUndefined();
		expect(runtime.formatStatus()).toContain("最近线索: 无");
	});

	it("Live2DEndpoint.supportsCue 准确判断合法与未知线索", () => {
		const runtime = createOfflineRuntime();
		expect(runtime.endpoint.supportsCue("sparkle")).toBe(true);
		expect(runtime.endpoint.supportsCue("warm_smile")).toBe(true);
		expect(runtime.endpoint.supportsCue("smile:0.8")).toBe(true);
		expect(runtime.endpoint.supportsCue("tilt_left,smile")).toBe(true);
		expect(runtime.endpoint.supportsCue("head=tilt_left,face=smug")).toBe(true);
		expect(runtime.endpoint.supportsCue("completely_invalid_garbage_cue")).toBe(false);
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

		// 1. 未启动时 environment 给出未就绪提示，status 动作报错
		expect(app.environment).toContain("未就绪");
		const failedCheck = await app.actions.status.run({}, fakeCtx());
		expect(failedCheck).toHaveProperty("status", "failed");

		// 2. 启动后 environment 动态返回完整 formatStatus
		await app.onStart?.(fakeServiceCtx as never);
		expect(app.environment).toContain("[live2d]");
		expect(app.environment).toContain("物理状态: 离线(VTS)");
		expect(app.environment).toContain("口型通道: 已接线");
		expect(app.environment).toContain("姿态: relaxed");

		// 3. live2d 工具 status 动作成功执行并返回 formatStatus
		const actionResult = await app.actions.status.run({}, fakeCtx());
		expect(typeof actionResult).toBe("object");
		expect(actionResult.result).toContain("[live2d]");
		expect(actionResult.result).toContain("口型通道:");

		// 4. body 工具 status 动作附带 endpoint.formatStatus()
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
