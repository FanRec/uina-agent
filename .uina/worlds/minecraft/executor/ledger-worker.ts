/** Executor owns only identity/launch/local gate intent, never Run outcomes. */
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import type { ContinueRequest, RunRequest, SubmissionLookup } from "../contracts/runtime.js";

export type RequestIntent =
	| { operation: "submit"; request: RunRequest }
	| { operation: "continue"; request: ContinueRequest };
export type RequestCredential = RequestIntent & {
	requestId: string;
	activation: string;
	createdAt: string;
	run?: string;
	segment?: string;
	refusal?: { kind: "rejected" | "cancelled"; code: string; message: string };
};
export interface DeliveryAttempt {
	key: string;
	attempt: string;
	channel: "tool" | "input";
	namespace: string;
	session: string;
	activation: string;
	createdAt: string;
}

export interface LedgerIdentity {
	worldOwner: string;
	storageId: string;
	runtimeCreated: boolean;
}
export interface LedgerSnapshot {
	identity: LedgerIdentity;
	previous: { launch: string; activation: string; clean: boolean } | null;
	gates: ("disabled" | "emergency" | "owner_lost")[];
}
export type TaskRequestSelection =
	| { kind: "roots"; activeOnly: boolean }
	| { kind: "continuation"; run: string; decision: string }
	| { kind: "unconfirmed" };

export type LedgerRequest =
	| { id: number; op: "open"; path: string; worldOwner: string; storageId: string }
	| { id: number; op: "launch"; launch: string; activation: string }
	| { id: number; op: "runtime_created" }
	| { id: number; op: "gate"; gate: string; closed: boolean }
	| { id: number; op: "clean"; launch: string }
	| { id: number; op: "request_put"; credential: RequestCredential }
	| { id: number; op: "request_get"; requestId: string }
	| { id: number; op: "request_entries"; ids: string[] }
	| { id: number; op: "request_list"; selection: TaskRequestSelection }
	| { id: number; op: "request_found"; requestId: string; lookup: Extract<SubmissionLookup, { kind: "found" }> }
	| { id: number; op: "request_refused"; requestId: string; refusal: NonNullable<RequestCredential["refusal"]> }
	| { id: number; op: "attempt_put"; attempt: DeliveryAttempt }
	| { id: number; op: "attempt_list"; keys: string[] }
	| { id: number; op: "close" };

