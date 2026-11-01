/**
 * 身体/Driver 公共合同：资格、操作、窗口与反馈。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4。Driver 实现 PlayerPort；
 * Runtime 是 acquire 的唯一调用方；能力/程序经 withBody 拿 BodyCallScope。
 */

import type { WorldQuery } from "./world.js";
import type { EffectReceipt, Fact, JsonValue, Place, Ref, Vec3 } from "./values.js";

export type Hand = "main" | "off";

/** 可装备位：双手 + 四个护甲槽（capabilities §4 equip）。 */
export type EquipSlot = "hand" | "offhand" | "head" | "chest" | "legs" | "feet";

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
	/** 游戏生命值单位；未收到血量包时为 null，不得填 0。 */
	health: number | null;
	/** 0..20；未收到饥饿包时为 null，不得填 0。 */
	food: number | null;
	onGround: boolean;
	maxHealth: number | null;
	saturation: number | null;
	oxygen: number | null;
	inWater: boolean | null;
	inLava: boolean | null;
	effects: StatusEffectValue[] | null;
	xpLevel: number | null;
	/** 视角（弧度）；未收到视角包时为 null。 */
	look: { yaw: number; pitch: number } | null;
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

/** Composition injects pure, validated current-query readers, never World storage. */
export type PrepareFeedback = (sensors: Record<string, WorldQuery>) => () => {
	self: Fact<SelfState>;
	sensors: Record<string, Fact<JsonValue>>;
};

export interface WindowSnapshot {
	/** 本次打开身份，不是网络 windowId。 */
	window: Ref;
	type: string;
	/**
	 * 内容修订号：只在槽位与光标变化时推进，是点击的 CAS 前置条件。
	 * properties（炉子燃烧/进度）变化不推进它——否则燃烧期间每次点击都会撞 CONFLICT。
	 */
	revision: number;
	layout: { slotCount: number; regions: { name: string; slots: number[] }[] };
	properties: Record<string, JsonValue>;
	slots: { slot: number; item: JsonValue | null }[];
	cursor: JsonValue | null;
}

/** 窗口物品的纯值载荷；缺失组件/耐久不伪装为空或满值。 */
export interface ItemValue {
	name: string;
	count: number;
	stackSize: number | null;
	components: JsonValue | null;
	durability: number | null;
}

export interface TossOutcome {
	receipt: EffectReceipt;
	removed: Record<string, number>;
	remaining: number;
}

export interface StackExpectation {
	item: ItemSelector | null;
	count: number;
}

export interface WindowClickReceipt extends EffectReceipt {
	/** Authoritative response snapshot; only the clicked slot/cursor transition is attributed to this click. */
	confirmed?: WindowSnapshot;
	needsSnapshot: boolean;
}

/**
 * 商人报价：服务端 `trade_list` 的真实载荷。index 是 0 基报价序号
 * （对应 selectTrade 的参数），付款项按协议实际给 1 或 2 项，不补齐。
 */
export interface MerchantOfferValue {
	index: number;
	cost: { item: string; count: number }[];
	output: { item: string; count: number };
	/** 该报价当前不可交易（等级不足/已下架）。 */
	disabled: boolean;
	uses: number;
	maxUses: number;
	xp: number;
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
	/**
	 * 工作站专用提交（批 15）：只承诺"包已进入当前连接"，生效与否由能力层按证据判定。
	 * 三者都不改 revision、不做槽位预测；非对应窗口类型在派发前报 WRONG_STATE。
	 */
	selectEnchant(offer: 1 | 2 | 3): Promise<EffectReceipt>;
	/** 铁砧改名；协议包不带 windowId，只能作用于当前打开的铁砧窗口。 */
	renameItem(name: string): Promise<EffectReceipt>;
	/** 商人第 index 个报价（0 基）。 */
	selectTrade(index: number): Promise<EffectReceipt>;
	/** 商人报价；未收到 trade_list 时为 null，不冒充空报价。 */
	offers(): Promise<Fact<MerchantOfferValue[] | null>>;
	/** 普通关闭要求光标为空；失败/取消清理须显式 force，保留未知归还/丢弃后果。 */
	close(options?: { force?: boolean }): Promise<void>;
}

/**
 * 一次攻击的派发事实与命中证据。hit=null 表示证据窗口内没有可归属的受击观察，
 * 不等于没打中（driver §7.4：低层只承诺派发，更强效果必须有证据来源）。
 * dead 只由 entityDead 观察置 true（批 12：fight 的击杀记账只认死亡观察，
 * 不把"受击后消失"冒认成击杀）。
 */
export interface AttackOutcome {
	receipt: EffectReceipt;
	hit: boolean | null;
	dead: boolean | null;
}

/** 证据窗口观察（不派发任何动作）：同一受击/死亡事件通道，供远程命中与击杀确认。 */
export interface EvidenceOutcome {
	hit: boolean | null;
	dead: boolean | null;
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
	attack(target: EntityRef, options?: { evidenceMs?: number }): Promise<AttackOutcome>;
	/** 证据窗口：不派发动作，等待该实体在窗口内的受击/死亡观察（批 12）。 */
	awaitEvidence(target: EntityRef, options?: { evidenceMs?: number }): Promise<EvidenceOutcome>;
	/** 一次激活；持续使用由 drive/feedback 的 hold 表达。 */
	useItem(hand: Hand): Promise<EffectReceipt>;
	/** 结束所属的原生使用状态，可能释放蓄力效果；对已结束状态幂等。 */
	endUse(): Promise<EffectReceipt>;
	interact(input: { target: BlockTarget | EntityRef; hand: Hand; face?: Vec3; cursor?: Vec3 }): Promise<EffectReceipt>;
	/** null=腾空该手（只允许 hand/offhand），不得隐式丢弃。 */
	equip(item: ItemSelector | null, slot: EquipSlot): Promise<EffectReceipt>;
	/**
	 * 丢出指定数量的同名物品（窗口外转移，destination -999）。
	 * 只作用于主背包+快捷栏（9..44）；不保证落地位置、不被他人拾取或目标收到。
	 */
	toss(item: ItemSelector, count: number): Promise<TossOutcome>;
	lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt>;
	writeSign(target: BlockTarget, input: { side: "front" | "back"; lines: SignText }): Promise<EffectReceipt>;
	openContainer(target: BlockTarget | EntityRef): Promise<WindowSession>;
	/**
	 * 玩家自带窗口（window 0，含 2×2 合成格与结果槽）的作用域：期间独占身体，退出时强制关闭。
	 * 与 openContainer 打开的窗口互斥；回调式是因为生命周期与身体资格是同一条作用域，
	 * 交出裸会话会让调用方漏关而卡住身体。
	 */
	withInventory<T>(work: (window: WindowSession) => Promise<T>): Promise<T>;
	feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream>;
}

export interface BodySession extends BodyOps {
	/** Trusted Runtime scope; all resumed writes recheck this qualification. */
	runScoped<T>(scope: { signal: AbortSignal; owner: ControlOwner; guard(): void }, work: () => Promise<T>): Promise<T>;
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
