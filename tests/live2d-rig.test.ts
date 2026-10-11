import { describe, expect, it } from "vitest";
import {
	type ModelRig,
	RigValidationError,
	resolveInputValue,
	scaleWithClamp,
	validateRig,
} from "../.uina/worlds/live2d/adapter/rig.js";

function headPitchBinding(input: string, points: readonly (readonly [number, number])[]) {
	return [
		{
			parameter: "ParamAngleX",
			input,
			points,
			followers: [],
			physicsFollowers: [],
			smoothing: 0.3,
			evidence: "declared" as const,
		},
	];
}

function baseRig(overrides: Partial<ModelRig> = {}): ModelRig {
	return {
		version: 3,
		modelID: "test-model",
		controls: {
			"head.pitch": { min: -30, max: 30, neutral: 0 },
			"eyes.left.smile": { min: 0, max: 1, neutral: 0 },
			"eyes.right.smile": { min: 0, max: 1, neutral: 0 },
		},
		bindings: {
			"head.pitch": headPitchBinding("FaceAngleX", [
				[-30, -30],
				[0, 0],
				[30, 30],
			]),
			"eyes.left.smile": [
				{
					parameter: "EyeSmileL",
					input: "EyeSmile",
					points: [
						[0, 0],
						[1, 1],
					],
					followers: [],
					physicsFollowers: [],
					smoothing: 0.5,
				},
			],
			"eyes.right.smile": [
				{
					parameter: "EyeSmileR",
					input: "EyeSmile",
					points: [
						[0, 0],
						[1, 1],
					],
					followers: [],
					physicsFollowers: [],
					smoothing: 0.5,
				},
			],
		},
		retargeting: { EyeSmile: { strategy: "max" } },
		external: { blink: "uina", breath: "none" },
		...overrides,
	};
}

describe("validateRig", () => {
	it("接受合法的 v3 rig", () => {
		expect(() => validateRig(baseRig())).not.toThrow();
	});

	it("拒绝 v2 与未知版本（修订 A7）", () => {
		const legacy = baseRig() as unknown as Record<string, unknown>;
		legacy.version = 2;
		expect(() => validateRig(legacy as unknown as ModelRig)).toThrow(RigValidationError);
		expect(() => validateRig(baseRig({ version: 4 as unknown as 3 }))).toThrow(/版本错误/);
	});

	it("拒绝缺少绑定的控制与未声明控制的绑定", () => {
		const missing = baseRig();
		delete (missing.bindings as Record<string, unknown>)["head.pitch"];
		expect(() => validateRig(missing)).toThrow(/缺少手工绑定: head\.pitch/);
		const orphan = baseRig();
		(orphan.bindings as Record<string, unknown>)["arm.wave"] = headPitchBinding("ArmInput", [
			[0, 0],
			[1, 1],
		]);
		expect(() => validateRig(orphan)).toThrow(/未声明控制: arm\.wave/);
	});

	it("拒绝非法曲线：端点不覆盖范围、y 方向不一致、中性点缺失", () => {
		const shortRange = baseRig({
			bindings: {
				...baseRig().bindings,
				"head.pitch": headPitchBinding("FaceAngleX", [
					[-20, -20],
					[30, 30],
				]),
			},
		});
		expect(() => validateRig(shortRange)).toThrow(/端点必须覆盖/);
		const folded = baseRig({
			bindings: {
				...baseRig().bindings,
				"head.pitch": headPitchBinding("FaceAngleX", [
					[-30, -30],
					[30, -45],
				]),
			},
		});
		expect(() => validateRig(folded)).toThrow(/方向不一致|中性点/);
		const noNeutral = baseRig({
			bindings: {
				...baseRig().bindings,
				"head.pitch": headPitchBinding("FaceAngleX", [
					[-30, -30],
					[-1, -1],
					[30, 30],
				]),
			},
		});
		expect(() => validateRig(noNeutral)).toThrow(/中性点不在曲线上/);
	});

	it("多轴汇入同一输入必须声明规则；未声明报错", () => {
		const undeclared = baseRig();
		undeclared.retargeting = undefined;
		expect(() => validateRig(undeclared)).toThrow(/未声明 retargeting 规则: EyeSmile/);
	});

	it("weighted 接受合法权重；拒绝缺失/非法权重；primary 仍报 not_implemented", () => {
		const validWeighted = baseRig({
			retargeting: { EyeSmile: { strategy: "weighted", weights: { "eyes.left.smile": 2, "eyes.right.smile": 1 } } },
		});
		expect(() => validateRig(validWeighted)).not.toThrow();

		const invalidWeights = baseRig({
			retargeting: { EyeSmile: { strategy: "weighted", weights: { "eyes.left.smile": 1 } } },
		});
		expect(() => validateRig(invalidWeights)).toThrow(/weighted 规则轴权重非法/);

		const primary = baseRig({ retargeting: { EyeSmile: { strategy: "primary", primaryAxis: "eyes.left.smile" } } });
		expect(() => validateRig(primary)).toThrow(/retargeting_not_implemented/);
	});

	it("optional 轴是合法标注（修订 A13）", () => {
		const optional = baseRig();
		(optional.controls as Record<string, unknown>)["face.blush"] = { min: 0, max: 1, neutral: 0, optional: true };
		(optional.bindings as Record<string, unknown>)["face.blush"] = [
			{
				parameter: "ParamBlushY",
				input: "Blush",
				points: [
					[0, 0],
					[1, 1],
				],
				followers: [],
				physicsFollowers: [],
				smoothing: 0.4,
			},
		];
		expect(() => validateRig(optional)).not.toThrow();
	});

	it("非法 evidence 值被拒绝", () => {
		const rig = baseRig();
		(rig.bindings["head.pitch"]![0] as { evidence: string }).evidence = "guessed";
		expect(() => validateRig(rig)).toThrow(/非法能力证据/);
	});
});

