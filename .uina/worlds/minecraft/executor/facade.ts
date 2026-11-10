/** Model adapter. Scheduling and completion remain in Runtime; delivery uses the existing Host. */
import { randomUUID } from "node:crypto";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { Acceptance, Entry, RunSummary, Schedule } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import { DeliveryPump } from "./delivery.js";
import { MinecraftExecutor } from "./index.js";
import { RpcError } from "./ipc.js";
import { taskHandle, taskView } from "../contracts/task.js";
import type { RequestIntent } from "./ledger-worker.js";

function response(value: unknown, status: ToolExecutionResult["status"] = "succeeded"): ToolExecutionResult {
	return { status, result: JSON.stringify(value), details: value };
}

/** observe(map@1) 值里的图片引用（capabilities.md §map；G11 出口只认这个形状）。 */
interface ObservedImageRef {
	path: string;
	sha256: string;
	bytes: number;
	mimeType: string;
}

interface ObservedValue {
	id?: number;
	receivedPixels?: number;
	totalPixels?: number;
	paintedPixels?: number;
	image?: ObservedImageRef | null;
}
function cancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new RpcError("REQUEST_CANCELLED", "tool waiting cancelled", "unknown"));
	return new Promise((resolve, reject) => {
		const abort = () => reject(new RpcError("REQUEST_CANCELLED", "tool waiting cancelled", "unknown"));
		signal.addEventListener("abort", abort, { once: true });
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export class MinecraftFacade {
	private readonly delivery: DeliveryPump;
	private closing = false;
	constructor(
		readonly executor: MinecraftExecutor,
		private readonly ctx: ServiceCompanionContext,
		private readonly policy: { pollMs?: number; profileId?: string; diagnostics?: boolean } = {},
	) {
		this.delivery = new DeliveryPump(executor, ctx, policy.pollMs, policy.profileId);
	}
	start() {
		this.delivery.start();
	}
	reconcile() {
		return this.delivery.reconcile();
	}
	async close() {
		this.closing = true;
		await this.delivery.close();
	}
	async execute(action: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		if (this.closing || this.ctx.signal.aborted)
			return response({ code: "WORLD_DISABLED", message: "Minecraft activation is closing" }, "not_started");
		if (signal.aborted)
			return response({ code: "REQUEST_CANCELLED", message: "query cancelled before dispatch" }, "not_started");
		try {
			switch (action) {
				case "observe":
					return await this.observeResult(
						await this.executor.rpc("observe", { selector: params.selector, input: params.input ?? {} }, signal),
						signal,
					);
				case "chat":
					return await this.run({ selector: "chat@1", input: { text: params.text } }, signal);
				case "run":
					return await this.run(params, signal);
				case "tasks":
					return await this.tasks(params, signal);
				case "runs":
					if (this.policy.diagnostics) return await this.runs(params, signal);
					throw new RpcError("INVALID_INPUT", "use tasks to manage Minecraft tasks");
				default:
					throw new RpcError("INVALID_INPUT", `unknown Minecraft action ${action}`);
			}
		} catch (error) {
			const e = error as { code?: string; message?: string; dispatch?: string };
			const submitting = action === "run" || action === "chat" || (action === "tasks" && params.op === "continue");
			return response(
				{
					...(submitting ? { kind: "rejected" } : {}),
					code: e.code ?? "INTERNAL",
					message: e.message ?? String(error),
					...(this.policy.diagnostics && e.code === "RECORD_TOO_LARGE"
						? { nextCall: { action: "runs", params: { op: "record", ref: params.ref, format: "file" } } }
						: {}),
				},
				e.code === "REQUEST_CANCELLED"
					? "cancelled"
					: (action === "tasks" || action === "runs") && params.op === "stop" && e.dispatch === "unknown"
						? "unknown"
						: "failed",
			);
		}
	}
	/**
	 * observe 的图片出口（executor.md §2.1.1，G11）：值里带 map@1 产出的 ImageFileRef
	 * 时，经受信任伴生进程核验 realpath/摘要并读出字节，填进已有 ToolExecutionResult.images；
	 * 读取失败给明确原因和原路径，元数据不冒充图片。路径不是授权——授权校验在伴生侧。
	 */
	private async observeResult(value: unknown, signal: AbortSignal): Promise<ToolExecutionResult> {
		const base = response(value);
		const image = (value as { value?: ObservedValue | null } | null)?.value?.image;
		if (image == null) return base;
		try {
			const bytes = await this.executor.rpc<{ mimeType: "image/png"; data: string }>(
				"read_image",
				{ path: image.path, sha256: image.sha256, bytes: image.bytes, mimeType: image.mimeType },
				signal,
			);
			const observed = (value as { value?: ObservedValue | null }).value ?? {};
			const alt = `minecraft map ${observed.id ?? "?"}: ${observed.receivedPixels ?? "?"}/${observed.totalPixels ?? 16384} pixels received, ${observed.paintedPixels ?? "?"} painted; magenta checkerboard = unknown, parchment = received transparent`;
			return {
				...base,
				images: [{ type: "image", mimeType: bytes.mimeType, data: bytes.data, alt }],
			};
		} catch (error) {
			if (error instanceof RpcError && error.code === "REQUEST_CANCELLED") throw error;
			return {
				...base,
				details: {
					...(base.details as Record<string, unknown> | null),
					imageDelivery: {
						delivered: false,
						path: image.path,
						reason: error instanceof Error ? error.message : String(error),
					},
				},
			};
		}
	}

	private entry(params: Record<string, unknown>): Entry {
		if ((typeof params.code === "string") === (typeof params.selector === "string"))
			throw new RpcError("INVALID_INPUT", "provide exactly one code or selector");
		return typeof params.code === "string"
			? { kind: "program", source: { code: params.code }, input: (params.input ?? {}) as JsonValue }
			: typeof params.selector === "string" && params.selector.includes("@")
				? { kind: "call", selector: params.selector, input: (params.input ?? {}) as JsonValue }
				: {
						kind: "program",
						source: { name: params.selector as string },
						input: (params.input ?? {}) as JsonValue,
					};
	}
	private async run(params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		const schedule = (params.schedule ?? { kind: "enqueue" }) as Schedule;
		const resolvedSchedule: Schedule =
			schedule.kind === "preempt_current"
				? { ...schedule, expectedRun: await this.taskRun(schedule.expectedRun) }
				: schedule.kind === "replace_pending" && schedule.targets
					? { ...schedule, targets: await Promise.all(schedule.targets.map((task) => this.taskRun(task))) }
					: schedule;
		return this.submitRequest(
			{
				operation: "submit",
				request: {
					requestId: randomUUID(),
					entry: this.entry(params),
					schedule: resolvedSchedule,
				},
			},
			signal,
		);
	}
	/**
	 * 顶层动作（run / chat / continue）的唯一出口：只等 Runtime 的可靠受理。
	 * 之后的结算由 Completion 走 Host 投递，这里不捎带终态——等一个"短窗"只会让模型
	 * 猜服务器时间，并让同一份结果出现工具与投递两条通道。
	 */
	private async submitRequest(
		intent: RequestIntent,
		signal: AbortSignal,
		task = this.handle(intent.request.requestId),
	): Promise<ToolExecutionResult> {
		if (!this.executor.status().actionsAllowed)
			return response(
				{ kind: "rejected", code: "OWNER_GATE_CLOSED", message: "Minecraft is not accepting actions" },
				"not_started",
			);
		const { requestId } = intent.request;
		await this.executor.ledger.putRequest({
			...intent,
			requestId,
			activation: this.executor.status().side!.launch,
			createdAt: new Date().toISOString(),
		});
		const reject = async (code: string, message: string, status: ToolExecutionResult["status"] = "failed") => {
			await this.executor.ledger.refuse(requestId, { kind: "rejected", code, message });
			return response({ kind: "rejected", task, code, message }, status);
		};
		if (signal.aborted) return reject("REQUEST_CANCELLED", "cancelled before dispatch", "not_started");
		this.delivery.heldRequests.add(requestId);
		const submission = (
			intent.operation === "submit" ? this.executor.submit(intent.request) : this.executor.continue(intent.request)
		).then(async (accepted) => {
			if (accepted.kind === "accepted")
				await this.executor.ledger.found(requestId, {
					kind: "found",
					requestId,
					operation: intent.operation,
					segment: accepted.segment,
					snapshot: accepted.snapshot,
				});
			if (accepted.kind === "not_accepted")
				await this.executor.ledger.refuse(requestId, {
					kind: "rejected",
					code: accepted.code,
					message: accepted.message,
				});
			return accepted;
		});

		let accepted: Acceptance;
		try {
			accepted = await cancelled(submission, signal);
		} catch (error) {
			if (error instanceof RpcError && error.dispatch === "not_sent")
				return reject(error.code, error.message, "not_started");
			return this.confirming(task, String(error));
		} finally {
			void submission.finally(() => this.delivery.heldRequests.delete(requestId)).catch(() => {});
		}
		if (accepted.kind === "unknown") return this.confirming(task, accepted.reason);
		if (accepted.kind === "not_accepted")
			return response({ kind: "rejected", task, code: accepted.code, message: accepted.message }, "failed");
		return {
			...response({
				kind: "accepted",
				task,
				...(this.policy.diagnostics ? { requestId, run: accepted.snapshot.run, segment: accepted.segment } : {}),
			}),
			continuation: "yield",
		};
	}

	private confirming(task: string, reason: string): ToolExecutionResult {
		return response(
			{ kind: "confirming", task, reason, nextCall: { action: "tasks", params: { op: "get", task } } },
			"unknown",
		);
	}

	private async pendingContinuation(snapshot: Extract<RunSummary, { phase: "awaiting_decision" }>) {
		const [pending] = await this.executor.ledger.requests({
			kind: "continuation",
			run: snapshot.run,
			decision: snapshot.decision,
		});
		return pending ? this.executor.lookup(pending.requestId) : null;
	}

	private handle(requestId: string): string {
		return taskHandle(this.policy.profileId ?? "local", requestId);
	}

	private taskRequest(task: string): string {
		const prefix = this.handle("");
		if (!task.startsWith(prefix))
			throw new RpcError("TASK_PROFILE_MISMATCH", "reconnect the Profile that owns this task");
		const requestId = task.slice(prefix.length);
		if (!requestId) throw new RpcError("INVALID_INPUT", "missing task identity");
		return requestId;
	}

	private async taskRun(task: string): Promise<string> {
		if (this.policy.diagnostics && !task.startsWith("task:")) return task;
		const found = await this.executor.lookup(this.taskRequest(task));
		if (found.kind !== "found") throw new RpcError("TASK_UNAVAILABLE", "this task has no readable execution");
		return found.snapshot.run;
	}

	private async tasks(p: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		const project = (snapshot: RunSummary) => taskView(this.handle(snapshot.rootRequestId), snapshot);
		if (p.op === "list") {
			const page = await this.executor.rpc<{ items: RunSummary[]; next?: string }>(
				"runtime.list",
				{ activeOnly: p.activeOnly ?? true, ...(p.cursor ? { cursor: p.cursor } : {}) },
				signal,
			);
			const seen = new Set(page.items.map((item) => item.rootRequestId));
			const additional = p.cursor
				? []
				: (await this.executor.ledger.requests({ kind: "roots", activeOnly: p.activeOnly !== false }))
						.filter(
							(item) =>
								item.operation === "submit" &&
								!item.run &&
								!seen.has(item.requestId) &&
								(p.activeOnly === false || !item.refusal),
						)
						.slice(-20)
						.reverse()
						.map((item) => {
							const task = this.handle(item.requestId);
							if (!item.refusal) return { task, phase: "confirming" };
							const { kind, code, message } = item.refusal;
							return {
								task,
								phase: "finished",
								outcome: kind === "cancelled" ? "cancelled" : "not_started",
								error: { code, message },
							};
						});
			return response({ ...page, items: [...additional, ...page.items.map(project)] });
		}
		const task = p.task as string;
		const requestId = this.taskRequest(task);
		const credential = await this.executor.ledger.getRequest(requestId);
		if (credential?.operation === "continue") throw new RpcError("TASK_NOT_FOUND", "use the original task handle");
		if (credential?.refusal) {
			const { kind, code, message } = credential.refusal;
			const terminal = {
				task,
				phase: "finished",
				outcome: kind === "cancelled" ? "cancelled" : "not_started",
				error: { code, message },
			};
			if (p.op === "get" || p.op === "stop") return response(terminal);
			throw new RpcError("TASK_UNAVAILABLE", "this task has no accepted execution");
		}
		const found = await this.executor.lookup(requestId);
		if (found.kind === "not_found" && !credential) throw new RpcError("TASK_NOT_FOUND", "unknown task");
		if (found.kind === "rejected" || found.kind === "cancelled") {
			if (p.op === "get" || p.op === "stop")
				return response({
					task,
					phase: "finished",
					outcome: found.kind === "cancelled" ? "cancelled" : "not_started",
					...(found.kind === "rejected" ? { error: { code: found.code, message: found.message } } : {}),
				});
			throw new RpcError("TASK_UNAVAILABLE", "this task has no accepted execution");
		}
		if (p.op === "stop") {
			if (!credential && found.kind !== "found")
				throw new RpcError("TASK_UNAVAILABLE", "task identity cannot be confirmed");
			const receipt = await this.executor.stop({
				requestId: randomUUID(),
				target: found.kind === "found" ? { run: found.snapshot.run } : { request: requestId },
			});
			return response(
				{
					task,
					intent: receipt.intent,
					control: receipt.control,
					...(receipt.snapshot ? { state: project(receipt.snapshot) } : {}),
					...(receipt.error ? { error: receipt.error } : {}),
				},
				receipt.intent === "unknown" ? "unknown" : "succeeded",
			);
		}
		if (p.op === "get") {
			if (found.kind !== "found")
				return response(
					{
						task,
						phase: "confirming",
						reason: found.kind === "unavailable" ? found.reason : "acceptance is not yet confirmed",
					},
					"unknown",
				);
			const { snapshot } = found;
			if (snapshot.phase === "awaiting_decision") {
				const latest = await this.pendingContinuation(snapshot);
				if (latest?.kind === "found") return response(project(latest.snapshot));
				if (latest?.kind === "not_found" || latest?.kind === "unavailable")
					return response(
						{ ...project(snapshot), phase: "confirming", reason: "continuation acceptance is not yet confirmed" },
						"unknown",
					);
			}
			if (snapshot.phase === "finished") {
				const report = await this.executor
					.rpc<import("../contracts/runtime.js").DeliveryState>(
						"runtime.readDelivery",
						{ ref: snapshot.completionRef },
						signal,
					)
					.then((state) => this.delivery.view(state))
					.catch(() => null);
				if (report?.content.kind === "inline" && report.content.report.reportKind === "terminal")
					return response({ ...project(snapshot), value: report.content.report.snapshot.value });
				return response({ ...project(snapshot), detail: report?.content.kind ?? "unavailable" });
			}
			return response(project(snapshot));
		}
		if (found.kind !== "found") throw new RpcError("TASK_UNAVAILABLE", "this task has no readable execution");
		if (p.op === "trace") {
			const { snapshot } = found;
			if (p.record) {
				if (p.record !== snapshot.record && !("completionRef" in snapshot && p.record === snapshot.completionRef))
					throw new RpcError("INVALID_INPUT", "record must be the current task record or report");
				return response(await this.executor.readRecord(p.record as string, { format: "inline" }));
			}
			const calls = await this.executor.rpc(
				"runtime.calls",
				{
					run: snapshot.run,
					...(p.parent ? { parent: p.parent } : {}),
					...(p.cursor ? { cursor: p.cursor } : {}),
				},
				signal,
			);
			return response({ snapshot, calls });
		}
		if (p.op === "continue") {
			if (found.snapshot.phase !== "awaiting_decision" || p.decision !== found.snapshot.decision)
				throw new RpcError("DECISION_STALE", "read the current task decision before continuing");
			const pending = await this.pendingContinuation(found.snapshot);
			if (pending?.kind === "not_found" || pending?.kind === "unavailable")
				return this.confirming(task, "continuation acceptance is not yet confirmed");
			if (pending?.kind === "found") throw new RpcError("DECISION_STALE", "this decision was already accepted");
			return this.submitRequest(
				{
					operation: "continue",
					request: {
						requestId: randomUUID(),
						run: found.snapshot.run,
						decision: found.snapshot.decision,
						entry: this.entry(p.entry as Record<string, unknown>),
						...(p.environment === undefined ? {} : { environment: p.environment as "inherit" | "current" }),
					},
				},
				signal,
				task,
			);
		}
		throw new RpcError("INVALID_INPUT", "unknown tasks operation");
	}

	/**
	 * `runs.status`（无 run）的模型出口：内部 status 带最多 64KB 执行侧日志尾，
	 * 只有排障时才需要。ready 且无 fault 时省略 tail；否则只给末 2000 字符。
	 */
	private async platformStatus(): Promise<Record<string, unknown>> {
		const status = this.executor.status();
		const full = status.phase === "ready" ? await this.executor.inspect() : status;
		const { tail, ...diagnostics } = full.diagnostics;
		const delivery = this.delivery.diagnostics();
		return {
			...full,
			diagnostics:
				full.phase === "ready" && full.fault == null ? diagnostics : { ...diagnostics, tail: tail.slice(-2000) },
			delivery: { pendingCount: delivery.pendingCount, error: delivery.error },
		};
	}
	private async runs(p: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		switch (p.op) {
			case "status":
				return response(p.run ? await this.executor.read(p.run as string) : await this.platformStatus());
			case "list":
				return response(
					await this.executor.rpc(
						"runtime.list",
						{ activeOnly: p.activeOnly ?? true, ...(p.cursor ? { cursor: p.cursor } : {}) },
						signal,
					),
				);
			case "calls":
				return response(
					await this.executor.rpc(
						"runtime.calls",
						{ run: p.run, ...(p.parent ? { parent: p.parent } : {}), ...(p.cursor ? { cursor: p.cursor } : {}) },
						signal,
					),
				);
			case "record":
				return response(
					await this.executor.readRecord(p.ref as string, {
						...(p.format ? { format: p.format as "auto" | "inline" | "file" } : {}),
					}),
				);
			case "wait":
				return response(
					await this.executor.wait(
						p.run as string,
						{
							...(p.afterRevision === undefined ? {} : { afterRevision: p.afterRevision as number }),
							...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs as number }),
						},
						signal,
					),
				);
			case "stop": {
				const receipt = await this.executor.stop({
					requestId: randomUUID(),
					target: p.run ? { run: p.run as string } : { request: p.request as string },
				});
				return response(receipt, receipt.intent === "unknown" ? "unknown" : "succeeded");
			}
			case "continue":
				return this.submitRequest(
					{
						operation: "continue",
						request: {
							requestId: randomUUID(),
							run: p.run as string,
							decision: p.decision as string,
							entry: this.entry(p.entry as Record<string, unknown>),
							...(p.environment === undefined ? {} : { environment: p.environment as "inherit" | "current" }),
						},
					},
					signal,
				);
			default:
				throw new RpcError("INVALID_INPUT", `unknown runs operation ${p.op}`);
		}
	}
}
