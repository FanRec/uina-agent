import { emptyCatalog, type CatalogSnapshot } from "../../authoring/catalog.js";
import type { ModelRig } from "../../adapter/rig.js";
import { MO_MODEL_ID } from "../rig-loader.js";

/**
 * MO 动作目录。
 *
 * 旧曲线树目录已整体退役至 catalog-bak.ts.txt（动作设计参考：数值、节奏、命名、别名）。
 * 新目录待按曲线函数模型（docs/proposals/live2d-curve-authoring-design.md）重写；
 * 当前诚实空目录：一切命名动作/姿态/表情/注视/环境/外观显式拒绝，不做模糊匹配。
 */
export function loadCatalog(modelID: string, rig: ModelRig): CatalogSnapshot | undefined {
	if (modelID !== MO_MODEL_ID || rig.modelID !== MO_MODEL_ID) return undefined;
	return emptyCatalog(MO_MODEL_ID);
}
