/** One report, two presentation channels. Host canonical receipts alone acknowledge Runtime. */
import { randomUUID } from "node:crypto";
import type { HostDeliveryState } from "../../../../src/core/types.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { CompletionView, DeliveryRef, DeliveryState } from "../contracts/runtime.js";
import type { MinecraftExecutor } from "./index.js";
import type { DeliveryAttempt } from "./ledger-worker.js";

/** minecraft_event 投递失败的补发等待；幂等 id 下重试一次的重复风险低于静默丢失。 */
const EVENT_RETRY_MS = 1000;

type EventNotice = Parameters<NonNullable<ServiceCompanionContext["emitEvent"]>>[0];

export class DeliveryPump {
	readonly heldRequests = new Set<string>();
	private readonly heldTools = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeSide: (() => void) | null = null;
	private active: (Omit<DeliveryAttempt, "activation"> & { activation?: string }) | null = null;
	private emitting = false;
	private error: { code: string; message: string } | null = null;
	private lastCheckedAt: string | null = null;
	private pendingCount: number | null = null;
	private hostState: HostDeliveryState = { kind: "unavailable", reason: "not checked" };
	private failures = 0;
	private readonly activation = `delivery:${randomUUID()}`;
	constructor(
		private readonly executor: MinecraftExecutor,
		private readonly ctx: ServiceCompanionContext,
		private readonly pollMs = 5000,
	) {}
	start(): void {
		this.unsubscribeSide = this.executor.subscribe((events) => {
			this.wake(0);
			for (const event of events) {
				this.emitNotice({
					id: event.ref,
					type: "minecraft_event",
					origin: "external",
					channel: "world",
					// 需要尽快重新决策的事件（玩家私聊/死亡/断线）走 steer；其余排队等下一次决策。
					...(urgentEvent(event.payload) ? { delivery: "urgent" as const } : {}),
					text: JSON.stringify({
						...event,
						nextCall:
							(event.payload as { kind?: string })?.kind === "safety_changed"
								? { action: "runs", params: { op: "record", ref: event.ref } }
								: { action: "observe", params: { selector: "events@1" } },
					}),
				});
			}
		});
		this.unsubscribe = this.ctx.onHostEvent?.(() => this.wake(0)) ?? null;
		this.wake(this.pollMs);
	}
	private wake(ms: number): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.reconcile().catch(() => {});
		}, ms);
	}
	/** 即发即弃但失败补发一次（幂等 id）；仍失败只存诊断——证据本体已持久，events@1 可回放。 */
	private emitNotice(notice: EventNotice): void {
		void this.attemptEmit(notice).catch((error: unknown) => {
			this.error = { code: "EVENT_DELIVERY_FAILED", message: String(error) };
		});
	}
	private async attemptEmit(notice: EventNotice, retries = 1): Promise<void> {
		try {
			await this.ctx.emitEvent!(notice);
		} catch (error) {
			if (retries === 0 || this.stopped) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, EVENT_RETRY_MS));
			if (this.stopped) throw error;
			await this.attemptEmit(notice, retries - 1);
		}
	}
	async view(state: DeliveryState): Promise<CompletionView> {
		const header = state.delivery;
		if (header.recordBytes + Buffer.byteLength(JSON.stringify(header)) + 1024 > 16 * 1024)
			return { ...header, content: { kind: "record", record: header.completionRef } };
		try {
			const full = await this.executor.readRecord(header.completionRef, { format: "inline" });
			if (full.kind !== "inline" || full.record.kind !== "completion") throw new Error("completion record unavailable");
			const delivery = full.record.value as unknown as import("../contracts/runtime.js").Delivery;
			return {
				...header,
				content: {
					kind: "inline",
					report: {
						reportKind: delivery.reportKind,
						snapshot: delivery.snapshot,
					} as import("../contracts/runtime.js").CompletionReport,
				},
			};
		} catch (error) {
			return {
				...header,
				content: {
					kind: "unavailable",
					record: header.completionRef,
					error: { code: "RECORD_UNAVAILABLE", message: String(error) },
				},
			};
		}
	}
	async toolAttempt(key: string): Promise<{ key: string; attempt: string }> {
		const attempt = await this.prepare(key, "tool");
		this.heldTools.add(key);
		// The Host registers tool attempts synchronously on receipt, ahead of after-hooks.
		setTimeout(() => {
			this.heldTools.delete(key);
			this.wake(this.pollMs);
		}, 0);
		return { key, attempt: attempt.attempt };
	}
	private async prepare(key: string, channel: "tool" | "input"): Promise<DeliveryAttempt> {
		const port = this.ctx.delivery!;
		const attempt: DeliveryAttempt = {
			key,
			attempt: randomUUID(),
			channel,
			namespace: port.namespace,
			session: port.session,
			activation: this.activation,
			createdAt: new Date().toISOString(),
		};
		await this.executor.ledger.putAttempt(attempt);
		return attempt;
	}
	private async ack(key: string, state: Extract<HostDeliveryState, { kind: "committed" }>): Promise<void> {
		const r = state.receipt,
			p = this.ctx.delivery!;
		if (r.key !== key || r.namespace !== p.namespace || r.session !== p.session)
			throw new Error("Host receipt scope mismatch");
		// Host has durably received this input. A lost Runtime ACK reply must not hold the local input slot.
		if (this.active?.key === key) this.active = null;
		await this.executor.rpc("runtime.settleDelivery", { ref: key, receipt: r });
	}
	reconcile(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return (this.running ??= (async () => {
			try {
				await this.drain();
				this.error = null;
				this.failures = 0;
			} catch (error) {
				this.error = { code: "DELIVERY_UNCONFIRMED", message: String(error) };
				this.failures++;
			} finally {
				this.running = null;
				this.wake(this.failures ? Math.min(8000, 1000 * 2 ** (this.failures - 1)) : this.pollMs);
			}
		})());
	}
	private async drain(): Promise<void> {
		if (this.ctx.signal.aborted || this.stopped) return;
		const port = this.ctx.delivery!;
		const attempts = new Map((await this.executor.ledger.attempts()).map((a) => [a.key, a]));
		// Recovery only looks up original intentions. It never resends actions.
		for (const c of await this.executor.ledger.requests())
			if (!c.run) {
				const found = await this.executor.lookup(c.requestId);
				if (found.kind === "found") await this.executor.ledger.found(c.requestId, found);
			}
		let cursor: string | undefined;
		let count = 0;
		let unconfirmed: Error | null = null;
		do {
			const page = await this.executor.rpc<{ items: DeliveryRef[]; next?: string }>("runtime.pendingDeliveries", {
				...(cursor ? { cursor } : {}),
				limit: 100,
			});
			cursor = page.next;
			count += page.items.length;
			for (const ref of page.items) {
				if (this.stopped || this.ctx.signal.aborted) return;
				if (this.heldRequests.has(ref.requestId)) continue;
				const host = await port.inspect(ref.completionRef);
				this.lastCheckedAt = new Date().toISOString();
				if (this.active?.key === ref.completionRef) this.hostState = host;
				if (host.kind === "committed") {
					await this.ack(ref.completionRef, host);
					continue;
				}
				if (host.kind === "unavailable") {
					unconfirmed = new Error(host.reason);
					continue;
				}
				const prior = attempts.get(ref.completionRef);
				if (host.kind === "pending") {
					const hold = (state: Extract<HostDeliveryState, { kind: "pending" }>) => {
						if (state.channel !== "input") return;
						this.hostState = state;
						this.active = {
							key: ref.completionRef,
							attempt: state.attempt,
							channel: "input",
							namespace: port.namespace,
							session: port.session,
							createdAt: state.since,
						};
					};
					if (prior?.channel === "input" && prior.activation !== this.activation && host.attempt === prior.attempt) {
						const retired = await port.retire(ref.completionRef, prior.attempt);
						if (retired.kind === "committed") {
							await this.ack(ref.completionRef, retired);
							continue;
						}
						if (retired.kind === "unavailable") {
							unconfirmed = new Error(retired.reason);
							continue;
						}
						if (this.active?.key === ref.completionRef) this.active = null;
						if (retired.kind === "changed") {
							if (retired.state.kind === "committed") await this.ack(ref.completionRef, retired.state);
							else if (retired.state.kind === "pending") hold(retired.state);
							else if (retired.state.kind === "unavailable") unconfirmed = new Error(retired.state.reason);
						}
						continue;
					}
					hold(host);
					continue;
				}
				if (this.heldTools.has(ref.completionRef)) continue;
				if (this.active?.key === ref.completionRef) {
					if (this.emitting) continue;
					this.active = null;
				}
				if (this.active) continue;
				let state: DeliveryState;
				try {
					state = await this.executor.rpc("runtime.readDelivery", { ref: ref.completionRef });
				} catch (error) {
					unconfirmed = error instanceof Error ? error : new Error(String(error));
					continue;
				}
				if (!state.eligible) continue;
				const view = await this.view(state);
				const attempt = await this.prepare(ref.completionRef, "input");
				if (this.stopped || this.ctx.signal.aborted) return;
				this.active = attempt;
				this.emitting = true;
				// emitEvent can encompass a full model turn; never await it inside drain.
				void Promise.resolve()
					.then(() =>
						this.ctx.emitEvent!({
							id: attempt.attempt,
							type: "minecraft_completion",
							channel: "world",
							origin: "internal",
							receipt: { key: attempt.key, attempt: attempt.attempt },
							render: async () => {
								if (this.stopped) return null;
								const latest = await this.executor.rpc<DeliveryState>("runtime.readDelivery", {
									ref: ref.completionRef,
								});
								return latest.eligible ? formatCompletion(view) : null;
							},
							data: view,
						}),
					)
					.catch((error) => {
						this.error = { code: "DELIVERY_UNCONFIRMED", message: String(error) };
					})
					.finally(() => {
						this.emitting = false;
						this.wake(0);
					});
			}
		} while (cursor);
		this.pendingCount = count;
		if (unconfirmed) throw unconfirmed;
	}
	async retry(key: string, expectedAttempt: string): Promise<unknown> {
		const reply = await this.ctx.delivery!.retire(key, expectedAttempt);
		if (reply.kind === "committed") await this.ack(key, reply);
		if (reply.kind === "retired" && this.active?.attempt === expectedAttempt) this.active = null;
		this.wake(0);
		return reply;
	}
	diagnostics() {
		return {
			observedAt: new Date().toISOString(),
			pendingCount: this.pendingCount,
			activeInput: this.active ? { ...this.active, lastCheckedAt: this.lastCheckedAt, host: this.hostState } : null,
			lastCheckedAt: this.lastCheckedAt,
			hostBusy: this.ctx.isBusy?.() ?? null,
			error: this.error,
		};
	}
	async close(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.unsubscribe?.();
		this.unsubscribeSide?.();
		await this.running;
	}
}

