/**
 * MineflayerClientBot：把真实 mineflayer（4.39.0）适配成 Driver 的 ClientBot 接缝。
 *
 * 形状依据固定上游源码核实（node_modules/mineflayer 4.39.0）：
 * - physicsTick 只在实际模拟后发出（lib/plugins/physics.js）。
 * - dig(block, forceLook?, digFace?) 的 forceLook='ignore' 即 preserve 路径（lib/plugins/digging.js）。
 * - attack/activateEntity 接收 Entity 对象，不是网络 ID（lib/plugins/entities.js、inventory.js）。
 * - activateItem 空手静默 no-op，usingHeldItem 由上游维护（lib/plugins/inventory.js）。
 * - clickWindow(slot, button, mode) 没有 windowId：只能作用于 bot.currentWindow。
 * - 窗口槽位变化经 Window 的 updateSlot(slot, oldItem, newItem) 暴露；bot 的 setSlot:<id>
 *   是分窗口事件，这里统一走 Window.updateSlot，避免动态事件名。
 * - blockAt 需要 Vec3（内部调用 pos.floored()），不能传普通对象。
 *
 * 这里只做结构适配与协议对象→纯值转换，不实现游戏策略，也不替 Driver 决定资格。
 * 上游失败（未加载、窗口不匹配、物品不存在）原样抛出，由 Driver 决定结算。
 */

import vec3Module, { type Vec3 } from "vec3";
import type { Key } from "../../contracts/body.js";
import type { JsonValue } from "../../contracts/values.js";
import type {
	BotBlockInfo,
	BotBlockPos,
	BotEntity,
	BotEvents,
	BotItemSelector,
	BotItemStack,
	BotSectionData,
	BotSelfState,
	BotVec3,
	BotWindowData,
	ClientBot,
} from "../internal/bot-shape.js";

// ---- 我们依赖的 mineflayer 最小表面（只列实际使用的成员）----

export interface MineflayerVec3 {
	x: number;
	y: number;
	z: number;
}

export interface MineflayerBlock {
	readonly name: string;
	readonly position: MineflayerVec3;
	getProperties(): Record<string, unknown>;
}

export interface MineflayerItem {
	readonly name: string;
	readonly count: number;
	readonly components?: unknown[] | null;
	readonly maxDurability?: number;
	readonly durabilityUsed?: number;
}

export interface MineflayerEntity {
	readonly id: number;
	readonly uuid?: string;
	readonly type?: string;
	readonly position: MineflayerVec3;
	readonly velocity: MineflayerVec3;
	readonly yaw?: number;
	readonly pitch?: number;
	readonly onGround?: boolean;
}

type SlotListener = (slot: number, oldItem: MineflayerItem | null, newItem: MineflayerItem | null) => void;

export interface MineflayerWindow {
	readonly id: number;
	readonly type: string;
	readonly slots: (MineflayerItem | null)[];
	readonly selectedItem: MineflayerItem | null;
	on(event: "updateSlot", listener: SlotListener): unknown;
	off(event: "updateSlot", listener: SlotListener): unknown;
	items(): MineflayerItem[];
}

export interface MineflayerSection {
	readonly data: { get(index: number): number };
}

export interface MineflayerColumn {
	readonly minY: number;
	readonly sections: (MineflayerSection | undefined)[];
}

/**
 * 事件监听用 never[] 接收：上游事件签名各异，适配层在 switch 里按事件名收窄，
 * 不用 any 也不要求上游类型与 BotEvents 对齐。
 */
type RawListener = (...args: never[]) => void;

export interface MineflayerBot {
	readonly version: string;
	on(event: string, listener: RawListener): unknown;
	off(event: string, listener: RawListener): unknown;

	setControlState(key: string, on: boolean): void;
	getControlState(key: string): boolean;
	clearControlStates(): void;
	look(yaw: number, pitch: number, force?: boolean): Promise<void>;
	physicsEnabled: boolean;

