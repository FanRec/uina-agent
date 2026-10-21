/**
 * Driver → World 客户端事实入口。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1。Driver 实现端口；
 * World 订阅/采样；不得向脚本或跨进程发送 read 函数/活 view。
 */

import type { BlockStateValue, BlockTarget, SignValue, WindowSnapshot } from "./body.js";
import type { ExactRef, Fact, JsonValue, Ref, Place, Vec3 } from "./values.js";

export interface ClientFactStamp {
	source: Ref;
	epoch: Ref;
	sequence: number;
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
}

/** extent 仅保证当前 tracked 集合，不证明范围外不存在。 */
export interface ClientEntitiesValue {
	extent: "tracked";
	entities: ClientEntityValue[];
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

export interface ClientItemValue {
	name: string;
	count: number;
	components: JsonValue | null;
}

export type ClientSlotValue = { slot: number } & (
	| { known: true; item: ClientItemValue | null }
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
	players(): Fact<ClientPlayersValue | null>;
	map(id: number): Fact<ClientMapValue | null>;
	inventory(): Fact<ClientInventoryValue | null>;
	window(): Fact<WindowSnapshot | null>;
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
