/**
 * Body / Driver 公开操作合同（lead 固定合同）。
 * 唯一设计来源：docs/proposals/mc/public-api.md §4。
 */

import type { EffectReceipt, Fact, JsonValue, Place, Ref, Vec3 } from "./values.js";
import type { WorldQuery } from "./world.js";

export type Hand = "main" | "off";
export type Key = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";

export interface EntityRef {
	connection: Ref;
	incarnation: Ref;
	appearance: Ref;
	networkId: number;
}

export interface BlockTarget {
	place: Place;
	/** 各分量须为整数。 */
	block: Vec3;
}

export interface ItemSelector {
	name: string;
	components?: JsonValue;
	minDurability?: number;
	substitutions?: string[];
}

export interface ControlInput {
	keys: Partial<Record<Key, boolean>>;
	/** 弧度。 */
	look?: { yaw: number; pitch: number };
	use?: { mode: "hold" | "once"; hand: Hand };
	attack?: EntityRef;
}

export interface SelfState {
	place: Place;
	velocity: Vec3;
	health: number;
	food: number;
	onGround: boolean;
}

export interface ClientPhysicsStep {
	connection: Ref;
	incarnation: Ref;
	sequence: number;
}

export interface FeedbackFrameRef {
	stream: Ref;
	sequence: number;
}

export interface FeedbackFrame extends FeedbackFrameRef {
	body: Ref;
	/** 持续控制 Operation；Controller 不另建一层代次。 */
	operation: Ref;
	/** 本帧采样的已完成客户端物理步。 */
	step: ClientPhysicsStep;
	/** 驱动单调时钟毫秒。 */
	sampledAt: number;
	validUntil: number;
	connection: Ref;
	incarnation: Ref;
	self: Fact<SelfState>;
	sensors: Record<string, Fact<JsonValue>>;
}

export interface FeedbackStream {
	next(after: number | null, signal: AbortSignal): Promise<FeedbackFrame>;
	apply(
		frame: FeedbackFrameRef,
		input: ControlInput,
	): Promise<{ receipt: EffectReceipt; appliedStep: ClientPhysicsStep }>;
	close(): Promise<void>;
}

export interface WindowSnapshot {
	/** 本次打开身份，不是网络 windowId。 */
	window: Ref;
	type: string;
	revision: number;
	layout: { slotCount: number; regions: { name: string; slots: number[] }[] };
	properties: Record<string, JsonValue>;
	slots: { slot: number; item: JsonValue | null }[];
	cursor: JsonValue | null;
}

export interface StackExpectation {
	item: ItemSelector | null;
	count: number;
}

export interface WindowSession {
	snapshot(): Promise<Fact<WindowSnapshot>>;
	click(input: {
		slot: number;
		button: number;
		mode: number;
		expectedRevision: number;
		expectedSlots: { slot: number; stack: StackExpectation }[];
		expectedCursor: StackExpectation;
	}): Promise<EffectReceipt>;
	close(): Promise<void>;
}

export interface BodyOps {
	drive(
		input: ControlInput,
		ticks: number,
	): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }>;
	dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt>;
	attack(target: EntityRef): Promise<EffectReceipt>;
	/** 一次激活，持续使用由 drive/feedback 的 hold 表达。 */
	useItem(hand: Hand): Promise<EffectReceipt>;
	/** 结束所属的原生使用状态，可能释放蓄力效果。 */
	endUse(): Promise<EffectReceipt>;
	interact(input: { target: BlockTarget | EntityRef; hand: Hand; face?: Vec3; cursor?: Vec3 }): Promise<EffectReceipt>;
	equip(item: ItemSelector, hand: Hand): Promise<EffectReceipt>;
	openContainer(target: BlockTarget | EntityRef): Promise<WindowSession>;
	feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream>;
}

export interface BodySession extends BodyOps {
	close(): Promise<void>;
}

export type ControlOwner =
	| { kind: "run"; run: Ref; segment: Ref; callId: Ref }
	| { kind: "safety"; intervention: Ref; interruptedRun?: Ref };

export interface PlayerPort {
	acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession>;
}
