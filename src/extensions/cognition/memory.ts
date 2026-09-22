/**
 * MemoryStore（认知扩展阶段 B / M3）：权威记录 + 单 writer。
 *
 * 不变量：
 * 1. 每条记录任意时刻恰好一个当前版本——文件（records/<id>.md）是权威，
 *    内存索引只是可重建的加速层；读未命中必回源磁盘扫描（索引降级诚实实现）。
 * 2. 写路径全串行（进程内 promise 链；跨进程互斥由阶段 A 的 wx host.lock 保证）。
 * 3. 乐观并发：更新条件是读出时的整文件内容 hash（expectedHash）。
 *    committed 必带新 hash；冲突返回 conflict + 当前 hash；不覆盖、不自动重试。
 *    禁止发明跨文件事务/写队列框架。
 * 4. 遗忘顺序：抑制记录先落盘（state/cognition.json）→ 停召回 → 清理副本。
 *    遗忘 ≠ 删除 journal（journal 不归本模块管）。
 * 5. subjectId 绑定：meta.subjectId 与构造绑定的主体不符的文件跳过——不读、不搜、不写。
 *
 * 写入顺序（design §8）：验证 → 串行 → 备份旧版本 → 写临时文件 → rename 替换 → 更新索引 → 返回。
 * 备份失败则不覆盖旧版；替换后索引更新失败以文件为准（下次读回源重建）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCognitionState, updateCognitionState } from "./cognition-state.js";

// ---------- 数据模型（design §7） ----------

export type MemoryType = "note" | "commitment" | "procedure";
export type MemoryBasis = "observed" | "reported" | "inferred";
export type MemoryStatus = "active" | "retired";

export interface MemoryScope {
	spaceId?: string;
	projectId?: string;
	actorId?: string;
}

export interface MemorySourceRef {
	sessionId: string;
	entryId?: string;
	note?: string;
}

export interface MemoryMeta {
	schema: 1;
	id: string;
	revision: number;
	type: MemoryType;
	basis: MemoryBasis;
	subjectId: string;
	scope: MemoryScope;
	sources: MemorySourceRef[];
	/** basis=inferred 时的依据说明（无来源写入的必要条件）。 */
	rationale?: string;
	status: MemoryStatus;
	pinned: boolean;
	title: string;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryRecord extends MemoryMeta {
	body: string;
	/** 读出时的整文件内容 hash——后续 revise/retire 的 expectedHash。 */
	hash: string;
}

// ---------- 写入变更 ----------

export interface NewMemoryRecord {
	type: MemoryType;
	basis: MemoryBasis;
	title: string;
	body: string;
	scope: MemoryScope;
	sources: MemorySourceRef[];
	rationale?: string;
	pinned: boolean;
}

export interface RevisedMemoryRecord {
	title?: string;
	body?: string;
	scope?: MemoryScope;
	sources?: MemorySourceRef[];
	rationale?: string;
	pinned?: boolean;
}

export type MemoryChange =
	| { op: "create"; record: NewMemoryRecord }
	| { op: "revise"; id: string; expectedHash: string; record: RevisedMemoryRecord }
	| { op: "retire"; id: string; expectedHash: string; reason: string };

// ---------- 结果（五态适配前的服务层三态；conflict 必带当前 hash） ----------

export type MemoryWriteResult =
	| { status: "committed"; id: string; hash: string; revision: number }
	| { status: "conflict"; id: string; currentHash: string; reason: string }
	| { status: "rejected"; id?: string; reason: string };

// ---------- 检索 ----------

export interface RecallScope extends MemoryScope {}

export interface MemoryHit {
	id: string;
	title: string;
	excerpt: string;
	hash: string;
	revision: number;
	score: number;
	pinned: boolean;
}

// ---------- 构造参数 ----------

export interface MemoryStoreOptions {
	subjectId: string;
	memoryRoot: string;
	stateRoot: string;
	sessionId: string;
	/**
	 * 来源校验回调（Host 注入）：引用必须指向本主体可用历史。
	 * 返回 false = 来源不存在/不可用。entryId 缺省时校验 sessionId 即可。
	 */
	validateSource: (ref: MemorySourceRef) => Promise<boolean>;
}

