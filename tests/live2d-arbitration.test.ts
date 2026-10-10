import { describe, expect, it } from "vitest";
import { compileMotion, motion, track, type CompiledMotion } from "../.uina/worlds/live2d/authoring/motion.js";
import { MotionDirector, SupersededError } from "../.uina/worlds/live2d/director/director.js";
import type { RigControlDef } from "../.uina/worlds/live2d/adapter/rig.js";

const controls: Readonly<Record<string, RigControlDef>> = {
	"head.pitch": { min: -30, max: 30, neutral: 0 },
	"head.yaw": { min: -12, max: 12, neutral: 0 },
	"mouth.form": { min: 0, max: 1, neutral: 0 },
	"face.blush": { min: 0, max: 1, neutral: 0 },
	"torso.breath": { min: 0, max: 1, neutral: 0.5 },
};

/** 仲裁专测：刚性管道（ω=2000 一步内收敛到机器精度、平滑 τ=1ms），使断言与管道动力学解耦。 */
const STIFF_PIPELINES = { spring: { omega: 2000 }, smoothTauMs: 1 } as const;
const director = () => new MotionDirector(controls, { pipelines: STIFF_PIPELINES });

/** 恒值 Override 片段。 */
const hold = (axis: string, value: number, durationMs = 1000): CompiledMotion =>
	compileMotion(
		motion(
			durationMs,
			track(axis, [
				[0, value],
				[durationMs, value],
			]),
		),
		controls,
	);
/** 恒值 Additive 片段（baseline-offset，ΔX 相对量）。 */
const offset = (axis: string, delta: number, durationMs = 1000): CompiledMotion =>
	compileMotion(
		motion(
			durationMs,
			track(
				axis,
				[
					[0, delta],
					[durationMs, delta],
				],
				"baseline-offset",
			),
		),
		controls,
	);

const step = (d: MotionDirector, ms: number, dt = 16): void => {
	for (let elapsed = 0; elapsed < ms; elapsed += dt) d.step(Math.min(dt, ms - elapsed));
};