let db: DatabaseSync | null = null;
parentPort!.on("message", (request: LedgerRequest) => {
	try {
		let value: unknown = null;
		if (request.op === "open") {
			if (db) throw new Error("ledger already open");
			db = new DatabaseSync(request.path);
			const prior = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity'").get();
			if (prior && Number(db.prepare("SELECT schema_version FROM identity WHERE id=1").get()?.schema_version) !== 3)
				throw new Error("incompatible executor ledger schema; use a new data root");
			db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
			if (
				db.prepare("PRAGMA journal_mode").get()!.journal_mode !== "wal" ||
				Number(db.prepare("PRAGMA synchronous").get()!.synchronous) !== 2
			)
				throw new Error("executor ledger requires WAL/FULL");
			db.exec(
				"CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, world_owner TEXT NOT NULL, storage_id TEXT NOT NULL, runtime_created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS launches (seq INTEGER PRIMARY KEY AUTOINCREMENT, launch TEXT UNIQUE NOT NULL, activation TEXT NOT NULL, clean INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS local_gates (gate TEXT PRIMARY KEY)",
			);
			db.exec(
				"CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, credential TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delivery_attempts (key TEXT PRIMARY KEY, attempt TEXT NOT NULL)",
			);
			db.prepare("INSERT OR IGNORE INTO identity VALUES (1,3,?,?,0)").run(request.worldOwner, request.storageId);
			const identity = db.prepare("SELECT * FROM identity WHERE id=1").get()!;
			if (Number(identity.schema_version) !== 3) throw new Error("incompatible executor ledger schema");
			const previous = db.prepare("SELECT launch,activation,clean FROM launches ORDER BY seq DESC LIMIT 1").get();
			const gates = db
				.prepare("SELECT gate FROM local_gates ORDER BY gate")
				.all()
				.map((r) => String(r.gate));
			if (gates.some((gate) => !["disabled", "emergency", "owner_lost"].includes(gate)))
				throw new Error("invalid persisted gate");
			value = {
				identity: {
					worldOwner: String(identity.world_owner),
					storageId: String(identity.storage_id),
					runtimeCreated: identity.runtime_created === 1,
				},
				previous: previous
					? { launch: String(previous.launch), activation: String(previous.activation), clean: previous.clean === 1 }
					: null,
				gates: gates as LedgerSnapshot["gates"],
			} satisfies LedgerSnapshot;
		} else {
			if (!db) throw new Error("ledger is not open");
			if (request.op === "launch")
				db.prepare("INSERT INTO launches (launch,activation) VALUES (?,?)").run(request.launch, request.activation);
			else if (request.op === "runtime_created") db.exec("UPDATE identity SET runtime_created=1 WHERE id=1");
			else if (request.op === "gate") {
				if (!["disabled", "emergency", "owner_lost"].includes(request.gate)) throw new Error("invalid local gate");
				if (request.closed) db.prepare("INSERT OR IGNORE INTO local_gates VALUES (?)").run(request.gate);
				else db.prepare("DELETE FROM local_gates WHERE gate=?").run(request.gate);
			} else if (request.op === "clean") {
				const changed = db.prepare("UPDATE launches SET clean=1 WHERE launch=?").run(request.launch);
				if (changed.changes !== 1) throw new Error("unknown launch");
			} else if (request.op === "request_put") {
				if (request.credential.requestId !== request.credential.request.requestId) throw new Error("REQUEST_CONFLICT");
				const old = db.prepare("SELECT credential FROM requests WHERE request_id=?").get(request.credential.requestId);
				if (
					old &&
					(JSON.parse(String(old.credential)).operation !== request.credential.operation ||
						JSON.stringify(JSON.parse(String(old.credential)).request) !== JSON.stringify(request.credential.request))
				)
					throw new Error("REQUEST_CONFLICT");
				db.prepare("INSERT OR IGNORE INTO requests VALUES(?,?)").run(
					request.credential.requestId,
					JSON.stringify(request.credential),
				);
			} else if (request.op === "request_get") {
				const row = db.prepare("SELECT credential FROM requests WHERE request_id=?").get(request.requestId);
				value = row ? JSON.parse(String(row.credential)) : null;
			} else if (request.op === "request_entries") {
				value = db
					.prepare(`SELECT request_id AS id, json_extract(credential, '$.request.entry') AS entry
					FROM requests WHERE request_id IN (SELECT value FROM json_each(?))
					AND json_extract(credential, '$.operation') = 'submit'
					AND json_type(credential, '$.request.entry') = 'object'`)
					.all(JSON.stringify(request.ids))
					.map(({ id, entry }) => [id, JSON.parse(String(entry))]);
			} else if (request.op === "request_list") {
				const selection = request.selection;
				const rows =
					selection.kind === "roots"
						? db
								.prepare(`SELECT credential FROM requests WHERE json_extract(credential, '$.operation')='submit'
						AND json_extract(credential, '$.run') IS NULL
						AND (?=0 OR json_extract(credential, '$.refusal') IS NULL) ORDER BY rowid DESC LIMIT 20`)
								.all(selection.activeOnly ? 1 : 0)
								.reverse()
						: selection.kind === "continuation"
							? db
									.prepare(`SELECT credential FROM requests WHERE json_extract(credential, '$.operation')='continue'
							AND json_extract(credential, '$.request.run')=? AND json_extract(credential, '$.request.decision')=?
							AND json_extract(credential, '$.run') IS NULL AND json_extract(credential, '$.refusal') IS NULL
							ORDER BY rowid DESC LIMIT 1`)
									.all(selection.run, selection.decision)
							: db
									.prepare(`SELECT credential FROM requests
									WHERE json_extract(credential, '$.run') IS NULL AND json_extract(credential, '$.refusal') IS NULL
									ORDER BY rowid`)
									.all();
				value = rows.map((row) => JSON.parse(String(row.credential)));
			} else if (request.op === "request_found") {
				const row = db.prepare("SELECT credential FROM requests WHERE request_id=?").get(request.requestId);
				if (row) {
					const c = JSON.parse(String(row.credential));
					c.run = request.lookup.snapshot.run;
					c.segment = request.lookup.segment;
					delete c.refusal;
					db.prepare("UPDATE requests SET credential=? WHERE request_id=?").run(JSON.stringify(c), request.requestId);
				}
			} else if (request.op === "request_refused") {
				const row = db.prepare("SELECT credential FROM requests WHERE request_id=?").get(request.requestId);
				if (row) {
					const c = JSON.parse(String(row.credential)) as RequestCredential;
					if (!c.run) {
						c.refusal = request.refusal;
						db.prepare("UPDATE requests SET credential=? WHERE request_id=?").run(JSON.stringify(c), request.requestId);
					}
				}
			} else if (request.op === "attempt_put") {
				db.prepare(
					"INSERT INTO delivery_attempts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET attempt=excluded.attempt",
				).run(request.attempt.key, JSON.stringify(request.attempt));
			} else if (request.op === "attempt_list") {
				value = db
					.prepare("SELECT key, attempt FROM delivery_attempts WHERE key IN (SELECT value FROM json_each(?))")
					.all(JSON.stringify(request.keys))
					.map(({ key, attempt }) => [key, JSON.parse(String(attempt))]);
			} else if (request.op === "close") {
				db.close();
				db = null;
			}
		}
		parentPort!.postMessage({ id: request.id, ok: true, value });
		if (request.op === "close") parentPort!.close();
	} catch (error) {
		parentPort!.postMessage({
			id: request.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});