describe("scaleWithClamp / resolveInputValue", () => {
	const points: readonly (readonly [number, number])[] = [
		[-30, -30],
		[0, 0],
		[30, 45],
	];

	it("分段线性插值，首尾之外强制端点裁剪", () => {
		expect(scaleWithClamp(points, 15)).toBeCloseTo(22.5);
		expect(scaleWithClamp(points, -40)).toBe(-30);
		expect(scaleWithClamp(points, 40)).toBe(45);
		expect(scaleWithClamp(points, 0)).toBe(0);
	});

	it("单轴直写按标尺缩放，缺帧回退中性值", () => {
		const rig = baseRig({
			retargeting: undefined,
			bindings: { "head.pitch": headPitchBinding("FaceAngleX", points) },
		});
		expect(resolveInputValue(rig, "FaceAngleX", { "head.pitch": -15 })).toBe(-15);
		expect(resolveInputValue(rig, "FaceAngleX", {})).toBe(0);
	});

	it("多轴汇入同一输入按 max 取缩放值最大", () => {
		const rig = baseRig();
		expect(resolveInputValue(rig, "EyeSmile", { "eyes.left.smile": 0.3, "eyes.right.smile": 0.8 })).toBe(0.8);
		expect(resolveInputValue(rig, "EyeSmile", {})).toBe(0);
	});

	it("多轴汇入同一输入按 weighted 计算归一化加权和", () => {
		const rig = baseRig({
			retargeting: {
				EyeSmile: {
					strategy: "weighted",
					weights: { "eyes.left.smile": 2, "eyes.right.smile": 1 },
				},
			},
		});
		// (2 * 0.3 + 1 * 0.9) / 3 = 1.5 / 3 = 0.5
		expect(resolveInputValue(rig, "EyeSmile", { "eyes.left.smile": 0.3, "eyes.right.smile": 0.9 })).toBeCloseTo(0.5);
	});

	it("没有控制写入该输入时抛错", () => {
		expect(() => resolveInputValue(baseRig(), "Ghost", {})).toThrow(/没有控制写入/);
	});
});
