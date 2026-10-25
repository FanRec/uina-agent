/**
 * Minecraft World 组合：当前读 + 静态知识 + 事件历史 + 可用性快照。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/world.md §4.2、§8、§13.1。
 * 读取按 §8.2 三类分派：current（facts.sample）/ static（版本知识，不建连接依赖）
 * / history（events@1，走历史存储与提交屏障）。cur=null 只出现在没有观察源的查询。
 * 绑定由 World 拥有（组合根注入当前绑定投影，Driver 据此标注捕获 scope）；
 * 历史侧两段启动（§13.1）：句柄立即可用，historyReady 结算 ready/unavailable。
 * I1 不做领域记录（readRecord/writeRecord 显式失败，沿 writeSign 先例）；
 * WorldEvidencePort 随真实记录所有者出现时再接入。
 */

import { callFailure } from "../contracts/values.js";
import type {
	CallFailure,
	ExactRef,
	Fact,
	JsonValue,
	Observation,
	ObservationCursor,
	Ref,
} from "../contracts/values.js";
import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { QueryDescriptor, QueryReader, QueryValidator } from "../contracts/capabilities.js";
import type {
	DomainRecord,
	EventPage,
	WorldAvailabilityValue,
	WorldPort,
	WorldQuery,
	WorldWatch,
} from "../contracts/world.js";
import { CONTAINER_LAST_REF, containerObservation, resolveContainerQuery } from "./containers.js";
import { checkCursor, queryStream, watchFailure } from "./watch.js";
import { CurrentReads } from "./current.js";
import { HistoryIngest, type HistoryState } from "./history-store.js";
import { EVENTS_REF, buildEventPage, eventScopeOf, resolveEventQuery, type EventScope } from "./events.js";

export interface MinecraftWorldOptions {
	facts: ClientFactsPort;
	/** 查询读取表（能力面声明生成；组合根装配）。 */
	readers: ReadonlyMap<ExactRef, QueryReader>;
	validators: ReadonlyMap<ExactRef, QueryValidator>;
	queries: QueryDescriptor[];
	/** world-history.db 路径（.uina/world-data/minecraft/ 下，Host 提供数据根）。 */
	dbPath: string;
	/** 当前绑定投影（§4.2；I1 每进程生成显式分区，不猜旧身份）。 */
	binding: { binding: Ref; world: Ref; worldRevision: Ref; state?: "bound" | "unbound" };
	/** 本次启动命名空间（与 Driver 证据流命名空间同源；跨进程不复用，§5.3）。 */
	namespace: string;
}

