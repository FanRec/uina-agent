/**
 * World 当前读：纯当前 read/watch 最小实现（不读历史存储）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/world.md §6.1、§9.2–§9.4。
 * read = facts.sample 同步采样 + 注入的查询 resolver（返回 Fact）；cursor 取当前源
 * stamp（stream=source、epoch、sequence），查询参数校验归 K1 描述符（I1 查询无参）。
 * watch 保守失效（§9.2）：当前源任何推进即 changed（changed=[] 不做精确分类），
 * epoch/source 断裂即 reset；首次 next 立即比较（§9.3）；同一水位只交付一次提示。
 * 历史依赖（events@1 等）不在 I1 范围。
 */

import { callFailure } from "../contracts/values.js";
import type { CallFailure, ExactRef, Fact, Observation, ObservationCursor } from "../contracts/values.js";
import type {
	ClientFactCapture,
	ClientFactNotice,
	ClientFactStamp,
	ClientFactView,
	ClientFactsPort,
	ClientFactsSubscription,
} from "../contracts/client-facts.js";
import type { WorldChange, WorldQuery, WorldWatch } from "../contracts/world.js";

/** 查询 resolver：从当前事实视图组装一个 Fact（组合根由 K1 声明生成注入）。 */
export type QueryResolver = (view: ClientFactView) => Fact<unknown>;

function worldFailure(code: string, message: string, hint?: string): CallFailure {
	return callFailure({ code, source: "world", message, hint, dispatch: "not_sent", effects: [], recoverable: false });
}

function unknownQuery(ref: string, resolvers: ReadonlyMap<ExactRef, QueryResolver>): CallFailure {
	const available = [...resolvers.keys()].sort().join(", ") || "(none)";
	return worldFailure("INVALID_INPUT", `unknown world query: ${ref}`, `available queries: ${available}`);
}

function abortError(): Error {
	const err = new Error("world watch wait aborted");
	err.name = "AbortError";
	return err;
}

/** facts.sample 的结构化错误收敛为 CallFailure（capabilities §2.6 口径）。 */
function toReadFailure(err: unknown): CallFailure {
	const code = (err as { code?: string } | null)?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === "WRONG_STATE") {
		// 源未附着活连接——当前读不可用（DISCONNECTED：连接断了，别重试）。
		return worldFailure("DISCONNECTED", "current facts source is not attached to a live connection", message);
	}
	if (typeof code === "string" && code.length > 0) {
		return callFailure({ code, source: "environment", message, dispatch: "not_sent", effects: [], recoverable: false });
	}
	return worldFailure("INTERNAL", `world read failed: ${message}`);
}

type CursorRelation = "equal" | "stream" | "epoch" | "moved";

/** 不同 stream/epoch 之间不可比较（values.ts ObservationCursor 约定）。 */
function relate(after: ObservationCursor, current: ObservationCursor): CursorRelation {
	if (after.stream !== current.stream) return "stream";
	if (after.epoch !== current.epoch) return "epoch";
	return after.sequence === current.sequence ? "equal" : "moved";
}

function cursorOf(stamp: ClientFactStamp): ObservationCursor {
	return { stream: stamp.source, epoch: stamp.epoch, sequence: stamp.sequence };
}

interface PendingWait {
	after: ObservationCursor;
	signal: AbortSignal;
	onAbort: () => void;
	resolve: (change: WorldChange) => void;
	reject: (err: Error) => void;
}

export class CurrentWatch implements WorldWatch {
	private closed = false;
	private readonly waiters = new Set<PendingWait>();
	private current: ObservationCursor;

	constructor(private readonly subscription: ClientFactsSubscription) {
		this.current = cursorOf(subscription.stamp);
	}

	handleNotice(notice: ClientFactNotice): void {
		if (this.closed) return;
		if (notice.kind !== "changed" && notice.kind !== "reset") return;
		this.current = cursorOf(notice.stamp);
		if (notice.kind === "reset") {
			for (const wait of [...this.waiters]) {
				const relation = relate(wait.after, this.current);
				if (relation === "stream") {
					this.settleWait(wait, { kind: "reset", reason: "stream_changed", cursor: { ...this.current } });
				} else if (relation === "epoch") {
					this.settleWait(wait, { kind: "reset", reason: "epoch_changed", cursor: { ...this.current } });
				} else if (relation === "moved") {
					// 防御：同 epoch 数字不同（不该发生）——保守交付 changed。
					this.settleWait(wait, { kind: "changed", cursor: { ...this.current }, changed: [] });
				}
			}
			return;
		}
		for (const wait of [...this.waiters]) {
			// 等待者游标落后于当前即保守失效；同一水位不重复交付（§9.2）。
			if (relate(wait.after, this.current) === "equal") continue;
			this.settleWait(wait, { kind: "changed", cursor: { ...this.current }, changed: [] });
		}
	}

	async next(after: ObservationCursor, signal: AbortSignal): Promise<WorldChange> {
		if (this.closed) {
			throw worldFailure("INTERNAL", "world watch is closed", "create a new watch via watch()");
		}
		if (signal.aborted) throw abortError();
		// 首次 next 立即返回登记时已发现的变化（§9.3）。
		const relation = relate(after, this.current);
		if (relation === "stream") return { kind: "reset", reason: "stream_changed", cursor: { ...this.current } };
		if (relation === "epoch") return { kind: "reset", reason: "epoch_changed", cursor: { ...this.current } };
		if (relation === "moved") return { kind: "changed", cursor: { ...this.current }, changed: [] };
		return new Promise<WorldChange>((resolve, reject) => {
			const wait: PendingWait = {
				after: { ...after },
				signal,
				onAbort: () => {},
				resolve,
				reject,
			};
			wait.onAbort = () => {
				this.waiters.delete(wait);
				signal.removeEventListener("abort", wait.onAbort);
				reject(abortError());
			};
			signal.addEventListener("abort", wait.onAbort, { once: true });
			this.waiters.add(wait);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.subscription.close();
		for (const wait of [...this.waiters]) {
			wait.signal.removeEventListener("abort", wait.onAbort);
			wait.reject(worldFailure("INTERRUPTED", "world watch closed while waiting"));
		}
		this.waiters.clear();
	}

	private settleWait(wait: PendingWait, change: WorldChange): void {
		this.waiters.delete(wait);
		wait.signal.removeEventListener("abort", wait.onAbort);
		wait.resolve(change);
	}
}

export class CurrentReads {
	constructor(
		private readonly facts: ClientFactsPort,
		private readonly resolvers: ReadonlyMap<ExactRef, QueryResolver>,
	) {}

	async read<T>(query: WorldQuery): Promise<Observation<T>> {
		const resolver = this.resolvers.get(query.ref);
		if (resolver == null) throw unknownQuery(query.ref, this.resolvers);
		let capture: ClientFactCapture<Fact<unknown>>;
		try {
			capture = this.facts.sample((view) => resolver(view));
		} catch (err) {
			throw toReadFailure(err);
		}
		const fact = capture.value;
		return {
			...fact,
			value: fact.value as T,
			cursor: cursorOf(capture.stamp),
		};
	}

	async watch(query: WorldQuery, _after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch> {
		if (signal.aborted) throw abortError();
		if (!this.resolvers.has(query.ref)) throw unknownQuery(query.ref, this.resolvers);
		let watch: CurrentWatch | null = null;
		const subscription = this.facts.subscribe((notice) => {
			watch?.handleNotice(notice);
		});
		watch = new CurrentWatch(subscription);
		return watch;
	}
}
