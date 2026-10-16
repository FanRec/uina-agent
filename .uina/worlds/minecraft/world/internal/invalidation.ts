/**
 * World 单调失效水位与 Watch 登记。
 *
 * 语义（docs/proposals/mc/modules/world.md §9）：
 * - 每个查询流（stream+epoch）持有自己的失效序号；失效事件按依赖类别分发，
 *   纯当前不被历史落盘唤醒，纯历史不追踪当前物理步。
 * - cursor.epoch 有两个分量：绑定代次 b（影响所有依赖）与当前源代次 s
 *   （只影响声明了 current 依赖的查询；纯历史不因 Driver 断线/源重建失去连续性）。
 * - changed 可合并；next 一次性消费，取消 next 不消费共享变化，多个观察者各自复查。
 * - reset 仅用于 epoch/来源断裂等无法比较的情形；登记时已发现的变化首次 next 立即交付。
 */

import type { ObservationCursor, Ref } from "../../contracts/values.js";
import type { WorldChange } from "../../contracts/world.js";

/** 查询依赖类别；与查询描述符的 deps 对应。 */
export type DependencyKind = "current" | "history";

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
			return { kind: "reset", reason: "epoch_changed", cursor: this.ledger.cursorFor(this.stream) };
		}
		if (after.stream !== this.stream) {
			return { kind: "reset", reason: "stream_changed", cursor: this.ledger.cursorFor(this.stream) };
		}
		const state = this.ledger.streamState(this.stream);
		if (state.seq > after.sequence) {
			return { kind: "changed", cursor: this.ledger.cursorFor(this.stream), changed: [...state.refs] };
		}
		return null;
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
				awaiter.deliver({ kind: "reset", reason, cursor: this.ledger.cursorFor(this.stream) });
				return true;
			}
			return false;
		}
		const immediate = this.check(after);
		if (immediate) {
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
	onEvent(kind: DependencyKind, seq: number, refs: Ref[]): void {
		if (this.closed || !this.deps.has(kind)) return;
		const cursor = this.ledger.cursorFor(this.stream);
		const change: WorldChange = { kind: "changed", cursor: { ...cursor, sequence: seq }, changed: refs };
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
			awaiter?.deliver({ kind: "reset", reason, cursor: this.ledger.cursorFor(this.stream) });
		} else {
			this.resetPending = reason;
		}
		this.ledger.removeRegistration(this);
	}
}

export class InvalidationLedger {
	private seq = 0;
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

	cursorFor(stream: string): ObservationCursor {
		const state = this.streamStates.get(stream);
		return { stream, epoch: this.epoch, sequence: state?.seq ?? 0 };
	}

	/** 登记/刷新流的依赖与失效状态；read 与 watch 都必须先调用，cursor 才能随失效推进。 */
	ensureStream(stream: string, deps: ReadonlySet<DependencyKind>): void {
		let state = this.streamStates.get(stream);
		if (!state) {
			this.streamStates.set(stream, { seq: 0, refs: [], deps: new Set(deps) });
		}
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

	/** 失效事件：推进所有依赖匹配的流水位；有等待者的注册立即投递。 */
	bump(kind: DependencyKind, refs: Ref[] | null): void {
		this.seq += 1;
		for (const state of this.streamStates.values()) {
			if (!state.deps.has(kind)) continue;
			state.seq = this.seq;
			state.refs = refs ?? [];
		}
		for (const registration of [...this.registrations]) {
			if (!registration.deps.has(kind)) continue;
			const state = this.streamState(registration.stream);
			registration.onEvent(kind, state.seq, state.refs);
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