describe("live2d MotionDirector（P2-1 仲裁核心）", () => {
	it("引擎 #19 类别优先级：reflex > voluntary > 槽位，atomic 跨类别抢占，additive 共存", async () => {
		const d = director();
		const slot = d.setPosture({ "head.pitch": 5 }, { durationMs: 300 }); // 显式时长，与默认解耦
		step(d, 400);
		expect(d.currentFrame["head.pitch"]).toBe(5);

		// voluntary（atomic 默认 true）接管。
		const voluntary = d.play(hold("head.pitch", 10), { category: "voluntary" });
		step(d, 300);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(10, 5);

		// reflex 接管：atomic voluntary 整场取消，但 finished 在自身 fadeOut 后才结算（A17.2）。
		const reflex = d.play(hold("head.pitch", -10, 500), { category: "reflex", fadeInMs: 0 });
		void reflex;
		let settled = false;
		void voluntary.finished.then((r) => {
			settled = true;
			expect(r.status).toBe("cancelled");
		});
		step(d, 16);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(-10, 5);
		await Promise.resolve();
		expect(settled).toBe(false); // 收势中，未结算
		step(d, 300);
		await Promise.resolve();
		expect(settled).toBe(true); // fadeOut(250) 完成后结算

		// 自律 additive 与 reflex Override 共存（A17.1：additive 永不抢占）。
		d.play(offset("head.pitch", 2), { category: "autonomic", fadeInMs: 0 });
		step(d, 100);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(-8, 3);

		// reflex 结束后交还槽位（A17.3），additive 随之结束。
		step(d, 400);
		step(d, 1200);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(5, 3);
		await slot;
	});

	it("引擎 #9 复合动作局部覆盖：同类别点头只遮蔽 head.pitch，脸红微笑保持", async () => {
		const d = director();
		// 害羞复合（voluntary）：低头 + 脸红 + 微笑。
		const shy = compileMotion(
			motion(
				2000,
				track("head.pitch", [
					[0, 0],
					[200, 8],
					[2000, 8],
				]),
				track("face.blush", [
					[0, 0],
					[200, 0.6],
					[2000, 0.6],
				]),
				track("mouth.form", [
					[0, 0],
					[200, 0.5],
					[2000, 0.5],
				]),
			),
			controls,
		);
		const handle = d.play(shy, { category: "voluntary", atomic: false, fadeInMs: 0 });
		step(d, 400);
		expect(d.currentFrame["face.blush"]).toBeCloseTo(0.6, 3);
		expect(d.currentFrame["mouth.form"]).toBeCloseTo(0.5, 3);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(8, 3);

		// 独立点头（同类别 voluntary）：只遮蔽 head.pitch。
		d.play(hold("head.pitch", 12, 400), { category: "voluntary", fadeInMs: 0 });
		step(d, 200);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(12, 3);
		// 脸红与微笑持续保持，不被误抢占（引擎 #9）。
		expect(d.currentFrame["face.blush"]).toBeCloseTo(0.6, 3);
		expect(d.currentFrame["mouth.form"]).toBeCloseTo(0.5, 3);
		expect(handle.status).toBe("playing");

		// 点头结束：head.pitch 无跳变地回到复合动作轨迹（shadow 恢复淡入）。
		step(d, 400);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(8, 2);
	});

	it("引擎 #6 Patch：异轴并发独立结算，同轴竞争旧 Promise SupersededError 且未冲突轴继续", async () => {
		const d = director();
		const patchA = d.patchExpression({ "face.blush": 0.8, "mouth.form": 0.4 }, { durationMs: 300 });
		step(d, 100);
		const patchB = d.patchExpression({ "face.blush": 0.2 }, { durationMs: 300 });
		await expect(patchA).rejects.toBeInstanceOf(SupersededError);
		step(d, 300); // A9：Promise 只在步进中推进，先步进后结算
		await patchB; // 新 blush 正常完成
		expect(d.currentFrame["face.blush"]).toBeCloseTo(0.2, 3);
		// mouth.form 未受冲突影响，继续平滑完成（引擎 #6）。
		expect(d.currentFrame["mouth.form"]).toBeCloseTo(0.4, 3);
	});

	it("引擎 #12 setExpression 整槽替换：旧 Promise 立即 SupersededError，新目标接管", async () => {
		const d = director();
		const first = d.setExpression({ "mouth.form": 0.8 }, { durationMs: 500 });
		step(d, 100);
		const second = d.setExpression({ "mouth.form": 0.2 }, { durationMs: 300 });
		await expect(first).rejects.toBeInstanceOf(SupersededError);
		step(d, 300);
		await second;
		expect(d.currentFrame["mouth.form"]).toBeCloseTo(0.2, 3);
	});

	it("引擎 #8 stop：cut 立即结算 cancelled 无淡出；release 淡出后结算；自然结束 completed", async () => {
		const d = director();
		const cut = d.play(hold("head.pitch", 10, 5000), { category: "voluntary", fadeInMs: 0 });
		step(d, 50);
		cut.stop("cut");
		expect(await cut.finished).toEqual({ status: "cancelled", reason: "stopped" });
		expect(cut.status).toBe("cancelled");
		step(d, 16);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6); // 无淡出，立即回落（刚性弹簧残差 ~1e-11）

		const release = d.play(hold("head.pitch", 10, 5000), { category: "voluntary", fadeInMs: 0, fadeOutMs: 200 });
		step(d, 50);
		release.stop("release");
		step(d, 100);
		expect(d.currentFrame["head.pitch"]).toBeGreaterThan(0); // 淡出中，未清零
		step(d, 150); // fadeOut(200) 走完
		expect(await release.finished).toEqual({ status: "cancelled", reason: "released" });
		step(d, 200);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6);

		const natural = d.play(hold("head.pitch", 6, 200), { category: "voluntary", fadeInMs: 0, fadeOutMs: 100 });
		step(d, 400);
		expect(await natural.finished).toEqual({ status: "completed", reason: undefined });
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6);
	});

	it("A11 限时槽位：holdMs 到期平滑回中性；冻结期间倒计时暂停", async () => {
		const d = director();
		void d.setPosture({ "head.pitch": 5 }, { durationMs: 300, holdMs: 200 });
		step(d, 400);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(5, 3);
		// 冻结：保持倒计时不消耗。
		d.setFrozen(true);
		step(d, 5000);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(5, 3);
		d.setFrozen(false);
		// holdTotal = 300 + 200 = 500ms，已消耗 400ms；再 200ms 触发回中性。
		step(d, 200);
		expect(d.currentFrame["head.pitch"]).toBeLessThan(5);
		step(d, 500);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 3);
	});

	it("A12 独占声明：互斥、cleanup 拒绝、同 reason 幂等替换、signal 取消", () => {
		const d = director();
		const flip = d.claimExclusive(["model:transform"], { reason: "flip" });
		expect(() => d.claimExclusive(["model:transform", "effect:hat"], { reason: "spatial" })).toThrow("资源冲突");
		// 同 reason 再声明：幂等替换，旧声明 signal 中止。
		const flip2 = d.claimExclusive(["model:transform"], { reason: "flip" });
		expect(flip.signal.aborted).toBe(true);
		flip2.release();

		// cleanup 声明完成前一律拒绝。
		const costume = d.claimExclusive(["effect:hat"], { reason: "costume", cleanup: true });
		expect(() => d.claimExclusive(["effect:hat"], { reason: "costume" })).toThrow("外部清理");
		costume.release();
		expect(() => d.claimExclusive(["effect:hat"], { reason: "costume" })).not.toThrow();

		// signal 取消后资源释放。
		const controller = new AbortController();
		d.claimExclusive(["effect:hat"], { reason: "costume", signal: controller.signal });
		controller.abort();
		expect(() => d.claimExclusive(["effect:hat"], { reason: "costume" })).not.toThrow();
	});

	it("引擎 #11 代次失效：invalidateAll 结算全部 Handle，槽位过渡作废，帧回中性", async () => {
		const d = director();
		const slot = d.setPosture({ "head.pitch": 5 }, { durationMs: 1000 });
		const handle = d.play(hold("head.yaw", 8, 5000), { category: "voluntary", fadeInMs: 0 });
		step(d, 50);
		d.invalidateAll("model switched");
		expect(await handle.finished).toEqual({ status: "cancelled", reason: "model switched" });
		await expect(slot).rejects.toBeInstanceOf(SupersededError);
		step(d, 16);
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(0, 6);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6);
	});

	it("A1 无优先级旋钮：携带 priority 数值的选项不产生任何越级效果", async () => {
		const d = director();
		const autonomic = d.play(hold("head.pitch", 10, 5000), {
			category: "autonomic",
			fadeInMs: 0,
			// 对抗性注入：伪造调用方试图携带 priority 绕过矩阵。
			...({ priority: 999 } as object),
		});
		const voluntary = d.play(hold("head.pitch", 0, 5000), { category: "voluntary", fadeInMs: 0 });
		step(d, 50);
		// autonomic 被当作 10 级处理：voluntary（30）胜出，且 atomic autonomic 被取消。
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6);
		step(d, 300); // autonomic 的 fadeOut 收势
		expect((await autonomic.finished).status).toBe("cancelled");
		voluntary.stop("cut");
		await voluntary.finished;
	});

	it("清槽归中：setPosture({}) 过渡全程有限值且终点回中性（NaN 回归）", async () => {
		const d = director();
		// 槽位 Promise 仅由 step() 推进（A9）：先步进完成入槽，再测清槽。
		void d.setPosture({ "head.yaw": 8, "head.pitch": -6 }, { durationMs: 50 });
		step(d, 100);
		expect(d.currentFrame["head.yaw"]).toBe(8);
		const clear = d.setPosture({}, { durationMs: 200 });
		let allFinite = true;
		for (let i = 0; i < 20; i++) {
			const frame = d.step(16);
			allFinite &&= Number.isFinite(frame["head.yaw"]) && Number.isFinite(frame["head.pitch"]);
		}
		await clear;
		expect(allFinite).toBe(true); // 过渡全程无 NaN（未声明轴目标映射到中性，而非 undefined）
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(0, 6);
		expect(d.currentFrame["head.pitch"]).toBeCloseTo(0, 6);
	});
});
