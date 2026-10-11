import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRig, type ModelRig } from "../adapter/rig.js";

/**
 * 模型 rig 装配：rig 是作者标定的**数据文件**（models/<folder>/rig.json），
 * 读取时过 validateRig 全量校验，拒绝任何不完整或非法的手工配置。
 *
 * 当前仅登记 MO；新模型在 MODELS 表加一行（folder 名即模型包目录）。
 */
/** 当前唯一已登记模型的身份（VTS 模型内容地址）。 */
export const MO_MODEL_ID = "da0021cd32ee464ca41f980e8c32515b";

const MODELS: Readonly<Record<string, string>> = {
	[MO_MODEL_ID]: "mo",
};

/** 按模型身份加载并校验 rig；未登记的模型返回 undefined（诚实零输出）。 */
export async function loadRig(modelID: string): Promise<ModelRig | undefined> {
	const folder = MODELS[modelID];
	if (!folder) return undefined;
	const path = resolve(dirname(fileURLToPath(import.meta.url)), folder, "rig.json");
	const rig = JSON.parse(await readFile(path, "utf8")) as ModelRig;
	validateRig(rig);
	if (rig.modelID !== modelID) throw new Error(`rig 身份不匹配: 文件 ${rig.modelID} ≠ 请求 ${modelID}`);
	return rig;
}

/** 模型包目录（models/<folder>/）；acceptance.json sidecar 的归属地。未登记模型返回 undefined。 */
export function modelPackageDir(modelID: string): string | undefined {
	const folder = MODELS[modelID];
	if (!folder) return undefined;
	return resolve(dirname(fileURLToPath(import.meta.url)), folder);
}
