/**
 * 身体/Driver 公共合同：资格、操作、窗口与反馈。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4。Driver 实现 PlayerPort；
 * Runtime 是 acquire 的唯一调用方；能力/程序经 withBody 拿 BodyCallScope。
 */

import type { EffectReceipt, Fact, JsonValue, Place, Ref, Vec3 } from "./values.js";
import type { WorldQuery } from "./world.js";

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

/**
 * 真服探针（Paper 1.21.11）证实：强制 stateId 的 click 每次都会收到权威 full 回包。
 * 因此回执必须区分"服务端确认 / 明确拒绝 / 状态分歧 / 无因果关联"，而不是把后两类
 * 一律压成模糊 unknown。已有字段语义不变，新增字段是可选的有界诊断。
 */
export type WindowClickOutcome = "confirmed" | "rejected" | "diverged" | "unknown";

export interface WindowClickReceipt extends EffectReceipt {
	/** Authoritative response snapshot; only the clicked slot/cursor transition is attributed to this click. */
	confirmed?: WindowSnapshot;
	needsSnapshot: boolean;
	/** 内部判定分类；未提供的旧构造方按 unknown 处理。 */
	outcome?: WindowClickOutcome;
	/** 可诊断证据：不含整张窗口，只读与本次 click 因果相关的有界事实。 */
	diagnostics?: {
		stateBefore: number | null;
		stateAfter: number | null;
		slot: number;
		button: number;
		elapsedMs: number;
		cursorChanged: boolean;
		slotChanged: boolean;
		/** 待恢复条件，供上层决定是重开窗口还是交还主脑。 */
		recovery: string;
	};
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
 * 身体事件证据窗口的观察对象（批 18）：睡眠、上下载具、拴绳链接、鱼漂与咬钩。
 * 来源都是服务端已解码事实：pose 元数据（sleep/wake）、set_passengers/attach_entity
 * （mount/dismount/link）、spawn_entity 鱼漂与 world_particles 咬钩判据（bobber/bite）。
 */
export type BodyEventKind = "sleep" | "wake" | "mount" | "dismount" | "bobber" | "bite" | "link";

export interface BodyEventOptions {
	evidenceMs?: number;
	/** kind="link" 时：只认该 passenger 的链接（拴绳证据归属目标实体）。 */
	passengerId?: number;
	/** kind="link" 时：true=等待解除链接（vehicleId<=0）；false/缺省=等待建立链接。 */
	detached?: boolean;
}

export interface BodyEventOutcome {
	/** true=窗口内观察到；false=窗口自然走完没有观察；null=中止/断线（没看完）。 */
	observed: boolean | null;
	/** link/mount 命中时的对端 id（拴绳持有者或载具；解除=0/-1）。 */
	vehicleId?: number | null;
}

/**
 * 载具输入权威（批 18，真服探针实测）：1.21.2+ 载具移动全面客户端权威——船与马/猪/驼
 * 都由客户端运动学维护位置、以 vehicle_move 上报（player_input 的 forward 对马无效，
 * 只承担下马 shift 等服务端判定键）；矿车是轨道驱动，不在其列。
 * **骑乘态位移有服务端回声**（探针 X4 实证）：服务端把接受的载具位姿以
 * rel_entity_move（马）/sync_entity_position（船）回传，mineflayer 应用后客户端视图
 * （self 除外——骑手自身位置仍冻结）与服务器真值吻合到 1e-7 量级；
 * 因此到达判定读载具实体位置是可信的，drive 返回的申报终点（vehicleAt）只作审计对照。
 */
export function isClientAuthVehicle(name: string | undefined): boolean {
	return name != null && !name.includes("minecart");
}

/**
 * 载具运动学速率（格/拍，批 18 真服探针实测被服务端接受的申报值）：
 * 唯一真源——driver 的 vehicle_move 递推与 capability 的驾驶拍预算都从这里取。
 * 船 0.22/拍；其余客户端权威载具（马/猪/驼等）0.15/拍。
 */
export const VEHICLE_KINEMATICS = {
	boat: { forward: 0.22, reverse: 0.12 },
	default: { forward: 0.15, reverse: 0.1 },
} as const;

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
		/** 载具驾驶的开环申报终点，审计对照用：骑乘态 self 视图冻结，但载具本体有
		 *  服务端回声（rel_entity_move/sync_entity_position），到达判定读载具实体位置。 */
		vehicleAt?: Vec3;
	}>;
	dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt>;
	attack(target: EntityRef, options?: { evidenceMs?: number }): Promise<AttackOutcome>;
	/** 证据窗口：不派发动作，等待该实体在窗口内的受击/死亡观察（批 12）。 */
	awaitEvidence(target: EntityRef, options?: { evidenceMs?: number }): Promise<EvidenceOutcome>;
	/**
	 * 本资格会话内观察到的死亡实体（批 29）：networkId 集合，由 Driver 的
	 * entityDead 事件持续累积，读它不派发也不等待。战斗会话用它把"击杀归属"
	 * 从阻塞式证据窗里解出来——循环保持移动，死亡在扫描缺席时按此集合结算。
	 */
	deadEntities(): ReadonlySet<number>;
	/**
	 * 证据窗口（批 18）：不派发动作，等待身体相关事件在窗口内出现。
	 * mount/dismount 的证据是 set_passengers/attach_entity 原始包——mineflayer 对
	 * "空 passengers 下马"不发事件，事件层不可靠，这里统一走协议事实。
	 */
	awaitBodyEvent(kind: BodyEventKind, options?: BodyEventOptions): Promise<BodyEventOutcome>;
	/**
	 * 目标当前是否被本玩家拴住（批 18）：attach_entity 的本连接事实缓存。
	 * 协议没有"查询拴绳状态"的包，重连后已拴状态不可见（此时对已拴目标
	 * interact 会解除——真实客户端也这样，只是它能看见绳子）。
	 */
	leashedBySelf(target: EntityRef): Promise<boolean>;
	/** 一次激活；持续使用由 drive/feedback 的 hold 表达。 */
	useItem(hand: Hand): Promise<EffectReceipt>;
	/** 结束所属的原生使用状态，可能释放蓄力效果；对已结束状态幂等。 */
	endUse(): Promise<EffectReceipt>;
	/** 结束睡眠（entity_action stop_sleeping）；是否真的醒来由调用方观察 wake 证据。 */
	endSleep(): Promise<EffectReceipt>;
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
