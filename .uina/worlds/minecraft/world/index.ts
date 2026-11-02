/**
 * Minecraft World 组合：当前读 + 静态知识 + 事件历史 + 领域记录 + 可用性快照。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/world.md §4.2、§8、§10、§13.1。
 * 读取按 §8.2 分派：current（facts.sample）/ static（版本知识，不建连接依赖）
 * / history（events@1、places@1，走历史存储与提交屏障）/ derived（route.plan@1 与
 * build.plan@1，组合根注入的窄计划端口，World 不依赖 Driver 或 Construction）。cur=null 只出现在没有观察源的查询。
 * 绑定由 World 拥有（组合根注入当前绑定投影，Driver 据此标注捕获 scope）；
 * 历史侧两段启动（§13.1）：句柄立即可用，historyReady 结算 ready/unavailable。
 * 领域记录经 HistoryIngest 的记录消息落地（CAS 在 worker 单事务内）；
 * WorldEvidencePort 仅保护可信记录所有者实际持有的不可变观察引用。
 */

import type { QueryDescriptor, QueryReader, QueryValidator } from "../contracts/capabilities.js";
import type { ClientFactsPort } from "../contracts/client-facts.js";
import type {
	CallFailure,
	ExactRef,
	Fact,
	ImageFileRef,
	JsonValue,
	Observation,
	ObservationCursor,
	Ref,
} from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type {
	ConstructionPlanner,
	DomainRecord,
	EventPage,
	WorldAvailabilityValue,
	WorldEvidencePort,
	WorldHistoryPrune,
	WorldHistoryPruneResult,
	WorldPort,
	WorldQuery,
	WorldRoutePlanner,
	WorldWatch,
} from "../contracts/world.js";
import { BUILD_PLAN_REF, buildPlanObservation } from "./build-plan.js";
import { CONTAINER_LAST_REF, containerObservation, resolveContainerQuery } from "./containers.js";
import { CurrentReads } from "./current.js";
import { buildEventPage, EVENTS_REF, type EventScope, eventScopeOf, resolveEventQuery } from "./events.js";
import { HistoryIngest, type HistoryState } from "./history-store.js";
import { exportMapImage, MAP_REF, mapValueOf, resolveMapInput, sampleMap } from "./map.js";
import { PLACE_SCHEMA, PLACES_REF, type PlacesOrigin, placesObservation, resolvePlacesQuery } from "./places.js";
import { ROUTE_PLAN_REF, routePlanObservation } from "./route-plan.js";
import { checkCursor, queryStream, watchFailure } from "./watch.js";

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
	/** route.plan@1 的窄计划端口（组合根用 Driver 受控寻路实现）；缺省时该查询明确失败。 */
	routePlanner?: WorldRoutePlanner;
	/** build.plan@1 的窄计划端口（组合根用 Construction 装配）；缺省时该查询明确失败。 */
	buildPlanner?: ConstructionPlanner;
	/** map@1 的 PNG 缓存目录（`<worldDataDir>/exports/images`）；缺省时 image=true 如实 unknown。 */
	imageDir?: string;
}

function recordFailure(code: string, message: string, hint?: string): CallFailure {
	return callFailure({
		code,
		source: "world",
		message,
		hint,
		dispatch: "not_sent",
		effects: [],
		recoverable: true,
	});
}

