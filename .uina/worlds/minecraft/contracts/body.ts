/**
 * 身体/Driver 公共合同：资格、操作、窗口与反馈。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4。Driver 实现 PlayerPort；
 * Runtime 是 acquire 的唯一调用方；能力/程序经 withBody 拿 BodyCallScope。
 */

import type { WorldQuery } from "./world.js";
import type { EffectReceipt, Fact, JsonValue, Place, Ref, Vec3 } from "./values.js";

export type Hand = "main" | "off";

export type Key = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";

export interface EntityRef {
	connection: Ref;
	incarnation: Ref;
	appearance: Ref;
	networkId: number;
}

export type PointTarget = Vec3 | { position: Vec3; dimension: string };

/** 坐标须为整数；没有隐式 floor。 */
export type BlockPos = Vec3 | { position: Vec3; dimension: string };

export interface BlockStateValue {
	name: string;
	properties: Record<string, string>;
}

/** 字符串约束名字；仅显式属性加入目标。 */
export type BlockSpec = string | { name: string; properties?: Record<string, string> };

/** Driver 的完整方块身份；block 各分量须为整数。 */
export interface BlockTarget {
	place: Place;
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
	/** 弧度；与 lookAt 互斥。 */
	look?: { yaw: number; pitch: number };
	lookAt?: PointTarget | EntityRef;
	use?: { mode: "hold" | "once"; hand: Hand };
	attack?: EntityRef;
}

export interface StatusEffectValue {
	name: string;
	amplifier: number;
	seconds: number | null;
}

/** self 查询与反馈共用的身体事实基础。缺失字段为 null 并进 Fact.unknown。 */
export interface SelfState {
	place: Place;
	velocity: Vec3;
	health: number;
	food: number;
	onGround: boolean;
	maxHealth: number | null;
	saturation: number | null;
	oxygen: number | null;
	inWater: boolean | null;
	inLava: boolean | null;
	effects: StatusEffectValue[] | null;
	xpLevel: number | null;
}

export type SignText = [string, string, string, string];

export interface SignFaceValue {
	lines: SignText;
	color: string | null;
	glowing: boolean | null;
}

export interface SignValue {
	front: SignFaceValue | null;
	back: SignFaceValue | null;
	waxed: boolean | null;
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

export interface WindowClickReceipt extends EffectReceipt {
	confirmed?: {
		slots: { slot: number; item: JsonValue | null }[];
		cursor?: JsonValue | null;
	};
	needsSnapshot: boolean;
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
	}): Promise<WindowClickReceipt>;
	close(): Promise<void>;
}

/**
 * 身体操作集。全部要求当前有效资格；资格失效返回 CONTROL_INVALID/REFERENCE_STALE。
 * dig 默认瞄准（aim=target）；preserve 不自动瞄准，供同一协调者组合使用。
 */
export interface BodyOps {
	drive(
		input: ControlInput,
		ticks: number,
	): Promise<{
		receipt: EffectReceipt;
		actualTicks: number;
		end: Fact<SelfState>;
	}>;
	dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt>;
	attack(target: EntityRef): Promise<EffectReceipt>;
	/** 一次激活；持续使用由 drive/feedback 的 hold 表达。 */
	useItem(hand: Hand): Promise<EffectReceipt>;
	/** 结束所属的原生使用状态，可能释放蓄力效果；对已结束状态幂等。 */
	endUse(): Promise<EffectReceipt>;
	interact(input: { target: BlockTarget | EntityRef; hand: Hand; face?: Vec3; cursor?: Vec3 }): Promise<EffectReceipt>;
	/** null=腾空该手，不得隐式丢弃。 */
	equip(item: ItemSelector | null, hand: Hand): Promise<EffectReceipt>;
	lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt>;
	writeSign(target: BlockTarget, input: { side: "front" | "back"; lines: SignText }): Promise<EffectReceipt>;
	openContainer(target: BlockTarget | EntityRef): Promise<WindowSession>;
	feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream>;
}

export interface BodySession extends BodyOps {
	close(): Promise<void>;
}

/** 身体写入的权威来源。safety 由运行管理持有，不是虚构 act Call。 */
export type ControlOwner =
	| { kind: "run"; run: Ref; segment: Ref; callId: Ref }
	| { kind: "safety"; intervention: Ref; interruptedRun?: Ref };

/**
 * 玩家端口。Runtime 是 acquire 的唯一调用方；chat 不占 Body，
 * 仍核验 act/Owner/连接。BodyOps 的行为合同见 public-api §4 与 driver.md。
 */
export interface PlayerPort {
	acquire(owner: ControlOwner, signal: AbortSignal): Promise<BodySession>;
	chat(text: string, signal: AbortSignal): Promise<EffectReceipt>;
}
