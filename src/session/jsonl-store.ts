import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { AgentMessage, ChatMsg } from "../core/types.js";
import {
	applyRecord,
	canonicalReplay,
	checkRecord,
	initialCanonicalState,
	isRecord,
	planRecovery,
	queuedInputs,
	SessionFormatError,
} from "./recovery.js";
import type { CanonicalState } from "./recovery.js";
import type {
	QueuedInput,
	SessionEventName,
	SessionEventRecord,
	SessionHeader,
	SessionRecord,
	SessionSnapshot,
	SessionStore,
} from "./types.js";

/**
 * Journal schema version, single source of truth for both the writer
 * (header creation) and the reader (parseHeader validation).
 *
 * v3 是当前唯一格式：写 v3、读只接受 v3。不维护迁移链，也没有旧版本
 * reader——旧版本 journal 明确拒绝（新会话开新文件即可，不为旧数据
 * 保留兼容代码）。
 */
const JOURNAL_VERSION = 3;

export async function openJsonlSession(path: string): Promise<{
	store: JsonlSessionStore;
	snapshot: SessionSnapshot;
}> {
	await mkdir(dirname(path), { recursive: true });
	if (!(await pathExists(path))) {
		const header: SessionHeader = {
			kind: "header",
			version: JOURNAL_VERSION,
			id: randomUUID(),
			cwd: process.cwd(),
			createdAt: new Date().toISOString(),
		};
		const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(header)}\n`, "utf8");
		try {
			await rename(temp, path);
		} catch (error) {
			await unlink(temp).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await pathExists(path))) {
				throw error;
			}
		}
	}

	const { header, records, lastSeq } = await readSnapshot(path);
	// Positional writes allow rollback on Windows, where append-only handles
	// cannot be truncated. This store serializes all writes to its handle.
	const handle = await open(path, "r+");
	let store: JsonlSessionStore;
	try {
		store = new JsonlSessionStore(path, handle, lastSeq, records);
	} catch (error) {
		await handle.close();
		throw error;
	}
	// Recovery decisions become auditable facts: planRecovery's entries are
	// persisted under their stable identity (recovered:${originId}:${callId}).
	// Idempotence is structural — a persisted recovery message closes its call,
	// so the next open's plan stays empty.
	try {
		for (const entry of planRecovery(store.state).entries) {
			await store.appendMessage(entry.message, entry.id);
		}
		const snapshotRecords = store.readRecords();
		return {
			store,
			snapshot: {
				header,
				records: [...snapshotRecords],
				entries: [...store.state.entries],
				queued: queuedInputs(store.state),
				lastSeq: snapshotRecords.at(-1)?.seq ?? lastSeq,
			},
		};
	} catch (error) {
		await store.close();
		throw error;
	}
}

export class JsonlSessionStore implements SessionStore {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private writeFailure?: Error;

	/** 常驻 canonical 状态：append = check → 落盘 → apply，内存永不领先磁盘。 */
	readonly state: CanonicalState;
	private readonly records: SessionRecord[];

	constructor(
		readonly path: string,
		private readonly handle: FileHandle,
		private nextSeq: number,
		records: SessionRecord[] = [],
	) {
		this.records = structuredClone(records);
		this.state = canonicalReplay(records);
	}

	readRecords(): readonly SessionRecord[] { return [...this.records]; }
	appendRewind(record: Omit<import("./types.js").SessionRewindRecord, "kind" | "seq" | "timestamp">): Promise<void> {
		return this.append({ ...structuredClone(record), kind:"rewind", seq:++this.nextSeq, timestamp:new Date().toISOString() });
	}

	appendInput(input: QueuedInput): Promise<void> {
		return this.append({ kind: "input", id: randomUUID(), seq: ++this.nextSeq, timestamp: new Date().toISOString(), input: structuredClone(input) });
	}

	appendMessage(message: AgentMessage | ChatMsg, id?: string): Promise<void> {
		return this.append({
			kind: "message",
			id: id ?? randomUUID(),
			seq: ++this.nextSeq,
			timestamp: new Date().toISOString(),
			message,
		});
	}

	appendCustomMessage(message: { customType: string; content: string; images?: import("../core/content.js").ImageContent[]; display?: boolean; details?: unknown }): Promise<void> {
		return this.append({ kind: "custom_message", id: randomUUID(), seq: ++this.nextSeq, timestamp: new Date().toISOString(), ...structuredClone(message) });
	}

	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void> {
		return this.append({ kind: "custom_entry", id: randomUUID(), seq: ++this.nextSeq, timestamp: new Date().toISOString(), ...structuredClone(entry) });
	}

	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void> {
		const record: SessionEventRecord = {
			kind: "event",
			id: randomUUID(),
			seq: ++this.nextSeq,
			timestamp: new Date().toISOString(),
			event,
			data: structuredClone(data),
		};
		return this.append(record);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.tail;
		this.closed = true;
		await this.handle.close();
	}

	/** An unsuccessful append must restore the last complete record boundary
	 * before another append is admitted. A failed rollback requires reopening. */
	private append(record: SessionRecord): Promise<void> {
		const result = this.tail.then(async () => {
			if (this.closed) throw new Error("session store 已关闭");
			if (this.writeFailure) throw this.writeFailure;
			// 两相第零相：schema 边界，对全部 record kind 一致——畸形输入拒绝落盘，
			// 否则"可写不可读"，重开即砖。
			if (!isRecord(record)) {
				throw new SessionFormatError(`record schema 无效: ${String((record as { kind?: unknown }).kind)}`);
			}
			// 两相第一相：语义校验先行，非法记录拒绝落盘（不触碰常驻状态）。
			checkRecord(this.state, record);
			const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
			const { size } = await this.handle.stat();
			try {
				let offset = 0;
				while (offset < data.length) {
					const { bytesWritten } = await this.handle.write(data, offset, data.length - offset, size + offset);
					if (bytesWritten === 0) throw new Error(`会话写入未取得进展：${this.path}`);
					offset += bytesWritten;
				}
				await this.handle.sync();
				this.records.push(structuredClone(record));
				// 两相第二相：落盘成功后 O(1) 增量登记（canonical 解释 + auxiliary 登记）。
				applyRecord(this.state, record);
			} catch (error) {
				try {
					await this.handle.truncate(size);
					await this.handle.sync();
				} catch (rollbackError) {
					this.writeFailure = new AggregateError([error, rollbackError], `会话追加及回滚失败，请重新打开会话：${this.path}`);
					throw this.writeFailure;
				}
				throw error;
			}
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class MemorySessionStore implements SessionStore {
	readonly path = ":memory:";
	readonly records: SessionRecord[] = [];
	/** 常驻 canonical 状态：与 records 严格同步（append = check → push → apply）。 */
	readonly state: CanonicalState = initialCanonicalState();

	readRecords(): readonly SessionRecord[] { return [...this.records]; }

	/** 单一写入路径：schema 校验 + 语义校验先行，失败即拒绝；成功后 O(1) 增量登记。 */
	private appendSync(record: SessionRecord): void {
		if (!isRecord(record)) throw new SessionFormatError(`record schema 无效: ${String((record as { kind?: unknown }).kind)}`);
		checkRecord(this.state, record);
		const stored = structuredClone(record);
		this.records.push(stored);
		applyRecord(this.state, stored);
	}

	appendRewind(record: Omit<import("./types.js").SessionRewindRecord, "kind" | "seq" | "timestamp">): Promise<void> {
		const next: import("./types.js").SessionRewindRecord = { ...structuredClone(record),kind:"rewind",seq:this.records.length+1,timestamp:new Date().toISOString() };
		this.appendSync(next);
		return Promise.resolve();
	}

	appendInput(input: QueuedInput): Promise<void> {
		this.appendSync({ kind: "input", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), input: structuredClone(input) });
		return Promise.resolve();
	}

	appendMessage(message: AgentMessage | ChatMsg, id?: string): Promise<void> {
		this.appendSync({
			kind: "message",
			id: id ?? randomUUID(),
			seq: this.records.length + 1,
			timestamp: new Date().toISOString(),
			message: structuredClone(message),
		});
		return Promise.resolve();
	}

	appendCustomMessage(message: { customType: string; content: string; images?: import("../core/content.js").ImageContent[]; display?: boolean; details?: unknown }): Promise<void> {
		this.appendSync({ kind: "custom_message", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), ...structuredClone(message) });
		return Promise.resolve();
	}

	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void> {
		this.appendSync({ kind: "custom_entry", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), ...structuredClone(entry) });
		return Promise.resolve();
	}

	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void> {
		this.appendSync({
			kind: "event",
			id: randomUUID(),
			seq: this.records.length + 1,
			timestamp: new Date().toISOString(),
			event,
			data: structuredClone(data),
		});
		return Promise.resolve();
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

async function readSnapshot(path: string): Promise<{
	header: SessionHeader;
	records: SessionRecord[];
	lastSeq: number;
}> {
	let text = await readFile(path, "utf8");
	const needsFinalNewline = text.length > 0 && !text.endsWith("\n");
	let lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) throw new SessionFormatError("session 缺少 header");

	const header = parseHeader(lines[0], path);
	const records: SessionRecord[] = [];
	let lastSeq = 0;
	let repairedTail = false;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line) throw new SessionFormatError(`${path}:${i + 1} 存在空记录`);
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			if (i === lines.length - 1 && isTornTail(line, error)) {
				const validPrefix = `${lines.slice(0, i).join("\n")}\n`;
				await repairTornTail(path, validPrefix);
				repairedTail = true;
				break;
			}
			throw new SessionFormatError(
				`${path}:${i + 1} JSON 无法解析: ${String(error)}`,
			);
		}
		if (!isRecord(value)) {
			throw new SessionFormatError(`${path}:${i + 1} record schema 无效`);
		}
		if (value.seq <= lastSeq) {
			throw new SessionFormatError(`${path}:${i + 1} seq 必须递增`);
		}
		lastSeq = value.seq;
		records.push(value);
	}
	if (needsFinalNewline && !repairedTail) await appendFinalNewline(path, text);
	return { header, records, lastSeq };
}

async function appendFinalNewline(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.${Date.now()}.newline.tmp`;
	await writeFile(temp, `${content}\n`, "utf8");
	await rename(temp, path).catch(async (error) => {
		await unlink(temp).catch(() => undefined);
		throw error;
	});
}

