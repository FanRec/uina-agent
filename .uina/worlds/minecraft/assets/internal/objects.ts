/**
 * 受管不可变修订包存储（assets.md §4/§5.3/§7.4）。
 *
 * - 捕获：把发布来源的字节接收进本次尝试独占的 tmp/<attemptId>/<path>（接收时计算
 *   摘要与长度）；未发布的暂存内容不可通过 readPayload 到达。
 * - 安装：提交临界区内把 tmp/<attemptId> 整目录 rename 为全新 objects/<objectId>，
 *   禁止覆盖已有对象；事务回滚留下的只是未引用 orphan。
 * - readObject：流式读出并在完整读取结束时核对实际长度与摘要（assets.md §7.2）。
 * - objectId/attemptId 由本存储（可信宿主侧）生成，uuid 不复用。
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Digest } from "../../contracts/assets.js";
import { canonicalJson } from "./canonical.js";
import { assetFailure } from "./failure.js";

const CHUNK_SIZE = 64 * 1024;

export interface CapturedFile {
	readonly path: string;
	readonly digest: Digest;
	readonly byteLength: number;
}

/** fsync 单个已存在文件（写入顺序不等于跨存储断电原子性，assets.md §7.4）。 */
function syncFile(path: string): void {
	const handle = openSync(path, "r+");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

export class AssetObjectStore {
	private readonly objectsDir: string;
	private readonly tmpDir: string;

	constructor(dataDir: string) {
		this.objectsDir = join(dataDir, "objects");
		this.tmpDir = join(dataDir, "tmp");
		mkdirSync(this.objectsDir, { recursive: true });
		mkdirSync(this.tmpDir, { recursive: true });
	}

	/** 本次发布尝试的独占暂存目录；每次尝试新 ID，不因 operation.id 相同共用。 */
	createAttempt(): string {
		const attemptId = randomUUID();
		mkdirSync(join(this.tmpDir, attemptId), { recursive: true });
		return attemptId;
	}

	/** 把一次来源读取的字节接收进暂存目录（单次读取，接收时计算摘要与长度）。 */
	async captureFile(attemptId: string, relPath: string, bytes: AsyncIterable<Uint8Array>): Promise<CapturedFile> {
		assertSafeRelPath(relPath);
		const target = join(this.tmpDir, attemptId, ...relPath.split("/"));
		mkdirSync(join(target, ".."), { recursive: true });
		let digest: Digest;
		let byteLength: number;
		try {
			const handle = await open(target, "wx");
			try {
				const hash = createHash("sha256");
				let length = 0;
				for await (const chunk of bytes) {
					if (!(chunk instanceof Uint8Array)) assetFailure("ASSET_INVALID", "捕获字节块必须是 Uint8Array");
					await handle.write(chunk);
					hash.update(chunk);
					length += chunk.byteLength;
				}
				await handle.sync();
				digest = `sha256:${hash.digest("hex")}`;
				byteLength = length;
			} finally {
				await handle.close();
			}
		} catch (error) {
			// 接收失败：本次 attempt 目录可回收（assets.md §6.4 取消时点表）。
			await rm(join(this.tmpDir, attemptId), { recursive: true, force: true });
			throw error;
		}
		return { path: relPath, digest, byteLength };
	}

	/** 写入暂存字节（来源已是完整缓冲时使用，免去流包装）。 */
	writeCapturedBytes(attemptId: string, relPath: string, bytes: Uint8Array): CapturedFile {
		assertSafeRelPath(relPath);
		const target = join(this.tmpDir, attemptId, ...relPath.split("/"));
		mkdirSync(join(target, ".."), { recursive: true });
		const handle = openSync(target, "wx");
		try {
			writeFileSync(handle, bytes);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		return {
			path: relPath,
			digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			byteLength: bytes.byteLength,
		};
	}

	/** 读取捕获记录（发布流程内核对暂存内容存在性）。 */
	stagedFile(attemptId: string, relPath: string): CapturedFile | null {
		const metaPath = join(this.tmpDir, attemptId, `${relPath}.mcmeta`);
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CapturedFile;
			if (meta.path === relPath && typeof meta.digest === "string" && typeof meta.byteLength === "number") {
				return meta;
			}
			return null;
		} catch {
			return null;
		}
	}

	/** 登记捕获记录（mcmeta），供声明身份与实际字节的核对。 */
	recordCaptured(attemptId: string, captured: CapturedFile): void {
		const metaPath = join(this.tmpDir, attemptId, `${captured.path}.mcmeta`);
		writeFileSync(metaPath, canonicalJson(captured), "utf8");
		syncFile(metaPath);
	}

	/** 提交临界区：写入包 Manifest 并把整个 attempt 目录安装为全新不可变对象；禁止覆盖。 */
	installPackage(attemptId: string, objectId: string, manifestText: string): void {
		const attemptDir = join(this.tmpDir, attemptId);
		const manifestPath = join(attemptDir, "manifest.json");
		writeFileSync(manifestPath, manifestText, "utf8");
		syncFile(manifestPath);
		const target = join(this.objectsDir, objectId);
		if (existsSync(target)) {
			assetFailure("ASSET_INVALID", `对象目录已存在，objectId 冲突：${objectId}`);
		}
		renameSync(attemptDir, target);
	}

	discardAttempt(attemptId: string): void {
		void rm(join(this.tmpDir, attemptId), { recursive: true, force: true }).catch(() => undefined);
	}

	readManifest(objectId: string): string {
		const path = join(this.objectsDir, objectId, "manifest.json");
		try {
			return readFileSync(path, "utf8");
		} catch {
			assetFailure("ASSET_CORRUPT", `修订包 manifest.json 缺失或不可读（objectId=${objectId}）`);
		}
	}

	objectExists(objectId: string): boolean {
		return existsSync(join(this.objectsDir, objectId, "manifest.json"));
	}

	/** 流式读出对象内文件；完整读取结束时核对实际长度与摘要（assets.md §7.2）。 */
	async *readObject(
		objectId: string,
		relPath: string,
		expected: { digest: Digest; byteLength: number },
	): AsyncGenerator<Uint8Array> {
		assertSafeRelPath(relPath);
		const payloadPath = join(this.objectsDir, objectId, ...relPath.split("/"));
		const handle = await open(payloadPath, "r").catch(() =>
			assetFailure("OBJECT_UNAVAILABLE", `对象 ${objectId} 的 "${relPath}" 不存在`),
		);
		try {
			const hash = createHash("sha256");
			const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
			let total = 0;
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, total);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
				total += bytesRead;
				const chunk = new Uint8Array(bytesRead);
				buffer.copy(chunk, 0, 0, bytesRead);
				yield chunk;
			}
			const digest: Digest = `sha256:${hash.digest("hex")}`;
			if (digest !== expected.digest || total !== expected.byteLength) {
				assetFailure("ASSET_CORRUPT", `对象 ${objectId}/${relPath} 实际字节与声明摘要/长度不符`);
			}
		} finally {
			await handle.close();
		}
	}
}

