/** Safety borrows the one body queue; it is not another Run or scheduler. */
import type { BodySession, ControlOwner } from "../contracts/body.js";
import type { DriverExecutionFact, SafetyInterventionRecord } from "../contracts/runtime.js";
import type { Ref } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { BodyLeaseQueue } from "./body-queue.js";
import type { RecordQueue } from "./records.js";
import type { RuntimeRefs } from "./refs.js";
import type { EffectRow } from "./runtime-db-worker.js";

export type SafetyTrigger = SafetyInterventionRecord["trigger"];
export type SafetyWork = (
	body: BodySession,
	signal: AbortSignal,
) => Promise<"safe" | "blocked" | "timeout" | "invalidated">;
export class RuntimeSafety {
	private active: {
		record: SafetyInterventionRecord;
		abort: AbortController;
		promise: Promise<SafetyInterventionRecord>;
	} | null = null;
	private last: Ref | null = null;
	constructor(
		private deps: {
			refs: RuntimeRefs;
			queue: RecordQueue;
			bodies: BodyLeaseQueue;
			guard(): void;
			interrupt(): Promise<Ref | null>;
			retain?(owner: Ref, evidence: Ref[]): Promise<void>;
			changed?(record: SafetyInterventionRecord): void;
		},
	) {}
	inspect() {
		return { active: this.active?.record.intervention ?? null, last: this.last };
	}
	isLive(intervention: Ref) {
		return this.active?.record.intervention === intervention && !this.active.abort.signal.aborted;
	}
	cancel(reason = "cancelled") {
		this.active?.abort.abort(reason);
	}
	async close() {
		this.cancel();
		await this.active?.promise;
	}
	recover(records: SafetyInterventionRecord[], retired: boolean, stopped: boolean, effects: EffectRow[]) {
		for (const record of records) {
			this.last = record.intervention;
			if (record.finishedAt === null)
				this.write({
					...record,
					...recoveredEffects(record, effects),
					record: this.deps.refs.record(),
					finishedAt: new Date().toISOString(),
					ended: retired && stopped ? "cancelled" : "invalidated",
					outcome: retired && stopped ? "cancelled" : "unknown",
				});
		}
	}
	private write(record: SafetyInterventionRecord) {
		const ticket = this.deps.queue.enqueue({ kind: "safety", value: structuredClone(record) });
		void this.deps.queue.flushThrough(ticket).then(
			() => this.deps.changed?.(record),
			() => {},
		);
	}
	run(trigger: SafetyTrigger, work: SafetyWork): Promise<SafetyInterventionRecord> {
		this.deps.guard();
		if (this.active)
			return Promise.reject(
				callFailure({
					code: "CONTROL_CONFLICT",
					message: "safety is already active",
					source: "environment",
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				}),
			);
		const record: SafetyInterventionRecord = {
			intervention: this.deps.refs.intervention(),
			record: this.deps.refs.record(),
			policy: "survival@1",
			trigger: structuredClone(trigger),
			thresholds: { oxygen: 4, healthRatio: 0.3, maxTimeMs: 10000 },
			interruptedRun: null,
			startedAt: new Date().toISOString(),
			effects: [],
			unknownEffects: [],
			finishedAt: null,
			ended: null,
			outcome: null,
		};
		const abort = new AbortController();
		const release = this.deps.bodies.reserve();
		const state: NonNullable<RuntimeSafety["active"]> = { record, abort, promise: Promise.resolve(record) };
		this.active = state;
		let recorded = false;
		state.promise = (async () => {
			let grant: Awaited<ReturnType<BodyLeaseQueue["request"]>> | undefined;
			let ended: "safe" | "blocked" | "timeout" | "cancelled" | "invalidated" = "invalidated";
			let timer: ReturnType<typeof setTimeout> | undefined;
			let evidenceReady = record.trigger.evidence.length === 0;
			try {
				record.interruptedRun = await this.deps.interrupt();
				this.deps.guard();
				if (abort.signal.aborted) throw new Error("cancelled");
				if (record.trigger.evidence.length) {
					if (!this.deps.retain) throw new Error("World evidence retention is not installed");
					await this.deps.retain(record.intervention, record.trigger.evidence);
					evidenceReady = true;
					this.deps.guard();
					if (abort.signal.aborted) throw new Error("cancelled");
				}
				this.write(record);
				recorded = true;
				const owner = {
					kind: "safety" as const,
					intervention: record.intervention,
					...(record.interruptedRun ? { interruptedRun: record.interruptedRun } : {}),
				};
				grant = await this.deps.bodies.request(owner, record.intervention, abort.signal);
				timer = setTimeout(() => abort.abort("timeout"), 10000);
				ended = await work(grant.session, abort.signal);
			} catch (error) {
				if (!evidenceReady) throw error;
				ended = abort.signal.aborted
					? abort.signal.reason === "timeout"
						? "timeout"
						: abort.signal.reason === "invalidated"
							? "invalidated"
							: "cancelled"
					: "invalidated";
			} finally {
				clearTimeout(timer);
				abort.abort();
				try {
					await grant?.session.close();
				} catch {
					ended = "invalidated";
				}
				grant?.release();
			}
			const effects = this.deps.queue.effectsForSafety(record.intervention);
			await this.deps.queue.flushThrough(this.deps.queue.capture());
			const final: SafetyInterventionRecord = {
				...record,
				...effects,
				record: this.deps.refs.record(),
				finishedAt: new Date().toISOString(),
				ended,
				outcome:
					ended === "safe"
						? effects.unknownEffects.length
							? "unknown"
							: "succeeded"
						: ended === "cancelled"
							? "cancelled"
							: ended === "invalidated"
								? "unknown"
								: "failed",
			};
			this.write(final);
			recorded = true;
			await this.deps.queue.flushThrough(this.deps.queue.capture());
			return final;
		})().finally(() => {
			if (recorded) this.last = record.intervention;
			if (this.active === state) this.active = null;
			release();
		});
		return state.promise;
	}
}

function recoveredEffects(record: SafetyInterventionRecord, rows: EffectRow[]) {
	const owned = rows.filter((row) => {
		const owner = JSON.parse(row.owner ?? "null") as ControlOwner | null;
		return owner?.kind === "safety" && owner.intervention === record.intervention;
	});
	const effects = [...new Set([...record.effects, ...owned.map((row) => row.effect)])];
	const unknownEffects = effects.filter((effect) => {
		const row = owned.find((row) => row.effect === effect);
		return !row || (JSON.parse(row.facts) as DriverExecutionFact[]).at(-1)?.completion !== "met";
	});
	return { effects, unknownEffects };
}
