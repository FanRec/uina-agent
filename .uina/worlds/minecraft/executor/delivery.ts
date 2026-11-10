/**
 * 完成通知只走一条路：Runtime 的 completion 报告 → Host 批量持久入队 → 模型回合消费。
 * Host 的 Canonical 回执才 ACK Runtime；工具层只回受理，不带报告正文。
 */
import { constructionDecisionEvidence, taskHandle, taskView } from "../contracts/task.js";
import { randomUUID } from "node:crypto";
import type { HostDeliveryPort, HostDeliveryState } from "../../../../src/core/types.js";
import type { ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import type { CompletionView, DeliveryRef, DeliveryState, Entry } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import type { MinecraftExecutor } from "./index.js";
import type { DeliveryAttempt } from "./ledger-worker.js";

/** minecraft_event 投递失败的补发等待；幂等 id 下重试一次的重复风险低于静默丢失。 */
const EVENT_RETRY_MS = 1000;
/**
 * 一次集中交付的条数上限。它不是正确性参数：超出部分留在 Runtime 的 pending 列表里，
 * 下一次唤醒再交。取小值只为不让一次唤醒读满一页记录、把 reconcile 拖长。
 */
const DELIVERY_BATCH = 8;
/**
 * 一轮对账检查的 pending 条数预算。规模变大时"每轮扫完全部历史待办"会把新完成
 * 饿在后面：10000 条 pending 意味着 100 次分页 + 10000 次宿主 inspect。预算用满就
 * 记住键集游标，下一轮从那里继续，扫到末尾再回到开头——每条都会被看到，但不要求
 * 一轮看完。
 */
const SCAN_BUDGET = 96;

type EventNotice = Parameters<NonNullable<ServiceCompanionContext["emitEvent"]>>[0];
/** 已备好 attempt、等着和同批一起交出去的一条完成通知。 */
interface Deliverable {
	ref: DeliveryRef;
	view: CompletionView;
	attempt: DeliveryAttempt;
}
/** 诊断用的在途输入：本激活派发的，或宿主正在处理的。 */
interface ActiveInput {
	channel: "input";
	attempt: string;
	createdAt: string;
	host: HostDeliveryState;
}

export class DeliveryPump {
	/**
	 * 工具调用期间压住该 requestId 的 Completion：受理结果还没进它自己的回合时，
	 * 不要让同一件事的完成通知抢先成为模型看到的第一个事实。
	 */
	readonly heldRequests = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeSide: (() => void) | null = null;
	/** 在途输入，按 completionRef 记：宿主回执提交即清。多份完成通知互不占位。 */
	private readonly inputs = new Map<string, ActiveInput>();
	private emitting = false;
	private error: { code: string; message: string } | null = null;
	private lastCheckedAt: string | null = null;
	/** 本激活累计：已提交给宿主的完成通知、被宿主明确退掉的输入。 */
	private committed = 0;
	private retired = 0;
	private pendingCount: number | null = null;
	/** 上一轮有界扫描停在哪（rowid 键集）；扫到末尾即清空，下一轮从头开始。 */
	private scanCursor: string | undefined;
	private scannedThisRound = 0;
	private failures = 0;
	private readonly activation = `delivery:${randomUUID()}`;
	constructor(
		private readonly executor: MinecraftExecutor,
		private readonly ctx: ServiceCompanionContext,
		private readonly pollMs = 5000,
		private readonly profileId?: string,
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
					text: JSON.stringify(gameEventView(event)),
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
		// 纯轮询定时器不拥有进程寿命：停机时没人清理也不会拖住伴生退役。
		this.timer.unref();
	}
	/** 即发即弃但失败补发一次（幂等 id）；仍失败只存诊断——证据本体已持久，events@1 可回放。 */
	private emitNotice(notice: EventNotice): void {
		void this.attemptEmit(notice).catch((error: unknown) => {
			this.error = { code: "EVENT_DELIVERY_FAILED", message: error instanceof Error ? error.message : String(error) };
		});
	}
	/**
	 * 交出去才算投递。`accepted:false` 表示事件还在世界手里，按 `retryable` 决定要不要再试一次；
	 * 形状非法的报错照旧抛——那是世界自己的 bug，重试没有意义。
	 */
	private async attemptEmit(notice: EventNotice, retries = 1): Promise<void> {
		const result = await this.ctx.emitEvent!(notice);
		if (result.accepted) return;
		if (!result.retryable || retries === 0 || this.stopped) throw new Error(result.reason);
		await new Promise<void>((resolve) => setTimeout(resolve, EVENT_RETRY_MS));
		if (this.stopped) throw new Error(result.reason);
		await this.attemptEmit(notice, retries - 1);
	}
	async view(state: DeliveryState): Promise<CompletionView> {
		const header = state.delivery;
		if (header.recordBytes + Buffer.byteLength(JSON.stringify(header)) + 1024 > 16 * 1024)
			return { ...header, content: { kind: "record", record: header.completionRef } };
		try {
			const full = await this.executor.readRecord(header.completionRef, { format: "inline" });
			if (full.kind !== "inline" || full.record.kind !== "completion") throw new Error("completion record unavailable");
			return {
				...header,
				content: { kind: "inline", report: completionReportOf(full.record.value) },
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
	/** 批41 起只写入 input 通道；"tool" 仅可能出现在旧账本记录里，由 scan 退役。 */
	private async prepare(key: string): Promise<DeliveryAttempt> {
		const port = this.ctx.delivery!;
		const attempt: DeliveryAttempt = {
			key,
			attempt: randomUUID(),
			channel: "input",
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
		this.inputs.delete(key);
		this.committed++;
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
		const attempts = new Map((await this.executor.ledger.attempts()).map((a) => [a.key, a]));
		await this.recoverRequests();
		const scan = await this.scan(this.ctx.delivery!, attempts);
		this.pendingCount = scan.backlog;
		// 已停用/已取消：这一批不再交出，尝试记录留在账本里，下次启动重投。
		if (this.stopped || this.ctx.signal.aborted) return;
		// 先交出能交的，再报对账失败：一条查不到回执不该拖住同一轮里别的完成通知。
		if (scan.ready.length > 0) {
			// 完成通知只走批量入口。没有它必须让本轮对账显式失败：往 this.error 里写一句
			// 会被 reconcile 的成功分支立刻清掉，诊断永远看不到这批事件根本没交出去。
			if (!this.ctx.emitEvents) throw new Error("宿主没有批量投递入口，完成通知无法交付");
			this.deliver(scan.ready);
		}
		if (scan.unconfirmed) throw scan.unconfirmed;
	}
	/** 恢复只查原始意图，绝不重发动作。 */
	private async recoverRequests(): Promise<void> {
		for (const c of await this.executor.ledger.requests({ kind: "unconfirmed" }))
			if (!c.run && !c.refusal) {
				const found = await this.executor.lookup(c.requestId);
				if (found.kind === "found") await this.executor.ledger.found(c.requestId, found);
				if (found.kind === "rejected")
					await this.executor.ledger.refuse(c.requestId, {
						kind: "rejected",
						code: found.code,
						message: found.message,
					});
				if (found.kind === "cancelled")
					await this.executor.ledger.refuse(c.requestId, {
						kind: "cancelled",
						code: "REQUEST_CANCELLED",
						message: "stopped before acceptance",
					});
			}
	}
	/**
	 * 对账一页 pending：宿主已提交的回 ACK，正在处理的记进诊断，剩下的收进本轮交付批次。
	 * 每一条各自判断，谁也不替谁占位——一条卡住不该拖住同一轮里别的完成通知。
	 *
	 * 扫描是**有界**的：最多检查 `SCAN_BUDGET` 条，用满就保留键集游标，下一轮从那里
	 * 继续。这样 10000 条积压也不会让新完成等 100 轮，且没有任何一条被永久跳过。
	 */
	private async scan(
		port: HostDeliveryPort,
		attempts: ReadonlyMap<string, DeliveryAttempt>,
	): Promise<{ backlog: number; unconfirmed: Error | null; ready: Deliverable[] }> {
		const ready: Deliverable[] = [];
		let cursor = this.scanCursor;
		/** 积压总数：Runtime 与分页同条件算出，与"本轮检查了几条"不是一回事。 */
		let backlog: number | null = null;
		let inspected = 0;
		let unconfirmed: Error | null = null;
		do {
			// 页大小按剩余预算取：单页不会超出本轮预算，于是"扫不完"时一定有 next 可续。
			const limit = Math.max(1, Math.min(100, SCAN_BUDGET - inspected));
			const page = await this.executor.rpc<{ items: DeliveryRef[]; next?: string; total?: number }>(
				"runtime.pendingDeliveries",
				{ ...(cursor ? { cursor } : {}), limit },
			);
			cursor = page.next;
			if (backlog == null && page.total != null) backlog = page.total;
			for (const ref of page.items) {
				if (this.stopped || this.ctx.signal.aborted) return { backlog: backlog ?? inspected, unconfirmed, ready };
				inspected += 1;
				if (this.heldRequests.has(ref.requestId)) continue;
				const host = await port.inspect(ref.completionRef);
				this.lastCheckedAt = new Date().toISOString();
				const known = this.inputs.get(ref.completionRef);
				if (known) known.host = host;
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
					// 上一次激活留下的输入仍挂在宿主上：不是本轮的投递，按端口规则退役或接管。
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
						this.inputs.delete(ref.completionRef);
						if (retired.kind === "changed") {
							if (retired.state.kind === "committed") await this.ack(ref.completionRef, retired.state);
							else if (retired.state.kind === "pending") this.hold(ref.completionRef, retired.state);
							else if (retired.state.kind === "unavailable") unconfirmed = new Error(retired.state.reason);
						}
						continue;
					}
					this.hold(ref.completionRef, host);
					continue;
				}
				// 宿主不认识这条：上一次尝试可能随宿主重启丢了，用新 attempt 重投是唯一正确的动作。
				if (this.emitting) continue;
				if (ready.length >= DELIVERY_BATCH) continue;
				this.inputs.delete(ref.completionRef);
				let state: DeliveryState;
				try {
					state = await this.executor.rpc("runtime.readDelivery", { ref: ref.completionRef });
				} catch (error) {
					unconfirmed = error instanceof Error ? error : new Error(String(error));
					continue;
				}
				if (!state.eligible) continue;
				ready.push({
					ref,
					view: await this.view(state),
					attempt: await this.prepare(ref.completionRef),
				});
			}
			if (inspected >= SCAN_BUDGET) break;
		} while (cursor);
		// 扫到末尾（没有 next）就回到开头：下一轮从最新的待办开始，积压不会让新完成饿死。
		this.scanCursor = cursor;
		this.scannedThisRound = inspected;
		return { backlog: backlog ?? inspected, unconfirmed, ready };
	}
	/**
	 * 一批完成通知一次交出：每条独立回执、独立结论。没交出去的那条不推进任何状态——
	 * attempt 已落账，下一次唤醒用新 attempt 重投，不把"宿主拒收"当成交付完成。
	 *
	 * emitEvents 可能覆盖一整个模型回合，绝不在 drain 里 await 它。
	 */
	private deliver(ready: readonly Deliverable[]): void {
		if (this.emitting) return;
		this.emitting = true;
		let entries: Promise<ReadonlyMap<string, Entry>> | undefined;
		const events = ready.map(({ ref, view, attempt }) => ({
			id: attempt.attempt,
			type: "minecraft_completion",
			channel: "world" as const,
			origin: "internal" as const,
			receipt: { key: attempt.key, attempt: attempt.attempt },
			// 正文到宿主真正取用才成形：一次决策看几条由宿主的有界领取预算决定。
			render: async () => {
				if (this.stopped) return null;
				entries ??= this.executor.ledger
					.taskEntries(ready.map(({ view }) => view.snapshot.rootRequestId))
					.catch(() => new Map());
				const entry = (await entries).get(view.snapshot.rootRequestId);
				const latest = await this.executor.rpc<DeliveryState>("runtime.readDelivery", { ref: ref.completionRef });
				return latest.eligible ? formatCompletion(view, this.profileId, entry) : null;
			},
			data: view,
		}));
		let delivered = 0;
		// 先记在途，再交出：诊断在整个交付窗口里都能看到这批去了哪里。
		for (const { attempt } of ready)
			this.inputs.set(attempt.key, {
				channel: "input",
				attempt: attempt.attempt,
				createdAt: attempt.createdAt,
				host: { kind: "absent" },
			});
		void Promise.resolve()
			.then(() => this.ctx.emitEvents!(events))
			.then((submissions) => {
				for (const [index, item] of ready.entries()) {
					const submission = submissions[index];
					if (submission?.accepted) {
						delivered++;
						continue;
					}
					// 宿主没接手：明确拒收与"少回一条"都算未交出。都清掉在途记录，
					// 下一次唤醒用新 attempt 重投，不留一个永远退不了的输入。
					this.inputs.delete(item.attempt.key);
					this.error = {
						code: "DELIVERY_UNCONFIRMED",
						message: submission ? submission.reason : "宿主批量回执缺少对应条目",
					};
				}
			})
			.catch((error: unknown) => {
				// 整批结果未知：留着在途记录，重投由下一次对账按宿主回执决定。
				this.error = { code: "DELIVERY_UNCONFIRMED", message: String(error) };
			})
			.finally(() => {
				this.emitting = false;
				// 全被拒就等下一次轮询：立刻再排一次会把"拒收"变成忙等。
				if (delivered > 0) this.wake(0);
			});
	}
	/** 宿主正在处理这条输入：记进诊断，不重复投递。工具通道的 pending 不算交付在途。 */
	private hold(key: string, state: Extract<HostDeliveryState, { kind: "pending" }>): void {
		if (state.channel !== "input") return;
		this.inputs.set(key, { channel: "input", attempt: state.attempt, createdAt: state.since, host: state });
	}
	async retry(key: string, expectedAttempt: string): Promise<unknown> {
		const reply = await this.ctx.delivery!.retire(key, expectedAttempt);
		if (reply.kind === "committed") await this.ack(key, reply);
		if (reply.kind === "retired" && this.inputs.get(key)?.attempt === expectedAttempt) {
			this.inputs.delete(key);
			this.retired++;
		}
		this.wake(0);
		return reply;
	}
	diagnostics() {
		return {
			observedAt: new Date().toISOString(),
			pendingCount: this.pendingCount,
			scan: { inspected: this.scannedThisRound, budget: SCAN_BUDGET, resumable: this.scanCursor != null },
			activeInputs: [...this.inputs].map(([key, input]) => ({
				key,
				channel: input.channel,
				attempt: input.attempt,
				createdAt: input.createdAt,
				lastCheckedAt: this.lastCheckedAt,
				host: input.host,
			})),
			lastCheckedAt: this.lastCheckedAt,
			hostBusy: this.ctx.isBusy?.() ?? null,
			/**
			 * 交付三态（§10.6）：committed = 宿主已回执并落库；activated = 本激活发出的
			 * 条数（换激活后老的回执不归这里）；consumption 恒为 consumption_unknown ——
			 * 宿主没有把"模型真的读到了"这一事实交回来的合法入口，MC 只能如实说不知道，
			 * 不在这里编一个 consumed 游标或 Outbox。
			 */
			commit: {
				activation: this.activation,
				activated: this.committed,
				retired: this.retired,
				consumption: "consumption_unknown" as const,
			},
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
		| { kind?: string; state?: string; channel?: string; self?: boolean; ended?: string; addressed?: boolean }
		| null
		| undefined;
	if (value == null) return false;
	switch (value.kind) {
		case "death":
			return true;
		case "connection":
			return value.state === "disconnected";
		case "chat":
			return value.self === false && (value.channel === "private" || value.addressed === true);
		// 本地安全响应已尽力仍未脱险：等到下一个回合可能就晚了。
		case "safety_changed":
			return value.ended === "blocked" || value.ended === "timeout";
		default:
			return false;
	}
}

function gameEventView(event: { ref: string; observedAt: string; payload: JsonValue }) {
	const payload = event.payload as {
		kind?: string;
		channel?: string;
		sender?: { name?: string | null };
		text?: string;
	} | null;
	if (payload?.kind === "chat")
		return {
			kind: "chat",
			channel: payload.channel,
			sender: payload.sender?.name ?? null,
			text: payload.text,
			ref: event.ref,
		};
	return { ...event, nextCall: { action: "observe", params: { selector: "events@1" } } };
}

/** User text is projected from the fixed report. The structured receipt remains internal. */
export function formatCompletion(view: CompletionView, profileId = "local", entry?: Entry): string {
	const task = taskHandle(profileId, view.snapshot.rootRequestId);
	const report = view.content.kind === "inline" ? view.content.report : undefined;
	const effect = view.snapshot.unknownEffects[0];
	const nextCall = effect
		? { action: "tasks", params: { op: "trace", task, record: effect } }
		: view.snapshot.unknownEffectCount > 0 || view.snapshot.unknownEffectsComplete === false
			? { action: "tasks", params: { op: "trace", task } }
			: view.snapshot.phase === "awaiting_decision" || view.content.kind !== "inline"
				? { action: "tasks", params: { op: "get", task } }
				: undefined;
	const construction =
		report?.reportKind === "decision" &&
		entry?.kind === "call" &&
		entry.selector === "build.resume@1" &&
		report.snapshot.checkpoint?.kind === "program"
			? constructionDecisionEvidence(task, view.snapshot, report.snapshot.checkpoint)
			: {};
	return JSON.stringify({
		kind: "result",
		...taskView(task, view.snapshot, entry),
		...(report?.reportKind === "terminal" ? { value: report.snapshot.value } : {}),
		...(view.content.kind !== "inline" ? { detail: view.content.kind } : {}),
		...(nextCall ? { nextCall } : {}),
		...construction,
	});
}

function completionReportOf(value: JsonValue): import("../contracts/runtime.js").CompletionReport {
	if (value == null || typeof value !== "object" || Array.isArray(value))
		throw new Error("completion record value is not an object");
	const stored = value as Record<string, JsonValue>;
	const snapshot = stored.snapshot;
	if (snapshot == null || typeof snapshot !== "object" || Array.isArray(snapshot))
		throw new Error("completion record has no snapshot");
	const phase = (snapshot as Record<string, JsonValue>).phase;
	if (stored.reportKind === "terminal" && phase === "finished")
		return { reportKind: "terminal", snapshot } as unknown as import("../contracts/runtime.js").CompletionReport;
	if (stored.reportKind === "decision" && phase === "awaiting_decision")
		return { reportKind: "decision", snapshot } as unknown as import("../contracts/runtime.js").CompletionReport;
	throw new Error("completion record does not match its reportKind");
}