/** 包内相对路径安全规则（assets.md §11.3）：小写 ASCII 组件与 /；拒绝空组件、绝对路径、..、反斜杠、保留设备名。 */
export function assertSafeRelPath(relPath: string): void {
	if (typeof relPath !== "string" || relPath.length === 0) assetFailure("ASSET_INVALID", "路径不能为空");
	if (relPath.includes("\\") || relPath.startsWith("/") || relPath.endsWith("/")) {
		assetFailure("ASSET_INVALID", `路径不合法：${relPath}`);
	}
	if (posix.normalize(relPath) !== relPath || relPath.split("/").includes("..")) {
		assetFailure("ASSET_INVALID", `路径不得包含 .. 或非规范段：${relPath}`);
	}
	for (const segment of relPath.split("/")) {
		if (segment.length === 0) assetFailure("ASSET_INVALID", "路径存在空组件");
		if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
			assetFailure("ASSET_INVALID", `路径段须为小写 ASCII 安全字符：${segment}`);
		}
		const base = segment.split(".", 1)[0];
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
			assetFailure("ASSET_INVALID", `路径段使用 Windows 保留设备名：${segment}`);
		}
	}
	if (relPath === "manifest.json") assetFailure("ASSET_INVALID", "manifest.json 是保留路径，不能作为 payload");
}

/** 按扩展名推导 mediaType（assets.md §5.2 安全表）；只是提示，不认证内容。 */
export function mediaTypeOfPath(path: string): string {
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".js")) return "text/javascript";
	if (path.endsWith(".md")) return "text/markdown";
	return "application/octet-stream";
}