function unknownQuery(ref: string, readers: ReadonlyMap<ExactRef, QueryReader>): CallFailure {
	const available = [...readers.keys()].sort().join(", ") || "(none)";
	return callFailure({
		code: "INVALID_INPUT",
		source: "world",
		message: `unknown world query: ${ref}`,
		hint: `available queries: ${available}, ${EVENTS_REF}, ${CONTAINER_LAST_REF}, ${MAP_REF}`,
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

export class MinecraftWorld implements WorldPort, WorldEvidencePort {
	private readonly facts: ClientFactsPort;
	private readonly current: CurrentReads;
	private readonly history: HistoryIngest;
	private readonly binding: MinecraftWorldOptions["binding"];
	private readonly readers: ReadonlyMap<ExactRef, QueryReader>;
	private readonly validators: ReadonlyMap<ExactRef, QueryValidator>;
	private readonly routePlanner: WorldRoutePlanner | null;
	private readonly buildPlanner: ConstructionPlanner | null;
	private readonly imageDir: string | null;
	private readonly eventScope: EventScope;
	/** places 记录观察的分区键：换分区后旧游标失效（与 events 同形）。 */
	private readonly placesPartition: string;
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
		this.routePlanner = options.routePlanner ?? null;
		this.buildPlanner = options.buildPlanner ?? null;
		this.imageDir = options.imageDir ?? null;
		this.watchable = new Set(options.queries.filter((q) => q.watchable).map((q) => q.ref));
		const queryRefs: ExactRef[] = [
			...options.readers.keys(),
			EVENTS_REF,
			CONTAINER_LAST_REF,
			PLACES_REF,
			ROUTE_PLAN_REF,
			BUILD_PLAN_REF,
			MAP_REF,
		];
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
		this.placesPartition = JSON.stringify([
			options.binding.binding,
			options.binding.world,
			options.binding.worldRevision,
		]);
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
		if (query.ref === PLACES_REF) return await this.readPlaces<T>(input);
		if (query.ref === ROUTE_PLAN_REF) {
			if (this.routePlanner == null)
				throw watchFailure("INTERNAL", "route.plan planner is not wired in this composition");
			return routePlanObservation<T>(await this.routePlanner.plan({ ref: query.ref, input }));
		}
		if (query.ref === BUILD_PLAN_REF) {
			if (this.buildPlanner == null)
				throw watchFailure("INTERNAL", "build.plan planner is not wired in this composition");
			return buildPlanObservation<T>(await this.buildPlanner.plan({ ref: query.ref, input }));
		}
		if (query.ref === MAP_REF) return await this.readMap<T>(input);
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
		} else if (query.ref === PLACES_REF) {
			// 记录观察按 record_version 失效：任何记录写都会触发 changed（保守提示，复查重读）。
			inner = this.history.watchRecords(queryStream(PLACES_REF, input, this.placesPartition));
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

	/** places@1：分区记录 + kind/near 过滤；near 原点取当前 self，断线显式失败。 */
	private async readPlaces<T>(input: JsonValue): Promise<Observation<T>> {
		const origin: PlacesOrigin | null = this.placesOrigin();
		const params = resolvePlacesQuery(input, origin);
		const result = await this.history.readRecords({
			schema: PLACE_SCHEMA,
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
		});
		return placesObservation<T>(result.rows, params, {
			observedAt: new Date().toISOString(),
			evidence: result.rows.map((row) => row.ref),
			cursor: this.history.placesCursor(queryStream(PLACES_REF, input, this.placesPartition)),
		});
	}

	/**
	 * map@1（§8.6）：一次纯当前 sample 固定选图与切面；image=true 才在关键循环外
	 * 编码 PNG 并原子写缓存。不可等待：cursor 恒 null。
	 */
	private async readMap<T>(input: JsonValue): Promise<Observation<T>> {
		const params = resolveMapInput(input);
		const sample = sampleMap(this.facts, params);
		const unknown = [...sample.unknown];
		let image: ImageFileRef | null = null;
		if (params.image) {
			if (sample.receivedPixels === 0) {
				unknown.push(`image omitted: no map pixels have arrived for id ${sample.id} on this connection yet`);
			} else if (this.imageDir == null) {
				unknown.push("image omitted: no image export directory is configured for this world");
			} else {
				try {
					image = (await exportMapImage(this.imageDir, sample)).ref;
				} catch (error) {
					unknown.push(`image encoding failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		return {
			value: mapValueOf(sample, image) as T,
			observedAt: sample.observedAt,
			source: "server",
			coverage: unknown.length > 0 ? "partial" : "complete",
			unknown,
			evidence: [],
			cursor: null,
		};
	}

	private placesOrigin(): PlacesOrigin | null {
		const self = this.facts.sample((view) => view.self()).value.value;
		return self == null ? null : { dimension: self.place.dimension, position: self.place.position };
	}

	async readRecord(ref: Ref): Promise<DomainRecord> {
		const row = await this.history.readRecord({
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
			ref,
		});
		if (row == null) throw recordFailure("NOT_FOUND", `record does not exist in the current world partition: ${ref}`);
		// schema 在写入时按合同的 ExactRef 校验过；wire 层放宽为 string，只在此处收窄。
		return row as DomainRecord;
	}

	async writeRecord(change: Parameters<WorldPort["writeRecord"]>[0]): Promise<DomainRecord> {
		// §10.1：分区由 World 拥有——变更的分区必须匹配当前绑定，不静默改写调用方值。
		if (change.world !== this.binding.world || change.worldRevision !== this.binding.worldRevision) {
			throw recordFailure(
				"INVALID_INPUT",
				`record partition (${change.world}, ${change.worldRevision}) does not match the current binding (${this.binding.world}, ${this.binding.worldRevision})`,
				"writeRecord binds to the current world partition; take world/worldRevision from self@1",
			);
		}
		// wire 上 schema 是 ExactRef（调用方按合同传入）；存储层放宽为 string，只在此处收窄。
		return (await this.history.writeRecord({
			...change,
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
		})) as DomainRecord;
	}

	async removeRecord(ref: Ref): Promise<{ removed: boolean }> {
		const removed = await this.history.removeRecord({
			world: this.binding.world,
			worldRevision: this.binding.worldRevision,
			ref,
		});
		return { removed };
	}

	/** Trusted record owners only; these operations never enter the guest API. */
	async retain(owner: Ref, evidence: Ref[]): Promise<void> {
		await this.history.retain(owner, evidence);
	}

	async release(owner: Ref): Promise<void> {
		await this.history.release(owner);
	}

	/** Explicit maintenance: capture partition plus exclusive local store sequence. */
	async pruneHistory(options: WorldHistoryPrune): Promise<WorldHistoryPruneResult> {
		return await this.history.prune(options);
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
