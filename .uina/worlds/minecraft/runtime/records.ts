/**
 * Runtime 记录队列：DriverExecutionSink + RuntimeRecordBarrier 的内存有序实现。
 *
 * 唯一定义来源：docs/proposals/mc/modules/runtime.md §5.4、§5.5、§5.6。
 * record 同步复制事实并入队，返回本 writer 实例递增 ticket（起点 1；空前缀
 * H=0）；队列/worker 故障锁存 recorder fault 并封闭新副作用（返回 null）。
 * effect→ControlOwner 关联在 Runtime 侧建立（不按"当前 Run"猜归属）：
 * Body 资格槽 / 受控导航槽由引擎在授予与退役边界设置，chat 旁路走瞬态槽；
 * 同一 effect 的后续事实沿用首次归属（晚到证据不换绑）。引擎状态突变与效果
 * 事实共用同一 writer 序列——flushThrough(H) 覆盖 ≤H 全部已收材料。
 */

import type { ControlOwner } from "../contracts/body.js";
import type {
	DriverExecutionFact,
	DriverExecutionSink,
	EffectVerification,
	RecordTicket,
	RuntimeRecordBarrier,
} from "../contracts/runtime.js";
import type { EffectReceipt, Ref } from "../contracts/values.js";
import type { ApplyItem } from "./runtime-db-worker.js";

type Mutation = ApplyItem["mutation"];

/**
 * 需要额外清理屏障的合同：写源静止是"派发后无残留写入"的必要证据。
 * 现有 Driver 只有受控导航声明这个合同（§3.2 小范围策略，与 Driver 同源，不外推）。
 */
const CLEANUP_BARRIER_CONTRACTS = new Set<string>(["body.goto@1"]);
/** 关闭操作本身就是该 Effect 的业务（body.window.close@1）：cleanup completion 即该操作的结论。 */
const STANDALONE_CLOSE_CONTRACTS = new Set<string>(["body.window.close@1"]);

/**
 * 唯一的 Effect 当前判定（§3）：
 * - `completion` 是**业务操作**的结论——取 receipt；独立关闭操作取其 cleanup；
 *   只有持久意图而未派发的按确定未达成记 not_met；操作已收尾（cleanup met）却无
 *   met 回执的同样是 not_met（清理成功不冒充业务成功）。
 * - `unresolved` 是**与世界相关的写入/清理后果**是否仍待对账——业务失败不清空
 *   它，业务成功也不遮蔽它（E06a：receipt met + cleanup unknown 仍是未决）。
 * 纯函数投影：不改写 facts / verifications / latest，历史截面不受影响。
 */
export interface EffectAssessment {
	dispatch: EffectReceipt["dispatch"];
	completion: EffectReceipt["completion"];
	unresolved: boolean;
	/** 仅供诊断，不是另一个权威结算状态。 */
	reason: string;
}

export function assessEffectFacts(
	facts: readonly DriverExecutionFact[],
	verifications: readonly EffectVerification[],
): EffectAssessment {
	const contract = facts[0]?.contract ?? "";
	let receipt: DriverExecutionFact | null = null;
	let cleanup: DriverExecutionFact | null = null;
	let sent = false;
	let unknownDispatch = false;
	for (const fact of facts) {
		if (fact.kind === "receipt") receipt = fact;
		if (fact.kind === "cleanup") cleanup = fact;
		if (fact.dispatch === "sent") sent = true;
		else if (fact.dispatch === "unknown") unknownDispatch = true;
	}
	const mayHaveSent = sent || unknownDispatch;
	const dispatch: EffectReceipt["dispatch"] = !mayHaveSent ? "not_sent" : unknownDispatch ? "unknown" : "sent";
	// 可信的"未派发即闭合"：Driver 亲自补的 not_sent cleanup（closeIntent / goto 未派发
	// 结算）。intent 自身的 dispatch 恒为 unknown（"可能已发出"），不能用它反推没发过。
	const closedWithoutSend = cleanup != null && cleanup.dispatch === "not_sent";

	// 业务结论：receipt 是权威；独立关闭操作的 cleanup 就是它的 receipt。
	let completion: EffectReceipt["completion"];
	let reason: string;
	if (receipt != null) {
		completion = receipt.completion;
		reason = `receipt ${receipt.completion}`;
	} else if (STANDALONE_CLOSE_CONTRACTS.has(contract)) {
		completion = cleanup?.completion ?? "unknown";
		reason = `standalone close operation ${completion}`;
	} else if (closedWithoutSend || !mayHaveSent) {
		completion = "not_met";
		reason = "durable intent closed before any dispatch; nothing was written";
	} else if (cleanup != null && cleanup.completion === "met") {
		// 操作已收尾却没有任何 met 回执：确定没有达成（如 goto NoPath 后 cleanup met）。
		completion = "not_met";
		reason = "operation ended (cleanup settled) without a met receipt";
	} else {
		completion = "unknown";
		reason = "dispatched but no conclusive receipt";
	}

	// 写入对账：cleanup 记录"写源是否静止"；导航合同额外要求派发后的静止证明。
	const cleanupSettled = cleanup == null || cleanup.dispatch === "not_sent" || cleanup.completion === "met";
	const barrierOk =
		!CLEANUP_BARRIER_CONTRACTS.has(contract) ||
		(cleanup != null && cleanup.dispatch !== "unknown" && cleanup.completion === "met");

	// 合格 verifier 参与当前判定（§3.5）：锚定追加时的 fact 前缀；之后又到新事实
	// 即失效。无锚点的旧记录只做历史诊断，不参与关闭。
	const anchored = [...verifications]
		.reverse()
		.find(
			(entry) => (entry.completion === "met" || entry.completion === "not_met") && entry.factsAnchor === facts.length,
		);
	let unresolved: boolean;
	if (closedWithoutSend || !mayHaveSent) unresolved = false;
	else if (anchored != null) unresolved = false;
	else if (completion === "unknown") unresolved = true;
	else unresolved = !cleanupSettled || !barrierOk;
	if (anchored != null) reason += `; qualified verification ${anchored.completion} closed the uncertainty`;
	else if (unresolved) reason += "; unresolved world-write reconciliation";
	return { dispatch, completion, unresolved, reason };
}

