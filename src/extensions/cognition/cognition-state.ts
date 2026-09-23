/**
 * cognition.json 读写（M3/M6 共享）：遗忘抑制、整理水位等扩展运行状态的唯一持久化通道。
 *
 * 不变量：同一进程内所有读改写请求按 stateRoot 串行，并以完整临时文件原子发布；
 * BOM 头（Windows 编辑器常见）剥离，坏 JSON 视为空状态（文件是加速恢复用状态，
 * 损坏不阻塞记忆权威 records/）。跨进程互斥由上层 host.lock 保证。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

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
		return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as CognitionState;
	} catch {
		return {};
	}
}

/** 每个状态文件独立排队，避免不相关主体互相阻塞。 */
const stateWriteTails = new Map<string, Promise<void>>();

/** 读改写合并：以 mutator 的返回值整体替换状态并原子落盘。 */
export function updateCognitionState(
	stateRoot: string,
	mutate: (state: CognitionState) => CognitionState,
): Promise<void> {
	const path = resolve(join(stateRoot, COGNITION_STATE_FILE));
	const previous = stateWriteTails.get(path) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(async () => {
		await mkdir(stateRoot, { recursive: true });
		const current = readCognitionState(stateRoot);
		const updated = mutate(current);
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(updated, null, "\t"), "utf8");
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	});
	let tracked!: Promise<void>;
	tracked = next.finally(() => {
		if (stateWriteTails.get(path) === tracked) stateWriteTails.delete(path);
	});
	stateWriteTails.set(path, tracked);
	return tracked;
}
