/**
 * Minecraft World 组合：当前读 + 历史接收持久 + 可用性快照。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §5、modules/world.md §4.2、§13.1。
 * 绑定由 World 拥有（组合根注入当前绑定投影，Driver 据此标注捕获 scope）；
 * 历史侧两段启动（§13.1）：句柄立即可用，historyReady 结算 ready/unavailable。
 * I1 不做领域记录（readRecord/writeRecord 显式失败，沿 writeSign 先例）；
 * WorldEvidencePort 随真实记录所有者出现时再接入。
 */

import { callFailure } from "../contracts/values.js";
import type { CallFailure, ExactRef, Observation, ObservationCursor, Ref } from "../contracts/values.js";
import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { DomainRecord, WorldAvailabilityValue, WorldPort, WorldQuery, WorldWatch } from "../contracts/world.js";
import { CurrentReads, type QueryResolver } from "./current.js";
import { HistoryIngest } from "./history-store.js";

export interface MinecraftWorldOptions {
	facts: ClientFactsPort;
	/** 当前查询 resolver 注册表（K1 声明生成；组合根装配）。 */
	resolvers: ReadonlyMap<ExactRef, QueryResolver>;
	/** world-history.db 路径（.uina/world-data/minecraft/ 下，Host 提供数据根）。 */
	dbPath: string;
	/** 当前绑定投影（§4.2；I1 每进程生成显式分区，不猜旧身份）。 */
	binding: { binding: Ref; world: Ref; worldRevision: Ref };
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

export class MinecraftWorld implements WorldPort {
	private readonly facts: ClientFactsPort;
	private readonly current: CurrentReads;
	private readonly history: HistoryIngest;
	private readonly binding: MinecraftWorldOptions["binding"];
	/** 历史侧就绪信号：ready 或明确 unavailable 都结算（§13.1，不进公开查询面）。 */
	readonly historyReady: Promise<"ready" | "unavailable">;

	constructor(options: MinecraftWorldOptions) {
		this.facts = options.facts;
		this.binding = options.binding;
		this.current = new CurrentReads(options.facts, options.resolvers);
		this.history = new HistoryIngest(options.facts, {
			dbPath: options.dbPath,
			receiverNamespace: options.namespace,
		});
		this.historyReady = this.history.historyReady;
	}

	read<T>(query: WorldQuery): Promise<Observation<T>> {
		return this.current.read<T>(query);
	}

	watch(query: WorldQuery, after: ObservationCursor, signal: AbortSignal): Promise<WorldWatch> {
		return this.current.watch(query, after, signal);
	}

	async readRecord(_ref: Ref): Promise<DomainRecord> {
		throw unimplementedRecords("readRecord");
	}

	async writeRecord(_change: Parameters<WorldPort["writeRecord"]>[0]): Promise<DomainRecord> {
		throw unimplementedRecords("writeRecord");
	}

	availability(): WorldAvailabilityValue {
		let currentState: "starting" | "ready" = "starting";
		try {
			this.facts.sample(() => null);
			currentState = "ready";
		} catch {
			currentState = "starting";
		}
		const history = this.history.state;
		return {
			current: { state: currentState },
			history:
				history.state === "unavailable" ? { state: "unavailable", reason: history.reason } : { state: history.state },
			binding: {
				state: "bound",
				binding: this.binding.binding,
				world: this.binding.world,
				worldRevision: this.binding.worldRevision,
			},
		};
	}

	async close(): Promise<void> {
		await this.history.close();
	}
}
