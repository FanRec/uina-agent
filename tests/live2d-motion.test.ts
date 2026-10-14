import { describe, expect, it } from "vitest";
import {
	compileMotion,
	elastic,
	keys,
	motion,
	absolute,
	offset,
	sampleMotion,
	sampleSpeechGain,
	withSpeech,
} from "../.uina/worlds/live2d/authoring/motion.js";

const CONTROLS = {
	"head.yaw": { min: -12, max: 12, neutral: 0 },
	"mouth.open": { min: 0, max: 1, neutral: 0 },
};

describe("elastic 曲线生成器", () => {
	it("首尾无条件归零，域外夹紧", () => {
		const curve = elastic(1000, -9.8, 2);
		expect(curve(-5)).toBe(0);
		expect(curve(0)).toBe(0);
		expect(curve(1000)).toBe(0);
		expect(curve(2000)).toBe(0);
	});

	it("主峰幅度恰为 peak，中点符号随 bounces 奇偶翻转", () => {
		const even = elastic(1000, -9.8, 2);
		const odd = elastic(1000, -9.8, 1);
		expect(even(500)).toBeCloseTo(-9.8, 9);
		expect(odd(500)).toBeCloseTo(9.8, 9);
	});

	it("全域有界：|f| ≤ |peak|（窗函数乘法保证）", () => {
		const curve = elastic(1000, -9.8, 3);
		for (let t = 0; t <= 1000; t += 7) {
			const value = curve(t);
			expect(value).toBeLessThanOrEqual(9.8 + 1e-12);
			expect(value).toBeGreaterThanOrEqual(-9.8 - 1e-12);
		}
	});

	it("非法参数拒绝", () => {
		expect(() => elastic(0, 1)).toThrow(/时长/);
		expect(() => elastic(Number.NaN, 1)).toThrow(/时长/);
		expect(() => elastic(100, Number.NaN)).toThrow(/峰值/);
		expect(() => elastic(100, 1, 0)).toThrow(/振荡次数/);
		expect(() => elastic(100, 1, 1.5)).toThrow(/振荡次数/);
	});
});

describe("keys 曲线助手", () => {
	it("域外强制端点值（Clamp，严禁外推）", () => {
		const curve = keys([
			[100, 5],
			[200, 10],
		]);
		expect(curve(0)).toBe(5);
		expect(curve(150)).toBeCloseTo(7.5, 9);
		expect(curve(300)).toBe(10);
	});

	it("linear 精确线性，hold 驻留前值", () => {
		const linear = keys(
			[
				[0, 0],
				[100, 10],
			],
			"linear",
		);
		expect(linear(25)).toBe(2.5);
		const hold = keys(
			[
				[0, 1],
				[100, 2],
			],
			"hold",
		);
		expect(hold(99)).toBe(1);
		expect(hold(100)).toBe(2);
	});

	it("非法点表拒绝", () => {
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
		).toThrow(/非法关键点/);
	});
});

