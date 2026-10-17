/**
 * World 单调失效水位与 Watch 登记。
 *
 * 语义（docs/proposals/mc/modules/world.md §9）：
 * - 每个查询流（stream+epoch）持有自己的水位；失效事件按依赖类别分发，
 *   纯当前不被历史落盘唤醒，纯历史不追踪当前物理步。
 * - 两类依赖使用**不同量纲**的水位，各自与"读到的内容"对齐：
 *   · current：Driver 当前源的失效事件序号（读取在同一同步段采样 → 读数即最新）。
 *   · history：存储提交版本（读取与版本取自同一 SQLite 读取边界 → cursor 声明它覆盖的视图）。
 *   因此 cursor 表达的不是"读取发生的时刻"，而是"读取实际覆盖到哪一步"：
 *   已读到的提交不会被再次通知，未读到的提交一定会唤醒。
 * - cursor.epoch 有两个分量：绑定代次 b（影响所有依赖）与当前源代次 s
 *   （只影响声明了 current 依赖的查询；纯历史不因 Driver 断线/源重建失去连续性）。
 * - changed 可合并；next 一次性消费，取消 next 不消费共享变化，多个观察者各自复查。
 * - reset 仅用于 epoch/来源断裂等无法比较的情形；登记时已发现的变化首次 next 立即交付。
 */

import type { ObservationCursor, Ref } from "../../contracts/values.js";
import type { WorldChange } from "../../contracts/world.js";

/** 查询依赖类别；与查询描述符的 deps 对应。 */
export type DependencyKind = "current" | "history";

/** 纯历史依赖（水位取存储提交版本）。 */
function isHistoryOnly(deps: ReadonlySet<DependencyKind>): boolean {
	return deps.has("history") && !deps.has("current");
}

export interface Awaiter {
	deliver: (change: WorldChange) => void;
	fail: (error: Error) => void;
}

interface StreamState {
	seq: number;
	refs: Ref[];
	deps: Set<DependencyKind>;
}

export class WatchRegistration {
	private awaiting = false;
	private pending: WorldChange | null = null;
	private closed = false;
	/** onReset 时无等待者挂起：reset 延迟到下一次 next() 交付一次。 */
	private resetPending: "stream_changed" | "epoch_changed" | null = null;

	constructor(
		private readonly ledger: InvalidationLedger,
		readonly stream: string,
		readonly deps: ReadonlySet<DependencyKind>,
	) {}

	/** 当前源代次变化是否影响本注册（纯历史不受 Driver 源断裂影响）。 */
	private caresAboutSourceEpoch(): boolean {
		return this.deps.has("current");
	}

	/**
	 * 以 after 为基准登记比较。返回登记瞬间已可交付的变化（调用方在首次 next 立即交付），
	 * null 表示当前无需交付、等待后续事件。
	 */
	check(after: ObservationCursor): WorldChange | null {
		if (!this.epochMatches(after.epoch)) {
			return { kind: "reset", reason: "epoch_changed", cursor: this.cursor() };
		}
		if (after.stream !== this.stream) {
			return { kind: "reset", reason: "stream_changed", cursor: this.cursor() };
		}
		if (this.ledger.watermark(this.stream, this.deps) > after.sequence) {
			return { kind: "changed", cursor: this.cursor(), changed: [...this.ledger.streamState(this.stream).refs] };
		}
		return null;
	}

	private cursor(): ObservationCursor {
		return this.ledger.cursorFor(this.stream, this.deps);
	}

	private epochMatches(afterEpoch: string): boolean {
		const current = this.ledger.epoch;
		if (this.caresAboutSourceEpoch()) return afterEpoch === current;
		// 纯历史只比较绑定分量（epoch 形如 "b<n>|s<m>"）。
		const bindingPart = current.split("|")[0];
		return afterEpoch.split("|")[0] === bindingPart;
	}

