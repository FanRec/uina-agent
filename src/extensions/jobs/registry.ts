import { randomUUID } from "node:crypto";
import { TaskOutputBuffer, TaskWaiters } from "../../runtime/task-handle.js";

export type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed" | "unknown";

export interface JobSource {
	extension: string;
	operation?: string;
	parentId?: string;
	metadata?: Record<string, unknown>;
}

export interface JobProgress {
	current?: number;
	total?: number;
	text?: string;
}

export interface JobSnapshot {
	id: string;
	ownerId: string;
	label: string;
	source: JobSource;
	status: JobStatus;
	detail?: string;
	progress?: JobProgress;
	startedAt: number;
	finishedAt?: number;
}

export interface JobOutput {
	result?: string;
	fullOutputPath?: string;
	truncated?: boolean;
}

export interface JobOutcome {
	status: Exclude<JobStatus, "running" | "stopping">;
	detail?: string;
	output?: JobOutput;
}

export interface JobHandle {
	cancel(reason?: string): void;
	done: Promise<JobOutcome>;
}

export interface JobContext {
	readonly id: string;
	readonly signal: AbortSignal;
	update(update: { detail?: string; progress?: JobProgress }): void;
	observe(chunk: { stream?: "stdout" | "stderr" | "text"; text: string }): void;
}

export interface JobSpec {
	label: string;
	ownerId: string;
	source: JobSource;
	/**
	 * Prepare and start the producer synchronously. Once this returns, the
	 * registry can publish an accepted job whose handle is always available for
	 * cancellation and teardown. Long-running work belongs in `done`.
	 */
	start(context: JobContext): JobHandle;
}

export interface JobRead {
	cursor: number;
	text: string;
	outputLost: boolean;
	job: JobSnapshot;
	result?: string;
	fullOutputPath?: string;
	truncated: boolean;
}

export interface JobsOptions {
	maxActivePerOwner?: number;
}

export interface ObservationChunk {
	readonly stream: "stdout" | "stderr" | "text";
	readonly text: string;
}

interface TrackedJob {
	readonly id: string;
	readonly ownerId: string;
	readonly label: string;
	readonly source: JobSource;
	readonly startedAt: number;
	finishedAt?: number;
	status: JobStatus;
	detail?: string;
	progress?: JobProgress;
	readonly controller: AbortController;
	handle?: JobHandle;
	output?: JobOutput;
	readonly buffer: TaskOutputBuffer<ObservationChunk>;
	readonly waiters: TaskWaiters;
}

const OUTPUT_BYTES = 50 * 1024;
const OUTPUT_LINES = 2000;
/** Raw output kept for all settled jobs before the oldest buffers are released. */
const SETTLED_OUTPUT_BUDGET = 4 * 1024 * 1024;

export class JobRegistry {
	private readonly jobs = new Map<string, TrackedJob>();
	private readonly changed = new Set<(job: JobSnapshot) => void>();
	private readonly resolved = new Set<(job: JobSnapshot) => void>();
	private readonly maxActivePerOwner?: number;
	private closePromise?: Promise<void>;
	private closed = false;

	constructor(options: JobsOptions = {}) {
		this.maxActivePerOwner = options.maxActivePerOwner;
	}

	start(spec: JobSpec): string {
		if (this.closed) throw new Error("后台任务服务已关闭");
		if (!spec.label.trim()) throw new Error("Job label 不能为空");
		if (!spec.ownerId) throw new Error("Job ownerId 不能为空");
		if (!spec.source.extension.trim()) throw new Error("Job source.extension 不能为空");
		if (this.maxActivePerOwner !== undefined && this.activeFor(spec.ownerId) >= this.maxActivePerOwner) {
			throw new Error(`后台任务数量已达到上限（${this.maxActivePerOwner}）`);
		}
		const id = `job-${randomUUID()}`;
		const controller = new AbortController();
		const job: TrackedJob = {
			id,
			ownerId: spec.ownerId,
			label: spec.label,
			source: structuredClone(spec.source),
			startedAt: Date.now(),
			status: "running",
			controller,
			buffer: new TaskOutputBuffer<ObservationChunk>({ maxBytes: OUTPUT_BYTES, maxLines: OUTPUT_LINES }),
			waiters: new TaskWaiters(),
		};
		const context: JobContext = {
			id,
			signal: controller.signal,
			update: (update) => this.update(job, update),
			observe: (chunk) => this.observe(job, chunk),
		};
		let handle: JobHandle;
		try {
			handle = spec.start(context);
		} catch (error) {
			throw new Error(`后台任务启动失败：${errorMessage(error)}`);
		}
		if (!isJobHandle(handle)) throw new Error("后台任务启动失败：producer 未返回有效的 JobHandle");
		job.handle = handle;
		this.jobs.set(id, job);
		this.notifyChanged(job);
		void handle.done.then(
			(outcome) => this.settle(job, outcome),
			(error: unknown) => this.settle(job, { status: "failed", detail: errorMessage(error) }),
		);
		return id;
	}

	/** Omit ownerId to list every owner's jobs (host UI / diagnostics). */
	list(ownerId?: string): JobSnapshot[] {
		return [...this.jobs.values()]
			.filter((job) => ownerId === undefined || job.ownerId === ownerId)
			.map((job) => snapshotOf(job));
	}

	get(id: string, ownerId?: string): JobSnapshot {
		return snapshotOf(this.expect(id, ownerId));
	}