interface QueueItem {
	ticket: RecordTicket;
	mutation: Mutation;
}

interface FlushWaiter {
	seq: number;
	resolve: () => void;
	reject: (err: Error) => void;
}

/** chat 旁路合同名：唯一不占 Body 的写入路径（driver/player-port §7.7）。 */
const CHAT_CONTRACT = "body.chat@1";

export interface EffectAttribution {
	owner: ControlOwner | null;
	operation: Ref;
	record: Ref;
	/** 本 writer 已收到的完整事实序列（按到达序，不重排）。 */
	facts: DriverExecutionFact[];
	/** ctx.verify 的追加判断（append-only；原 completion 不改写，G4）。 */
	verifications: EffectVerification[];
	latest: { dispatch: EffectReceipt["dispatch"]; completion: EffectReceipt["completion"]; evidence: Ref[] };
}

export interface RecordQueueOptions {
	/** 本 writer 实例 ref（rw:<ns>:<n>）；ticket 与 record_log 主键绑定它。 */
	instance: Ref;
	/** 效果行 record ref 发号（rec:<ns>:<n>）。 */
	mintRecord: () => Ref;
	/** 既往实例的已提交水线（打开握手回报）；缺省按 0 处理。 */
	recoveredWatermarks: Record<string, number>;
	/** 批量提交（宿主 post 给 worker）。 */
	apply: (items: ApplyItem[]) => void;
}

export class RecordQueue implements DriverExecutionSink, RuntimeRecordBarrier {
	private readonly instance: Ref;
	private readonly mintRecord: () => Ref;
	private readonly recoveredWatermarks: Record<string, number>;
	private readonly apply: (items: ApplyItem[]) => void;

	private seq = 0;
	private pending: QueueItem[] = [];
	private flushScheduled = false;
	private faulted: string | null = null;
	private durableSeq = 0;
	private waiters: FlushWaiter[] = [];

	private readonly effectOwner = new Map<Ref, EffectAttribution>();
	private qualificationOwner: ControlOwner | null = null;
	private navigationOwner: ControlOwner | null = null;
	private chatOwner: ControlOwner | null = null;

	constructor(opts: RecordQueueOptions) {
		this.instance = opts.instance;
		this.mintRecord = opts.mintRecord;
		this.recoveredWatermarks = opts.recoveredWatermarks;
		this.apply = opts.apply;
	}

	// ---- DriverExecutionSink ----

