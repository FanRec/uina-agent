/**
 * Driver → World 客户端事实入口。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1。Driver 实现端口；
 * World 订阅/采样；不得向脚本或跨进程发送 read 函数/活 view。
 */

import type { BlockStateValue, BlockTarget, EntityRef, ItemValue, SignValue, WindowSnapshot } from "./body.js";

/** 真实打开目标与服务端窗口快照；由 Driver 捕获，沿现有证据队列保存。 */
export interface ClientWindowObservation {
	target: BlockTarget | EntityRef;
	snapshot: WindowSnapshot;
}

import type { ExactRef, Fact, JsonValue, Place, Ref, Vec3 } from "./values.js";

/**
 * 事实类别（Watch 类别化失效）：FactsSource.commit 只推进受影响类别的修订版本；
 * current 查询声明依赖后，游标 = 依赖类别修订之和——无关提交不再唤醒等待方。
 * 无法精确归类的事件源必须保守多报，不得漏报。
 */
export type FactCategory =
	| "self"
	| "inventory"
	| "entities"
	| "blocks"
	| "world"
	| "players"
	| "maps"
	| "window"
	/** Addon 发布的连接级模组事实：共同一个类别，不为每个包生成游标体系。 */
	| "addon";

export type FactRevisions = Record<FactCategory, number>;

/** 游标序号 = 依赖类别修订之和（各类别只增不减，任一依赖变化必然改变和值）。 */
export function queryRevision(revisions: FactRevisions, dependencies: readonly FactCategory[]): number {
	let sum = 0;
	for (const category of dependencies) sum += revisions[category];
	return sum;
}

export function emptyFactRevisions(): FactRevisions {
	return {
		self: 0,
		inventory: 0,
		entities: 0,
		blocks: 0,
		world: 0,
		players: 0,
		maps: 0,
		window: 0,
		addon: 0,
	};
}

export interface ClientFactStamp {
	source: Ref;
	epoch: Ref;
	sequence: number;
	/** 各类别修订版本；与 sequence 出自同一同步采样边界（stamp 拷贝共享只读）。 */
	revisions: FactRevisions;
	connection: Ref | null;
	incarnation: Ref | null;
}

export interface SectionTarget {
	world: Ref;
	worldRevision: Ref;
	dimension: Ref;
	section: Vec3;
}

export interface ClientBlockValue {
	target: BlockTarget;
	/** null=未知；真实空气用 minecraft:air。 */
	state: BlockStateValue | null;
	/** null=非告示牌或数据未收到（后者须列 unknown）。 */
	sign: SignValue | null;
}

export interface ClientSectionValue {
	target: SectionTarget;
	revision: Ref;
	base: { palette: BlockStateValue[]; indices: (number | null)[] } | null;
	patches: { index: number; state: BlockStateValue | null }[];
}

export interface ClientSectionsValue {
	sections: ClientSectionValue[];
}

export interface ClientEntityValue {
	ref: import("./body.js").EntityRef;
	uuid: string | null;
	type: string | null;
	position: Vec3 | null;
	velocity: Vec3 | null;
	metadata: { schema: ExactRef; value: JsonValue } | null;
	/** 掉落物栈（只有 item 实体有）；未收到元数据或解析失败为 null，不猜。 */
	item: { name: string; count: number } | null;
	/**
	 * 苦力怕引燃状态（metadata[16]，creeper-probe 真服实证 fuse 信号）；
	 * 非苦力怕、元数据未到或读不出为 null，不猜。
	 */
	ignited: boolean | null;
}

/** extent 仅保证当前 tracked 集合，不证明范围外不存在。 */
export interface ClientEntitiesValue {
	extent: "tracked";
	entities: ClientEntityValue[];
	/** 本客户端玩家自己的实体引用；查询侧据此排除自己。 */
	selfRef: import("./body.js").EntityRef | null;
}

/**
 * 当前环境读数（world@1 的基础载荷）：时间、天气、维度、生物群系与规则。
 * 未收到/版本无该项一律 null + unknown，不用默认值补齐。
 */
export interface ClientWorldValue {
	dimension: string;
	/** 时间与天气读不到时为 null（unknown 说明原因），不填默认值。 */
	timeOfDay: "day" | "noon" | "night" | "midnight" | "dawn" | "dusk" | null;
	ticks: number | null;
	dayCount: number | null;
	weather: "clear" | "rain" | "thunder" | null;
	biome: string | null;
	difficulty: string | null;
	gameMode: string | null;
	spawn: Place | null;
}

/**
 * 按名字搜方块的读取请求：radius 为水平半径（格），exclude 为调用方已处理位置。
 * Driver 只按 section palette 跳过不含该名字的段，不做排序策略之外的选择。
 */
export interface ClientBlockSearchRequest {
	name: string;
	radius: number;
	/** 返回候选上限（硬帽 4096）；超过即 capped=true。 */
	limit: number;
	exclude: Vec3[];
}

export interface ClientBlockSearchValue {
	/** 按与采样点的距离升序（同距离按坐标稳定排序）；不含 exclude 命中。 */
	matches: { position: Vec3; name: string }[];
	scanned: { radius: number; chunksLoaded: number };
	/** 命中数触到上限，matches 只是最近的一批。 */
	capped: boolean;
}

export interface ClientListedPlayer {
	name: string;
	uuid: string | null;
	displayName: string | null;
	latencyMs: number | null;
	gameMode: string | null;
	entity: import("./body.js").EntityRef | null;
}

/** 只说明服务器实际公告的名单；未列出不证明离线。 */
export interface ClientPlayersValue {
	extent: "server_listed";
	players: ClientListedPlayer[];
}

