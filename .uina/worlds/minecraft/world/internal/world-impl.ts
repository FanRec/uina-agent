/**
 * World 组装实现（World 重构终态）。
 *
 * 职责边界：
 * - Driver 拥有当前客户端事实；World 只经 ClientFactsPort 读取受控纯值，
 *   接收选定不可变证据，维护历史/领域记录与失效水位。
 * - 纯当前 read 同步固定切面（sample → 纳入水位 → 组装 cursor），不读存储、不等历史。
 * - 纯历史 read 走"提交屏障"模型：固定本次需要的接收上界 → 等待该上界内的证据
 *   完成提交或得到明确故障 → 同步固定 cursor → 在专用存储 Worker 中原子读取。
 *   cursor 先于读取 await 固定：读取期间到达的新提交只会让下次 next 立即交付，
 *   旧数据绝不会拿到覆盖新事实的 cursor。
 * - 提交经单一有序队列发往存储 Worker；提交完成在同一续体发布 durable ACK 并解除屏障。
 */

import type {
	ClientFactNotice,
	ClientFactScope,
	ClientFactsPort,
	ClientFactsSubscription,
} from "../../contracts/client-facts.js";
import type {
	DomainRecord,
	WorldAvailabilityValue,
	WorldChange,
	WorldEvidencePort,
	WorldPort,
	WorldQuery,
	WorldWatch,
} from "../../contracts/world.js";
import type { ExactRef, Fact, JsonValue, Observation, ObservationCursor, Ref } from "../../contracts/values.js";
import { CallFailureError } from "../../contracts/errors.js";
import { CurrentSourceTracker } from "./current-source.js";
import { InvalidationLedger, type WatchRegistration } from "./invalidation.js";
import { builtinQueries, canonicalJson, queryStreamRef, type QueryDefinition } from "./queries.js";
import type { EvidenceFilter, WorldStore } from "./store.js";
import { ReceptionEngine, type AcceptedEntry } from "./reception.js";

const RECEIVER_GENERATION = "mcw:receiver:g1";

export interface WorldDepsInternal {
	readonly facts: ClientFactsPort;
	/** World 数据目录（由持久存储实现使用；内存存储忽略）。 */
	readonly dataDir: string;
	readonly store: WorldStore;
	/** 接收代次 ref（恢复/重挂载时由组合根提供新代次；默认 g1）。 */
	readonly receiver?: Ref;
}

interface BarrierWaiter {
	target: number;
	resolve: () => void;
	fail: (error: CallFailureError) => void;
}

export class WorldImpl implements WorldPort, WorldEvidencePort {
	private readonly facts: ClientFactsPort;
	private readonly store: WorldStore;
	private readonly ledger: InvalidationLedger;
	private readonly queries = builtinQueries();
	private subscription: ClientFactsSubscription | null = null;
	private reception: ReceptionEngine;
	private currentTracker: CurrentSourceTracker;
	private scope: ClientFactScope | null = null;
	private bindingTagCounter = 0;
	private readonly diagnostics: string[] = [];

	// ---- 单一有序提交队列与屏障 ----
	/** 已接收条目计数（接收序）；提交完成按同一序推进 lastCommitted。 */
	private lastAccepted = 0;
	private lastCommitted = 0;
	private barrierWaiters: BarrierWaiter[] = [];
	private flushChain: Promise<void> = Promise.resolve();
	private storeFailed = false;

	// ---- 生命周期 ----
	private closed = false;
	private closing = false;
	private sampledOnce = false;
	private noticeBuffer: ClientFactNotice[] = [];
	private initialized = false;
	private readonly readyPromise: Promise<void>;

	constructor(deps: WorldDepsInternal) {
		this.facts = deps.facts;
		this.store = deps.store;
		this.ledger = new InvalidationLedger(`b${++this.bindingTagCounter}`);
		this.reception = new ReceptionEngine(deps.receiver ?? RECEIVER_GENERATION, {
			accepted: (entries) => this.onAccepted(entries),
			ackReady: (ack) => this.subscription?.acknowledge(ack),
			protocolFault: (message) => this.recordDiagnostic(message),
		});
		this.currentTracker = new CurrentSourceTracker({
			preciseChanged: (refs) => this.ledger.bump("current", refs),
			conservativeInvalidation: () => this.ledger.bump("current", null),
			sourceEpochChanged: () => this.ledger.resetCurrentSource(),
		});
		// 先订阅后采样（public-api §4.1）：初始化是异步的（恢复播种需读存储），
		// 订阅先行保证不漏 Driver 材料；初始化期间到达的通知进缓冲，按到达序重放。
		this.subscription = this.facts.subscribe((notice) => this.onNotice(notice));
		this.readyPromise = this.initialize();
	}

