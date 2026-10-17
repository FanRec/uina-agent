/**
 * ClientBot：Driver 与 Minecraft 客户端实现（M5 为 Mineflayer 适配）之间的内部接缝。
 *
 * 形状以固定上游源码核实为准（mineflayer 7b4bb8d2）：
 * - 控制键恰为 forward/back/left/right/jump/sprint/sneak（physics.js L28-36）。
 * - 物理循环顺序：模拟条件检查 → simulatePlayer → emit physicsTick → updatePosition → tick_end
 *   （physics.js L84-96）；physicsTick 只在实际模拟后发出，不可模拟路径不发出。
 * - dig(block, forceLook, digFace)：forceLook='ignore' 为 preserve 瞄准路径；
 *   内部 await lookAt 后才写 block_dig（digging.js L121-160）。
 * - activateItem(offHand) 在空手时不派发（inventory.js L120-122），调用方须先核验手持。
 * - attack 存在于 entities.js（bot.attack），由适配层决定是否先行瞄准；Driver 不暗中瞄准。
 *
 * 这是内部接缝，不是公开合同：真实适配层在 M5 由 lead 批准依赖后实现同一形状。
 */

import type { Key } from "../../contracts/body.js";
import type { JsonValue, Ref } from "../../contracts/values.js";

/**
 * 适配层失败的分类：Driver 据此选择合同错误码，不靠猜上游 Error 文本。
 * - unavailable：客户端当前拿不到所需状态（未加载/未跟踪/未连接）。
 * - stale：引用已过期（窗口更换、实体已消失）。
 * - invalid：输入本身不合法（不支持的 selector/参数）。
 * 其它（含上游未分类异常）按派发失败处理。
 */
export type BotFailureKind = "unavailable" | "stale" | "invalid";

export class BotFailure extends Error {
	readonly kind: BotFailureKind;

	constructor(kind: BotFailureKind, message: string) {
		super(message);
		this.name = "BotFailure";
		this.kind = kind;
	}
}

export interface BotVec3 {
	x: number;
	y: number;
	z: number;
}

export interface BotBlockInfo {
	name: string;
	properties: Record<string, string>;
}

export interface BotItemStack {
	name: string;
	count: number;
	components: JsonValue | null;
	/**
	 * 剩余耐久（未损耗的可承受次数）；无耐久概念的物品为 null。
	 * 这是接缝上的唯耐久语义：Driver 的 ItemSelector.minDurability 与
	 * StackExpectation.minDurability 都按它比较，不从 components 里猜编码。
	 */
	remainingDurability: number | null;
}

export interface BotEntity {
	networkId: number;
	uuid: string | null;
	type: string | null;
	position: BotVec3;
	velocity: BotVec3;
}

export interface BotWindowData {
	/** 协议窗口 ID；Driver 用自己的窗口代次包裹它。 */
	id: number;
	type: string;
	slotCount: number;
	slots: (BotItemStack | null)[];
	cursor: BotItemStack | null;
	properties: Record<string, JsonValue>;
}

export interface BotSectionData {
	revision: Ref;
	base: { palette: BotBlockInfo[]; indices: (number | null)[] } | null;
}

export interface BotSelfState {
	position: BotVec3;
	velocity: BotVec3;
	yaw: number;
	pitch: number;
	onGround: boolean;
	health: number;
	food: number;
	dimension: string | null;
}

export interface BotItemSelector {
	name: string;
	components?: JsonValue;
	minDurability?: number;
	substitutions?: string[];
}

export interface BotBlockPos {
	x: number;
	y: number;
	z: number;
}

export interface BotEvents {
	physicsTick: [];
	end: [reason: string];
	kicked: [reason: string];
	error: [error: Error];
	spawn: [];
	death: [];
	health: [];
	entitySpawn: [entity: BotEntity];
	entityGone: [entity: BotEntity];
	/**
	 * 方块变化。source 标明这次变化是服务端入包（"server"）还是客户端本地预测
	 * （"prediction"，如挖掘完成把目标格本地写空气）。Driver 据此决定是否清除
	 * 该格的预测标记：只有服务端入包才算确认。
	 */
	blockUpdate: [pos: BotBlockPos, block: BotBlockInfo | null, source: "server" | "prediction"];
	windowOpen: [window: BotWindowData];
	windowClose: [windowId: number];
	setSlot: [windowId: number, slot: number, item: BotItemStack | null, cursor: BotItemStack | null];
}

export interface ClientBot {
	readonly version: string;

	on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): () => void;

	// ---- 连续控制（physics.js 的 controlState）----
	setControlState(key: Key, on: boolean): void;
	getControlState(key: Key): boolean;
	clearControlStates(): void;
	/** 弧度视角；真实实现为异步平滑/强制视角，适配层用 force 保证即时。 */
	look(yaw: number, pitch: number, force?: boolean): Promise<void>;
	physicsEnabled: boolean;

	// ---- 当前状态采样（同步、纯读）----
	self(): BotSelfState;
	/** null 表示未知/未加载；真实空气由调用方按名称区分。 */
	blockAt(pos: BotBlockPos): BotBlockInfo | null;
	entities(): BotEntity[];
	/** 玩家背包槽位（0..44；45 为副手），与协议槽位编号一致。 */
	inventorySlots(): { slotCount: number; slots: (BotItemStack | null)[]; selectedSlot: number };
	currentWindow(): BotWindowData | null;
	section(section: BotBlockPos): BotSectionData | null;

	// ---- 受控动作 ----
	chat(text: string): void;
	dig(pos: BotBlockPos, options: { forceLook: boolean }): Promise<void>;
	stopDigging(): void;
	/** 单次攻击尝试派发；不做瞄准。 */
	attack(networkId: number): void;
	activateItem(offHand: boolean): void;
	deactivateItem(): void;
	/** 原生使用状态；activateItem 置位、deactivateItem/结束清除。 */
	usingHeldItem(): boolean;
	/**
	 * 上游这两个激活动作先转头再写包（mineflayer inventory.js:200/250），
	 * Promise 完成才表示包已写入；reject 表示根本没派发。必须等它，不能当成同步派发。
	 */
	activateBlock(pos: BotBlockPos, face: BotVec3 | null, cursor: BotVec3 | null): Promise<void>;
	activateEntity(networkId: number): Promise<void>;
	equip(selector: BotItemSelector, hand: "main" | "off"): Promise<void>;
	clickWindow(windowId: number, slot: number, button: number, mode: number): Promise<void>;
	closeWindow(windowId: number): Promise<void>;

	// ---- 生命周期 ----
	quit(): void;
}