	/** 挂起一次 next 等待；返回 false 表示该注册已显式关闭（此后拒绝）。 */
	awaitNext(after: ObservationCursor, awaiter: Awaiter): boolean {
		if (this.closed) {
			if (this.resetPending) {
				const reason = this.resetPending;
				this.resetPending = null;
				awaiter.deliver({ kind: "reset", reason, cursor: this.cursor() });
				return true;
			}
			return false;
		}
		const immediate = this.check(after);
		if (immediate) {
			// 立即交付的新鲜变化不旧于 pending：清掉，防止下次 next 用新 cursor 时重放陈旧变化。
			this.pending = null;
			awaiter.deliver(immediate);
			return true;
		}
		this.awaiting = true;
		this.ledger.setAwaiter(this, awaiter);
		if (!this.closed && this.pending) {
			const change = this.pending;
			this.pending = null;
			this.awaiting = false;
			this.ledger.clearAwaiter(this);
			awaiter.deliver(change);
		}
		return true;
	}

	cancelAwait(): void {
		this.awaiting = false;
		this.ledger.clearAwaiter(this);
	}

	close(): void {
		this.closed = true;
		this.awaiting = false;
		this.pending = null;
		this.ledger.removeRegistration(this);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** 模块内协作入口（仅 InvalidationLedger 调用）。 */
	onEvent(kind: DependencyKind, refs: Ref[]): void {
		if (this.closed || !this.deps.has(kind)) return;
		const change: WorldChange = { kind: "changed", cursor: this.cursor(), changed: [...refs] };
		if (this.awaiting) {
			this.awaiting = false;
			const awaiter = this.ledger.takeAwaiter(this);
			awaiter?.deliver(change);
			return;
		}
		// 无等待：合并为 pending（下一次 next 立即交付）。
		this.pending = change;
	}

	/** 模块内协作入口（仅 InvalidationLedger 调用）。 */
	onReset(reason: "stream_changed" | "epoch_changed"): void {
		if (this.closed) return;
		this.closed = true;
		if (this.awaiting) {
			this.awaiting = false;
			const awaiter = this.ledger.takeAwaiter(this);
			awaiter?.deliver({ kind: "reset", reason, cursor: this.cursor() });
		} else {
			this.resetPending = reason;
		}
		this.ledger.removeRegistration(this);
	}
}

export class InvalidationLedger {
	/** 当前源失效事件序（仅 current 依赖使用）。 */
	private seq = 0;
	/** 已提交存储版本（仅 history 依赖使用）。 */
	private historyVersion = 0;
	private bindingTag: string;
	private sourceTag = 0;
	private registrations = new Set<WatchRegistration>();
	private awaiters = new Map<WatchRegistration, Awaiter>();
	private streamStates = new Map<string, StreamState>();

	constructor(bindingTag: string) {
		this.bindingTag = bindingTag;
	}

	/** 完整 epoch：绑定分量 | 当前源分量。 */
	get epoch(): string {
		return `${this.bindingTag}|${this.sourceTag}`;
	}

	/** 该流当前的失效水位（按其依赖类别取对应量纲）。 */
	watermark(stream: string, deps: ReadonlySet<DependencyKind>): number {
		if (isHistoryOnly(deps)) return this.historyVersion;
		const state = this.streamStates.get(stream);
		// 无记录的 current 流视为"已对齐当前事件序"：不制造登记时的伪变化。
		return state ? state.seq : this.seq;
	}

	cursorFor(stream: string, deps: ReadonlySet<DependencyKind>): ObservationCursor {
		return { stream, epoch: this.epoch, sequence: this.watermark(stream, deps) };
	}

	/** 以指定读取视图版本构造历史 cursor（数据与该版本取自同一读取边界）。 */
	cursorAt(stream: string, sequence: number): ObservationCursor {
		return { stream, epoch: this.epoch, sequence };
	}