	record(fact: DriverExecutionFact): RecordTicket | null {
		if (this.faulted != null) return null;
		const slotOwner =
			fact.owner ??
			(fact.contract === CHAT_CONTRACT ? this.chatOwner : (this.qualificationOwner ?? this.navigationOwner));
		if (slotOwner == null) {
			this.fault(`cannot attribute effect ${fact.effect} (${fact.contract}) to a trusted control owner`);
			return null;
		}
		let attribution = this.effectOwner.get(fact.effect);
		if (attribution == null) {
			attribution = {
				owner: slotOwner,
				operation: fact.operation,
				record: this.mintRecord(),
				facts: [fact],
				verifications: [],
				latest: { dispatch: fact.dispatch, completion: fact.completion, evidence: fact.evidence },
			};
			this.effectOwner.set(fact.effect, attribution);
		} else {
			attribution.record = this.mintRecord();
			attribution.facts.push(fact);
			attribution.latest = { dispatch: fact.dispatch, completion: fact.completion, evidence: fact.evidence };
		}
		const ticket = this.enqueue({
			kind: "effect_fact",
			row: {
				effect: fact.effect,
				owner: JSON.stringify(attribution.owner),
				operation: fact.operation,
				record: attribution.record,
				facts: JSON.stringify(attribution.facts),
				verifications: JSON.stringify(attribution.verifications),
			},
			fact,
		});
		return ticket;
	}

	// ---- RuntimeRecordBarrier ----

	/** 派发前屏障：等真实 SQLite ACK，不把"已入队"当"已持久"（§5.3）。 */
	async ensureDurable(ticket: RecordTicket): Promise<void> {
		await this.flushThrough(ticket);
	}

	capture(): RecordTicket {
		return { instance: this.instance, sequence: this.seq };
	}

	async flushThrough(through: RecordTicket): Promise<void> {
		if (this.faulted != null) {
			throw new Error(`recorder faulted: ${this.faulted}`);
		}
		if (through.instance !== this.instance) {
			// 既往实例：只看打开时水线；崩溃丢失的尾部如实缺失，明确失败。
			const durable = this.recoveredWatermarks[through.instance] ?? 0;
			if (durable >= through.sequence) return;
			throw new Error(`ticket ${through.instance}#${through.sequence} not durable (recovered watermark ${durable})`);
		}
		if (this.durableSeq >= through.sequence) return;
		await new Promise<void>((resolve, reject) => {
			this.waiters.push({ seq: through.sequence, resolve, reject });
		});
	}

	// ---- 引擎归属槽 ----

	/** Body 资格授予/退役边界设置；null = 退役完成。 */
	setQualificationOwner(owner: ControlOwner | null): void {
		this.qualificationOwner = owner;
	}

	/** 受控独占导航（goto）运行边界设置。 */
	setNavigationOwner(owner: ControlOwner | null): void {
		this.navigationOwner = owner;
	}

	/** chat 旁路瞬态归属：作用域内的 body.chat@1 事实归属该调用。 */
	async runWithChatOwner<T>(owner: ControlOwner, fn: () => Promise<T>): Promise<T> {
		const previous = this.chatOwner;
		this.chatOwner = owner;
		try {
			return await fn();
		} finally {
			this.chatOwner = previous;
		}
	}

	// ---- 引擎查询 ----

	/**
	 * 唯一当前判定（assessEffectFacts）：只有仍待对账的世界写入/清理后果才算
	 * 未决；确定未派发不算，确认的业务失败（not_met 且已闭合）也不算（§3.3）。
	 */
	private unresolved(entry: EffectAttribution): boolean {
		return assessEffectFacts(entry.facts, entry.verifications).unresolved;
	}

	/** 某 run 名下各效果的最新判断；只有可能影响过外部世界的未确认效果才算未知。 */
	unknownEffectsFor(run: Ref): Ref[] {
		const out: Ref[] = [];
		for (const [effect, attribution] of this.effectOwner) {
			const owner = attribution.owner;
			if (owner != null && owner.kind === "run" && owner.run === run && this.unresolved(attribution)) {
				out.push(effect);
			}
		}
		return out;
	}

	/** 归属该调用的 effect ref 列表（首条事实定归属，§5.4 晚到证据不换绑）。 */
	effectsForCall(call: Ref): Ref[] {
		const out: Ref[] = [];
		for (const [effect, attribution] of this.effectOwner) {
			const owner = attribution.owner;
			if (owner != null && owner.kind === "run" && owner.callId === call) out.push(effect);
		}
		return out;
	}

	effectsForSafety(intervention: Ref): { effects: Ref[]; unknownEffects: Ref[] } {
		const effects: Ref[] = [],
			unknownEffects: Ref[] = [];
		for (const [effect, entry] of this.effectOwner)
			if (entry.owner?.kind === "safety" && entry.owner.intervention === intervention) {
				effects.push(effect);
				if (this.unresolved(entry)) unknownEffects.push(effect);
			}
		return { effects, unknownEffects };
	}

