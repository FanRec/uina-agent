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

import type { JsonValue, Ref } from "../../contracts/values.js";
import type { Key } from "../../contracts/body.js";

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
	blockUpdate: [pos: BotBlockPos, block: BotBlockInfo | null];
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
	activateBlock(pos: BotBlockPos, face: BotVec3 | null, cursor: BotVec3 | null): void;
	activateEntity(networkId: number): void;
	equip(selector: BotItemSelector, hand: "main" | "off"): Promise<void>;
	clickWindow(windowId: number, slot: number, button: number, mode: number): Promise<void>;
	closeWindow(windowId: number): void;
	resyncWindow(windowId: number): Promise<void>;

	// ---- 生命周期 ----
	quit(): void;
}
