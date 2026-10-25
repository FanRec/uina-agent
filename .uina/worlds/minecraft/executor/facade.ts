/** Model adapter. Scheduling and completion remain in Runtime; delivery uses the existing Host. */
import { randomUUID } from "node:crypto";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { Acceptance, DeliveryState, RunRequest } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import { MinecraftExecutor } from "./index.js";
import { DeliveryPump, formatCompletion } from "./delivery.js";
import { RpcError } from "./ipc.js";

function response(value: unknown, status: ToolExecutionResult["status"] = "succeeded"): ToolExecutionResult {
	return { status, result: JSON.stringify(value), details: value };
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
				case "describe":
					return response(await this.executor.rpc("describe", params, signal));
				case "observe":
					return response(
						await this.executor.rpc("observe", { selector: params.selector, input: params.input ?? {} }, signal),
					);
				case "library":
					throw new RpcError("LIBRARY_UNAVAILABLE", "file Library is not delivered in the native stage");
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
	private async run(params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		if (params.code !== undefined || typeof params.selector !== "string" || !params.selector.includes("@"))
			throw new RpcError(
				"PROGRAM_UNAVAILABLE",
				"this stage supports exact native selectors; programs and code are not delivered",
			);
		const schedule = params.schedule ?? { kind: "enqueue" };
		if ((schedule as { kind?: string }).kind !== "enqueue")
			throw new RpcError("SCHEDULE_UNAVAILABLE", "this stage supports enqueue only");
		if (!this.executor.status().actionsAllowed)
			return response({ code: "OWNER_GATE_CLOSED", message: "owner action gate is closed" }, "not_started");
		const requestId = randomUUID();
		const request: RunRequest = {
			requestId,
			entry: { kind: "call", selector: params.selector, input: (params.input ?? {}) as JsonValue },
			schedule: { kind: "enqueue" },
		};
		await this.executor.ledger.putRequest({
			requestId,
			request,
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
		const submission = this.executor.submit(request);
		// The shared acceptance has its own lifetime, independent of this tool wait.
		void submission
			.then(async (accepted) => {
				if (accepted.kind === "accepted")
					await this.executor.ledger.found(requestId, {
						kind: "found",
						requestId,
						operation: "submit",
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
			let waited;
			try {
				waited = await this.executor.wait(
					accepted.snapshot.run,
					{ timeoutMs: this.policy.shortWindowMs ?? 3000 },
					signal,
				);
			} catch (error) {
				if ((error as { code?: string }).code !== "REQUEST_CANCELLED") throw error;
				return response(accepted);
			}
			if (waited.kind !== "result" || waited.snapshot.phase !== "finished") return response(accepted);
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
	private async runs(p: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionResult> {
		switch (p.op) {
			case "status":
				return response(
					p.run
						? await this.executor.read(p.run as string)
						: {
								...(this.executor.status().phase === "ready" ? await this.executor.inspect() : this.executor.status()),
								delivery: this.delivery.diagnostics(),
							},
				);
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
				const accepted = await this.executor.submit(credential.request);
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
				throw new RpcError("PROGRAM_UNAVAILABLE", "decision continuation is not delivered");
			default:
				throw new RpcError("INVALID_INPUT", `unknown runs operation ${p.op}`);
		}
	}
}
