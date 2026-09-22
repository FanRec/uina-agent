/**
 * cognition.json 读写（M3/M6 共享）：遗忘抑制、整理水位等扩展运行状态的唯一持久化通道。
 *
 * 不变量：读改写由调用方在各自串行通道内完成（memory 的写链 / worker 的单任务）；
 * 本模块只负责文件格式与容错——BOM 头（Windows 编辑器常见）剥离，坏 JSON 视为空状态
 * （文件是加速恢复用状态，损坏不阻塞记忆权威 records/）。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const COGNITION_STATE_FILE = "cognition.json";

export interface CognitionState {
	/** 已遗忘记录 ID（抑制召回与整理复活）。 */
	forgottenIds?: string[];
	/** 整理水位：已处理过的证据条数（按证据列表稳定序）。 */
	consolidationWatermark?: number;
}

export function readCognitionState(stateRoot: string): CognitionState {
	const path = join(stateRoot, COGNITION_STATE_FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as CognitionState;
	} catch {
		return {};
	}
}

/** 读改写合并：以 mutator 的返回值整体替换状态并落盘（调用方保证串行）。 */
export async function updateCognitionState(
	stateRoot: string,
	mutate: (state: CognitionState) => CognitionState,
): Promise<void> {
	await mkdir(stateRoot, { recursive: true });
	const next = mutate(readCognitionState(stateRoot));
	await writeFile(join(stateRoot, COGNITION_STATE_FILE), JSON.stringify(next, null, "\t"), "utf8");
}