describe("compileMotion（bake）", () => {
	it("未知轴拒绝、非有限曲线域探测拒绝、speech 轴非法拒绝、非法时长拒绝", () => {
		expect(() =>
			compileMotion(
				motion(100, {
					"nope.x": absolute(
						keys([
							[0, 0],
							[100, 0],
						]),
					),
				}),
				CONTROLS,
			),
		).toThrow(/未知轴/);
		expect(() =>
			// 阈值分支：端点网格 t=1000 必中 NaN，探测必定拒绝
			compileMotion(motion(1000, { "head.yaw": absolute((t) => (t > 500 ? Number.NaN : 0)) }), CONTROLS),
		).toThrow(/非有限值/);
		expect(() => compileMotion(motion(100, { "head.yaw": absolute(() => 0, "exclusive") }), CONTROLS)).toThrow(
			/mouth\.open/,
		);
		expect(() => compileMotion(motion(0, { "head.yaw": absolute(() => 0) }), CONTROLS)).toThrow(/时长/);
		expect(() => compileMotion(motion(100, {}), CONTROLS)).toThrow(/至少需要一个通道/);
	});

	it("产物深度冻结，isCompiledMotion 守卫生效", () => {
		const clip = compileMotion(
			motion(100, {
				"head.yaw": absolute(
					keys([
						[0, 0],
						[100, 5],
					]),
				),
			}),
			CONTROLS,
		);
		expect(Object.isFrozen(clip)).toBe(true);
		expect(Object.isFrozen(clip.channels)).toBe(true);
		expect(Object.isFrozen(clip.channels[0])).toBe(true);
	});

	it("offset 通道 bake 期冻结值域探针，absolute 通道不带", () => {
		const clip = compileMotion(
			motion(1000, {
				"head.yaw": offset(
					keys([
						[0, 0],
						[500, -9.8],
						[1000, 0],
					]),
				),
			}),
			CONTROLS,
		);
		expect(clip.channels[0]!.extents!.max).toBe(0);
		// 峰值 t=500 不恰在探测网格上：留网格分辨率容差
		expect(clip.channels[0]!.extents!.min).toBeCloseTo(-9.8, 2);
	});

	it("同 rng 两次 bake 采样逐点相等（bake 确定性）", () => {
		const definition = motion(1000, (rng) => {
			const gain = 1 + (rng() * 2 - 1) * 0.06;
			return {
				"head.yaw": offset(
					(t) =>
						keys([
							[0, 0],
							[500, -9.8],
							[1000, 0],
						])(t) * gain,
				),
			};
		});
		const a = compileMotion(definition, CONTROLS, () => 0.3);
		const b = compileMotion(definition, CONTROLS, () => 0.3);
		for (const t of [0, 250, 500, 999]) expect(sampleMotion(a, t)).toEqual(sampleMotion(b, t));
	});
});

describe("sampleMotion / sampleSpeechGain", () => {
	it("absolute 返回目标值，offset 返回 (baseline ?? neutral) + 增量", () => {
		const clip = compileMotion(
			motion(1000, {
				"head.yaw": absolute(
					keys([
						[0, 0],
						[1000, 6],
					]),
				),
				"mouth.open": offset(
					keys([
						[0, 0],
						[1000, 0.3],
					]),
				),
			}),
			CONTROLS,
			() => 0.5,
		);
		expect(sampleMotion(clip, 500)["head.yaw"]).toBeCloseTo(3, 9);
		// baseline 空 → neutral(0) + 增量；提供 baseline → baseline + 增量
		expect(sampleMotion(clip, 1000)["mouth.open"]).toBeCloseTo(0.3, 9);
		expect(sampleMotion(clip, 1000, { "mouth.open": 0.2 })["mouth.open"]).toBeCloseTo(0.5, 9);
	});

	it("采样时间夹紧到 [0, durationMs]（可 seek）", () => {
		const clip = compileMotion(
			motion(1000, {
				"head.yaw": absolute(
					keys([
						[0, 0],
						[1000, 6],
					]),
				),
			}),
			CONTROLS,
			() => 0.5,
		);
		expect(sampleMotion(clip, -50)["head.yaw"]).toBe(0);
		expect(sampleMotion(clip, 5000)["head.yaw"]).toBeCloseTo(6, 9);
	});

	it("运行期非有限值抛错（响亮失败）", () => {
		const clip = compileMotion(
			motion(1000, { "head.yaw": absolute((t) => (t > 493 && t < 507 ? Number.NaN : 0)) }),
			CONTROLS,
			() => 0.5,
		);
		expect(() => sampleMotion(clip, 500)).toThrow(/非有限值/);
	});

	it("speech 增益：exclusive 的 mouth.open 压制为 0，其余 1", () => {
		const exclusive = compileMotion(
			withSpeech(motion(100, { "mouth.open": absolute(() => 0.2) }), "exclusive"),
			CONTROLS,
			() => 0.5,
		);
		expect(sampleSpeechGain(exclusive, 50)).toBe(0);
		const allow = compileMotion(
			withSpeech(motion(100, { "mouth.open": absolute(() => 0.2) }), "allow"),
			CONTROLS,
			() => 0.5,
		);
		expect(sampleSpeechGain(allow, 50)).toBe(1);
	});
});
