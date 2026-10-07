import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { OperationLog } from "./operation-log.js";

/**
 * QQ 自持 staging（G8）：上传前把允许根内的源文件复制到 worldDataDir/staging/<operationRef>/。
 * 目的：源文件（如 TTS 输出）的后续删除/轮转不影响上传；unknown 操作保留副本作证据。
 * 不引入租约/引用计数（合同明令）；清理按 operationRef 结算状态与 operation-log 对齐。
 */

export interface MediaStagingOptions {
	readonly stagingDir: string;
	readonly ops: OperationLog;
}

export class MediaStaging {
	constructor(private readonly options: MediaStagingOptions) {}

	private dirFor(operationRef: string): string {
		// 无冒号、无碰撞的可逆编码，Windows/POSIX 都能作为单一目录名。
		return resolve(this.options.stagingDir, Buffer.from(operationRef).toString("base64url"));
	}

	/** 复制源文件到该操作的 staging（目录内写 marker 记录原始 operationRef）；返回 staging 内绝对路径。 */
	stage(sourceRealPath: string, operationRef: string): string {
		const dir = this.dirFor(operationRef);
		mkdirSync(dir, { recursive: true });
		if (lstatSync(dir).isSymbolicLink()) throw new Error("staging 操作目录不能是 symlink/junction");
		writeFileSync(join(dir, ".operation"), operationRef, "utf8");
		const target = join(dir, `${randomUUID()}-${basename(sourceRealPath)}`);
		copyFileSync(sourceRealPath, target, constants.COPYFILE_EXCL);
		return target;
	}

	/**
	 * 启动清理：删除已确定（succeeded/failed/cancelled/not_started）操作的 staging；
	 * unknown 保留（证据；不自动重发但可核验）。孤儿目录（marker 缺失或无对应记录）保留并计数——
	 * 不猜测归属，供人工检查。
	 */
	cleanupSettled(): { removed: number; keptUnknown: number; keptOrphan: number } {
		let removed = 0;
		let keptUnknown = 0;
		let keptOrphan = 0;
		if (!existsSync(this.options.stagingDir)) return { removed, keptUnknown, keptOrphan };
		for (const entry of readdirSync(this.options.stagingDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(this.options.stagingDir, entry.name);
			const marker = this.readMarker(dir);
			if (!marker) {
				keptOrphan++;
				continue;
			}
			const record = this.options.ops.get(marker);
			if (!record || resolve(dir) !== this.dirFor(marker)) {
				keptOrphan++;
				continue;
			}
			if (record.outcome === "unknown") {
				keptUnknown++;
				continue;
			}
			rmSync(dir, { recursive: true, force: true });
			removed++;
		}
		return { removed, keptUnknown, keptOrphan };
	}

	/** 单个操作结算为确定结论后立即清理（可选的即时路径）。 */
	removeIfSettled(operationRef: string): boolean {
		const record = this.options.ops.get(operationRef);
		if (!record || record.outcome === "unknown") return false;
		const dir = this.dirFor(operationRef);
		if (!existsSync(dir)) return false;
		if (lstatSync(dir).isSymbolicLink()) return false;
		rmSync(dir, { recursive: true, force: true });
		return true;
	}

	/** staging 内占用统计（诊断用）。 */
	usage(): { files: number; bytes: number } {
		let files = 0;
		let bytes = 0;
		if (!existsSync(this.options.stagingDir)) return { files, bytes };
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else {
					files++;
					try {
						bytes += statSync(full).size;
					} catch {
						// 单文件统计失败不影响总量
					}
				}
			}
		};
		walk(this.options.stagingDir);
		return { files, bytes };
	}

	private readMarker(dir: string): string | null {
		try {
			const markerPath = join(dir, ".operation");
			if (!existsSync(markerPath)) return null;
			return readFileSync(markerPath, "utf8").trim() || null;
		} catch {
			return null;
		}
	}
}