	effectRecord(effect: Ref): (EffectAttribution & { effect: Ref }) | null {
		const attribution = this.effectOwner.get(effect);
		return attribution == null ? null : { effect, ...attribution };
	}

	/** 由效果记录 ref 反查 effect ref（引擎 readRecord 兜底）。 */
	effectByRecord(record: Ref): Ref | null {
		for (const [effect, attribution] of this.effectOwner) {
			if (attribution.record === record) return effect;
		}
		return null;
	}

	/**
	 * ctx.verify 的追加路径（G4）：核验判断 append-only 入 attribution 并落库为新的
	 * 不可变截面；原 completion 与既有 facts 不改写。核验记录锚定它所依据的 fact
	 * 前缀（§3.5.3）：此后又到达的新 Driver fact 会使该核验不再参与当前判定。
	 */
	appendVerification(effect: Ref, verification: EffectVerification): void {
		const attribution = this.effectOwner.get(effect);
		if (attribution == null) throw new Error(`cannot verify unknown effect ${effect}`);
		const anchored: EffectVerification = { factsAnchor: attribution.facts.length, ...verification };
		attribution.verifications.push(anchored);
		attribution.record = this.mintRecord();
		this.enqueue({
			kind: "effect_verification",
			row: {
				effect,
				record: attribution.record,
				owner: JSON.stringify(attribution.owner),
				facts: JSON.stringify(attribution.facts),
				verifications: attribution.verifications,
			},
		});
	}

	/** 恢复注入：既往会话的效果行（facts/verifications 都是已提交事实）只读装载。 */
	restoreEffect(row: import("./runtime-db-worker.js").EffectRow): void {
		if (this.effectOwner.has(row.effect)) return;
		const facts = JSON.parse(row.facts) as DriverExecutionFact[];
		const last = facts.length > 0 ? facts[facts.length - 1] : null;
		this.effectOwner.set(row.effect, {
			owner: JSON.parse(row.owner ?? "null") as ControlOwner | null,
			operation: row.operation,
			record: row.record,
			facts,
			verifications: JSON.parse(row.verifications) as EffectVerification[],
			latest: {
				dispatch: last?.dispatch ?? "unknown",
				completion: last?.completion ?? "unknown",
				evidence: last?.evidence ?? [],
			},
		});
	}

	// ---- 引擎突变入队 ----

	enqueue(mutation: Mutation): RecordTicket {
		const seq = ++this.seq;
		this.pending.push({ ticket: { instance: this.instance, sequence: seq }, mutation });
		this.scheduleFlush();
		return { instance: this.instance, sequence: seq };
	}

	enqueueAll(mutations: Mutation[]): RecordTicket {
		let ticket: RecordTicket = { instance: this.instance, sequence: this.seq };
		for (const mutation of mutations) ticket = this.enqueue(mutation);
		return ticket;
	}

	/** 优雅收尾：冲刷剩余队列并等待全部持久；失败即抛，由调用方如实呈现。 */
	async flushAll(): Promise<void> {
		this.flush();
		await this.flushThrough(this.capture());
	}

	// ---- 宿主回调（index.ts 持有 worker 时转发） ----

	onDurable(instance: string, through: number): void {
		if (instance !== this.instance) return;
		if (through <= this.durableSeq) return;
		this.durableSeq = through;
		this.pending = this.pending.filter((item) => item.ticket.sequence > through);
		const remaining: FlushWaiter[] = [];
		for (const waiter of this.waiters) {
			if (waiter.seq <= through) waiter.resolve();
			else remaining.push(waiter);
		}
		this.waiters = remaining;
	}

	onFault(reason: string): void {
		this.fault(reason);
	}

	get faultReason(): string | null {
		return this.faulted;
	}

	// ---- 内部 ----

	private fault(reason: string): void {
		if (this.faulted != null) return;
		this.faulted = reason;
		const err = new Error(`recorder fault: ${reason}`);
		for (const waiter of this.waiters) waiter.reject(err);
		this.waiters = [];
	}

	private scheduleFlush(): void {
		if (this.flushScheduled || this.faulted != null) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.flush();
		});
	}

	private flush(): void {
		if (this.faulted != null || this.pending.length === 0) return;
		const batch = this.pending;
		this.pending = [];
		try {
			this.apply(batch.map((item) => ({ ticket: item.ticket, mutation: item.mutation })));
		} catch (err) {
			// post 失败：材料退回队首，锁存故障；durable 停在真实起点（§5.4）。
			this.pending = [...batch, ...this.pending];
			this.fault(`storage apply failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
