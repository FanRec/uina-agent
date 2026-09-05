import { randomUUID } from "node:crypto";

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

interface Observation {
	seq: number;
	stream: "stdout" | "stderr" | "text";
	text: string;
}

interface TrackedJob {
	snapshot: JobSnapshot;
	controller: AbortController;
	handle?: JobHandle;
	observations: Observation[];
	nextObservation: number;
	outputBytes: number;
	outputLines: number;
	output?: JobOutput;
	waiters: Set<() => void>;
}

const OUTPUT_BYTES = 50 * 1024;
const OUTPUT_LINES = 2000;

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
			snapshot: {
				id,
				ownerId: spec.ownerId,
				label: spec.label,
				source: structuredClone(spec.source),
				status: "running",
				startedAt: Date.now(),
			},
			controller,
			observations: [],
			nextObservation: 0,
			outputBytes: 0,
			outputLines: 0,
			waiters: new Set(),
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

	list(ownerId: string): JobSnapshot[] {
		return [...this.jobs.values()]
			.filter((job) => job.snapshot.ownerId === ownerId)
			.map((job) => snapshotOf(job));
	}

	get(id: string, ownerId: string): JobSnapshot {
		return snapshotOf(this.expect(id, ownerId));
	}

	read(id: string, ownerId: string, cursor = 0): JobRead {
		const job = this.expect(id, ownerId);
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor 无效");
		const first = job.observations[0]?.seq ?? job.nextObservation + 1;
		const outputLost = cursor > 0 && cursor < first - 1;
		const observations = job.observations.filter((item) => item.seq > cursor);
		return {
			cursor: job.nextObservation,
			text: observations.map(formatObservation).join(""),
			outputLost,
			job: snapshotOf(job),
			result: job.output?.result,
			fullOutputPath: job.output?.fullOutputPath,
			truncated: job.output?.truncated ?? outputLost,
		};
	}

	async wait(id: string, ownerId: string, timeoutMs: number, cursor = 0, signal?: AbortSignal): Promise<JobSnapshot> {
		const job = this.expect(id, ownerId);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("等待时间无效");
		if (isTerminal(job.snapshot.status) || job.nextObservation > cursor) return snapshotOf(job);
		if (signal?.aborted) throw new Error("等待已取消");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(done, timeoutMs);
			const onAbort = (): void => { cleanup(); reject(new Error("等待已取消")); };
			const onChange = (): void => { if (isTerminal(job.snapshot.status) || job.nextObservation > cursor) done(); };
			function cleanup(): void {
				clearTimeout(timer);
				job.waiters.delete(onChange);
				signal?.removeEventListener("abort", onAbort);
			}
			function done(): void { cleanup(); resolve(); }
			job.waiters.add(onChange);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		return snapshotOf(job);
	}

	cancel(id: string, ownerId: string, reason?: string): "cancellation-requested" | "already-finished" {
		const job = this.expect(id, ownerId);
		if (isTerminal(job.snapshot.status)) return "already-finished";
		if (job.snapshot.status !== "stopping") {
			job.snapshot.status = "stopping";
			job.snapshot.detail = reason ?? "已请求取消";
			this.notifyChanged(job);
		}
		job.controller.abort(reason);
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
		const active = [...this.jobs.values()].filter((job) => !isTerminal(job.snapshot.status));
		for (const job of active) this.cancel(job.snapshot.id, job.snapshot.ownerId, "宿主正在关闭");
		this.closePromise = Promise.all(active.map((job) => this.waitForTerminal(job))).then(() => undefined);
		await this.closePromise;
	}

	private update(job: TrackedJob, update: { detail?: string; progress?: JobProgress }): void {
		if (isTerminal(job.snapshot.status)) return;
		if (update.detail !== undefined) job.snapshot.detail = update.detail;
		if (update.progress !== undefined) job.snapshot.progress = structuredClone(update.progress);
		this.notifyChanged(job);
	}

	private observe(job: TrackedJob, chunk: { stream?: "stdout" | "stderr" | "text"; text: string }): void {
		if (isTerminal(job.snapshot.status) || !chunk.text) return;
		const observation: Observation = { seq: ++job.nextObservation, stream: chunk.stream ?? "text", text: chunk.text };
		job.observations.push(observation);
		job.outputBytes += Buffer.byteLength(observation.text, "utf8");
		job.outputLines += countLines(observation.text);
		while (job.observations.length > 0 && (job.outputBytes > OUTPUT_BYTES || job.outputLines > OUTPUT_LINES)) {
			const removed = job.observations.shift()!;
			job.outputBytes -= Buffer.byteLength(removed.text, "utf8");
			job.outputLines -= countLines(removed.text);
		}
		this.notifyWaiters(job);
		this.notifyChanged(job);
	}

	private requestCancel(job: TrackedJob, reason?: string): void {
		try { job.handle?.cancel(reason); } catch (error) { job.snapshot.detail = `取消请求失败：${errorMessage(error)}`; this.notifyChanged(job); }
	}

	private settle(job: TrackedJob, outcome: JobOutcome): void {
		if (isTerminal(job.snapshot.status)) return;
		job.snapshot.status = outcome.status;
		job.snapshot.detail = outcome.detail ?? job.snapshot.detail;
		job.snapshot.finishedAt = Date.now();
		job.output = outcome.output;
		this.notifyWaiters(job);
		this.notifyChanged(job);
		for (const listener of this.resolved) {
			try { listener(snapshotOf(job)); } catch { /* observers cannot alter settlement */ }
		}
	}

	private notifyChanged(job: TrackedJob): void {
		const snapshot = snapshotOf(job);
		for (const listener of this.changed) {
			try { listener(snapshot); } catch { /* observers cannot alter lifecycle */ }
		}
	}

	private notifyWaiters(job: TrackedJob): void {
		for (const waiter of [...job.waiters]) waiter();
	}

	private expect(id: string, ownerId: string): TrackedJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`未知后台任务 ${id}`);
		if (job.snapshot.ownerId !== ownerId) throw new Error(`后台任务 ${id} 不属于当前 owner`);
		return job;
	}

	private activeFor(ownerId: string): number {
		return [...this.jobs.values()].filter((job) => job.snapshot.ownerId === ownerId && !isTerminal(job.snapshot.status)).length;
	}

	private waitForTerminal(job: TrackedJob): Promise<void> {
		if (isTerminal(job.snapshot.status)) return Promise.resolve();
		return new Promise((resolve) => {
			const waiter = (): void => {
				if (!isTerminal(job.snapshot.status)) return;
				job.waiters.delete(waiter);
				resolve();
			};
			job.waiters.add(waiter);
		});
	}
}

function isTerminal(status: JobStatus): boolean {
	return status === "completed" || status === "killed" || status === "failed" || status === "unknown";
}

function snapshotOf(job: TrackedJob): JobSnapshot {
	return structuredClone(job.snapshot);
}

function formatObservation(observation: Observation): string {
	return observation.stream === "stderr" ? `[stderr] ${observation.text}` : observation.text;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
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