	readonly entity?: MineflayerEntity;
	readonly entities: Record<string, MineflayerEntity>;
	readonly game?: { dimension?: string };
	readonly health: number;
	readonly food: number;
	readonly quickBarSlot: number | null;
	readonly inventory: MineflayerWindow;
	readonly currentWindow: MineflayerWindow | null;
	readonly world: { getColumn(chunkX: number, chunkZ: number): MineflayerColumn | null };

	blockAt(point: MineflayerVec3, extraInfos?: boolean): MineflayerBlock | null;
	chat(text: string): void;
	dig(block: MineflayerBlock, forceLook?: boolean | "ignore"): Promise<void>;
	stopDigging(): void;
	attack(entity: MineflayerEntity): void;
	activateItem(offHand?: boolean): void;
	deactivateItem(): void;
	readonly usingHeldItem: boolean;
	activateBlock(block: MineflayerBlock, direction?: MineflayerVec3, cursorPos?: MineflayerVec3): Promise<void>;
	activateEntity(entity: MineflayerEntity): Promise<void>;
	equip(item: MineflayerItem, destination: "hand" | "off-hand"): Promise<void>;
	clickWindow(slot: number, mouseButton: number, mode: number): Promise<void>;
	closeWindow(window: MineflayerWindow): Promise<void>;
	quit(reason?: string): void;
}

const INVENTORY_HOTBAR_START = 36;
const SECTION_VOLUME = 4096;

/**
 * vec3 的 .d.ts 只声明可调用形式，而 CJS 导出在 module.exports 上同时挂了 Vec3 构造器；
 * 这里按运行时事实取构造器，避免为了一个坐标类型再造一份实现。
 */
const Vec3Ctor = (vec3Module as unknown as { Vec3: new (x: number, y: number, z: number) => Vec3 }).Vec3;
const v3 = (p: { x: number; y: number; z: number }): Vec3 => new Vec3Ctor(p.x, p.y, p.z);

type Emitter = (...args: unknown[]) => void;

export class MineflayerClientBot implements ClientBot {
	readonly #bot: MineflayerBot;
	readonly #listeners = new Map<string, Set<Emitter>>();
	readonly #attached = new Set<string>();
	readonly #windowHandlers = new Map<number, { window: MineflayerWindow; handler: SlotListener }>();
	/** section 内容变化计数：blockUpdate 与区块加载/卸载都会推进，用于只读 revision。 */
	readonly #sectionSeq = new Map<string, number>();
	readonly #columnSeq = new Map<string, number>();