	/** 初始化完成（恢复播种 + 当前基线建立）；createWorld 等待它之后才交付句柄。 */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	private async initialize(): Promise<void> {
		// 恢复：从持久存储播种已持久事实/gap，使新接收代次的 durable 从真实持久状态起步；
		// receivedThrough 不继承（由源重放重建），不把 RAM 接收冒充持久。
		try {
			const recovery = await this.store.recoverySnapshot();
			if (recovery) {
				for (const stream of recovery) {
					this.reception.restore(stream.stream, {
						factSeqs: stream.persistedFactSeqs,
						gapRefs: stream.persistedGapRefs,
					});
				}
			}
		} catch (error) {
			this.recordDiagnostic(`恢复播种失败：${String(error)}`);
		}
		// 重放初始化期间到达的通知（真实到达顺序在初始采样之前）。
		const buffered = this.noticeBuffer;
		this.noticeBuffer = [];
		this.initialized = true;
		for (const notice of buffered) this.dispatchNotice(notice);
		// 以最新状态建立当前基线（先订阅后采样；callLog 断言保持 subscribe → sample）。
		try {
			const capture = this.facts.sample(() => null);
			this.applyScope(capture.scope, true);
			this.currentTracker.observeStamp(capture.stamp);
			this.sampledOnce = true;
		} catch (error) {
			this.recordDiagnostic(`初始化采样失败：${String(error)}`);
		}
	}

	// ---- 接收与水位 ----

	private recordDiagnostic(message: string): void {
		if (this.diagnostics.length < 100) this.diagnostics.push(message);
	}

	private onNotice(notice: ClientFactNotice): void {
		if (this.closed) return;
		if (!this.initialized) {
			this.noticeBuffer.push(notice);
			return;
		}
		this.dispatchNotice(notice);
	}

	private dispatchNotice(notice: ClientFactNotice): void {
		if (notice.kind === "evidence" || notice.kind === "evidence_gap" || notice.kind === "evidence_end") {
			this.reception.handleNotice(notice);
			return;
		}
		this.currentTracker.observeNotice(notice);
	}

	private onAccepted(entries: AcceptedEntry[]): void {
		this.lastAccepted += entries.length;
		this.scheduleFlush();
		// 新历史证据接收改变已接收范围 → 历史依赖失效。
		this.ledger.bump("history", null);
	}

	private scheduleFlush(): void {
		if (this.closed) return;
		// 单一有序提交队列：每次接收排一个冲刷步；步内排空当前全部待落盘。
		this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
	}

	/**
	 * 冲刷一步：取当前全部待落盘条目发往存储 Worker；提交成功在同一续体
	 * 发布 durable ACK（reception.committed）并解除已满足的屏障。
	 * 失败时 durable 暂停推进、屏障以明确故障解除；待落盘保留，由后续接收/屏障重试。
	 */
	private async flushOnce(): Promise<void> {
		if (this.closed && !this.closing) return;
		const pending = this.reception.takePending();
		if (pending.length === 0) return;
		if (this.store.availability.state !== "ready") {
			this.failBarriers(
				new CallFailureError({
					code: "STORE_UNAVAILABLE",
					message: this.store.availability.reason ?? "历史存储不可用",
				}),
			);
			return;
		}
		let ok: boolean;
		try {
			ok = await this.store.append(pending);
		} catch (error) {
			ok = false;
			this.recordDiagnostic(`存储提交异常：${String(error)}`);
		}
		if (!ok) {
			this.storeFailed = true;
			this.recordDiagnostic("存储提交失败：durable 水位暂停推进");
			this.failBarriers(new CallFailureError({ code: "STORE_UNAVAILABLE", message: "存储提交失败" }));
			return;
		}
		this.storeFailed = false;
		this.lastCommitted += pending.length;
		this.reception.committed(pending);
		this.resolveBarriers();
	}

	/** 屏障捕获（同步）：固定本次查询需要的接收上界。 */
	private captureBarrier(): number {
		return this.lastAccepted;
	}

