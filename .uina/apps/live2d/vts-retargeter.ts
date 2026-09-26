import type { VTSParamValue } from "./vts-client.js";

/**
 * Live2D Cubism 模型参数与 VTube Studio 标准输入追踪参数映射表
 */
export const CUBISM_TO_VTS_MAP: Readonly<Record<string, string | readonly string[]>> = Object.freeze({
	ParamAngleX: "FaceAngleX",
	ParamAngleY: "FaceAngleY",
	ParamAngleZ: "FaceAngleZ",
	ParamBodyAngleX: "FacePositionX",
	ParamBodyAngleY: "FacePositionY",
	ParamBodyAngleZ: "FacePositionZ",
	ParamEyeBallX: ["EyeLeftX", "EyeRightX"],
	ParamEyeBallY: ["EyeLeftY", "EyeRightY"],
	ParamEyeLOpen: "EyeOpenLeft",
	ParamEyeROpen: "EyeOpenRight",
	ParamEyeLSmile: "MouthSmile",
	ParamEyeRSmile: "MouthSmile",
	ParamBrowLY: ["Brows", "BrowLeftY"],
	ParamBrowRY: ["Brows", "BrowRightY"],
	ParamMouthOpenY: "MouthOpen",
	ParamMouthForm: "MouthSmile",
	ParamCheek: "CheekPuff",
});

/**
 * VTS 参数重定向与语义融合器 (VTSParameterRetargeter)
 * 职责：Cubism -> VTS 标准映射、MouthSmile 极性保护融合、躯干旋转与微晃比例映射、胸腔微起伏。
 */
export class VTSParameterRetargeter {
	private readonly vtsTargetMap = new Map<string, number>();
	private readonly cachedParamValues: VTSParamValue[] = [];

	private accumulateVtsParam(targetId: string, sourceId: string, value: number): void {
		if (targetId === "MouthSmile") {
			if (sourceId === "ParamMouthForm") {
				if (value < 0) {
					this.vtsTargetMap.set("MouthSmile", value);
					return;
				}
				const existing = this.vtsTargetMap.get("MouthSmile") ?? 0;
				this.vtsTargetMap.set("MouthSmile", Math.max(existing, value));
				return;
			}
			const existing = this.vtsTargetMap.get("MouthSmile");
			if (existing !== undefined && existing < 0) return;
			this.vtsTargetMap.set("MouthSmile", Math.max(existing ?? 0, value));
			return;
		}

		let vtsVal = value;
		if (sourceId.startsWith("ParamBodyAngle")) {
			vtsVal = Math.max(-10, Math.min(10, value * 0.25));
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

		if (frame.ParamBreath !== undefined) {
			const currentY = this.vtsTargetMap.get("FacePositionY") ?? 0;
			this.vtsTargetMap.set("FacePositionY", currentY + (frame.ParamBreath - 0.5) * 0.7);
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
