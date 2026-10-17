/**
 * 受管不可变字节对象存储（LEAD S-A2，assets.md §4/§5.3/§7.4）。
 *
 * - stage：把可信所有者的字节流接收进本次尝试独占的 tmp/<attemptId>（接收时计算
 *   摘要与长度），分配不复用的 objectId；未发布的暂存对象不可通过 read 到达。
 * - install：提交临界区内把 tmp/<attemptId> 整目录 rename 为全新 objects/<objectId>，
 *   禁止覆盖已有对象；事务回滚留下的只是未引用 orphan。
 * - readObject：流式读出并在完整读取结束时核对实际长度与摘要；range 读不做摘要核验。
 * - objectId/attemptId 由本存储（可信宿主侧）生成，uuid 不复用。
 */

import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	renameSync,
	existsSync,
	openSync,
	closeSync,
	fsyncSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AssetObject, AssetObjectPort } from "../../contracts/assets.js";
import type { Ref } from "../../contracts/values.js";
import { assetFailure } from "./failure.js";
import { canonicalJson, type Digest } from "./canonical.js";

const CHUNK_SIZE = 64 * 1024;

export interface StagedObjectRecord {
	readonly attemptId: string;
	readonly objectId: string;
	readonly digest: Digest;
	readonly byteLength: number;
	readonly mediaType?: string;
	readonly fileName?: string;
}

interface ObjectMeta {
	digest: Digest;
	byteLength: number;
	mediaType?: string;
	fileName?: string;
}

