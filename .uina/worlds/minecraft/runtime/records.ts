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

import type {
	DriverExecutionFact,
	DriverExecutionSink,
	RecordTicket,
	RuntimeRecordBarrier,
} from "../contracts/runtime.js";
import type { ControlOwner } from "../contracts/body.js";
import type { EffectReceipt, Ref } from "../contracts/values.js";
import type { ApplyItem } from "./runtime-db-worker.js";

type Mutation = ApplyItem["mutation"];

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
				verifications: "[]",
			},
			fact,
		});
		return ticket;
	}

	// ---- RuntimeRecordBarrier ----

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

	/** 某 run 名下各效果的最新判断；completion != "met" 即未知效果（§5.6）。 */
	unknownEffectsFor(run: Ref): Ref[] {
		const out: Ref[] = [];
		for (const [effect, attribution] of this.effectOwner) {
			const owner = attribution.owner;
			if (owner != null && owner.kind === "run" && owner.run === run && attribution.latest.completion !== "met") {
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
