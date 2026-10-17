/**
 * Driver → World 客户端事实入口合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §4.1。
 *
 * 这是游戏执行侧宿主内接缝：sample 同步读取同一本地提交边界的只读纯值，
 * 拒绝 Promise/thenable；view 在返回时失效。结果为不可变纯数据，不能泄漏 Bot/Item/Chunk。
 */

import type { EntityRef, BlockTarget, SelfState, WindowSnapshot } from "./body.js";
import type { WorldQuery } from "./world.js";
import type { ExactRef, Fact, JsonValue, Ref, Vec3 } from "./values.js";

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

export interface BlockStateValue {
	name: string;
	properties: Record<string, string>;
}

export interface ClientBlockValue {
	target: BlockTarget;
	/** null 表示未知；真实空气用 minecraft:air。 */
	state: BlockStateValue | null;
}

export interface ClientSectionValue {
	target: SectionTarget;
	/** 不可复用只读版本，不是活 Chunk。 */
	revision: Ref;
	base: { palette: BlockStateValue[]; indices: (number | null)[] } | null;
	patches: { index: number; state: BlockStateValue | null }[];
}

export interface ClientSectionsValue {
	sections: ClientSectionValue[];
}

export interface ClientEntityValue {
	ref: EntityRef;
	uuid: string | null;
	type: string | null;
	position: Vec3 | null;
	velocity: Vec3 | null;
	metadata: { schema: ExactRef; value: JsonValue } | null;
}

export interface ClientEntitiesValue {
	extent: "tracked";
	entities: ClientEntityValue[];
}

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

/** 同步只读视图：返回时失效，其方法不能逃逸后再读。 */
export interface ClientFactView {
	self(): Fact<SelfState | null>;
	block(target: BlockTarget): Fact<ClientBlockValue>;
	sections(targets: SectionTarget[]): Fact<ClientSectionsValue>;
	entities(): Fact<ClientEntitiesValue>;
	inventory(): Fact<ClientInventoryValue | null>;
	window(): Fact<WindowSnapshot | null>;
}

export interface ClientEvidenceMark {
	stream: Ref;
	sequence: number;
}

export interface ClientFactScope {
	binding: Ref;
	world: Ref;
	worldRevision: Ref;
	/** 维度未知为 null。 */
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
	/** 源证据头；不表示 World 已收到/落盘，也不是纯当前 read 的等待条件。 */
	evidenceThrough: ClientEvidenceMark;
	value: T;
}

export interface ClientEvidenceAck {
	receiver: Ref;
	stream: Ref;
	/**
	 * 确认指定 receiver 代次已持久提交的源前缀：每个序号都有已持久载荷，
	 * 或已被已持久缺口记录覆盖。同域部署的唯一确认层；跨域重传协议留待真正拆域时引入。
	 */
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
	| { kind: "evidence_gap"; ref: Ref; stream: Ref; after: number; through: number | null; reason: string }
	| { kind: "evidence_end"; through: ClientEvidenceMark };

export interface ClientFactsSubscription {
	stamp: ClientFactStamp;
	evidenceThrough: ClientEvidenceMark;
	acknowledge(ack: ClientEvidenceAck): void;
	close(): void;
}

export interface ClientFactsPort {
	sample<T>(read: (view: ClientFactView) => T): ClientFactCapture<T>;
	subscribe(listener: (notice: ClientFactNotice) => void): ClientFactsSubscription;
}

/** 跨域纯当前采样请求：由宿主按既有查询定义生成，只执行纯客户端采样。 */
export interface ClientCaptureRequest {
	request: Ref;
	queries: Record<string, WorldQuery>;
}

export interface ClientCaptureReply {
	request: Ref;
	capture: ClientFactCapture<Record<string, Fact<JsonValue>>>;
}
