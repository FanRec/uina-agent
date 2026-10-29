import { describe, expect, it } from "vitest";
import type { RigControlDef } from "../.uina/worlds/live2d/adapter/rig.js";
import { absolute, compileAction, keys, motion } from "../.uina/worlds/live2d/authoring/index.js";
import { AutonomicGenerator } from "../.uina/worlds/live2d/director/autonomic.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";

const step = <T extends { step(dtMs: number): unknown }>(g: T, ms: number, dt = 16): void => {
	for (let elapsed = 0; elapsed < ms; elapsed += dt) g.step(Math.min(dt, ms - elapsed));
};

/** 固定序列 RNG：依次返回给定值，耗尽后重复最后一个。 */
const seqRng = (...values: number[]): (() => number) => {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)]!;
};

describe("live2d 自律发生器（P2-2）", () => {
	it("A9 固定 RNG：眨眼时序确定（冷却 2000 + 均值 1500 指数延迟）", () => {
		// rng=0.5 → delay = -1500·ln(0.5) ≈ 1039.7ms；首次眨眼于 3039.7ms。
		const g = new AutonomicGenerator({ rng: () => 0.5 });
		step(g, 3039);
		expect(g.step(1).blinkFactor).toBe(1); // 触发步：转入 closing 并返回 1
		let minFactor = 1;
		for (let i = 0; i < 20; i++) minFactor = Math.min(minFactor, g.step(5).blinkFactor);
		expect(minFactor).toBe(0); // 闭眼 60ms 内触及全闭
		let maxAfter = 0;
		for (let i = 0; i < 40; i++) maxAfter = Math.max(maxAfter, g.step(5).blinkFactor);
		expect(maxAfter).toBe(1); // 睁眼 120ms 内恢复全开

		// 确定性：同 RNG 的两个发生器因子轨迹逐点一致（A9）。
		const trace = (gen: AutonomicGenerator): number[] => {
			const out: number[] = [];
			for (let i = 0; i < 400; i++) out.push(gen.step(16).blinkFactor);
			return out;
		};
		expect(trace(new AutonomicGenerator({ rng: seqRng(0.5, 0.3, 0.7) }))).toEqual(
			trace(new AutonomicGenerator({ rng: seqRng(0.5, 0.3, 0.7) })),
		);
	});

	it("唯一主来源：breath=vts 时呼吸静默；none 时正弦驱动", () => {
		const silent = new AutonomicGenerator({ rng: () => 0.5 });
		silent.setExternal({ blink: "uina", breath: "vts" });
		for (let i = 0; i < 300; i++) expect(silent.step(16).deltas["torso.breath"]).toBeUndefined();

		const driven = new AutonomicGenerator({ rng: () => 0.5, breath: { amplitude: 0.08 } });
		driven.setExternal({ blink: "uina", breath: "none" });
		let peak = 0;
		for (let i = 0; i < 400; i++) peak = Math.max(peak, Math.abs(driven.step(16).deltas["torso.breath"] ?? 0));
		expect(peak).toBeGreaterThan(0.07); // 正弦峰值接近幅度
	});

	it("blink 非 uina 时眨眼静默（factor 恒 1）", () => {
		const g = new AutonomicGenerator({ rng: () => 0.5 });
		g.setExternal({ blink: "vts", breath: "none" });
		for (let i = 0; i < 5000; i += 16) expect(g.step(16).blinkFactor).toBe(1);
	});

	it("避让规则：主动动作抑制系数使微晃平滑衰减；注视锁定抑制漂移", () => {
		// 同相位双发生器对照：一个被抑制、一个自由，比较同帧幅度。
		const free = new AutonomicGenerator({ rng: () => 0.5 });
		const damped = new AutonomicGenerator({ rng: () => 0.5 });
		damped.setSuppression({ sway: 0, drift: 0 });
		for (let i = 0; i < 62; i++) {
			free.step(16);
			damped.step(16);
		}
		const freeSway = Math.abs(free.step(16).deltas["head.yaw"] ?? 0);
		const dampedSway = Math.abs(damped.step(16).deltas["head.yaw"] ?? 0);
		expect(dampedSway).toBeLessThan(freeSway * 0.2); // 1s 后衰减 >80%，且平滑未突变
		const freeDrift = Math.abs(free.step(16).deltas["gaze.x"] ?? 0);
		const dampedDrift = Math.abs(damped.step(16).deltas["gaze.x"] ?? 0);
		expect(dampedDrift).toBeLessThan(freeDrift * 0.2);
	});

	it("director 集成：breath=vts 静默（帧停在中性）、主动动作抑制遮罩、blinkFactor 可读", () => {
		const controls: Readonly<Record<string, RigControlDef>> = {
			"torso.breath": { min: 0, max: 1, neutral: 0.5 },
			"head.yaw": { min: -12, max: 12, neutral: 0 },
		};
		// breath=vts → 呼吸增量静默，torso.breath 停在中性 0.5。
		const d = new MotionDirector(controls, {
			external: { blink: "uina", breath: "vts" },
			rng: () => 0.5,
			pipelines: { spring: { omega: 2000 }, smoothTauMs: 1 },
		});
		const clip = compileAction(
			motion(5000, {
				"head.yaw": absolute(
					keys([
						[0, 6],
						[5000, 6],
					]),
				),
			}),
			controls,
		);
		d.play(clip, { category: "voluntary", fadeInMs: 0 });
		// 4s：微晃抑制经 exp(−dt/300) 平滑收敛，残留 ≈ e^(−13) ≈ 0，帧稳定在轨迹值。
		for (let i = 0; i < 250; i++) d.step(16);
		expect(d.currentFrame["torso.breath"]).toBe(0.5);
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(6, 3);
		expect(d.blinkFactor).toBe(1);

		// breath=none + torso.breath 存在 → 正弦增量叠加在中性上。
		const d2 = new MotionDirector(controls, {
			external: { blink: "uina", breath: "none" },
			rng: () => 0.5,
			pipelines: { spring: { omega: 2000 }, smoothTauMs: 1 },
		});
		d2.step(800); // 半周期附近幅度显著
		expect(Math.abs(d2.currentFrame["torso.breath"]! - 0.5)).toBeGreaterThan(0.02);
	});

	it("眼睑调制（引擎 #3 P2 简化版）：表情把眼压到 0.8，眨眼仍完全闭拢再回 0.8", () => {
		const controls: Readonly<Record<string, RigControlDef>> = {
			"eyes.left.open": { min: 0, max: 1, neutral: 1 },
			"eyes.right.open": { min: 0, max: 1, neutral: 1 },
		};
		const d = new MotionDirector(controls, {
			external: { blink: "uina", breath: "vts" },
			rng: () => 0.5,
			pipelines: { spring: { omega: 2000 }, smoothTauMs: 1 },
		});
		void d.setExpression({ "eyes.left.open": 0.8, "eyes.right.open": 0.8 });
		d.step(1000); // 表情过渡完成
		expect(d.currentFrame["eyes.left.open"]).toBeCloseTo(0.8, 3);

		// rng=0.5 → 首次眨眼于 ~3039.7ms；闭眼 60ms 内 factor 触 0，眼值 = 0.8 × 0 = 0。
		d.step(2200);
		let minEye = 1;
		for (let i = 0; i < 30; i++) minEye = Math.min(minEye, d.step(5)["eyes.left.open"]!);
		expect(minEye).toBe(0);
		// 睁眼 120ms 后回到表情保持值 0.8。
		let maxEye = 0;
		for (let i = 0; i < 40; i++) maxEye = Math.max(maxEye, d.step(5)["eyes.left.open"]!);
		expect(maxEye).toBeCloseTo(0.8, 3);
	});
});
