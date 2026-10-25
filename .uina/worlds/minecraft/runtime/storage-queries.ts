/** SQLite-worker-only immutable snapshots, bounded reads and regenerable exports. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CompletionHeader, DeliveryReceipt, RecordFormat, RuntimeRecord } from "../contracts/runtime.js";
import { plain } from "../contracts/values.js";
import {
	boundedSummary,
	callFromRow,
	recoveredEffectValueOf,
	segmentFromRow,
	snapshotFromRow,
	summaryFromRow,
} from "./rows.js";
import type { ApplyItem, CallRow, RunRow, SegmentRow } from "./runtime-db-worker.js";

export const RECORD_SCHEMA = `
CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, object_ref TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE INDEX records_object ON records(object_ref,seq);
CREATE TABLE completions (completion_ref TEXT PRIMARY KEY, run TEXT NOT NULL, header TEXT NOT NULL, disposition TEXT NOT NULL DEFAULT 'pending', receipt TEXT);
`;
export type StorageQuery =
	| { op: "record"; ref: string; format?: RecordFormat }
	| { op: "read"; run: string }
	| { op: "list"; activeOnly?: boolean; cursor?: string }
	| { op: "calls"; run: string; parent?: string; cursor?: string }
	| { op: "pending"; cursor?: string; limit?: number }
	| { op: "delivery"; ref: string }
	| { op: "settle"; ref: string; receipt: DeliveryReceipt };

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

function save(db: DatabaseSync, record: RuntimeRecord, objectRef: string): number {
	const payload = JSON.stringify(record);
	const old = db.prepare("SELECT payload FROM records WHERE record=?").get(record.record);
	if (old && old.payload !== payload) fail("RECORD_CONFLICT", `immutable record changed: ${record.record}`);
	const bytes = Buffer.byteLength(payload);
	db.prepare("INSERT OR IGNORE INTO records(record,kind,object_ref,payload,bytes) VALUES(?,?,?,?,?)").run(
		record.record,
		record.kind,
		objectRef,
		payload,
		bytes,
	);
	return bytes;
}

/** Runs in the same transaction as the materialized row. No second completion authority. */
export function snapshotMutation(db: DatabaseSync, mutation: ApplyItem["mutation"]): void {
	switch (mutation.kind) {
		case "run": {
			const r = mutation.row;
			const segment = r.segment
				? (db.prepare("SELECT * FROM segments WHERE segment=?").get(r.segment) as unknown as SegmentRow | undefined)
				: undefined;
			const snapshot = snapshotFromRow(r, segment);
			save(db, { kind: "run", record: r.record, value: plain(snapshot) }, r.run);
			if (r.phase === "finished" && r.completion_ref) {
				const refs = {
					completionRef: r.completion_ref,
					requestId: r.request_id,
					run: r.run,
					segment: r.segment!,
					revision: r.revision,
				};
				const report = { ...refs, reportKind: "terminal", snapshot };
				const recordBytes = save(
					db,
					{ kind: "completion", record: r.completion_ref, value: plain(report) },
					r.completion_ref,
				);
				const header = { ...refs, recordBytes, reportKind: "terminal", snapshot: boundedSummary(summaryFromRow(r)) };
				db.prepare("INSERT OR IGNORE INTO completions(completion_ref,run,header) VALUES(?,?,?)").run(
					r.completion_ref,
					r.run,
					JSON.stringify(header),
				);
			}
			return;
		}
		case "segment":
			save(
				db,
				{ kind: "segment", record: mutation.row.record, value: segmentFromRow(mutation.row) },
				mutation.row.segment,
			);
			return;
		case "call":
			save(db, { kind: "call", record: mutation.row.record, value: callFromRow(mutation.row) }, mutation.row.call);
			return;
		case "effect_fact": {
			const r = mutation.row;
			save(
				db,
				{
					kind: "effect",
					record: r.record,
					value: recoveredEffectValueOf(r.effect, { factsJson: r.facts, ownerJson: r.owner, record: r.record }),
				},
				r.effect,
			);
			return;
		}
		case "stop_intent": {
			const r = mutation.row;
			save(
				db,
				{
					kind: "stop",
					record: r.record,
					value: plain({
						requestId: r.stop_request_id,
						target: JSON.parse(r.target),
						record: r.record,
						intent: "durable",
						control: r.control,
						snapshot: null,
					}),
				},
				r.record,
			);
		}
	}
}

