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

export async function openJsonlSession(path: string): Promise<{
	store: JsonlSessionStore;
	snapshot: SessionSnapshot;
}> {
	await mkdir(dirname(path), { recursive: true });
	if (!(await pathExists(path))) {
		const header: SessionHeader = {
			kind: "header",
			version: 2,
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
	const handle = await open(path, "a+");
	return { store: new JsonlSessionStore(path, handle, snapshot.lastSeq), snapshot };
}

export class JsonlSessionStore implements SessionStore {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		readonly path: string,
		private readonly handle: FileHandle,
		private nextSeq: number,
	) {}

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

	appendCustomMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): Promise<void> {
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

	private append(record: SessionRecord): Promise<void> {
		this.tail = this.tail.then(async () => {
			if (this.closed) throw new Error("session store 已关闭");
			await this.handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
			await this.handle.sync();
		});
		return this.tail;
	}
}

export class MemorySessionStore implements SessionStore {
	readonly path = ":memory:";
	readonly records: SessionRecord[] = [];

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

	appendCustomMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }): Promise<void> {
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
	if (
		header.kind !== "header" ||
		header.version !== 2 ||
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