	/**
	 * 登记/刷新流的依赖与失效状态；read 与 watch 都必须先调用，cursor 才能随失效推进。
	 * 基线取登记时刻的水位：流不存在期间发生的变化不算"本流已消费"，
	 * 但也不在本流建立前凭空唤醒（历史侧由提交版本精确表达）。
	 */
	ensureStream(stream: string, deps: ReadonlySet<DependencyKind>): void {
		if (deps.size !== 1) {
			// 临时限制（world.md §9.1 条件条款），不是永久合同错误：混合查询与时间阈值
			// 的组合机制在真实消费者（Runtime/Callable）出现时激活——Watch 内部关联
			// 多水位与独立到期条件，对外仍是单一 Watch。在那之前两类水位量纲不同，
			// 挤进单一水位会静默漏失效，因此显式拒绝而不是悄悄接受。
			throw new Error(
				`当前实现不支持混合依赖（${[...deps].join("+")}）：current 用当前源失效事件序、history 用存储提交版本，` +
					"两量纲不可比；组合水位机制见 world.md §9.1 条件条款，激活前混声明被显式拒绝（不静默漏失效）",
			);
		}
		if (this.streamStates.has(stream)) return;
		this.streamStates.set(stream, { seq: this.watermark(stream, deps), refs: [], deps: new Set(deps) });
	}

	streamState(stream: string): StreamState {
		return this.streamStates.get(stream) ?? { seq: 0, refs: [], deps: new Set() };
	}

	createRegistration(stream: string, deps: ReadonlySet<DependencyKind>): WatchRegistration {
		this.ensureStream(stream, deps);
		const registration = new WatchRegistration(this, stream, deps);
		this.registrations.add(registration);
		return registration;
	}

	/** 当前事实失效事件：推进所有依赖 current 的流水位；有等待者的注册立即投递。 */
	bumpCurrent(refs: Ref[] | null): void {
		this.seq += 1;
		for (const state of this.streamStates.values()) {
			if (!state.deps.has("current")) continue;
			state.seq = this.seq;
			state.refs = refs ?? [];
		}
		for (const registration of [...this.registrations]) {
			if (!registration.deps.has("current")) continue;
			registration.onEvent("current", refs ?? []);
		}
	}

	/**
	 * 存储提交版本前进：所有依赖 history 的流水位取该版本，有等待者的注册立即投递。
	 * 只在提交成功后调用——未可读的提交不产生唤醒（唤醒只会得到同样的历史）。
	 */
	advanceHistory(version: number): void {
		if (!Number.isFinite(version) || version <= this.historyVersion) return;
		this.historyVersion = version;
		for (const state of this.streamStates.values()) {
			if (!state.deps.has("history")) continue;
			state.seq = version;
			state.refs = [];
		}
		for (const registration of [...this.registrations]) {
			if (!registration.deps.has("history")) continue;
			registration.onEvent("history", []);
		}
	}

	/**
	 * Driver 当前源 epoch/实例断裂：当前源代次分量前进，current 注册按 reset 交付；
	 * 纯历史注册不受影响（不因 Driver 断线失去本地水位连续性）。
	 */
	resetCurrentSource(): void {
		this.sourceTag += 1;
		const registrations = [...this.registrations].filter((r) => r.deps.has("current"));
		for (const registration of registrations) registration.onReset("epoch_changed");
	}

	/**
	 * 绑定/分区代次更换：全部注册按 reset 交付（保守；调用方重新 read→watch）。
	 */
	resetBinding(reason: "stream_changed" | "epoch_changed", nextBindingTag: string): void {
		if (nextBindingTag !== this.bindingTag) {
			this.bindingTag = nextBindingTag;
			this.streamStates.clear();
		}
		const registrations = [...this.registrations];
		for (const registration of registrations) registration.onReset(reason);
	}

	setAwaiter(registration: WatchRegistration, awaiter: Awaiter): void {
		this.awaiters.set(registration, awaiter);
	}

	clearAwaiter(registration: WatchRegistration): void {
		this.awaiters.delete(registration);
	}

	takeAwaiter(registration: WatchRegistration): Awaiter | undefined {
		const awaiter = this.awaiters.get(registration);
		this.awaiters.delete(registration);
		return awaiter;
	}

	removeRegistration(registration: WatchRegistration): void {
		this.registrations.delete(registration);
		this.awaiters.delete(registration);
	}

	/** World 关闭：fail 所有挂起等待（不把关闭伪装成 reset/changed），注册全部退役。 */
	shutdown(failWith: () => Error): void {
		const awaiters = [...this.awaiters];
		this.awaiters.clear();
		for (const [, awaiter] of awaiters) awaiter.fail(failWith());
		const registrations = [...this.registrations];
		for (const registration of registrations) registration.close();
		this.registrations.clear();
	}
}