	/**
	 * 等待屏障：上界内全部已接收证据完成提交，或得到明确故障。
	 * 不追逐屏障捕获后新到达的事件；不阻塞 Driver 当前读取。
	 */
	private waitForBarrier(target: number): Promise<void> {
		if (this.lastCommitted >= target) return Promise.resolve();
		this.scheduleFlush(); // 确保待落盘队列被驱动（失败时屏障以故障解除，不悬挂）
		return new Promise<void>((resolve, reject) => {
			this.barrierWaiters.push({ target, resolve, fail: reject });
		});
	}

	private resolveBarriers(): void {
		if (this.barrierWaiters.length === 0) return;
		const remaining: BarrierWaiter[] = [];
		for (const waiter of this.barrierWaiters) {
			if (this.lastCommitted >= waiter.target) waiter.resolve();
			else remaining.push(waiter);
		}
		this.barrierWaiters = remaining;
	}

	private failBarriers(error: CallFailureError): void {
		if (this.barrierWaiters.length === 0) return;
		const waiters = this.barrierWaiters;
		this.barrierWaiters = [];
		for (const waiter of waiters) waiter.fail(error);
	}

	/** 证据引用存在性：已持久或在待落盘队列（retain/writeRecord 的存在性校验）。 */
	private async evidenceExists(ref: Ref): Promise<boolean> {
		if (this.reception.hasPendingRef(ref)) return true;
		if (this.store.availability.state !== "ready") return false;
		return this.store.hasEvidence(ref);
	}

	// ---- 绑定与分区 ----

	private applyScope(scope: ClientFactScope, initial: boolean): void {
		const previous = this.scope;
		if (
			previous &&
			previous.binding === scope.binding &&
			previous.world === scope.world &&
			previous.worldRevision === scope.worldRevision &&
			previous.dimension === scope.dimension
		) {
			return;
		}
		this.scope = scope;
		if (initial) return;
		// 绑定代次变化（重绑）或分区/维度变化：旧 cursor 无法对账 → 全部 reset。
		// 历史分区数据不动；原始捕获归属不可变。
		const reason = previous && previous.binding !== scope.binding ? "epoch_changed" : "stream_changed";
		this.ledger.resetBinding(reason, `b${++this.bindingTagCounter}`);
	}

	// ---- 查询 ----