/**
 * 需要立即重新决策的事件（urgent → steer）：当前执行前提已失效，或有人在等回应。
 * 其余事实走 queued——不打断当前思考，等下一次决策回合一起处理。
 */
function urgentEvent(payload: unknown): boolean {
	const value = payload as
		| { kind?: string; state?: string; channel?: string; self?: boolean; ended?: string }
		| null
		| undefined;
	if (value == null) return false;
	switch (value.kind) {
		case "death":
			return true;
		case "connection":
			return value.state === "disconnected";
		case "chat":
			return value.channel === "private" && value.self === false;
		// 本地安全响应已尽力仍未脱险：等到下一个回合可能就晚了。
		case "safety_changed":
			return value.ended === "blocked" || value.ended === "timeout";
		default:
			return false;
	}
}

/**
 * 模型展示投影：只保留该 phase 决策所需字段，每个事实只出现一次。
 *
 * 这不是 CompletionView 的序列化——结构化原件留在工具 details
 * （`facade.execute` 的 `{kind:"result", ...view}`）与后台通知的 event.data，
 * 供前端与 effect 读取。`awaiting_decision` 必须带 decision：runs.continue 只能用它续段。
 */
export function formatCompletion(view: CompletionView): string {
	const base = { kind: "result" as const, run: view.run };
	if (view.content.kind !== "inline") {
		// 正文读不到或太大：只能用有界 summary，被截断处必须留标志。
		const snapshot = view.snapshot;
		return JSON.stringify({
			...base,
			phase: snapshot.phase,
			progress: snapshot.progress,
			...(snapshot.progressComplete ? {} : { progressComplete: false }),
			...(snapshot.phase === "awaiting_decision"
				? {
						decision: snapshot.decision,
						reason: snapshot.reason,
						...(snapshot.reasonComplete ? {} : { reasonComplete: false }),
					}
				: {
						outcome: snapshot.outcome,
						...(snapshot.error != null
							? {
									error: {
										code: snapshot.error.code,
										message: snapshot.error.message,
										...(snapshot.error.messageComplete ? {} : { messageComplete: false }),
									},
								}
							: {}),
					}),
			detail: view.content.kind,
			unknownEffectCount: snapshot.unknownEffectCount,
			unknownEffectsComplete: snapshot.unknownEffectsComplete,
			completionRef: view.completionRef,
			// 正文读不到时 record 同样读不到，不指一条注定失败的下一步。
			...(view.content.kind === "record"
				? { nextCall: { action: "runs", params: { op: "record", ref: view.completionRef } } }
				: {}),
		});
	}
	const snapshot = view.content.report.snapshot;
	if (snapshot.phase === "awaiting_decision")
		return JSON.stringify({
			...base,
			phase: snapshot.phase,
			progress: snapshot.progress,
			decision: snapshot.decision,
			reason: snapshot.reason,
			completionRef: view.completionRef,
		});
	return JSON.stringify({
		...base,
		phase: snapshot.phase,
		outcome: snapshot.outcome,
		progress: snapshot.progress,
		...(snapshot.value !== undefined ? { value: snapshot.value } : {}),
		...(snapshot.error != null ? { error: { code: snapshot.error.code, message: snapshot.error.message } } : {}),
		...(snapshot.unknownEffects.length > 0 ? { unknownEffects: snapshot.unknownEffects } : {}),
		...(snapshot.interruptedChildren != null && snapshot.interruptedChildren.length > 0
			? { interruptedChildren: snapshot.interruptedChildren }
			: {}),
		completionRef: view.completionRef,
		nextCall: { action: "runs", params: { op: "record", ref: view.completionRef } },
	});
}
