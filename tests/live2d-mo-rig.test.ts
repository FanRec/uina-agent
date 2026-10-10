import { describe, expect, it } from "vitest";
import { encodeFrame, neutralFrame } from "../.uina/worlds/live2d/adapter/rig.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";

describe("MO rig 装配（真实数据文件）", () => {
	it("loadRig：v3 校验全过、身份一致、9 轴全 calibrated", async () => {
		const rig = await loadRig(MO_MODEL_ID);
		expect(rig).toBeDefined();
		expect(rig!.modelID).toBe(MO_MODEL_ID);
		expect(Object.keys(rig!.controls)).toHaveLength(9);
		const targets = Object.values(rig!.bindings).flat();
		expect(targets).toHaveLength(9);
		expect(targets.every((t) => t.evidence === "calibrated")).toBe(true);
		// MO 全部单轴独立输入，无需 retargeting（与 probe 结论一致）。
		const inputs = targets.map((t) => t.input);
		expect(new Set(inputs).size).toBe(9);
		expect(rig!.retargeting).toBeUndefined();
		expect(rig!.external).toEqual({ blink: "uina", breath: "vts" });
	});

	it("未登记模型返回 undefined（诚实降级）", async () => {
		expect(await loadRig("not-registered")).toBeUndefined();
	});

	it("标定曲线保真：head.yaw ±12→±14、gaze 端点 0.65、睁眼中性 1", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		// head.yaw：逻辑 ±12 → 输入 ±14（作者标定的放大系数）。
		expect(rig.bindings["head.yaw"]![0]!.points).toEqual([
			[-12, -14],
			[0, 0],
			[12, 14],
		]);
		// gaze：逻辑 ±1 → 输入 ±0.65。
		expect(rig.bindings["gaze.x"]![0]!.points.at(-1)).toEqual([1, 0.65]);
		// 睁眼中性为 1，中性帧编码 EyeOpenLeft = 1。
		expect(rig.controls["eyes.left.open"]!.neutral).toBe(1);
	});

	it("中性流值：MO 中性帧编码出真实 VTS 输入中性值", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
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
		});
	});
});