function parseHeader(value: string | undefined, path: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value ?? "");
	} catch (error) {
		throw new SessionFormatError(`${path}:1 header JSON 无法解析: ${String(error)}`);
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.kind !== "header") {
		throw new SessionFormatError(`${path}:1 header schema 无效`);
	}
	// 版本断代：只接受当前版本。旧版本 journal 明确拒绝，不做内存升级。
	if (header.version !== JOURNAL_VERSION) {
		throw new SessionFormatError(
			`${path}:1 header 版本不支持: ${String(header.version)}（期望 ${JOURNAL_VERSION}）`,
		);
	}
	if (
		typeof header.id !== "string" ||
		typeof header.cwd !== "string" ||
		typeof header.createdAt !== "string"
	) {
		throw new SessionFormatError(`${path}:1 header schema 无效`);
	}
	return header as SessionHeader;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return false;
	}
}

async function repairTornTail(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.${Date.now()}.repair.tmp`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}

function isTornTail(line: string, error: unknown): boolean {
	return (
		line.trimStart().startsWith("{") &&
		error instanceof SyntaxError &&
		isUnclosedJson(line)
	);
}

function isUnclosedJson(line: string): boolean {
	let braces = 0;
	let brackets = 0;
	let quoted = false;
	let escaped = false;
	for (const char of line) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quoted) {
			escaped = true;
			continue;
		}
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (char === "{") braces++;
		if (char === "}") braces--;
		if (char === "[") brackets++;
		if (char === "]") brackets--;
	}
	return quoted || braces > 0 || brackets > 0;
}