function isMeta(value: unknown): value is ObjectMeta {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.digest)) return false;
	if (typeof record.byteLength !== "number" || !Number.isInteger(record.byteLength) || record.byteLength < 0) {
		return false;
	}
	if (record.mediaType !== undefined && typeof record.mediaType !== "string") return false;
	if (record.fileName !== undefined && typeof record.fileName !== "string") return false;
	return true;
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
	/** requestId → (key → 暂存记录)。同 key 重复 stage 后写者胜，旧 attempt 目录被回收。 */
	private readonly staged = new Map<string, Map<string, StagedObjectRecord>>();

	constructor(dataDir: string) {
		this.objectsDir = join(dataDir, "objects");
		this.tmpDir = join(dataDir, "tmp");
		mkdirSync(this.objectsDir, { recursive: true });
		mkdirSync(this.tmpDir, { recursive: true });
	}

	stagedRecord(requestId: string, key: string): StagedObjectRecord | undefined {
		return this.staged.get(requestId)?.get(key);
	}

	/** 提交成功后释放该请求的暂存记录（暂存字节已随 attempt 目录安装或留作 orphan）。 */
	releaseStaged(requestId: string): void {
		this.staged.delete(requestId);
	}

	async stage(
		request: { requestId: Ref; key: string; mediaType?: string; fileName?: string },
		bytes: AsyncIterable<Uint8Array>,
	): Promise<AssetObject> {
		if (typeof request.requestId !== "string" || request.requestId.length === 0) {
			assetFailure("ASSET_INVALID", "stage 需要 requestId");
		}
		if (typeof request.key !== "string" || request.key.length === 0) {
			assetFailure("ASSET_INVALID", "stage 需要 key");
		}
		const attemptId = randomUUID();
		const attemptDir = join(this.tmpDir, attemptId);
		mkdirSync(attemptDir, { recursive: true });
		const payloadPath = join(attemptDir, "payload");
		let digest: Digest;
		let byteLength: number;
		try {
			const handle = await open(payloadPath, "wx");
			try {
				const hash = createHash("sha256");
				let length = 0;
				for await (const chunk of bytes) {
					if (!(chunk instanceof Uint8Array)) assetFailure("ASSET_INVALID", "stage 字节块必须是 Uint8Array");
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
			await rm(attemptDir, { recursive: true, force: true });
			throw error;
		}
		const meta: ObjectMeta = { digest, byteLength, mediaType: request.mediaType, fileName: request.fileName };
		writeFileSync(join(attemptDir, "meta.json"), canonicalJson(meta), "utf8");
		const objectId = `obj-${randomUUID()}`;
		const record: StagedObjectRecord = {
			attemptId,
			objectId,
			digest,
			byteLength,
			mediaType: request.mediaType,
			fileName: request.fileName,
		};
		let perRequest = this.staged.get(request.requestId);
		if (!perRequest) {
			perRequest = new Map();
			this.staged.set(request.requestId, perRequest);
		}
		const replaced = perRequest.get(request.key);
		if (replaced) {
			// 同 key 重新 stage：新 attempt 独立，旧 attempt 回收，不共用可写目录。
			await rm(join(this.tmpDir, replaced.attemptId), { recursive: true, force: true });
		}
		perRequest.set(request.key, record);
		return {
			ref: objectId,
			digest,
			byteLength,
			mediaType: request.mediaType,
			fileName: request.fileName,
		};
	}

	/** 在提交事务内安装一个已 fsync 的 attempt 目录为全新不可变对象；禁止覆盖。 */
	installSync(record: StagedObjectRecord): void {
		const target = join(this.objectsDir, record.objectId);
		if (existsSync(target)) {
			assetFailure("ASSET_INVALID", `对象目录已存在，objectId 冲突：${record.objectId}`);
		}
		renameSync(join(this.tmpDir, record.attemptId), target);
	}

	/** 把新构建的 manifest 字节写入本次独占的空 attempt 目录并安装为修订包。 */
	installManifestSync(attemptId: string, objectId: string, manifestText: string): void {
		const attemptDir = join(this.tmpDir, attemptId);
		mkdirSync(attemptDir, { recursive: true });
		const manifestPath = join(attemptDir, "manifest.json");
		writeFileSync(manifestPath, manifestText, "utf8");
		syncFile(manifestPath);
		const target = join(this.objectsDir, objectId);
		if (existsSync(target)) {
			assetFailure("ASSET_INVALID", `对象目录已存在，objectId 冲突：${objectId}`);
		}
		renameSync(attemptDir, target);
	}

	createManifestAttempt(): string {
		return randomUUID();
	}

	readManifest(objectId: string): string {
		const path = join(this.objectsDir, objectId, "manifest.json");
		return readFileSync(path, "utf8");
	}

	/** 核对已安装对象的 meta.json 与声明一致（repository.read 的目录级完整性检查）。 */
	verifyInstalledDeclaration(objectId: string, declared: AssetObject): void {
		const metaPath = join(this.objectsDir, objectId, "meta.json");
		let meta: unknown;
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf8"));
		} catch {
			assetFailure("ASSET_CORRUPT", `对象 ${objectId} 的 meta.json 缺失或不可解析`);
		}
		if (!isMeta(meta)) assetFailure("ASSET_CORRUPT", `对象 ${objectId} 的 meta.json 形状不合法`);
		if (
			meta.digest !== declared.digest ||
			meta.byteLength !== declared.byteLength ||
			meta.mediaType !== declared.mediaType ||
			meta.fileName !== declared.fileName
		) {
			assetFailure("ASSET_CORRUPT", `对象 ${objectId} 的 meta 与目录声明不符`);
		}
	}

	objectExists(objectId: string): boolean {
		return existsSync(join(this.objectsDir, objectId, "payload"));
	}

	/** 流式读出对象字节；完整读取（无 range）结束时核对实际长度与摘要（assets.md §7.2）。 */
	async *readObject(
		objectId: string,
		expected: { digest: Digest; byteLength: number } | null,
		range?: { offset: number; length: number },
	): AsyncGenerator<Uint8Array> {
		const payloadPath = join(this.objectsDir, objectId, "payload");
		const handle = await open(payloadPath, "r").catch(() =>
			assetFailure("OBJECT_UNAVAILABLE", `对象 ${objectId} 的字节不存在`),
		);
		try {
			const verify = expected !== null && range === undefined;
			const hash = createHash("sha256");
			const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
			let position = range?.offset ?? 0;
			let remaining = range?.length ?? Number.POSITIVE_INFINITY;
			let total = 0;
			while (remaining > 0) {
				const want = Number.isFinite(remaining) ? Math.min(CHUNK_SIZE, remaining) : CHUNK_SIZE;
				const { bytesRead } = await handle.read(buffer, 0, want, position);
				if (bytesRead === 0) break;
				if (verify) hash.update(buffer.subarray(0, bytesRead));
				total += bytesRead;
				const chunk = new Uint8Array(bytesRead);
				buffer.copy(chunk, 0, 0, bytesRead);
				yield chunk;
				position += bytesRead;
				remaining -= bytesRead;
			}
			if (verify) {
				const digest: Digest = `sha256:${hash.digest("hex")}`;
				if (digest !== expected.digest || total !== expected.byteLength) {
					assetFailure("ASSET_CORRUPT", `对象 ${objectId} 实际字节与声明摘要/长度不符`);
				}
			}
		} finally {
			await handle.close();
		}
	}
}

/** 供 AssetObjectPort 使用：把合同形状委托到存储。 */
export function createObjectPort(
	store: AssetObjectStore,
	resolve: {
		lookup(asset: string, object: string): { objectId: string; digest: Digest; byteLength: number } | null;
	},
): AssetObjectPort {
	return {
		stage(request, bytes) {
			return store.stage(request, bytes);
		},
		async read(request) {
			if (typeof request.asset !== "string" || request.asset.length === 0) {
				assetFailure("ASSET_INVALID", "objects.read 需要确切 asset 引用");
			}
			if (typeof request.object !== "string" || request.object.length === 0) {
				assetFailure("ASSET_INVALID", "objects.read 需要 object 键");
			}
			if (request.range !== undefined) {
				const { offset, length } = request.range;
				if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) {
					assetFailure("ASSET_INVALID", "range 必须是非负整数 offset/length");
				}
			}
			const resolved = resolve.lookup(request.asset, request.object);
			if (!resolved) assetFailure("OBJECT_UNAVAILABLE", `资产 ${request.asset} 没有对象 "${request.object}"`);
			return store.readObject(
				resolved.objectId,
				request.range === undefined ? { digest: resolved.digest, byteLength: resolved.byteLength } : null,
				request.range,
			);
		},
	};
}