	private resolveQuery(query: WorldQuery): { definition: QueryDefinition; input: JsonValue } {
		const definition = this.queries.get(query.ref);
		if (!definition) {
			throw new CallFailureError({
				code: "CALL_UNAVAILABLE",
				message: `查询不存在或未注册：${query.ref}`,
			});
		}
		let input: JsonValue;
		try {
			input = definition.normalizeInput(query.input);
		} catch (error) {
			if (error instanceof CallFailureError) throw error;
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: `查询输入不合法：${String(error)}` });
		}
		return { definition, input };
	}

	private requireScope(): ClientFactScope {
		if (!this.scope) {
			throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "当前事实源尚未建立（Driver 未就绪）" });
		}
		return this.scope;
	}

	async read<T>(query: WorldQuery): Promise<Observation<T>> {
		this.assertNotClosed();
		const { definition, input } = this.resolveQuery(query);
		if (definition.deps.has("current")) {
			// 纯当前：同步段固定切面——sample、纳入水位、组装 cursor；不读存储、不等历史。
			this.requireScope();
			let fact: Fact<JsonValue> | undefined;
			let capture: ReturnType<ClientFactsPort["sample"]> | undefined;
			try {
				capture = this.facts.sample((view) => {
					fact = definition.evalCurrent!(view, input);
					return null;
				});
			} catch (error) {
				// Driver/view 异常不按当前事实失败解释：如实报源不可用（不吞诊断）。
				this.recordDiagnostic(`采样求值失败：${String(error)}`);
				throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: `当前事实源采样失败：${String(error)}` });
			}
			// 采样结果可能携带变化的 scope/stamp：先纳入失效水位，再固定 cursor。
			this.applyScope(capture.scope, false);
			this.currentTracker.observeStamp(capture.stamp);
			this.sampledOnce = true;
			if (!fact) {
				throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "当前采样未返回事实" });
			}
			// 流身份用采样原子返回的 scope：事实属于 capture.scope，不是调用前的旧绑定。
			const stream = queryStreamRef(
				query.ref,
				capture.scope.world,
				capture.scope.worldRevision,
				capture.scope.dimension,
				input,
			);
			this.ledger.ensureStream(stream, definition.deps);
			const cursor = this.ledger.cursorFor(stream);
			return { ...fact, cursor } as Observation<T>;
		}
		// 纯历史：提交屏障模型。
		if (this.store.availability.state !== "ready") {
			throw new CallFailureError({
				code: "STORE_UNAVAILABLE",
				message: this.store.availability.reason ?? "历史存储不可用",
			});
		}
		const barrierTarget = this.captureBarrier();
		await this.waitForBarrier(barrierTarget);
		const filter = input as {
			stream?: string;
			schema?: string;
			limit?: number;
			page?: { version: number; afterStoreSeq: number };
		};
		// cursor 先于读取 await 固定：读取期间的新提交只会让下次 next 立即交付，
		// 本观测绝不会拿到覆盖了它未包含事实的 cursor（不漏失效）。
		const stream = `mcw:qh:${query.ref}|${canonicalJson(input)}`;
		this.ledger.ensureStream(stream, definition.deps);
		const cursor = this.ledger.cursorFor(stream);
		const evidenceFilter: EvidenceFilter = {
			stream: filter.stream,
			schema: filter.schema,
			limit: filter.limit ?? 50,
			afterStoreSeq: filter.page?.afterStoreSeq,
		};
		// 单条消息 = Worker 内原子读取边界；页携带其读取边界的提交版本。
		const page = await this.store.listEvidence(evidenceFilter);
		if (!page) {
			throw new CallFailureError({ code: "STORE_UNAVAILABLE", message: "历史存储读取失败" });
		}
		if (filter.page && filter.page.version !== page.version) {
			throw new CallFailureError({
				code: "SNAPSHOT_EXPIRED",
				message: `分页版本 ${filter.page.version} 已过期（当前 ${page.version}）`,
			});
		}
		const items = page.items.map(({ entry }) =>
			entry.kind === "fact"
				? {
						kind: "fact" as const,
						ref: entry.record.ref,
						stream: entry.record.mark.stream,
						seq: entry.record.mark.sequence,
						schema: entry.record.schema,
						fact: entry.record.fact,
					}
				: {
						kind: "gap" as const,
						ref: entry.gap.ref,
						stream: entry.gap.stream,
						after: entry.gap.after,
						through: entry.gap.through,
						reason: entry.gap.reason,
					},
		);
		const value = {
			items,
			next: page.nextStoreSeq === null ? null : { version: page.version, afterStoreSeq: page.nextStoreSeq },
		};
		// 纯历史不要求 Driver 在线（不变量 A）：流身份不含分区——分区代次由 epoch 分量承载，
		// 重绑/分区变化经 resetBinding 全量 reset，历史注册随之退役后重新 read→watch。
		return {
			value,
			observedAt: new Date().toISOString(),
			source: "history",
			coverage: "complete",
			unknown: [],
			evidence: [],
			cursor,
		} as unknown as Observation<T>;
	}

	async watch(query: WorldQuery, after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch> {
		void after; // after 只在首次 next 比较使用（awaitNext → check）
		this.assertNotClosed();
		if (signal.aborted) throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "watch 前已被取消" });
		const { definition, input } = this.resolveQuery(query);
		let registration: WatchRegistration;
		if (definition.deps.has("current")) {
			this.requireScope();
			// 同步段：先纳入当前 stamp（含保守失效），再登记等待者——登记后无漏。
			const capture = this.facts.sample(() => null);
			this.applyScope(capture.scope, false);
			this.currentTracker.observeStamp(capture.stamp);
			this.sampledOnce = true;
			// 流身份用采样原子返回的 scope（事实所属分区），不用调用前的旧绑定。
			const stream = queryStreamRef(
				query.ref,
				capture.scope.world,
				capture.scope.worldRevision,
				capture.scope.dimension,
				input,
			);
			registration = this.ledger.createRegistration(stream, definition.deps);
		} else {
			// 纯历史不要求 Driver 在线（不变量 A）；分区代次由 epoch 分量承载（同 read）。
			const stream = `mcw:qh:${query.ref}|${canonicalJson(input)}`;
			registration = this.ledger.createRegistration(stream, definition.deps);
		}
		// 登记时已发现的变化由首次 next 立即交付（awaitNext → check）。
		return {
			next: (nextAfter: ObservationCursor, nextSignal: AbortSignal) =>
				this.awaitChange(registration, nextAfter, nextSignal),
			close: async () => {
				registration.close();
			},
		};
	}

	private awaitChange(
		registration: WatchRegistration,
		after: ObservationCursor,
		signal: AbortSignal,
	): Promise<WorldChange> {
		return new Promise<WorldChange>((resolve, reject) => {
			if (signal.aborted) {
				reject(new CallFailureError({ code: "INVALID_ARGUMENT", message: "next 前已被取消" }));
				return;
			}
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				registration.cancelAwait();
				reject(new CallFailureError({ code: "INVALID_ARGUMENT", message: "next 等待已取消" }));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const registered = registration.awaitNext(after, {
				deliver: (change) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(change);
				},
				fail: (error) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			if (!registered && !settled) {
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(new CallFailureError({ code: "REFERENCE_STALE", message: "watch 已关闭，请重新 read→watch" }));
			}
		});
	}

	// ---- 领域记录 ----

	async readRecord(ref: Ref): Promise<DomainRecord> {
		this.assertNotClosed();
		if (this.store.availability.state !== "ready") {
			throw new CallFailureError({
				code: "STORE_UNAVAILABLE",
				message: this.store.availability.reason ?? "历史存储不可用",
			});
		}
		const row = await this.store.readRecord(ref);
		if (!row) {
			throw new CallFailureError({ code: "CALL_UNAVAILABLE", message: `领域记录不存在：${ref}` });
		}
		return this.recordFromRow(row);
	}

	async writeRecord(change: {
		ref?: Ref;
		schema: ExactRef;
		world: Ref;
		worldRevision: Ref;
		expectedRevision: number | null;
		value: JsonValue;
		evidence: Ref[];
	}): Promise<DomainRecord> {
		this.assertNotClosed();
		// 结构校验；所有权核验（真实当前调用 + schema 归属）需组合根注入，登记为合同缺口。
		if (typeof change.schema !== "string" || !change.schema.includes("@")) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "schema 必须是 ExactRef" });
		}
		if (typeof change.world !== "string" || typeof change.worldRevision !== "string") {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "world/worldRevision 必须是 Ref" });
		}
		if (change.expectedRevision !== null && !Number.isInteger(change.expectedRevision)) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "expectedRevision 必须是整数或 null" });
		}
		JSON.stringify(change.value); // 值必须可 JSON 编码
		if (!Array.isArray(change.evidence) || change.evidence.some((e) => typeof e !== "string")) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "evidence 必须是 Ref 数组" });
		}
		if (this.store.availability.state !== "ready") {
			throw new CallFailureError({
				code: "STORE_UNAVAILABLE",
				message: this.store.availability.reason ?? "历史存储不可写",
			});
		}
		// 证据存在性：领域记录的同类保留在修订事务内完成，不得引用未收到的证据（悬空引用）。
		for (const ref of change.evidence) {
			if (!(await this.evidenceExists(ref))) {
				throw new CallFailureError({ code: "EVIDENCE_UNAVAILABLE", message: `记录引用的证据不存在：${ref}` });
			}
		}
		// 引用了证据的修订：先等已接收证据提交完成，记录不落在证据之前（不建立悬空持久引用）。
		if (change.evidence.length > 0) {
			await this.waitForBarrier(this.captureBarrier());
		}
		// 分区一致性：不凭 worldId 文本相同放行旧代次写入。
		// 写入有当前分区依赖：先同步采样刷新绑定视图。
		let capture: ReturnType<ClientFactsPort["sample"]>;
		try {
			capture = this.facts.sample(() => null);
		} catch (error) {
			this.recordDiagnostic(`写入前采样失败：${String(error)}`);
			throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: `写入前绑定核验失败：${String(error)}` });
		}
		this.applyScope(capture.scope, false);
		this.currentTracker.observeStamp(capture.stamp);
		this.sampledOnce = true;
		const scope = this.requireScope();
		if (change.world !== scope.world || change.worldRevision !== scope.worldRevision) {
			throw new CallFailureError({
				code: "REFERENCE_STALE",
				message: `记录分区 ${change.world}/${change.worldRevision} 与当前绑定 ${scope.world}/${scope.worldRevision} 不一致`,
			});
		}
		const ref = change.ref ?? `mcw:record:${cryptoRandomRef()}`;
		const result = await this.store.writeRecord({
			ref,
			schema: change.schema,
			world: change.world,
			worldRevision: change.worldRevision,
			expectedRevision: change.expectedRevision,
			value: change.value,
			evidence: [...change.evidence],
		});
		if (!result.ok) {
			if (result.reason === "conflict") {
				throw new CallFailureError({
					code: "RECORD_CHANGED",
					message: `领域记录 CAS 冲突：ref=${ref} expectedRevision=${change.expectedRevision}`,
				});
			}
			if (result.reason === "not_found") {
				throw new CallFailureError({ code: "CALL_UNAVAILABLE", message: `领域记录不存在：${ref}` });
			}
			if (result.reason === "immutable_fields") {
				throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "schema/world/worldRevision 不可随修订偷换" });
			}
			throw new CallFailureError({ code: "STORE_UNAVAILABLE", message: "领域记录写入失败" });
		}
		// 领域修订持久提交 → 历史依赖失效。
		this.ledger.bump("history", null);
		return this.recordFromRow(result.record);
	}

	private recordFromRow(row: {
		ref: string;
		revision: number;
		schema: string;
		world: string;
		worldRevision: string;
		value: unknown;
		evidence: string[];
	}): DomainRecord {
		return {
			ref: row.ref,
			schema: row.schema as ExactRef,
			world: row.world,
			worldRevision: row.worldRevision,
			revision: row.revision,
			value: row.value as JsonValue,
			evidence: row.evidence,
		};
	}

	// ---- 证据保留（WorldEvidencePort） ----

	async retain(owner: Ref, evidence: Ref[]): Promise<void> {
		this.assertNotClosed();
		if (typeof owner !== "string" || owner.length === 0) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "owner 必须是不可变的持久记录所有者身份" });
		}
		if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== "string")) {
			throw new CallFailureError({ code: "INVALID_ARGUMENT", message: "evidence 必须是 Ref 数组" });
		}
		if (this.store.availability.state !== "ready") {
			throw new CallFailureError({ code: "STORE_UNAVAILABLE", message: "无法保证证据与保留关系已提交" });
		}
		// 成功前保证证据已持久且存在：等屏障把待落盘冲完；失败不虚假成功。
		await this.waitForBarrier(this.captureBarrier());
		for (const ref of evidence) {
			if (!(await this.evidenceExists(ref))) {
				throw new CallFailureError({ code: "EVIDENCE_UNAVAILABLE", message: `被保留的证据不存在：${ref}` });
			}
		}
		const ok = await this.store.retain(owner, evidence);
		if (!ok) {
			throw new CallFailureError({ code: "EVIDENCE_UNAVAILABLE", message: "保留关系提交失败" });
		}
	}

	async release(owner: Ref): Promise<void> {
		this.assertNotClosed();
		if (this.store.availability.state !== "ready") {
			throw new CallFailureError({ code: "STORE_UNAVAILABLE", message: "历史存储不可用" });
		}
		// release 语义即"此后无保留"：对不存在的 owner 幂等成功。
		await this.store.release(owner);
	}

	// ---- 状态与生命周期 ----

	async status(): Promise<WorldAvailabilityValue> {
		const scope = this.scope;
		const current: WorldAvailabilityValue["current"] = this.sampledOnce
			? { state: "ready" }
			: { state: "starting", reason: "尚未取得 Driver 当前采样" };
		const availability = this.store.availability;
		const history: WorldAvailabilityValue["history"] =
			availability.state !== "ready" || this.storeFailed
				? { state: "unavailable", reason: availability.reason ?? "存储提交失败" }
				: { state: "ready", reason: this.store.description };
		const binding: WorldAvailabilityValue["binding"] = scope
			? { state: "bound", binding: scope.binding, world: scope.world, worldRevision: scope.worldRevision }
			: { state: "unbound", binding: "mcw:unbound", world: "mcw:unbound", worldRevision: "mcw:unbound" };
		return { current, history, binding };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.closing = true;
		this.ledger.shutdown(() => new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "World 已关闭，等待终止" }));
		this.reception.close();
		// 最终冲刷：串入提交队列，提交可得前缀并返回 durable ACK 后关闭资源。
		this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
		await this.flushChain;
		this.failBarriers(new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "World 已关闭" }));
		this.subscription?.close();
		this.subscription = null;
		await this.store.close();
	}

	private assertNotClosed(): void {
		if (this.closed) {
			throw new CallFailureError({ code: "SOURCE_UNAVAILABLE", message: "World 已关闭" });
		}
	}

	/** 诊断（集成报告/健康查询用；非公开合同）。 */
	getDiagnosticLog(): readonly string[] {
		return this.diagnostics;
	}

	/** WorldEvidencePort 视图：仅注入 Runtime、Assets 等持久记录所有者，不给 Program。 */
	get evidence(): WorldEvidencePort {
		return { retain: (owner, evidence) => this.retain(owner, evidence), release: (owner) => this.release(owner) };
	}
}

function cryptoRandomRef(): string {
	// 局部唯一即可：随机 ID 防跨实例碰撞；引用稳定性由存储主键保证。
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