	constructor(bot: MineflayerBot) {
		this.#bot = bot;
		// 先占位一个 error 监听：连接错误若在 Host 接线前发出，EventEmitter 会因无监听者崩溃。
		bot.on("error", () => {});
		// 库存（窗口 0）与所有打开窗口的槽位变化统一走 Window.updateSlot。
		bot.inventory.on("updateSlot", (slot, _old, item) => {
			this.#emitSlot(0, slot, item, null);
		});
		bot.on("windowOpen", (window: MineflayerWindow) => this.#onWindowOpen(window));
		bot.on("windowClose", (window: MineflayerWindow) => this.#onWindowClose(window));
		// section revision 是采样正确性的一部分，不能依赖是否有人订阅 blockUpdate：
		// 内容变化必须无条件推进，否则按 revision 缓存的读取会拿到旧地形。
		bot.on("blockUpdate", (oldBlock: MineflayerBlock | null, newBlock: MineflayerBlock | null) =>
			this.#onBlockUpdate(oldBlock, newBlock),
		);
		bot.on("chunkColumnLoad", (point: MineflayerVec3) => this.#bumpColumn(point.x, point.z));
		bot.on("chunkColumnUnload", (point: MineflayerVec3) => this.#bumpColumn(point.x, point.z));
		this.#attached.add("windowOpen");
		this.#attached.add("windowClose");
		this.#attached.add("blockUpdate");
	}

	// ---- 生命周期与事件 ----

	get version(): string {
		return this.#bot.version ?? "unknown";
	}

	on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): () => void {
		const cb = listener as unknown as Emitter;
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(cb);
		this.#attach(event);
		return () => {
			set.delete(cb);
		};
	}

	#attach(event: string): void {
		// 上游监听按事件挂一次、随 bot 生命周期存在；取消订阅只移除本地回调，
		// 避免 ClientHost 死亡后重接时重复挂上游监听。
		if (this.#attached.has(event)) return;
		this.#attached.add(event);
		const bot = this.#bot;
		switch (event) {
			case "physicsTick":
				bot.on("physicsTick", () => this.#emit("physicsTick"));
				break;
			case "end":
				bot.on("end", (reason: string) => this.#emit("end", String(reason)));
				break;
			case "kicked":
				bot.on("kicked", (reason: string) => this.#emit("kicked", String(reason)));
				break;
			case "error":
				bot.on("error", (error: Error) => this.#emit("error", error));
				break;
			case "spawn":
				bot.on("spawn", () => this.#emit("spawn"));
				break;
			case "death":
				bot.on("death", () => this.#emit("death"));
				break;
			case "health":
				bot.on("health", () => this.#emit("health"));
				break;
			case "entitySpawn":
				bot.on("entitySpawn", (entity: MineflayerEntity) => this.#emit("entitySpawn", this.#entity(entity)));
				break;
			case "entityGone":
				bot.on("entityGone", (entity: MineflayerEntity) => this.#emit("entityGone", this.#entity(entity)));
				break;
			// windowOpen/windowClose/blockUpdate 在构造时已挂（前两者派生 setSlot，
			// 后者无条件推进 section revision）；setSlot 由窗口 updateSlot 派生，无上游事件。
			default:
				break;
		}
	}

	#emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) listener(...args);
	}

	#emitSlot(windowId: number, slot: number, item: MineflayerItem | null, cursor: MineflayerItem | null): void {
		this.#emit("setSlot", windowId, slot, this.#stack(item), this.#stack(cursor));
	}

	#onWindowOpen(window: MineflayerWindow): void {
		const handler: SlotListener = (slot, _old, item) => this.#emitSlot(window.id, slot, item, window.selectedItem);
		window.on("updateSlot", handler);
		this.#windowHandlers.set(window.id, { window, handler });
		this.#emit("windowOpen", this.#windowData(window));
	}

	#onWindowClose(window: MineflayerWindow): void {
		const entry = this.#windowHandlers.get(window.id);
		if (entry) {
			entry.window.off("updateSlot", entry.handler);
			this.#windowHandlers.delete(window.id);
		}
		this.#emit("windowClose", window.id);
	}

	#onBlockUpdate(oldBlock: MineflayerBlock | null, newBlock: MineflayerBlock | null): void {
		const block = newBlock ?? oldBlock;
		if (!block) return;
		this.#bumpSection(block.position.x, block.position.y, block.position.z);
		this.#emit("blockUpdate", this.#pos(block.position), this.#blockInfo(newBlock));
	}

	// ---- 连续控制 ----

	setControlState(key: Key, on: boolean): void {
		this.#bot.setControlState(key, on);
	}

	getControlState(key: Key): boolean {
		return this.#bot.getControlState(key);
	}

	clearControlStates(): void {
		this.#bot.clearControlStates();
	}

	async look(yaw: number, pitch: number, force?: boolean): Promise<void> {
		await this.#bot.look(yaw, pitch, force);
	}

	get physicsEnabled(): boolean {
		return this.#bot.physicsEnabled;
	}

	set physicsEnabled(value: boolean) {
		this.#bot.physicsEnabled = value;
	}

	// ---- 当前状态采样 ----

	self(): BotSelfState {
		const entity = this.#bot.entity;
		if (!entity) throw new Error("mineflayer 客户端尚未 spawn，无法读取自身状态");
		return {
			position: this.#pos(entity.position),
			velocity: this.#pos(entity.velocity),
			yaw: entity.yaw ?? 0,
			pitch: entity.pitch ?? 0,
			onGround: entity.onGround ?? false,
			health: this.#bot.health,
			food: this.#bot.food,
			dimension: this.#bot.game?.dimension ?? null,
		};
	}

	blockAt(pos: BotBlockPos): BotBlockInfo | null {
		return this.#blockInfo(this.#blockAt(pos));
	}

	entities(): BotEntity[] {
		const self = this.#bot.entity;
		return Object.values(this.#bot.entities)
			.filter((entity) => entity !== self)
			.map((entity) => this.#entity(entity));
	}

	inventorySlots(): { slotCount: number; slots: (BotItemStack | null)[]; selectedSlot: number } {
		const inventory = this.#bot.inventory;
		const hotbar = this.#bot.quickBarSlot ?? 0;
		return {
			slotCount: inventory.slots.length,
			slots: inventory.slots.map((item) => this.#stack(item)),
			selectedSlot: INVENTORY_HOTBAR_START + Math.min(Math.max(hotbar, 0), 8),
		};
	}

	currentWindow(): BotWindowData | null {
		const window = this.#bot.currentWindow;
		return window ? this.#windowData(window) : null;
	}

	section(section: BotBlockPos): BotSectionData | null {
		const column = this.#bot.world.getColumn(section.x, section.z);
		if (!column) return null;
		const chunkSection = column.sections[((section.y << 4) - column.minY) >> 4];
		if (!chunkSection) return null;
		const stateIds: number[] = new Array(SECTION_VOLUME);
		// 每个 stateId 取一个代表格读名称/属性，避免 4096 次 Block 分配。
		const representative = new Map<number, number>();
		for (let index = 0; index < SECTION_VOLUME; index++) {
			const stateId = chunkSection.data.get(index);
			stateIds[index] = stateId;
			if (!representative.has(stateId)) representative.set(stateId, index);
		}
		const palette: BotBlockInfo[] = [];
		const paletteIndex = new Map<number, number>();
		for (const [stateId, index] of representative) {
			const block = this.#blockAt({
				x: section.x * 16 + (index & 15),
				y: section.y * 16 + (index >> 8),
				z: section.z * 16 + ((index >> 4) & 15),
			});
			if (!block) continue; // 读不到就保留 null（未知），不冒充空气。
			paletteIndex.set(stateId, palette.length);
			palette.push(this.#blockInfo(block)!);
		}
		return {
			revision: this.#sectionRevision(section),
			base: {
				palette,
				indices: stateIds.map((stateId) => paletteIndex.get(stateId) ?? null),
			},
		};
	}

	// ---- 受控动作 ----

	chat(text: string): void {
		this.#bot.chat(text);
	}

	async dig(pos: BotBlockPos, options: { forceLook: boolean }): Promise<void> {
		const block = this.#blockAt(pos);
		if (!block) throw new Error(`目标方块未加载：${pos.x},${pos.y},${pos.z}`);
		// forceLook=true 让上游瞄准目标；preserve 走 'ignore'，不覆盖当前视角。
		await this.#bot.dig(block, options.forceLook ? true : "ignore");
	}

	stopDigging(): void {
		this.#bot.stopDigging();
	}

	attack(networkId: number): void {
		this.#bot.attack(this.#requireEntity(networkId));
	}

	activateItem(offHand: boolean): void {
		this.#bot.activateItem(offHand);
	}

	deactivateItem(): void {
		this.#bot.deactivateItem();
	}

	usingHeldItem(): boolean {
		return this.#bot.usingHeldItem;
	}

	activateBlock(pos: BotBlockPos, face: BotVec3 | null, cursor: BotVec3 | null): void {
		const block = this.#blockAt(pos);
		if (!block) throw new Error(`目标方块未加载：${pos.x},${pos.y},${pos.z}`);
		// 接口是同步的（Driver 靠 windowOpen 判定打开结果），上游 Promise 失败只记录不抛出。
		void this.#bot
			.activateBlock(
				block,
				face ? v3({ x: face.x, y: face.y, z: face.z }) : undefined,
				cursor ? v3({ x: cursor.x, y: cursor.y, z: cursor.z }) : undefined,
			)
			.catch(() => {});
	}

	activateEntity(networkId: number): void {
		void this.#bot.activateEntity(this.#requireEntity(networkId)).catch(() => {});
	}

	async equip(selector: BotItemSelector, hand: "main" | "off"): Promise<void> {
		if (selector.components !== undefined) {
			// mineflayer 的 Item 组件是协议解码对象，无法按任意 JsonValue 可靠匹配；
			// 明确拒绝，避免"看起来按组件选中、实际按名称选中"。
			throw new Error("mineflayer 适配不支持按 components 选择物品");
		}
		const names = new Set([selector.name, ...(selector.substitutions ?? [])]);
		const candidate = this.#bot.inventory.items().find((item) => {
			if (!names.has(item.name)) return false;
			if (selector.minDurability === undefined) return true;
			const remaining = (item.maxDurability ?? 0) - (item.durabilityUsed ?? 0);
			return remaining >= selector.minDurability;
		});
		if (!candidate) throw new Error(`背包中没有满足条件的物品：${selector.name}`);
		await this.#bot.equip(candidate, hand === "off" ? "off-hand" : "hand");
	}

	async clickWindow(windowId: number, slot: number, button: number, mode: number): Promise<void> {
		const window = this.#bot.currentWindow;
		if (!window || window.id !== windowId) throw new Error(`窗口不存在或已更换：${windowId}`);
		await this.#bot.clickWindow(slot, button, mode);
	}

	closeWindow(windowId: number): void {
		const window = this.#bot.currentWindow;
		if (!window || window.id !== windowId) return;
		void this.#bot.closeWindow(window).catch(() => {});
	}

	async resyncWindow(windowId: number): Promise<void> {
		// mineflayer 不提供窗口重同步；协议层也没有"请求窗口内容"的独立包。
		throw new Error(`mineflayer 不支持窗口重同步：${windowId}`);
	}

	quit(): void {
		this.#bot.quit();
	}

	// ---- 内部转换 ----

	#requireEntity(networkId: number): MineflayerEntity {
		const entity = this.#bot.entities[String(networkId)];
		if (!entity) throw new Error(`实体未跟踪：${networkId}`);
		return entity;
	}

	#blockAt(pos: BotBlockPos): MineflayerBlock | null {
		// blockAt 内部会调用 pos.floored()，必须传真正的 Vec3。
		return this.#bot.blockAt(v3({ x: pos.x, y: pos.y, z: pos.z }));
	}

	#blockInfo(block: MineflayerBlock | null): BotBlockInfo | null {
		if (!block) return null;
		const properties: Record<string, string> = {};
		for (const [key, value] of Object.entries(block.getProperties())) properties[key] = String(value);
		return { name: block.name, properties };
	}

	#stack(item: MineflayerItem | null): BotItemStack | null {
		if (!item) return null;
		return {
			name: item.name,
			count: item.count,
			// 组件是协议解码后的普通数据；没有组件时保持 null，不伪造空对象。
			components: item.components?.length ? (item.components as unknown as JsonValue) : null,
		};
	}

	#entity(entity: MineflayerEntity): BotEntity {
		return {
			networkId: entity.id,
			uuid: entity.uuid ?? null,
			type: entity.type ?? null,
			position: this.#pos(entity.position),
			velocity: this.#pos(entity.velocity),
		};
	}

	#windowData(window: MineflayerWindow): BotWindowData {
		return {
			id: window.id,
			type: window.type,
			slotCount: window.slots.length,
			slots: window.slots.map((item) => this.#stack(item)),
			cursor: this.#stack(window.selectedItem),
			// mineflayer 不消费 window_property，窗口属性（熔炉进度等）保持未知。
			properties: {},
		};
	}

	#pos(value: MineflayerVec3): BotVec3 {
		return { x: value.x, y: value.y, z: value.z };
	}

	#bumpSection(x: number, y: number, z: number): void {
		const key = `${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`;
		this.#sectionSeq.set(key, (this.#sectionSeq.get(key) ?? 0) + 1);
	}

	#bumpColumn(x: number, z: number): void {
		const key = `${x},${z}`;
		this.#columnSeq.set(key, (this.#columnSeq.get(key) ?? 0) + 1);
	}

	#sectionRevision(section: BotBlockPos): string {
		const key = `${section.x},${section.y},${section.z}`;
		return `sec:${key}#${this.#sectionSeq.get(key) ?? 0}/${this.#columnSeq.get(`${section.x},${section.z}`) ?? 0}`;
	}
}