export interface MapIconValue {
	type: string;
	pixel: { x: number; z: number };
	direction: number | null;
	label: string | null;
}

/** 只读当前连接收到的地图包；缺失增量不补透明色，重连清空当前覆盖。 */
export interface ClientMapValue {
	id: number;
	scale: number | null;
	locked: boolean | null;
	/** 恰好 128*128，按 z 行、x 列；null=未收到。 */
	colors: (number | null)[];
	icons: MapIconValue[] | null;
	center: { x: number; z: number } | null;
	dimension: string | null;
}

export interface EventActor {
	name: string | null;
	uuid: string | null;
	entity: import("./body.js").EntityRef | null;
}

export type ClientEventPayload =
	| {
			kind: "chat";
			channel: "public" | "private" | "system" | "action_bar" | "unknown";
			text: string;
			sender: EventActor | null;
			recipient: string | null;
			self: boolean | null;
	  }
	| {
			kind: "damage";
			amount: number | null;
			healthAfter: number | null;
			cause: string | null;
			attacker: EventActor | null;
	  }
	| { kind: "death"; message: string | null; place: Place | null }
	| {
			kind: "connection";
			state: "connected" | "disconnected";
			reason: string | null;
	  };

export type ClientSlotValue = { slot: number } & (
	| { known: true; item: ItemValue | null }
	| { known: false; item: null }
);

export interface ClientInventoryValue {
	revision: number;
	layout: { slotCount: number; regions: { name: string; slots: number[] }[] };
	slots: ClientSlotValue[];
	selectedSlot: number | null;
}

export interface ClientEvidenceMark {
	stream: Ref;
	sequence: number;
}

export interface ClientFactScope {
	binding: Ref;
	world: Ref;
	worldRevision: Ref;
	dimension: Ref | null;
}

export interface CapturedClientFact {
	ref: Ref;
	schema: ExactRef;
	mark: ClientEvidenceMark;
	stamp: ClientFactStamp;
	scope: ClientFactScope;
	fact: Fact<JsonValue>;
}

export interface ClientFactCapture<T> {
	stamp: ClientFactStamp;
	scope: ClientFactScope;
	evidenceThrough: ClientEvidenceMark;
	value: T;
}

export interface ClientEvidenceAck {
	receiver: Ref;
	stream: Ref;
	/** 每个序号都有已持久载荷或已持久缺口覆盖。 */
	durableThrough: number;
}

export type ClientFactNotice =
	| { kind: "changed"; stamp: ClientFactStamp; changed: Ref[] }
	| {
			kind: "reset";
			stamp: ClientFactStamp;
			reason: "connection_changed" | "incarnation_changed" | "source_rebuilt" | "gap";
	  }
	| { kind: "evidence"; records: CapturedClientFact[] }
	| {
			kind: "evidence_gap";
			ref: Ref;
			stream: Ref;
			after: number;
			through: number | null;
			reason: string;
	  }
	| { kind: "evidence_end"; through: ClientEvidenceMark };

export interface ClientFactsSubscription {
	stamp: ClientFactStamp;
	evidenceThrough: ClientEvidenceMark;
	acknowledge(ack: ClientEvidenceAck): void;
	close(): void;
}

/**
 * 同步读取同一本地提交边界的只读纯值；拒绝 Promise/thenable；
 * view 在返回时失效。null 表示不可用并带 unknown，不解释为空背包/箱子。
 */
export interface ClientFactView {
	/** 当前提交边界的绑定 scope；查询参数（Place/SectionTarget）组装用，随视图失效。 */
	scope(): ClientFactScope;
	self(): Fact<import("./body.js").SelfState | null>;
	block(target: BlockTarget): Fact<ClientBlockValue>;
	sections(targets: SectionTarget[]): Fact<ClientSectionsValue>;
	entities(): Fact<ClientEntitiesValue>;
	world(): Fact<ClientWorldValue>;
	searchBlocks(request: ClientBlockSearchRequest): Fact<ClientBlockSearchValue>;
	players(): Fact<ClientPlayersValue | null>;
	map(id: number): Fact<ClientMapValue | null>;
	inventory(): Fact<ClientInventoryValue | null>;
	/**
	 * 槽位级增量（G7）：自 since 以来内容可能变化的槽位及其当前内容（item null = 已空）。
	 * 差量按"自 since 起被写过"合并，不重放中间态；标记不可用（未同步/长度不齐）回 null，不猜。
	 */
	inventoryChanges(since: number): { slot: number; item: import("./body.js").ItemValue | null }[] | null;
	window(): Fact<WindowSnapshot | null>;
	/**
	 * Addon 发布的连接级事实（`<addonId>` + `key`）；未发布时 null（调用方如实报 unknown，
	 * 不编造默认状态）。值只读纯 JSON，随断线清空。
	 */
	addonFact(addonId: string, key: string): Fact<JsonValue> | null;
}

/**
 * 订阅选项。证据释放水线只在**消费证据**的接收方之间取最小值：
 * 只读观察者（如当前读的 watch）不落盘证据，若一并计入则永不确认，
 * 有界缓冲会被无谓耗尽并按溢出报假缺口。
 */
export interface ClientFactsSubscribeOptions {
	/** 该接收方承诺把证据持久化后才 acknowledge（World 历史存储）。缺省 false。 */
	consumesEvidence?: boolean;
}

export interface ClientFactsPort {
	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T>;
	subscribe(
		listener: (notice: ClientFactNotice) => void,
		options?: ClientFactsSubscribeOptions,
	): ClientFactsSubscription;
}