function pageOffset(cursor?: string): number {
	if (cursor === undefined) return 0;
	if (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
		fail("CURSOR_INVALID", "invalid page cursor");
	return Number(cursor);
}
function page<T>(items: T[], offset: number, limit: number) {
	return { items: items.slice(0, limit), ...(items.length > limit ? { next: String(offset + limit) } : {}) };
}

export async function queryStorage(db: DatabaseSync, dbPath: string, q: StorageQuery): Promise<unknown> {
	if (q.op === "record") {
		const row =
			db.prepare("SELECT record,kind,payload,bytes FROM records WHERE record=?").get(q.ref) ??
			db
				.prepare("SELECT record,kind,payload,bytes FROM records WHERE object_ref=? ORDER BY seq DESC LIMIT 1")
				.get(q.ref);
		if (!row) fail("NOT_FOUND", `record ${q.ref} is not known to this runtime`);
		const payload = String(row.payload),
			bytes = Number(row.bytes);
		if (q.format !== "file" && bytes <= 256 * 1024) return { kind: "inline", record: JSON.parse(payload) };
		if (q.format === "inline") fail("RECORD_TOO_LARGE", "record exceeds inline budget; use format=file");
		const sha256 = createHash("sha256").update(payload).digest("hex");
		const root = join(dirname(dbPath), "exports");
		await mkdir(root, { recursive: true });
		const path = join(root, `${sha256}.json`);
		let valid = false;
		try {
			const b = await readFile(path);
			valid = b.length === bytes && createHash("sha256").update(b).digest("hex") === sha256;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		if (!valid) {
			const temp = join(root, `${sha256}.${randomUUID()}.tmp`);
			try {
				await writeFile(temp, payload, { encoding: "utf8", flag: "wx" });
				await rename(temp, path);
			} finally {
				await unlink(temp).catch((e) => {
					if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
				});
			}
		}
		return { kind: "file", record: String(row.record), recordKind: String(row.kind), file: { path, sha256, bytes } };
	}
	if (q.op === "read") {
		const r = db.prepare("SELECT * FROM runs WHERE run=?").get(q.run) as unknown as RunRow | undefined;
		if (!r) fail("NOT_FOUND", `run ${q.run} not found`);
		return boundedSummary(summaryFromRow(r));
	}
	if (q.op === "list") {
		const offset = pageOffset(q.cursor);
		const rows = db
			.prepare(
				`SELECT * FROM runs ${q.activeOnly !== false ? "WHERE phase!='finished'" : ""} ORDER BY rowid LIMIT 11 OFFSET ?`,
			)
			.all(offset) as unknown as RunRow[];
		return page(
			rows.map((r) => boundedSummary(summaryFromRow(r))),
			offset,
			10,
		);
	}
	if (q.op === "calls") {
		const offset = pageOffset(q.cursor);
		const rows = (q.parent === undefined
			? db.prepare("SELECT * FROM calls WHERE run=? ORDER BY rowid LIMIT 11 OFFSET ?").all(q.run, offset)
			: db
					.prepare("SELECT * FROM calls WHERE run=? AND parent=? ORDER BY rowid LIMIT 11 OFFSET ?")
					.all(q.run, q.parent, offset)) as unknown as CallRow[];
		return page(
			rows.map((r) => ({
				call: r.call,
				run: r.run,
				segment: r.segment,
				parent: r.parent,
				record: r.record,
				ref: r.ref,
				implementation: r.implementation,
				access: r.access,
				execution: r.execution,
				...(r.outcome ? { outcome: r.outcome } : {}),
			})),
			offset,
			10,
		);
	}
	if (q.op === "pending") {
		const offset = pageOffset(q.cursor),
			limit = q.limit ?? 10;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			fail("INVALID_INPUT", "delivery page limit must be 1..100");
		const rows = db
			.prepare("SELECT header FROM completions WHERE disposition='pending' ORDER BY rowid LIMIT ? OFFSET ?")
			.all(limit + 1, offset);
		return page(
			rows.map((r) => {
				const h = JSON.parse(String(r.header)) as CompletionHeader;
				return {
					completionRef: h.completionRef,
					requestId: h.requestId,
					run: h.run,
					segment: h.segment,
					revision: h.revision,
				};
			}),
			offset,
			limit,
		);
	}
	const row = db.prepare("SELECT * FROM completions WHERE completion_ref=?").get(q.ref);
	if (!row) fail("NOT_FOUND", `completion ${q.ref} not found`);
	if (q.op === "delivery")
		return { delivery: JSON.parse(String(row.header)), disposition: String(row.disposition), eligible: true };
	const receipt = q.receipt;
	if (
		receipt.key !== q.ref ||
		![receipt.namespace, receipt.session, receipt.attempt, receipt.record].every(
			(v) => typeof v === "string" && v.length > 0,
		) ||
		!["tool", "input"].includes(receipt.channel)
	)
		fail("RECEIPT_INVALID", "Host receipt does not match this completion");
	db.prepare(
		"UPDATE completions SET disposition='committed',receipt=? WHERE completion_ref=? AND disposition='pending'",
	).run(JSON.stringify(receipt), q.ref);
	return null;
}
