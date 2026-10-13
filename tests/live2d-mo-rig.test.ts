import { describe, expect, it } from "vitest";
import { bodyInputName } from "../.uina/worlds/live2d/adapter/body-inputs.js";
import { encodeFrame, neutralFrame } from "../.uina/worlds/live2d/adapter/rig.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO rig 装配（真实数据文件）", () => {
	it("loadRig：v3 校验全过、身份一致、12 轴全登记 evidence", async () => {
		const rig = await loadRig(MO_MODEL_ID);
		expect(rig).toBeDefined();
		expect(rig!.modelID).toBe(MO_MODEL_ID);
		expect(Object.keys(rig!.controls)).toHaveLength(12);
		const targets = Object.values(rig!.bindings).flat();
		expect(targets).toHaveLength(12);
		// gaze 两轴经实测修正（VTS 映射反向+缩放）登记为 observed，其余 calibrated。
		expect(targets.every((t) => t.evidence !== undefined)).toBe(true);
		// MO 全部单轴独立输入，无需 retargeting（与 probe 结论一致）。
		const inputs = targets.map((t) => t.input);
		expect(new Set(inputs).size).toBe(12);
		expect(rig!.retargeting).toBeUndefined();
		expect(rig!.external).toEqual({ blink: "uina", breath: "vts" });
	});

	it("未登记模型返回 undefined（诚实降级）", async () => {
		expect(await loadRig("not-registered")).toBeUndefined();
	});

	it("标定曲线保真：head.yaw ±12→±14、gaze 反向端点 0.52、睁眼中性 1", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		// head.yaw：逻辑 ±12 → 输入 ±14（作者标定的放大系数）。
		expect(rig.bindings["head.yaw"]![0]!.points).toEqual([
			[-12, -14],
			[0, 0],
			[12, 14],
		]);
		// gaze.x：VTS Eye X 映射实测反向 + ×1.25 缩放 → 逻辑 ±1 → 注入 ∓0.52（模型终值 0.65）。
		expect(rig.bindings["gaze.x"]![0]!.points).toEqual([
			[-1, 0.52],
			[0, 0],
			[1, -0.52],
		]);
		// gaze.y：VTS Eye Y 映射正向但同缩放 → 逻辑 ±1 → 注入 ±0.52。
		expect(rig.bindings["gaze.y"]![0]!.points).toEqual([
			[-1, -0.52],
			[0, 0],
			[1, 0.52],
		]);
		// 睁眼中性为 1，中性帧编码 EyeOpenLeft = 1。
		expect(rig.controls["eyes.left.open"]!.neutral).toBe(1);
	});

	it("中性流值：MO 中性帧编码出真实 VTS 输入中性值", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const bodyInputs = {
			yaw: bodyInputName(MO_MODEL_ID, "torso.yaw"),
			pitch: bodyInputName(MO_MODEL_ID, "torso.pitch"),
			roll: bodyInputName(MO_MODEL_ID, "torso.roll"),
		};
		const encoded = Object.fromEntries(encodeFrame(rig, neutralFrame(rig)).map((p) => [p.id, p.value]));
		expect(encoded).toEqual({
			FaceAngleX: 0,
			FaceAngleY: 0,
			FaceAngleZ: 0,
			EyeRightX: 0,
			EyeRightY: 0,
			MouthSmile: 0,
			MouthOpen: 0,
			EyeOpenLeft: 1,
			EyeOpenRight: 1,
			[bodyInputs.yaw]: 0,
			[bodyInputs.pitch]: 0,
			[bodyInputs.roll]: 0,
		});
	});
});