const META_COMMENT_PREFIX = "<!-- uina-memory ";
const RECORDS_DIR = "records";
const REVISIONS_DIR = "revisions";

// ---------- 序列化 ----------

function serializeRecord(meta: MemoryMeta, body: string): string {
	const metaLine = `${META_COMMENT_PREFIX}${JSON.stringify(meta)} -->`;
	return `${metaLine}\n# ${meta.title}\n\n${body}\n`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseRecordFile(raw: string, subjectId: string): MemoryRecord | undefined {
	const firstLineEnd = raw.indexOf("\n");
	if (!raw.startsWith(META_COMMENT_PREFIX) || firstLineEnd < 0) return undefined; // 损坏文件：报告并排除
	const metaJson = raw.slice(META_COMMENT_PREFIX.length, raw.indexOf("-->")).trim();
	let meta: MemoryMeta;
	try {
		meta = JSON.parse(metaJson) as MemoryMeta;
	} catch {
		return undefined;
	}
	// 主体绑定校验：他人的记录对当前 store 完全不可见。
	if (meta.subjectId !== subjectId) return undefined;
	const body = raw.slice(firstLineEnd + 1).replace(/^# .*\n+/, "").trimEnd();
	return { ...meta, body, hash: sha256(raw) };
}

// ---------- MemoryStore ----------

export interface MemoryStore {
	read(id: string): Promise<MemoryRecord | undefined>;
	/** 列举当前主体全部可用记录（整理快照等真实消费者用——search 需要查询词，不适合当列举器）。 */
	listActive(): Promise<MemoryRecord[]>;
	search(query: string, scope: RecallScope): Promise<MemoryHit[]>;
	write(change: MemoryChange): Promise<MemoryWriteResult>;
	forget(id: string): Promise<void>;
	/** 测试/降级验证用：清空内存索引，强制读路径回源磁盘。 */
	invalidateIndex(): void;
	/** 等待在途写结算；此后写入明确拒绝（弱合同转硬合同：不靠调用方自觉）。 */
	close(): Promise<void>;
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
	const { subjectId, memoryRoot, stateRoot, sessionId } = options;
	const recordsDir = join(memoryRoot, RECORDS_DIR);
	const revisionsDir = join(memoryRoot, REVISIONS_DIR);

	// 内存索引：id → {meta, body, raw}。权威在文件；未命中回源扫描。
	type IndexedRecord = MemoryRecord & { raw: string };
	let index = new Map<string, IndexedRecord>();
	let closed = false;

	const forgotten = (): Set<string> => new Set(readCognitionState(stateRoot).forgottenIds ?? []);

	/** 权威回源：扫描 records/ 目录重建索引（损坏文件跳过——报告排除，不拿他库回填）。 */
	const rebuildIndex = async (): Promise<void> => {
		const next = new Map<string, IndexedRecord>();
		const suppressed = forgotten();
		if (existsSync(recordsDir)) {
			for (const file of await readdir(recordsDir)) {
				if (!file.endsWith(".md")) continue;
				try {
					const raw = await readFile(join(recordsDir, file), "utf8");
					const record = parseRecordFile(raw, subjectId);
					if (record && !suppressed.has(record.id)) next.set(record.id, { ...record, raw });
				} catch {
					// 不可读：排除该项，不阻塞其余记录。
				}
			}
		}
		index = next;
	};

	const load = async (id: string): Promise<IndexedRecord | undefined> => {
		if (forgotten().has(id)) return undefined;
		const cached = index.get(id);
		if (cached) return cached;
		await rebuildIndex();
		return index.get(id);
	};

	/** 串行化写通道：所有写请求经 promise 链排队，天然消除进程内并发交错。 */
	let writeTail: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
		const result = writeTail.then(task, task);
		writeTail = result.catch(() => {}); // 链不因单次失败断裂
		return result;
	};

	// scope 匹配：已填字段必须全部匹配当前上下文；无字段 = 主体全局。
	const scopeMatches = (recordScope: MemoryScope, current: RecallScope): boolean => {
		for (const key of ["spaceId", "projectId", "actorId"] as const) {
			if (recordScope[key] !== undefined && recordScope[key] !== current[key]) return false;
		}
		return true;
	};

	/** 确定性中文片段匹配（备忘 §3.4：偏精确、宁可漏；不用模型、不造分词）。 */
	const matchScore = (record: IndexedRecord, query: string): number => {
		const q = query.trim();
		if (!q) return 0;
		const haystack = `${record.title}\n${record.body}`;
		let score = 0;
		for (const term of q.split(/\s+/).filter(Boolean)) {
			if (haystack.includes(term)) score += term.length >= 2 ? 2 : 1;
		}
		return score;
	};

	const validateSources = async (sources: MemorySourceRef[], basis: MemoryBasis, rationale?: string): Promise<string | undefined> => {
		if (basis === "inferred") {
			if (!rationale || !rationale.trim()) return "basis=inferred 必须提供 rationale（依据说明），不能伪造证据";
		} else {
			if (!sources.length) return `basis=${basis} 必须提供来源引用`;
			for (const ref of sources) {
				if (ref.sessionId !== sessionId) {
					return `来源 sessionId ${ref.sessionId} 不属于当前主体会话 ${sessionId}`;
				}
				if (ref.entryId && !(await options.validateSource(ref))) {
					return `来源引用不存在或不可用：${ref.sessionId}/${ref.entryId}`;
				}
			}
		}
		return undefined;
	};

	const store: MemoryStore = {
		async read(id) {
			const record = await load(id);
			if (!record) return undefined;
			const { raw, ...rest } = record;
			return rest;
		},

		async listActive() {
			if (index.size === 0) await rebuildIndex();
			const suppressed = forgotten();
			const out: MemoryRecord[] = [];
			for (const record of index.values()) {
				if (record.status !== "active" || suppressed.has(record.id)) continue;
				const { raw: _raw, ...rest } = record;
				out.push(rest);
			}
			return out;
		},

		async search(query, scope) {
			// 索引为空时回源一次（首次搜索的懒加载）。
			if (index.size === 0) await rebuildIndex();
			const suppressed = forgotten();
			const hits: MemoryHit[] = [];
			for (const record of index.values()) {
				if (record.status !== "active" || suppressed.has(record.id)) continue;
				if (!scopeMatches(record.scope, scope)) continue;
				const score = matchScore(record, query);
				if (score > 0) {
					hits.push({
						id: record.id,
						title: record.title,
						excerpt: record.body.slice(0, 120),
						hash: record.hash,
						revision: record.revision,
						score,
						pinned: record.pinned,
					});
				}
			}
			return hits.sort((a, b) => b.score - a.score);
		},

		write(change) {
			return enqueue(async (): Promise<MemoryWriteResult> => {
				if (closed) return { status: "rejected", reason: "MemoryStore 已关闭，不再接受写入" };
				await mkdir(recordsDir, { recursive: true });
				await mkdir(revisionsDir, { recursive: true });

				if (change.op === "create") {
					const id = `m${randomUUID().slice(0, 8)}`;
					const reject = await validateSources(change.record.sources, change.record.basis, change.record.rationale);
					if (reject) return { status: "rejected", reason: reject };
					if (!change.record.title.trim() || !change.record.body.trim()) {
						return { status: "rejected", reason: "title 与 body 不得为空" };
					}
					const now = new Date().toISOString();
					const meta: MemoryMeta = {
						schema: 1,
						id,
						revision: 1,
						type: change.record.type,
						basis: change.record.basis,
						subjectId,
						scope: change.record.scope,
						sources: change.record.sources,
						rationale: change.record.rationale,
						status: "active",
						pinned: change.record.pinned,
						title: change.record.title,
						createdAt: now,
						updatedAt: now,
					};
					return commit(id, meta, change.record.body, undefined);
				}

				// revise / retire 共同前置：目标必须存在、hash 必须匹配。
				const current = await load(change.id);
				if (!current) {
					return { status: "rejected", id: change.id, reason: `记录不存在或已被遗忘：${change.id}` };
				}
				if (current.hash !== change.expectedHash) {
					return {
						status: "conflict",
						id: change.id,
						currentHash: current.hash,
						reason: "expectedHash 与当前版本不符；请重新读取后再决定，不自动覆盖",
					};
				}

				if (change.op === "retire") {
					if (current.status === "retired") {
						return { status: "rejected", id: change.id, reason: "记录已是 retired 状态" };
					}
					const meta: MemoryMeta = { ...stripRaw(current), status: "retired", updatedAt: new Date().toISOString() };
					return commit(change.id, meta, current.body, current);
				}

				// revise：合并字段；主体归属与 ID 不可变。
				const r = change.record;
				const mergedSources = r.sources ?? current.sources;
				const mergedBasis = r.rationale !== undefined && mergedSources.length === 0 ? "inferred" : current.basis;
				const reject = await validateSources(mergedSources, mergedBasis, r.rationale ?? current.rationale);
				if (reject) return { status: "rejected", id: change.id, reason: reject };
				const meta: MemoryMeta = {
					...stripRaw(current),
					revision: current.revision + 1,
					title: r.title ?? current.title,
					scope: r.scope ?? current.scope,
					sources: mergedSources,
					rationale: r.rationale ?? current.rationale,
					pinned: r.pinned ?? current.pinned,
					basis: mergedBasis,
					updatedAt: new Date().toISOString(),
				};
				return commit(change.id, meta, r.body ?? current.body, current);
			});
		},

		async forget(id) {
			return enqueue(async () => {
				if (closed) throw new Error("MemoryStore 已关闭，不再接受遗忘操作");
				// 顺序（备忘 §3.3）：抑制记录先落盘 → 停召回 → 清理副本。
				await updateCognitionState(stateRoot, (state) => ({
					...state,
					forgottenIds: [...new Set([...state.forgottenIds ?? [], id])],
				}));
				index.delete(id);
				await rm(join(recordsDir, `${id}.md`), { force: true });
				await rm(join(revisionsDir, id), { recursive: true, force: true });
			});
		},

		invalidateIndex() {
			index = new Map();
		},

		async close() {
			closed = true;
			await writeTail;
		},
	};

	/** 统一提交路径：序列化 → hash 单算 → 备份（有旧版时）→ 原子替换 → 更新索引 → 返回。
	 * 备份失败则不覆盖旧版；替换后索引更新失败以文件为准（下次读回源重建）。 */
	async function commit(id: string, meta: MemoryMeta, body: string, previous: IndexedRecord | undefined): Promise<MemoryWriteResult> {
		const raw = serializeRecord(meta, body);
		const hash = sha256(raw);
		if (previous) await backupAndReplace(id, previous, raw);
		else {
			// create：临时文件 + rename，进程异常时当前文件为不存在或完整新版，不出现半写。
			const tmpPath = join(recordsDir, `.${id}.tmp`);
			await writeFile(tmpPath, raw, "utf8");
			await rename(tmpPath, join(recordsDir, `${id}.md`));
		}
		index.set(id, { ...meta, body, hash, raw });
		return { status: "committed", id, hash, revision: meta.revision };
	}

	/** 备份旧版本到 revisions/<id>/，成功后原子替换当前文件。备份失败则不覆盖旧版。 */
	async function backupAndReplace(id: string, current: IndexedRecord, newRaw: string): Promise<void> {
		const revDir = join(revisionsDir, id);
		await mkdir(revDir, { recursive: true });
		const backupPath = join(revDir, `rev${String(current.revision).padStart(4, "0")}-${current.hash.slice(0, 8)}.md`);
		await writeFile(backupPath, current.raw, "utf8"); // 备份失败 → 抛出 → 当前文件未被触碰
		const tmpPath = join(recordsDir, `.${id}.tmp`);
		await writeFile(tmpPath, newRaw, "utf8");
		await rename(tmpPath, join(recordsDir, `${id}.md`));
	}

	function stripRaw(record: IndexedRecord): MemoryMeta {
		const { body: _body, hash: _hash, raw: _raw, ...meta } = record;
		return meta;
	}

	return store;
}