	read(id: string, ownerId?: string, cursor = 0): JobRead {
		const job = this.expect(id, ownerId);
		const readResult = job.buffer.read(cursor);
		return {
			cursor: readResult.cursor,
			text: readResult.chunks.map(formatObservation).join(""),
			outputLost: readResult.outputLost,
			job: snapshotOf(job),
			result: job.output?.result,
			fullOutputPath: job.output?.fullOutputPath,
			truncated: job.output?.truncated ?? readResult.outputLost,
		};
	}

	async wait(id: string, ownerId: string | undefined, timeoutMs: number, cursor = 0, signal?: AbortSignal): Promise<JobSnapshot> {
		const job = this.expect(id, ownerId);
		await job.waiters.wait(
			() => isTerminal(job.status) || job.buffer.currentCursor > cursor,
			timeoutMs,
			signal,
		);
		return snapshotOf(job);
	}

	cancel(id: string, ownerId?: string, reason?: string): "cancellation-requested" | "already-finished" {
		const job = this.expect(id, ownerId);
		if (isTerminal(job.status)) return "already-finished";
		if (job.status !== "stopping") {
			job.status = "stopping";
			job.detail = reason ?? "已请求取消";
			this.notifyChanged(job);
		}
		job.controller.abort(reason);
		job.waiters.notify();
		this.requestCancel(job, reason);
		return "cancellation-requested";
	}

	onChanged(listener: (job: JobSnapshot) => void): () => void {
		this.changed.add(listener);
		return () => this.changed.delete(listener);
	}

	onResolved(listener: (job: JobSnapshot) => void): () => void {
		this.resolved.add(listener);
		return () => this.resolved.delete(listener);
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.status));
		for (const job of active) this.cancel(job.id, job.ownerId, "宿主正在关闭");
		this.closePromise = Promise.all(active.map((job) => this.waitForTerminal(job))).then(() => undefined);
		await this.closePromise;
	}

	private update(job: TrackedJob, update: { detail?: string; progress?: JobProgress }): void {
		if (isTerminal(job.status)) return;
		if (update.detail !== undefined) job.detail = update.detail;
		if (update.progress !== undefined) job.progress = structuredClone(update.progress);
		this.notifyChanged(job);
	}

	private observe(job: TrackedJob, chunk: { stream?: "stdout" | "stderr" | "text"; text: string }): void {
		if (isTerminal(job.status) || !chunk.text) return;
		job.buffer.append({ stream: chunk.stream ?? "text", text: chunk.text });
		job.waiters.notify();
		this.notifyChanged(job);
	}

	private requestCancel(job: TrackedJob, reason?: string): void {
		try {
			job.handle?.cancel(reason);
		} catch (error) {
			job.detail = `取消请求失败：${errorMessage(error)}`;
			this.notifyChanged(job);
		}
	}

	private settle(job: TrackedJob, outcome: JobOutcome): void {
		if (isTerminal(job.status)) return;
		job.status = outcome.status;
		job.detail = outcome.detail ?? job.detail;
		job.finishedAt = Date.now();
		job.output = outcome.output;
		this.pruneSettledObservations();
		job.waiters.notify();
		this.notifyChanged(job);
		for (const listener of this.resolved) {
			try { listener(snapshotOf(job)); } catch { /* observers cannot alter settlement */ }
		}
	}

	/** Settled jobs keep their snapshot and result, but their raw observation
	 * buffers are released oldest-first once the total exceeds the budget.
	 * Readers still see outputLost instead of silently missing text. */
	private pruneSettledObservations(): void {
		let bytes = 0;
		const settled: TrackedJob[] = [];
		for (const job of this.jobs.values()) {
			if (!isTerminal(job.status)) continue;
			settled.push(job);
			bytes += job.buffer.bytes;
		}
		settled.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
		for (const job of settled) {
			if (bytes <= SETTLED_OUTPUT_BUDGET) break;
			bytes -= job.buffer.bytes;
			job.buffer.clear();
		}
	}

	private notifyChanged(job: TrackedJob): void {
		const snapshot = snapshotOf(job);
		for (const listener of this.changed) {
			try { listener(snapshot); } catch { /* observers cannot alter lifecycle */ }
		}
	}

	private expect(id: string, ownerId?: string): TrackedJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`未知后台任务 ${id}`);
		if (ownerId !== undefined && job.ownerId !== ownerId) throw new Error(`后台任务 ${id} 不属于当前 owner`);
		return job;
	}

	private activeFor(ownerId: string): number {
		return [...this.jobs.values()].filter((job) => job.ownerId === ownerId && !isTerminal(job.status)).length;
	}

	private waitForTerminal(job: TrackedJob): Promise<void> {
		if (isTerminal(job.status)) return Promise.resolve();
		return job.waiters.wait(() => isTerminal(job.status), 10_000).catch(() => {});
	}
}

function isTerminal(status: JobStatus): boolean {
	return status === "completed" || status === "killed" || status === "failed" || status === "unknown";
}

function snapshotOf(job: TrackedJob): JobSnapshot {
	return {
		id: job.id,
		ownerId: job.ownerId,
		label: job.label,
		source: structuredClone(job.source),
		status: job.status,
		detail: job.detail,
		progress: job.progress ? structuredClone(job.progress) : undefined,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
	};
}

function formatObservation(observation: ObservationChunk): string {
	return observation.stream === "stderr" ? `[stderr] ${observation.text}` : observation.text;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isJobHandle(value: unknown): value is JobHandle {
	return !!value
		&& typeof value === "object"
		&& typeof (value as JobHandle).cancel === "function"
		&& typeof (value as JobHandle).done?.then === "function";
}
