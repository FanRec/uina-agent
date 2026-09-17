import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { AgentMessage, ChatMsg } from "../core/types.js";
import {
	isRecord,
	recoverRecords,
	SessionFormatError,
} from "./recovery.js";
import type {
	QueuedInput,
	SessionCompactionRecord,
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
 * Migration skeleton: bumping this constant is a schema change and MUST be
 * accompanied by a migration chain here — parseHeader accepts older versions
 * and each step upgrades in-memory before records are interpreted. Never
 * rewrite old journals in place; migration is a read-time concern until a
 * dedicated migration commit is authorized (out of P0 scope).
 */
const JOURNAL_VERSION = 2;

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

	const snapshot = await readSnapshot(path);
	// Positional writes allow rollback on Windows, where append-only handles
	// cannot be truncated. This store serializes all writes to its handle.
	const handle = await open(path, "r+");
	const store = new JsonlSessionStore(path, handle, snapshot.lastSeq, snapshot.records);
	// Recovery outcomes become durable before the session is exposed to live readers.
	// Live snapshots must never infer that an in-flight tool has crashed.
	try {
		const tail = recoverRecords([...snapshot.records]).recoveredTail;
		for (const message of tail) await store.appendMessage(message);
		if (tail.length) {
			snapshot.records = [...store.readRecords()];
			snapshot.entries = recoverRecords(snapshot.records, false).entries;
			snapshot.lastSeq = snapshot.records.at(-1)!.seq;
		}
		return {store,snapshot};
	} catch (error) { await store.close(); throw error; }
}

export class JsonlSessionStore implements SessionStore {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private writeFailure?: Error;

	constructor(
		readonly path: string,
		private readonly handle: FileHandle,
		private nextSeq: number,
		private readonly records: SessionRecord[] = [],
	) { this.records = structuredClone(records); }

	readRecords(): readonly SessionRecord[] { return [...this.records]; }
	appendRewind(record: Omit<import("./types.js").SessionRewindRecord, "kind" | "seq" | "timestamp">): Promise<void> {
		return this.append({ ...structuredClone(record), kind:"rewind", seq:++this.nextSeq, timestamp:new Date().toISOString() });
	}

	appendInput(input: QueuedInput): Promise<void> {
		return this.append({ kind: "input", id: randomUUID(), seq: ++this.nextSeq, timestamp: new Date().toISOString(), input: structuredClone(input) });
	}

	appendMessage(message: AgentMessage | ChatMsg): Promise<void> {
		return this.append({
			kind: "message",
			id: randomUUID(),
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

	appendCompaction(
		summary: string,
		retainedTail: (AgentMessage | ChatMsg)[],
		tokensBefore: number,
	): Promise<void> {
		const record: SessionCompactionRecord = {
			kind: "compaction",
			id: randomUUID(),
			seq: ++this.nextSeq,
			timestamp: new Date().toISOString(),
			summary,
			retainedTail: structuredClone(retainedTail),
			tokensBefore,
		};
		return this.append(record);
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
			if (record.kind === "rewind") {
				if (!isRecord(record)) throw new SessionFormatError("回溯记录无效");
				recoverRecords([...this.records, record]);
			}
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
	readRecords(): readonly SessionRecord[] { return [...this.records]; }
	appendRewind(record: Omit<import("./types.js").SessionRewindRecord, "kind" | "seq" | "timestamp">): Promise<void> {
		const next: import("./types.js").SessionRewindRecord = { ...structuredClone(record),kind:"rewind",seq:this.records.length+1,timestamp:new Date().toISOString() };
		if (!isRecord(next)) return Promise.reject(new SessionFormatError("回溯记录无效"));
		recoverRecords([...this.records,next]); this.records.push(next); return Promise.resolve();
	}

	appendInput(input: QueuedInput): Promise<void> {
		this.records.push({ kind: "input", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), input: structuredClone(input) });
		return Promise.resolve();
	}

	appendMessage(message: AgentMessage | ChatMsg): Promise<void> {
		this.records.push({
			kind: "message",
			id: randomUUID(),
			seq: this.records.length + 1,
			timestamp: new Date().toISOString(),
			message: structuredClone(message),
		});
		return Promise.resolve();
	}

	appendCustomMessage(message: { customType: string; content: string; images?: import("../core/content.js").ImageContent[]; display?: boolean; details?: unknown }): Promise<void> {
		this.records.push({ kind: "custom_message", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), ...structuredClone(message) });
		return Promise.resolve();
	}

	appendCustomEntry(entry: { customType: string; data?: unknown }): Promise<void> {
		this.records.push({ kind: "custom_entry", id: randomUUID(), seq: this.records.length + 1, timestamp: new Date().toISOString(), ...structuredClone(entry) });
		return Promise.resolve();
	}

	appendCompaction(
		summary: string,
		retainedTail: (AgentMessage | ChatMsg)[],
		tokensBefore: number,
	): Promise<void> {
		this.records.push({
			kind: "compaction",
			id: randomUUID(),
			seq: this.records.length + 1,
			timestamp: new Date().toISOString(),
			summary,
			retainedTail: structuredClone(retainedTail),
			tokensBefore,
		});
		return Promise.resolve();
	}

	appendEvent(
		event: SessionEventName,
		data: Record<string, unknown>,
	): Promise<void> {
		this.records.push({
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

async function readSnapshot(path: string): Promise<SessionSnapshot> {
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

	const recovered = recoverRecords(records);
	return {
		header,
		records,
		entries: recovered.entries,
		queued: recovered.queued,
		lastSeq,
	};
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
	// Migration landing point: when JOURNAL_VERSION is bumped, this branch
	// becomes a version switch — older headers are upgraded in memory via a
	// migration chain instead of being rejected outright. For now only the
	// current version is accepted (P0 freeze).
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
