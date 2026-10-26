/** The Runtime writer's short admission transaction. Ordinary rejection never faults the recorder. */
import type { DatabaseSync } from "node:sqlite";
import type { ApplyItem } from "./runtime-db-worker.js";

export interface AdmissionCommand {
	requestId: string;
	owner: string;
	gateRevision: number;
	continuation?: { run: string; decision: string; revision: number };
	replacements?: string[];
	preemption?: string;
	mutations: ApplyItem["mutation"][];
}

export function applyAdmission(
	db: DatabaseSync,
	c: AdmissionCommand,
	apply: (mutation: ApplyItem["mutation"]) => void,
): void {
	try {
		db.exec("BEGIN IMMEDIATE");

		const reject = (code: string, message: string): never => {
			throw Object.assign(new Error(message), { code });
		};
		const gates = db.prepare("SELECT value FROM meta WHERE key='owner_gates'").get();
		const revision = db.prepare("SELECT value FROM meta WHERE key='owner_gate_revision'").get();
		if (JSON.parse(String(gates?.value)).length || Number(revision?.value) !== c.gateRevision)
			reject("OWNER_STATE_CHANGED", "owner gates changed before admission");
		const prior = db.prepare("SELECT status FROM submissions WHERE owner=? AND request_id=?").get(c.owner, c.requestId);
		if (prior?.status === "cancelled") reject("REQUEST_CANCELLED", "request has a durable stop barrier");
		if (prior) reject("REQUEST_CONFLICT", "request already has a durable submission");
		if (c.continuation) {
			const row = db
				.prepare("SELECT phase,decision,revision FROM runs WHERE run=? AND owner=?")
				.get(c.continuation.run, c.owner);
			if (
				!row ||
				row.phase !== "awaiting_decision" ||
				JSON.parse(String(row.decision)).ref !== c.continuation.decision ||
				Number(row.revision) !== c.continuation.revision
			)
				reject("DECISION_STALE", "decision is no longer pending");
		}
		for (const run of c.replacements ?? []) {
			const row = db.prepare("SELECT owner,started,phase FROM runs WHERE run=?").get(run);
			if (!row || row.owner !== c.owner || Number(row.started) !== 0 || row.phase !== "queued")
				reject("REPLACE_TARGET_INVALID", "replacement target already started or stopped");
		}
		if (c.preemption) {
			const row = db.prepare("SELECT owner,control,phase FROM runs WHERE run=?").get(c.preemption);
			if (
				!row ||
				row.owner !== c.owner ||
				row.control !== "active" ||
				row.phase === "stopping" ||
				row.phase === "finished"
			)
				reject("CONTROL_CHANGED", "expected control changed before admission");
		}
		for (const mutation of c.mutations) apply(mutation);
		db.exec("COMMIT");
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}
