/** Model adapter. Scheduling and completion remain in Runtime; delivery uses the existing Host. */
import { randomUUID } from "node:crypto";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { Acceptance, DeliveryState, Entry, Schedule } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import { DeliveryPump, formatCompletion } from "./delivery.js";
import { MinecraftExecutor } from "./index.js";
import { RpcError } from "./ipc.js";
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
		private readonly policy: { shortWindowMs?: number; pollMs?: number } = {},
	) {
		this.delivery = new DeliveryPump(executor, ctx, policy.pollMs);
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
				case "runs":
					return await this.runs(params, signal);
				default:
					throw new RpcError("INVALID_INPUT", `unknown Minecraft action ${action}`);
			}
		} catch (error) {
			const e = error as { code?: string; message?: string; dispatch?: string };
			return response(
				{
					code: e.code ?? "INTERNAL",
					message: e.message ?? String(error),
					...(e.code === "RECORD_TOO_LARGE"
						? { nextCall: { action: "runs", params: { op: "record", ref: params.ref, format: "file" } } }
						: {}),
				},
				e.code === "REQUEST_CANCELLED"
					? "cancelled"
					: action === "runs" && params.op === "stop" && e.dispatch === "unknown"
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
	private run(params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		return this.submitRequest(
			{
				operation: "submit",
				request: {
					requestId: randomUUID(),
					entry: this.entry(params),
					schedule: (params.schedule ?? { kind: "enqueue" }) as Schedule,
				},
			},
			signal,
			// G8：按调用短窗覆盖。0 = 只受理不等（完成走 minecraft_completion）。
			typeof params.wait === "number" ? params.wait : undefined,
		);
	}
	private async submitRequest(
		intent: RequestIntent,
		signal: AbortSignal,
		waitMs?: number,
	): Promise<ToolExecutionResult> {
		if (!this.executor.status().actionsAllowed)
			return response({ code: "OWNER_GATE_CLOSED", message: "owner action gate is closed" }, "not_started");
		const { requestId } = intent.request;
		await this.executor.ledger.putRequest({
			...intent,
			requestId,
			activation: this.executor.status().side!.launch,
			createdAt: new Date().toISOString(),
		});
		if (signal.aborted)
			return response(
				{
					kind: "not_accepted",
					requestId,
					code: "REQUEST_CANCELLED",
					message: "cancelled before dispatch; original credential retained",
				},
				"not_started",
			);
		this.delivery.heldRequests.add(requestId);
		const submission =
			intent.operation === "submit" ? this.executor.submit(intent.request) : this.executor.continue(intent.request);
		// The shared acceptance has its own lifetime, independent of this tool wait.
		void submission
			.then(async (accepted) => {
				if (accepted.kind === "accepted")
					await this.executor.ledger.found(requestId, {
						kind: "found",
						requestId,
						operation: intent.operation,
						segment: accepted.segment,
						snapshot: accepted.snapshot,
					});
			})
			.catch(() => {});
		let accepted: Acceptance;
		try {
			accepted = await cancelled(submission, signal);
		} catch (error) {
			void submission.finally(() => this.delivery.heldRequests.delete(requestId)).catch(() => {});
			if (error instanceof RpcError && error.dispatch === "not_sent")
				return response(
					{
						kind: "not_accepted",
						requestId,
						code: error.code,
						message: error.message,
						nextCall: { action: "runs", params: { op: "retry", request: requestId } },
					},
					["EXECUTOR_UNAVAILABLE", "TRANSPORT_BUSY"].includes(error.code) ? "not_started" : "failed",
				);
			return response(
				{
					kind: "unknown",
					requestId,
					reason: String(error),
					nextCall: { action: "runs", params: { op: "request", request: requestId } },
				},
				"unknown",
			);
		}
		try {
			if (accepted.kind !== "accepted")
				return response(
					{
						...accepted,
						...(accepted.kind === "unknown"
							? { nextCall: { action: "runs", params: { op: "request", request: requestId } } }
							: {}),
					},
					accepted.kind === "unknown" ? "unknown" : "failed",
				);
			if (waitMs === 0) return response(accepted);
			let waited;
			try {
				waited = await this.executor.wait(
					accepted.snapshot.run,
					{ timeoutMs: waitMs ?? this.policy.shortWindowMs ?? 3000 },
					signal,
				);
			} catch (error) {
				if ((error as { code?: string }).code !== "REQUEST_CANCELLED") throw error;
				return response(accepted);
			}
			if (
				waited.kind !== "result" ||
				(waited.snapshot.phase !== "finished" && waited.snapshot.phase !== "awaiting_decision")
			)
				return response(accepted);
			const state = await this.executor.rpc<DeliveryState>("runtime.readDelivery", {
				ref: waited.snapshot.completionRef,
			});
			const view = await this.delivery.view(state);
			const receipt = await this.delivery.toolAttempt(view.completionRef);
			return {
				status: view.snapshot.phase === "finished" ? view.snapshot.outcome : "succeeded",
				result: formatCompletion(view),
				details: { kind: "result", ...view },
				receipt,
			};
		} catch (error) {
			return response({
				...accepted,
				error: { code: (error as { code?: string }).code ?? "RESULT_UNAVAILABLE", message: String(error) },
				nextCall: { action: "runs", params: { op: "request", request: requestId } },
			});
		} finally {
			this.delivery.heldRequests.delete(requestId);
		}
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
			case "request":
				return response(await this.executor.lookup(p.request as string));
			case "retry": {
				const credential = await this.executor.ledger.getRequest(p.request as string);
				if (!credential) throw new RpcError("NOT_FOUND", "original request credential is unavailable");
				const found = await this.executor.lookup(credential.requestId);
				if (found.kind === "found" || found.kind === "cancelled" || found.kind === "unavailable")
					return response(found);
				const accepted =
					credential.operation === "continue"
						? await this.executor.continue(credential.request)
						: await this.executor.submit(credential.request);
				return response(
					accepted,
					accepted.kind === "unknown" ? "unknown" : accepted.kind === "not_accepted" ? "failed" : "succeeded",
				);
			}
			case "stop": {
				const receipt = await this.executor.stop({
					requestId: randomUUID(),
					target: p.run ? { run: p.run as string } : { request: p.request as string },
				});
				return response(receipt, receipt.intent === "unknown" ? "unknown" : "succeeded");
			}
			case "recover": {
				const state = await this.executor.recover(
					p.expected as { attachment: string; gateRevision: number } | undefined,
				);
				return response({
					...state,
					...(state.side?.owner?.gates.includes("owner_lost")
						? {
								nextCall: {
									action: "runs",
									params: {
										op: "recover",
										expected: { attachment: state.side.owner.attachment, gateRevision: state.side.owner.gateRevision },
									},
								},
							}
						: {}),
				});
			}
			case "delivery": {
				const item = p.ref ? await this.executor.rpc<DeliveryState>("runtime.readDelivery", { ref: p.ref }) : undefined;
				if (p.retry === true) return response(await this.delivery.retry(p.ref as string, p.expectedAttempt as string));
				return response({
					...this.delivery.diagnostics(),
					...(item ? { item: { key: p.ref, ...item, host: await this.ctx.delivery!.inspect(p.ref as string) } } : {}),
				});
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
