import type { VTSParamValue } from "./vts-client.js";

/**
 * Live2D Cubism 模型参数与 VTube Studio 标准输入追踪参数映射表
 */
export const CUBISM_TO_VTS_MAP: Readonly<Record<string, string | readonly string[]>> = Object.freeze({
	ParamAngleX: "FaceAngleX",
	ParamAngleY: "FaceAngleY",
	ParamAngleZ: "FaceAngleZ",
	ParamBodyAngleX: "BodyAngleX",
	ParamBodyAngleY: "BodyAngleY",
	ParamBodyAngleZ: "BodyAngleZ",
	ParamEyeBallX: ["EyeLeftX", "EyeRightX"],
	ParamEyeBallY: ["EyeLeftY", "EyeRightY"],
	ParamEyeLOpen: "EyeOpenLeft",
	ParamEyeROpen: "EyeOpenRight",
	ParamEyeLSmile: ["EyeSmileLeft", "EyeSmile"],
	ParamEyeRSmile: ["EyeSmileRight", "EyeSmile"],
	ParamBrowLY: ["Brows", "BrowLeftY"],
	ParamBrowRY: ["Brows", "BrowRightY"],
	ParamMouthOpenY: "MouthOpen",
	ParamMouthForm: "MouthSmile",
	ParamCheek: ["CheekPuff", "ParamCheek", "Cheek", "Blush"],
	ParamBreath: "Breath",
});

/**
 * VTS 参数重定向与语义融合器 (VTSParameterRetargeter)
 * 职责：Cubism -> VTS 标准映射、MouthSmile 极性保护融合、EyeSmile 左右眼追踪分流、真实身体骨骼映射、杜绝屏幕打滑与升降。
 */
export class VTSParameterRetargeter {
	private readonly vtsTargetMap = new Map<string, number>();
	private readonly cachedParamValues: VTSParamValue[] = [];

	private accumulateVtsParam(targetId: string, sourceId: string, value: number): void {
		if (targetId === "MouthSmile") {
			if (sourceId === "ParamMouthForm") {
				this.vtsTargetMap.set("MouthSmile", value);
				return;
			}
			const existing = this.vtsTargetMap.get("MouthSmile");
			if (existing !== undefined && existing < 0) return;
			this.vtsTargetMap.set("MouthSmile", Math.max(existing ?? 0, value));
			return;
		}

		if (targetId === "EyeSmile") {
			const existing = this.vtsTargetMap.get("EyeSmile");
			if (existing !== undefined) {
				this.vtsTargetMap.set("EyeSmile", Math.max(existing, value));
				return;
			}
		}

		if (targetId === "Brows") {
			const existing = this.vtsTargetMap.get("Brows");
			if (existing !== undefined) {
				this.vtsTargetMap.set("Brows", (existing + value) / 2);
				return;
			}
		}

		let vtsVal = value;
		if (sourceId.startsWith("ParamBodyAngle")) {
			// 规范身体旋转角度区间 [-30, 30]
			vtsVal = Math.max(-30, Math.min(30, value));
		}
		this.vtsTargetMap.set(targetId, vtsVal);
	}

	retarget(frame: Record<string, number>, mouthOpen?: number): readonly VTSParamValue[] {
		this.vtsTargetMap.clear();

		for (const id in frame) {
			let value = frame[id]!;
			if (id === "ParamMouthOpenY" && mouthOpen !== undefined && mouthOpen > 0) {
				value = Math.max(value, mouthOpen);
			}

			const vtsTarget = CUBISM_TO_VTS_MAP[id];
			if (!vtsTarget) continue;

			if (Array.isArray(vtsTarget)) {
				for (let i = 0; i < vtsTarget.length; i++) {
					this.accumulateVtsParam(vtsTarget[i]!, id, value);
				}
			} else {
				this.accumulateVtsParam(vtsTarget as string, id, value);
			}
		}

		if (frame.ParamMouthOpenY === undefined && mouthOpen !== undefined && mouthOpen > 0) {
			this.accumulateVtsParam("MouthOpen", "ParamMouthOpenY", mouthOpen);
		}

		// 动理学融合（Kinematic Upper-Body Fusion）：
		// VTube Studio 原生模型（包括 MO）普遍将 FaceAngle 作为驱动上半身与面部的统一输入。
		// 当物理引擎计算出身体倾角时，将其叠加至 FaceAngle 中，确保无需用户配置即可呈现身体动作；
		// 同时保留独立 BodyAngleX/Y/Z 输出，供高级用户在 VTS 独立绑定。
		if (frame.ParamBodyAngleX !== undefined) {
			const headX = this.vtsTargetMap.get("FaceAngleX") ?? 0;
			const bodyX = frame.ParamBodyAngleX;
			this.vtsTargetMap.set("FaceAngleX", Math.max(-30, Math.min(30, headX + bodyX * 0.75)));
		}
		if (frame.ParamBodyAngleY !== undefined) {
			const headY = this.vtsTargetMap.get("FaceAngleY") ?? 0;
			const bodyY = frame.ParamBodyAngleY;
			this.vtsTargetMap.set("FaceAngleY", Math.max(-20, Math.min(20, headY + bodyY * 0.75)));
		}
		if (frame.ParamBodyAngleZ !== undefined) {
			const headZ = this.vtsTargetMap.get("FaceAngleZ") ?? 0;
			const bodyZ = frame.ParamBodyAngleZ;
			this.vtsTargetMap.set("FaceAngleZ", Math.max(-25, Math.min(25, headZ + bodyZ * 0.75)));
		}

		// 眼神微笑联动：若帧内无显式 ParamMouthForm，但存在眼部微笑，联动驱动 MouthSmile
		// （因为二次元模型如 MO 将左右眼微笑统一绑定至 MouthSmile 输入源）
		if (frame.ParamMouthForm === undefined) {
			const eyeSmile = Math.max(frame.ParamEyeLSmile ?? 0, frame.ParamEyeRSmile ?? 0);
			if (eyeSmile > 0) {
				const existing = this.vtsTargetMap.get("MouthSmile") ?? 0;
				if (existing >= 0) {
					this.vtsTargetMap.set("MouthSmile", Math.max(existing, eyeSmile));
				}
			}
		}

		let idx = 0;
		this.vtsTargetMap.forEach((value, id) => {
			if (idx < this.cachedParamValues.length) {
				const item = this.cachedParamValues[idx]!;
				item.id = id;
				item.value = value;
				item.weight = 1.0;
			} else {
				this.cachedParamValues.push({ id, value, weight: 1.0 });
			}
			idx++;
		});
		this.cachedParamValues.length = idx;

		return this.cachedParamValues;
	}

	getComputedTargetMap(): ReadonlyMap<string, number> {
		return this.vtsTargetMap;
	}
}