function unimplementedRecords(op: string): CallFailure {
	return callFailure({
		code: "INTERNAL",
		source: "world",
		message: `${op} is not implemented in world I1 scope`,
		hint: "domain records arrive with the executor/program work packages (development-plan.md §4)",
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

function unknownQuery(ref: string, readers: ReadonlyMap<ExactRef, QueryReader>): CallFailure {
	const available = [...readers.keys()].sort().join(", ") || "(none)";
	return callFailure({
		code: "INVALID_INPUT",
		source: "world",
		message: `unknown world query: ${ref}`,
		hint: `available queries: ${available}, ${EVENTS_REF}, ${CONTAINER_LAST_REF}`,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

/**
 * 可用性投影（public-api §5）：纯函数，便于在不装配历史 worker 的情况下核对语义。
 * current 三态不可混用：尚未连接 = starting；连接已断/故障 = unavailable（不可自恢复）；
 * 能同步采样 = ready。
 */
export function projectAvailability(input: {
	/** 采样探针：不抛错即当前读可用；抛 DISCONNECTED 表示连接已消失。 */
	probeCurrent: () => void;
	historyState: HistoryState;
	binding: MinecraftWorldOptions["binding"];
}): WorldAvailabilityValue {
	let current: WorldAvailabilityValue["current"];
	try {
		input.probeCurrent();
		current = { state: "ready" };
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		current =
			code === "DISCONNECTED"
				? { state: "unavailable", reason: err instanceof Error ? err.message : "client connection is gone" }
				: { state: "starting" };
	}
	const history = input.historyState;
	return {
		current,
		history:
			history.state === "unavailable" ? { state: "unavailable", reason: history.reason } : { state: history.state },
		binding: {
			state: input.binding.state ?? "bound",
			binding: input.binding.binding,
			world: input.binding.world,
			worldRevision: input.binding.worldRevision,
		},
	};
}

export class MinecraftWorld implements WorldPort {
	private readonly facts: ClientFactsPort;
	private readonly current: CurrentReads;
	private readonly history: HistoryIngest;
	private readonly binding: MinecraftWorldOptions["binding"];
	private readonly readers: ReadonlyMap<ExactRef, QueryReader>;
	private readonly validators: ReadonlyMap<ExactRef, QueryValidator>;
	private readonly eventScope: EventScope;
	private readonly watchable: Set<string>;
	private readonly watches = new Set<WorldWatch>();
	private closed = false;
	/** 历史侧就绪信号：ready 或明确 unavailable 都结算（§13.1，不进公开查询面）。 */
	readonly historyReady: Promise<"ready" | "unavailable">;

	constructor(options: MinecraftWorldOptions) {
		this.facts = options.facts;
		this.binding = options.binding;
		this.readers = options.readers;
		this.validators = options.validators;
		this.watchable = new Set(options.queries.filter((q) => q.watchable).map((q) => q.ref));
		const queryRefs: ExactRef[] = [...options.readers.keys(), EVENTS_REF, CONTAINER_LAST_REF];
		for (const ref of queryRefs) {
			if (typeof options.validators?.get(ref) !== "function") throw new Error(`query validator is missing: ${ref}`);
		}
		this.current = new CurrentReads(options.facts);
		this.history = new HistoryIngest(options.facts, {
			dbPath: options.dbPath,
			receiverNamespace: options.namespace,
		});
		this.historyReady = this.history.historyReady;
		this.eventScope = eventScopeOf(options.binding.binding, options.binding.world, options.binding.worldRevision);
	}

	async read<T>(query: WorldQuery): Promise<Observation<T>> {
		const observation = await this.readPartition<T>(query);
		if (this.binding.state !== "unbound") return observation;
		return {
			...observation,
			coverage: "partial",
			unknown: [
				...observation.unknown,
				"persistent world identity is unbound; this observation belongs to the current launch partition",
			],
		};
	}

	private async readPartition<T>(query: WorldQuery): Promise<Observation<T>> {
		const input = this.validateQuery(query);
		const reader = this.readers.get(query.ref);
		if (reader?.kind === "current") {
			const observation = await this.current.read<T>(query.ref, input, reader.read);
			// 派生结果（如 recipe 的 plan）读当前库存但不发布观察水位。
			return reader.cursor === "none" || !this.watchable.has(query.ref)
				? { ...observation, cursor: null }
				: observation;
		}
		if (reader?.kind === "static") {
			return { ...(reader.read(input) as Fact<T>), cursor: null };
		}
		if (query.ref === EVENTS_REF) return await this.readEvents<T>(input);
		if (query.ref === CONTAINER_LAST_REF) {
			const params = resolveContainerQuery(input, this.binding, this.facts);
			return containerObservation<T>(await this.history.readContainer(params));
		}
		throw unknownQuery(query.ref, this.readers);
	}

	async watch(query: WorldQuery, after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch> {
		const input = this.validateQuery(query);
		checkCursor(after);
		signal.throwIfAborted();
		if (!this.watchable.has(query.ref)) throw watchFailure("INVALID_INPUT", `${query.ref} is not watchable`);
		let inner: WorldWatch;
		if (query.ref === EVENTS_REF) {
			const observation = await this.readEvents<EventPage>(input);
			if (!observation.cursor)
				throw watchFailure(
					"INVALID_INPUT",
					"events waiting requires a fixed after and a complete page; read next pages first",
				);
			inner = this.history.watchEvents(queryStream(EVENTS_REF, input, this.eventScope.partition));
		} else {
			const reader = this.readers.get(query.ref);
			if (reader?.kind !== "current" || reader.cursor === "none")
				throw watchFailure("INVALID_INPUT", `${query.ref} has no watchable observation source`);
			inner = await this.current.watch(query.ref, input, signal);
		}
		const close = async () => {
			signal.removeEventListener("abort", abort);
			this.watches.delete(watch);
			await inner.close();
		};
		const abort = () => {
			void close();
		};
		const watch: WorldWatch = { next: (cursor, waitSignal) => inner.next(cursor, waitSignal), close };
		if (this.closed || signal.aborted) {
			await inner.close();
			throw watchFailure("INTERRUPTED", "World or watch scope closed");
		}
		this.watches.add(watch);
		signal.addEventListener("abort", abort, { once: true });
		return watch;
	}

	private validateQuery(query: WorldQuery): JsonValue {
		if (this.closed) throw watchFailure("INTERRUPTED", "World is closed");
		const validate = this.validators.get(query.ref);
		if (validate === undefined) throw unknownQuery(query.ref, this.readers);
		return validate(query.input);
	}

	/** events@1：分区内历史页；提交屏障 + worker 单消息读取保证页内一致（§8.5）。 */
	private async readEvents<T>(input: JsonValue): Promise<Observation<T>> {
		const { params } = resolveEventQuery(input, this.eventScope);
		const result = await this.history.readEvents(params);
		const page: EventPage = buildEventPage(result, params);
		const gaps = page.gaps;
		return {
			value: page as T,
			observedAt: new Date().toISOString(),
			source: "history",
			coverage: gaps.length > 0 ? "partial" : "complete",
			unknown: gaps.length > 0 ? [`${gaps.length} recorded gap(s) exist in this partition; see page.gaps`] : [],
			evidence: page.events.map((event) => event.ref),
			cursor:
				params.afterRowid !== null && params.upper === null && !page.next
					? this.history.eventCursor(queryStream(EVENTS_REF, input, this.eventScope.partition), result.version)
					: null,
		};
	}

	async readRecord(_ref: Ref): Promise<DomainRecord> {
		throw unimplementedRecords("readRecord");
	}

	async writeRecord(_change: Parameters<WorldPort["writeRecord"]>[0]): Promise<DomainRecord> {
		throw unimplementedRecords("writeRecord");
	}

	availability(): WorldAvailabilityValue {
		return projectAvailability({
			probeCurrent: () => {
				this.facts.sample(() => null);
			},
			historyState: this.history.state,
			binding: this.binding,
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.watches].map((w) => w.close()));
		await this.history.close();
	}
}
