import { describe, expect, it } from "vitest";
import { encodeFrame, type ModelRig, type RigControlDef, validateRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { absolute, compileAction, keys, motion, withSpeech } from "../.uina/worlds/live2d/authoring/index.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { gazeCompensation, SpeechEnvelope, SpringFilter } from "../.uina/worlds/live2d/director/pipelines.js";

const step = (d: MotionDirector, ms: number, dt = 16): void => {
	for (let elapsed = 0; elapsed < ms; elapsed += dt) d.step(Math.min(dt, ms - elapsed));
};

const hold = (axis: string, value: number, durationMs = 8000) =>
	compileAction(
		motion(durationMs, {
			[axis]: absolute(
				keys([
					[0, value],
					[durationMs, value],
				]),
			),
		}),
		controls,
	);

const controls: Readonly<Record<string, RigControlDef>> = {
	"head.yaw": { min: -12, max: 12, neutral: 0 },
	"head.pitch": { min: -10, max: 10, neutral: 0 },
	"gaze.x": { min: -1, max: 1, neutral: 0 },
	"gaze.y": { min: -1, max: 1, neutral: 0 },
	"mouth.open": { min: 0, max: 1, neutral: 0 },
	"eyes.left.open": { min: 0, max: 1, neutral: 1 },
	"eyes.right.open": { min: 0, max: 1, neutral: 1 },
};

describe("live2d 专用管道（P3-1，引擎规范 §4.2 阶段 B）", () => {
	it("引擎 #2 TTS 语音张嘴：底座闭嘴时 L=0.7 → 开度 0.7；暂停后 50ms 释放回零", () => {
		const d = new MotionDirector(controls);
		d.setSpeechLevel(0.7);
		step(d, 100); // 快攻：立即跟随
		expect(d.currentFrame["mouth.open"]).toBeCloseTo(0.7, 6);

		// 暂停：包络不静止在当前开度，自释放起点 50ms 线性降零。
		d.setSpeechLevel(0);
		const samples: number[] = [];
		for (let i = 0; i < 6; i++) samples.push(d.step(10)["mouth.open"]!);
		expect(samples[0]!).toBeGreaterThan(0.35);
		expect(samples[0]!).toBeLessThan(0.7); // 立即开始衰减
		expect(samples.every((v, i) => i === 0 || v <= samples[i - 1]!)).toBe(true); // 单调下降
		expect(d.currentFrame["mouth.open"]).toBe(0); // 60ms > 50ms 释放完成

		// 恢复播放重新同步。
		d.setSpeechLevel(0.5);
		d.step(16);
		expect(d.currentFrame["mouth.open"]).toBeCloseTo(0.5, 6);
	});

	it("引擎 #2 speech=exclusive：认领 mouth.open 的动作压制语音信号", () => {
		const d = new MotionDirector(controls, { pipelines: { spring: { omega: 2000 }, smoothTauMs: 1 } });
		d.setSpeechLevel(0.9);
		// withSpeech 是定义级包装，必须先包再编译。
		const clip = compileAction(
			withSpeech(
				motion(3000, {
					"mouth.open": absolute(
						keys([
							[0, 0.2],
							[3000, 0.2],
						]),
					),
				}),
				"exclusive",
			),
			controls,
		);
		d.play(clip, { category: "voluntary", fadeInMs: 0 });
		step(d, 100);
		// exclusive → L=0，嘴停在动作轨迹值（stiff 管道下即 0.2）。
		expect(d.currentFrame["mouth.open"]).toBeCloseTo(0.2, 3);
	});

	it("引擎 #5 视线补偿：注视点固定、头部转动 → 眼球反向补偿保持锚定", () => {
		const d = new MotionDirector(controls);
		d.setAttention({ x: 0.5, y: 0 });
		step(d, 100);
		expect(d.currentFrame["gaze.x"]).toBeCloseTo(0.5, 6); // 头在中位，眼球承担全部瞄准

		// 头右转 6°（弹簧收敛后），眼球反向补偿 0.5 个视线单位。
		d.play(hold("head.yaw", 6), { category: "voluntary", fadeInMs: 0 });
		step(d, 800);
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(6, 3);
		expect(d.currentFrame["gaze.x"]).toBeCloseTo(0, 3); // 0.5 − 6/12 = 0

		// 头转到量程 12°：补偿 −0.5。
		d.play(hold("head.yaw", 12), { category: "reflex", fadeInMs: 0 });
		step(d, 800);
		expect(d.currentFrame["gaze.x"]).toBeCloseTo(-0.5, 3);

		// 命名目标：词表是类型层联合（未知名称由 P4-1 工具词汇校验拒绝，不进引擎）。
		d.setAttention("screen");
		step(d, 100);
		expect(d.currentFrame["gaze.x"]).toBeCloseTo(-1, 3); // aim 0 − 12/12 = −1
	});

	it("引擎 #5 视线让位：动作 Override 认领的视线轴不被补偿覆写", () => {
		const d = new MotionDirector(controls, { pipelines: { spring: { omega: 2000 }, smoothTauMs: 1 } });
		d.setAttention({ x: 0.5, y: 0 });
		d.play(hold("gaze.x", -0.8, 5000), { category: "voluntary", fadeInMs: 0 });
		step(d, 200);
		expect(d.currentFrame["gaze.x"]).toBeCloseTo(-0.8, 3); // 动作认领 → 补偿让位
	});

	it("引擎 #10 遮蔽后平滑恢复：低优先级轴重新接管时无姿态跳变", () => {
		const d = new MotionDirector(controls);
		// non-atomic：被 reflex 遮蔽时继续存活（A17.2 整场取消只针对 atomic），恢复后阴影接管。
		d.play(hold("head.yaw", 8, 8000), { category: "voluntary", fadeInMs: 0, atomic: false });
		step(d, 600);
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(8, 1); // 弹簧 600ms 残留 ~0.006°

		// reflex 遮蔽（临时）→ 自然结束 → 被遮蔽的 low 阴影恢复（不做任何显式 stop）。
		d.play(
			compileAction(
				motion(400, {
					"head.yaw": absolute(
						keys([
							[0, -6],
							[400, -6],
						]),
					),
				}),
				controls,
			),
			{
				category: "reflex",
				fadeInMs: 0,
			},
		);
		step(d, 700); // reflex 接管（切入快是弹簧正常物理速率）→ 400ms 结束 + 收势，low 已恢复接管

		// 恢复段逐帧差分：无突变（弹簧连续转向，每次 16ms 步进的变化有界）。
		let maxDelta = 0;
		let previous = d.currentFrame["head.yaw"]!;
		for (let i = 0; i < 120; i++) {
			const current = d.step(16)["head.yaw"]!;
			maxDelta = Math.max(maxDelta, Math.abs(current - previous));
			previous = current;
		}
		expect(maxDelta).toBeLessThan(1); // 正常弹簧步进 <1°/帧；跳变会是数度
		expect(d.currentFrame["head.yaw"]).toBeCloseTo(8, 2);
	});

	it("骨骼弹簧：ζ=0.85 阶跃响应收敛、过冲 <1%、大步长与子步一致", () => {
		const spring = new SpringFilter();
		spring.ensure("head.yaw", 0);
		let overshoot = 0;
		for (let t = 0; t <= 2000; t += 16) {
			spring.step({ "head.yaw": 10 }, 16);
			overshoot = Math.max(overshoot, spring.get("head.yaw")! - 10);
		}
		expect(spring.get("head.yaw")).toBeCloseTo(10, 6);
		expect(overshoot).toBeLessThan(0.1); // ζ=0.85 理论过冲 ~0.6%

		// 大步长（卡顿 1s）与 20×50ms 子步结果一致（解析解采样稳定）。
		const a = new SpringFilter();
		const b = new SpringFilter();
		a.ensure("x", 0);
		b.ensure("x", 0);
		a.step({ x: 10 }, 1000);
		for (let i = 0; i < 20; i++) b.step({ x: 10 }, 50);
		expect(a.get("x")).toBeCloseTo(b.get("x")!, 9);
	});

	it("骨骼弹簧：高优先级切入保留位置与速度；resetVelocity 才清速度", () => {
		const spring = new SpringFilter();
		spring.ensure("head.yaw", 0);
		spring.step({ "head.yaw": 10 }, 100); // 获得正向速度
		const x = spring.get("head.yaw")!;
		// 切入新目标：不重置速度 → 轨迹越过当前位置继续前进（惯性）。
		spring.step({ "head.yaw": x }, 16);
		const x2 = spring.get("head.yaw")!;
		expect(x2).toBeGreaterThan(x);
		// resetVelocity：速度清零、位置保留 → 目标=当前位置时位置精确保持。
		spring.resetVelocity(["head.yaw"]);
		spring.step({ "head.yaw": x2 }, 16);
		expect(spring.get("head.yaw")).toBeCloseTo(x2, 9);
	});

	it("口型包络：快攻立即跟随；释放自起点 50ms 线性降零", () => {
		const env = new SpeechEnvelope();
		env.setLevel(0.6);
		expect(env.step(16)).toBe(0.6); // 快攻
		env.setLevel(0);
		expect(env.step(16)).toBeCloseTo(0.6 * (1 - 16 / 50), 6); // 线性释放（起点冻结）
		env.setLevel(0.4);
		expect(env.step(16)).toBe(0.4); // 升高立即跟随
	});

	it("视线补偿纯函数：舒适域夹紧", () => {
		const r = gazeCompensation({ x: 2, y: 0 }, -6, 0, 12, 10, 0.9);
		expect(r.x).toBe(0.9); // 2 + 0.5 = 2.5 → 夹紧 0.9
		expect(r.y).toBe(0);
	});

	it("引擎 #7 多轴聚合：max 策略正确输出；未声明的多轴汇入被校验拦截", () => {
		const rig: ModelRig = {
			version: 3,
			modelID: "fixture",
			controls: {
				"eyes.left.smile": { min: 0, max: 1, neutral: 0 },
				"eyes.right.smile": { min: 0, max: 1, neutral: 0 },
			},
			bindings: {
				"eyes.left.smile": [
					{
						parameter: "ParamEyeSmileL",
						input: "EyeSmile",
						points: [
							[0, 0],
							[0.5, 0.5],
							[1, 1],
						],
						followers: [],
						physicsFollowers: [],
						smoothing: 0,
					},
				],
				"eyes.right.smile": [
					{
						parameter: "ParamEyeSmileR",
						input: "EyeSmile",
						points: [
							[0, 0],
							[0.5, 0.5],
							[1, 1],
						],
						followers: [],
						physicsFollowers: [],
						smoothing: 0,
					},
				],
			},
			external: { blink: "uina", breath: "none" },
			retargeting: { EyeSmile: { strategy: "max" } },
		};
		// 同向非负量汇入同一输入：max 聚合。
		const frame = encodeFrame(rig, { "eyes.left.smile": 0.3, "eyes.right.smile": 0.7 });
		expect(frame).toEqual([{ id: "EyeSmile", value: 0.7 }]);
		// 未声明 retargeting 的多轴汇入：绑定期校验报错（A6）。
		const undeclared: ModelRig = { ...rig, retargeting: undefined };
		expect(() => validateRig(undeclared)).toThrow();
	});
});
