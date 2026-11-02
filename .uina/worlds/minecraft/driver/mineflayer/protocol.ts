/** Connection-bound protocol seam. Other Driver modules consume decoded facts, never wire packets. */
import { createRequire } from "node:module";
import type { ItemValue, MerchantOfferValue, SignText, WindowSnapshot } from "../../contracts/body.js";
import type { MapIconValue } from "../../contracts/client-facts.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { fixedLayout } from "../window/layout.js";
import { type MineflayerBot, toMineflayerVec3 } from "./adapter.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
export type NativeWindow = NonNullable<MineflayerBot["currentWindow"]>;
export type ProtocolNotice =
	| { kind: "full"; windowId: number; items: (JsonValue | null)[]; cursor: JsonValue | null }
	| { kind: "slot"; windowId: number; slot: number; item: JsonValue | null }
	| { kind: "cursor"; item: JsonValue | null }
	| { kind: "player_slot"; slot: number; item: JsonValue | null }
	| { kind: "property"; windowId: number; property: number; value: number }
	| { kind: "trades"; windowId: number; offers: MerchantOfferValue[] }
	| { kind: "window_open"; window: NativeWindow }
	| { kind: "window_close"; window: NativeWindow | null }
	| { kind: "replacement" }
	| { kind: "block"; position: Vec3; stateId: number; air: boolean }
	| { kind: "sign_editor"; position: Vec3; front: boolean }
	| { kind: "sign_update"; position: Vec3 }
	/** 拴绳/上下车的链接事实（批 18）：attach_entity 的 (passenger, vehicle) 对；vehicleId<=0 = 解除。 */
	| { kind: "link"; entityId: number; vehicleId: number }
	/** 骑乘乘客表（批 18）：set_passengers；含自己 = 上载具，不含 = 下载具（mineflayer 对后者不发事件）。 */
	| { kind: "passengers"; vehicleId: number; passengers: number[] }
	/** 鱼漂生命周期与咬钩判据（批 18）：spawn_entity(type=fishing_bobber) / entity_destroy / 粒子窗口命中。 */
	| { kind: "bobber"; id: number }
	| { kind: "bobber_gone"; id: number }
	| { kind: "bite"; bobberId: number }
	/** 1.21.11 的 packet_map（线上包名 map）：像素矩形未校验，由事实层校验后一次提交。 */
	| {
			kind: "map";
			id: number;
			scale: number;
			locked: boolean;
			/** 字段缺席=undefined（保留旧图标）；数组=明确替换（空数组=清空）。 */
			icons: MapIconValue[] | undefined;
			columns: number;
			rows: number | undefined;
			x: number | undefined;
			y: number | undefined;
			data: Uint8Array | undefined;
	  }
	| { kind: "end" };

interface NativeItem {
	name: string;
	count: number;
	stackSize?: number;
	components?: unknown;
	removedComponents?: unknown;
	maxDurability?: number;
	durabilityUsed?: number | null;
}
interface ItemCodec {
	fromNotch(value: unknown): NativeItem | null;
}
/** 商人报价的线上形态：付款项给 itemId/count，产物是 Slot（count=0 表示空）。 */
interface RawTradeCost {
	itemId: number;
	itemCount: number;
}
interface RawTrade {
	inputItem1?: RawTradeCost;
	inputItem2?: RawTradeCost;
	outputItem?: { itemId?: number; itemCount: number };
	tradeDisabled?: boolean;
	nbTradeUses?: number;
	maximumNbTradeUses?: number;
	xp?: number;
}
interface RawPackets {
	window_items: { windowId: number; items: unknown[]; carriedItem?: unknown };
	set_slot: { windowId: number; slot: number; item: unknown };
	set_cursor_item: { contents: unknown };
	set_player_inventory: { slotId: number; contents: unknown };
	craft_progress_bar: { windowId: number; property: number; value: number };
	trade_list: { windowId: number; trades?: RawTrade[] };
	open_window: unknown;
	open_horse_window: unknown;
	block_change: { location: Vec3; type: number };
	multi_block_change: { chunkCoordinates: Vec3; records: number[] };
	open_sign_entity: { location: Vec3; isFrontText: boolean };
	tile_entity_data: { location?: Vec3 };
	map: {
		itemDamage: number;
		scale: number;
		locked: boolean;
		icons?: { type: number; x: number; z: number; direction: number; displayName?: unknown }[] | null;
		columns: number;
		rows?: number;
		x?: number;
		y?: number;
		data?: Buffer;
	};
	/** 批 18 观察面：拴绳/乘客/鱼漂/咬钩。 */
	attach_entity: { entityId: number; vehicleId: number };
	set_passengers: { entityId: number; passengers: number[] };
	spawn_entity: { entityId: number; type: number };
	entity_destroy: { entityIds: number[] };
	world_particles: { x: number; y: number; z: number; amount: number; particle: { type?: unknown } };
}
/** registry 只暴露到这里的字段；不引第二份物品表。 */
interface ItemRegistry {
	itemsArray?: { id: number; name: string }[];
	items?: Record<string, { id: number; name: string }>;
}
export interface DriverProtocol {
	readonly version: string;
	assertSupported(): void;
	subscribe(listener: (notice: ProtocolNotice) => void): () => void;
	decode(raw: unknown): JsonValue | null;
	item(value: unknown): ItemValue | null;
	playerSnapshot(): WindowSnapshot | null;
	click(window: NativeWindow, slot: number, button: number): void;
	/** 工作站专用提交（批 15）：只写包，不预测槽位、不判定生效。 */
	selectEnchant(window: NativeWindow, offer: number): void;
	renameItem(name: string): void;
	selectTrade(index: number): void;
	close(window: NativeWindow): void;
	activateBlock(position: Vec3, face?: number, hand?: number, cursor?: Vec3): void;
	activateEntity(networkId: number, hand?: number): void;
	useItem(hand: number): void;
	endUse(): void;
	startDig(position: Vec3, face: number): void;
	finishDig(position: Vec3, face: number): void;
	cancelDig(position: Vec3, face: number): void;
	writeSign(position: Vec3, front: boolean, lines: SignText): void;
	/** 载具驾驶输入（批 18）。 */
	vehicleMove(position: Vec3, yaw: number, pitch?: number): void;
	vehicleInput(inputs: VehicleInputFlags): void;
	look(yaw: number, pitch: number, onGround: boolean): void;
	/**
	 * 链接状态查询（批 18）：该实体当前的持有者 id（拴绳的玩家/knot，或骑乘的载具）；
	 * 无记录 = null。只覆盖本连接内收到过的 attach_entity（协议无查询包，重连后为空）。
	 */
	linkHolder(entityId: number): number | null;
	/** 结束睡眠（1.21.11 entity_action 0 = stop_sleeping；mineflayer bed.js 硬编码的 2 在本版本是 stop_sprinting）。 */
	wakeUp(): void;
}

/** player_input 的键位面（1.21.2+ 服务端权威载具输入；船忽略，只认 vehicle_move）。 */
export interface VehicleInputFlags {
	forward?: boolean;
	backward?: boolean;
	left?: boolean;
	right?: boolean;
	jump?: boolean;
	shift?: boolean;
	sprint?: boolean;
}

function json(value: unknown): JsonValue {
	return JSON.parse(
		JSON.stringify(value, (_key, part) => (typeof part === "bigint" ? part.toString() : part)),
	) as JsonValue;
}

/** 地图图标 displayName 匿名 NBT → 纯文本；解不出如实 null，不编造。 */
function nbtLabel(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null || typeof value !== "object") return null;
	const rec = value as { text?: unknown; value?: unknown };
	if (typeof rec.text === "string") return rec.text;
	if (rec.text != null && typeof rec.text === "object") return nbtLabel(rec.text);
	if (rec.value !== undefined) return nbtLabel(rec.value);
	return null;
}

/** The only implemented version. A future adapter implements this same narrow port. */
class Protocol12111 implements DriverProtocol {
	private readonly listeners = new Set<(notice: ProtocolNotice) => void>();
	private readonly detach: (() => void)[] = [];
	private codec: ItemCodec | null = null;
	private itemNames: Map<number, string> | null = null;
	private player: WindowSnapshot | null = null;
	private lastClosedWindow: NativeWindow | null = null;
	private playerSynchronized = false;
	private sequence = 0;
	private ended = false;
	/** 当前连接的活跃鱼漂（批 18）：spawn 起置位，destroy 清空；bite 判据以它的位置为锚。 */
	private activeBobber: number | null = null;
	/**
	 * 链接事实缓存（批 18）：attach_entity 的 (entity → holder) 最新状态。
	 * 骑乘与拴绳共用这个包（entityId=乘客/被拴者，vehicleId=载具/持有者，<=0 解除）；
	 * 协议没有"查询拴绳状态"的包，这是客户端唯一可用的已拴事实，重连后为空。
	 */
	private readonly linkHolders = new Map<number, number>();
	/** fishing_bobber 的实体类型 id；registry 查不到 = null（本版本无鱼漂观察）。 */
	private bobberTypeIdCache: number | null | undefined = undefined;
	get version(): string {
		return this.bot.version;
	}
	constructor(private readonly bot: MineflayerBot) {
		const raw = <K extends keyof RawPackets>(event: K, callback: (packet: RawPackets[K]) => void) => {
			const listener = (packet: RawPackets[K]) => {
				if (!this.ended && this.version === "1.21.11") callback(packet);
			};
			bot._client.on(event, listener);
			this.detach.push(() => bot._client.removeListener(event, listener));
		};
		const native = (event: string, callback: (...args: never[]) => void) => {
			bot.on(event as never, callback as never);
			this.detach.push(() => bot.removeListener(event as never, callback as never));
		};
		raw("window_items", (packet) => {
			if (packet.carriedItem === undefined) return;
			const items = packet.items.map((item: unknown) => this.decode(item));
			const cursor = this.decode(packet.carriedItem);
			const current = packet.windowId === 0 ? bot.inventory : bot.currentWindow;
			const window =
				current?.id === packet.windowId
					? current
					: this.lastClosedWindow?.id === packet.windowId
						? this.lastClosedWindow
						: null;
			if (current && current.id === packet.windowId)
				current.selectedItem = this.nativeItem(packet.carriedItem) as NativeWindow["selectedItem"];
			if (packet.windowId === 0 && items.length >= 46) {
				this.playerSynchronized = true;
				const inventory = fixedLayout("minecraft:inventory");
				this.player = {
					window: "player-inventory",
					type: "minecraft:inventory",
					revision: (this.player?.revision ?? 0) + 1,
					layout: { slotCount: items.length, regions: inventory?.regions ?? [] },
					properties: {},
					slots: items.map((item: JsonValue | null, slot: number) => ({ slot, item })),
					cursor,
				};
			}
			if (packet.windowId !== 0 && window && items.length === window.slots.length && this.player) {
				for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++)
					this.updatePlayer(9 + slot - window.inventoryStart, items[slot]);
				if (window === current) {
					this.player.cursor = cursor;
					this.playerSynchronized = true;
				}
			}
			this.emit({ kind: "full", windowId: packet.windowId, items, cursor });
		});
		raw("set_slot", (packet) => {
			const item = this.decode(packet.item);
			if (packet.windowId === 0 || packet.windowId === -2) this.updatePlayer(packet.slot, item);
			const window =
				bot.currentWindow?.id === packet.windowId
					? bot.currentWindow
					: this.lastClosedWindow?.id === packet.windowId
						? this.lastClosedWindow
						: null;
			if (
				window &&
				packet.windowId === window.id &&
				packet.slot >= window.inventoryStart &&
				packet.slot < window.inventoryEnd
			)
				this.updatePlayer(9 + packet.slot - window.inventoryStart, item);
			if (packet.windowId === -1 && packet.slot === -1) this.updateCursor(packet.item);
			this.emit({ kind: "slot", windowId: packet.windowId, slot: packet.slot, item });
		});
		raw("set_cursor_item", (packet) => {
			this.updateCursor(packet.contents);
			this.emit({ kind: "cursor", item: this.decode(packet.contents) });
		});
		raw("set_player_inventory", (packet) => {
			const index = packet.slotId;
			const slot =
				index < 9 ? 36 + index : index <= 35 ? index : index === 40 ? 45 : index >= 36 && index <= 39 ? 44 - index : -1;
			if (slot < 0) return;
			const item = this.decode(packet.contents);
			this.updatePlayer(slot, item);
			const window = bot.currentWindow;
			if (window && slot >= 9 && slot <= 44)
				window.updateSlot(
					window.inventoryStart + slot - 9,
					this.nativeItem(packet.contents) as Parameters<NativeWindow["updateSlot"]>[1],
				);
			this.emit({ kind: "player_slot", slot, item });
		});
		raw("craft_progress_bar", (p) =>
			this.emit({ kind: "property", windowId: p.windowId, property: p.property, value: p.value }),
		);
		raw("trade_list", (packet) => {
			const offers = (packet.trades ?? []).map((trade, index) => this.offer(trade, index));
			this.emit({ kind: "trades", windowId: packet.windowId, offers });
		});
		raw("open_window", () => {
			this.lastClosedWindow = null;
			this.emit({ kind: "replacement" });
		});
		raw("open_horse_window", () => {
			this.lastClosedWindow = null;
			this.emit({ kind: "replacement" });
		});
		raw("block_change", (p) => this.block(p.location, p.type));
		raw("multi_block_change", (p) => {
			for (const record of p.records)
				this.block(
					{
						x: p.chunkCoordinates.x * 16 + ((record >> 8) & 15),
						y: p.chunkCoordinates.y * 16 + (record & 15),
						z: p.chunkCoordinates.z * 16 + ((record >> 4) & 15),
					},
					record >> 12,
				);
		});
		raw("open_sign_entity", (p) =>
			this.emit({ kind: "sign_editor", position: p.location, front: p.isFrontText === true }),
		);
		raw("tile_entity_data", (p) => {
			if (p.location) this.emit({ kind: "sign_update", position: p.location });
		});
		raw("map", (p) => {
			const icons =
				p.icons == null
					? undefined
					: p.icons.map((icon) => ({
							type: this.mapIconName(icon.type),
							pixel: { x: icon.x, z: icon.z },
							direction: icon.direction,
							label: icon.displayName == null ? null : nbtLabel(icon.displayName),
						}));
			this.emit({
				kind: "map",
				id: p.itemDamage,
				scale: p.scale,
				locked: p.locked === true,
				icons,
				columns: p.columns,
				rows: p.rows,
				x: p.x,
				y: p.y,
				data: p.data,
			});
		});
		// ---- 批 18 观察面：拴绳/乘客/鱼漂/咬钩 ----
		raw("attach_entity", (p) => {
			if (p.vehicleId > 0) this.linkHolders.set(p.entityId, p.vehicleId);
			else this.linkHolders.delete(p.entityId);
			this.emit({ kind: "link", entityId: p.entityId, vehicleId: p.vehicleId });
		});
		raw("set_passengers", (p) =>
			this.emit({ kind: "passengers", vehicleId: p.entityId, passengers: [...p.passengers] }),
		);
		raw("spawn_entity", (p) => {
			const bobber = this.bobberTypeId();
			if (bobber != null && p.type === bobber) {
				this.activeBobber = p.entityId;
				this.emit({ kind: "bobber", id: p.entityId });
			}
		});
		raw("entity_destroy", (p) => {
			if (this.activeBobber != null && p.entityIds.includes(this.activeBobber)) {
				const id = this.activeBobber;
				this.activeBobber = null;
				this.emit({ kind: "bobber_gone", id });
			}
		});
		raw("world_particles", (p) => {
			// 咬钩判据与 mineflayer fishing.js 同口径：fishing/bubble × 6 且距鱼漂 ≤1.23（同 y）。
			if (this.activeBobber == null) return;
			const type = p.particle?.type;
			if (type !== "fishing" && type !== "bubble") return;
			if (p.amount !== 6) return;
			const bobber = this.bot.entities[String(this.activeBobber)] as
				| { position?: { x: number; z: number } }
				| undefined;
			if (bobber?.position == null) return;
			const d = Math.hypot(p.x - bobber.position.x, p.z - bobber.position.z);
			if (d <= 1.23) this.emit({ kind: "bite", bobberId: this.activeBobber });
		});
		native("windowOpen", (window: NativeWindow) => this.emit({ kind: "window_open", window }));
		native("windowClose", (window: NativeWindow | null) => {
			if (window && window.id !== 0) this.lastClosedWindow = window;
			this.emit({ kind: "window_close", window });
		});
		native("respawn", () => {
			this.player = null;
			this.lastClosedWindow = null;
			this.activeBobber = null;
		});
		native("end", () => {
			this.ended = true;
			this.player = null;
			this.lastClosedWindow = null;
			this.activeBobber = null;
			this.emit({ kind: "end" });
			for (const detach of this.detach.splice(0)) detach();
			this.listeners.clear();
		});
	}
	private check(): void {
		if (this.ended || this.version !== "1.21.11")
			throw fail({
				code: this.ended ? "DISCONNECTED" : "UNSUPPORTED_PROTOCOL",
				source: "environment",
				message: `controlled protocol ${this.version} is ${this.ended ? "retired" : "unsupported; supported: 1.21.11"}`,
				dispatch: "not_sent",
				recoverable: false,
			});
	}
	assertSupported(): void {
		this.check();
	}
	private nativeItem(raw: unknown): NativeItem | null {
		this.check();
		this.codec ??= mf("prismarine-item")(this.bot.registry) as ItemCodec;
		return this.codec.fromNotch(raw);
	}
	item(raw: unknown): ItemValue | null {
		const item = raw as NativeItem | null;
		if (item == null) return null;
		const used = item.durabilityUsed;
		const added = Array.isArray(item.components) ? (item.components as { type: string; data: unknown }[]) : [];
		const removed = Array.isArray(item.removedComponents)
			? (item.removedComponents as (string | { type: string })[])
			: [];
		const effective = (name: string, fallback: number | undefined): number | null => {
			const component = added.find((part) => part.type === name);
			if (component) return typeof component.data === "number" ? component.data : null;
			if (removed.some((part) => (typeof part === "string" ? part : part.type) === name)) return null;
			return fallback ?? null;
		};
		const maximum = effective("max_damage", item.maxDurability);
		const damage = effective("damage", typeof used === "number" ? used : maximum == null ? undefined : 0);
		return {
			name: item.name,
			count: item.count,
			stackSize: effective("max_stack_size", item.stackSize),
			components:
				item.components === undefined ? null : json({ added: item.components, removed: item.removedComponents ?? [] }),
			durability: maximum != null && damage != null ? maximum - damage : null,
		};
	}
	decode(raw: unknown): JsonValue | null {
		return plain(this.item(this.nativeItem(raw)));
	}
	playerSnapshot(): WindowSnapshot | null {
		return this.player == null || !this.playerSynchronized ? null : structuredClone(this.player);
	}
	subscribe(listener: (notice: ProtocolNotice) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(notice: ProtocolNotice): void {
		for (const listener of [...this.listeners]) listener(notice);
	}
	private updatePlayer(slot: number, item: JsonValue | null): void {
		if (this.player && slot >= 0 && slot < this.player.layout.slotCount) {
			this.player.slots[slot] = { slot, item };
			this.player.revision++;
		}
	}
	private updateCursor(raw: unknown): void {
		const item = this.nativeItem(raw);
		this.bot.inventory.selectedItem = item as NativeWindow["selectedItem"];
		if (this.bot.currentWindow) this.bot.currentWindow.selectedItem = item as NativeWindow["selectedItem"];
		if (this.player) {
			this.player.cursor = plain(this.item(item));
			this.player.revision++;
		}
	}
	private block(position: Vec3, stateId: number): void {
		const name = this.bot.registry.blocksByStateId[stateId]?.name;
		this.emit({ kind: "block", position, stateId, air: name === "air" || name === "cave_air" || name === "void_air" });
	}
	/** 线上 itemId → 物品名；registry 与当前版本同源，查不到时不编造名字。 */
	private itemName(id: number): string {
		this.itemNames ??= (() => {
			const registry = this.bot.registry as unknown as ItemRegistry;
			const map = new Map<number, string>();
			for (const entry of registry.itemsArray ?? []) map.set(entry.id, entry.name);
			for (const entry of Object.values(registry.items ?? {})) map.set(entry.id, entry.name);
			return map;
		})();
		return this.itemNames.get(id) ?? "unknown";
	}
	/** 地图图标类型 id → 名字（minecraft-data mapIcons，1.21.11 取 pc/1.20.2 数据）；查不到按数字如实。 */
	private mapIconName(id: number): string {
		const registry = this.bot.registry as unknown as { mapIcons?: Record<string, { name?: string }> };
		const name = registry.mapIcons?.[id]?.name;
		return typeof name === "string" ? name : String(id);
	}
	/** fishing_bobber 实体类型 id（批 18）；查不到返回 null 且不再重试（版本没有鱼漂观察面）。 */
	private bobberTypeId(): number | null {
		if (this.bobberTypeIdCache === undefined) {
			const registry = this.bot.registry as unknown as { entitiesByName?: Record<string, { id: number }> };
			this.bobberTypeIdCache = registry.entitiesByName?.fishing_bobber?.id ?? null;
		}
		return this.bobberTypeIdCache;
	}
	/** 付款项只在 itemCount>0 时算存在；产物为 Slot（itemCount=0 即空）。 */
	private cost(raw: RawTradeCost | undefined): { item: string; count: number }[] {
		if (raw == null || raw.itemCount <= 0) return [];
		return [{ item: this.itemName(raw.itemId), count: raw.itemCount }];
	}
	private offer(trade: RawTrade, index: number): MerchantOfferValue {
		const output = trade.outputItem;
		return {
			index,
			cost: [...this.cost(trade.inputItem1), ...this.cost(trade.inputItem2)],
			output:
				output == null || output.itemCount <= 0 || output.itemId == null
					? { item: "unknown", count: 0 }
					: { item: this.itemName(output.itemId), count: output.itemCount },
			disabled: trade.tradeDisabled === true,
			uses: trade.nbTradeUses ?? 0,
			maxUses: trade.maximumNbTradeUses ?? 0,
			xp: trade.xp ?? 0,
		};
	}
	private write(name: string, input: Record<string, unknown>): void {
		this.check();
		this.bot._client.write(name, input);
	}
	click(window: NativeWindow, slot: number, button: number): void {
		this.check();
		this.playerSynchronized = false;
		this.write("window_click", {
			windowId: window.id,
			stateId: -1,
			slot,
			mouseButton: button,
			mode: 0,
			changedSlots: [],
			cursorItem: null,
		});
	}
	close(window: NativeWindow): void {
		this.check();
		this.bot.closeWindow(window);
	}
	/** enchant_item 的 enchantment 是 0..2 的档位下标（服务端 clickMenuButton）。 */
	selectEnchant(window: NativeWindow, offer: number): void {
		this.write("enchant_item", { windowId: window.id, enchantment: offer - 1 });
	}
	/** name_item 在 1.21.11 不带 windowId：只能作用于当前打开的铁砧菜单。 */
	renameItem(name: string): void {
		this.write("name_item", { name });
	}
	/** select_trade 的 slot 是报价下标（0 基）。 */
	selectTrade(index: number): void {
		this.write("select_trade", { slot: index });
	}
	activateBlock(position: Vec3, face = 1, hand = 0, cursor: Vec3 = { x: 0.5, y: 0.5, z: 0.5 }): void {
		this.write("block_place", {
			location: toMineflayerVec3(position),
			direction: face,
			hand,
			cursorX: cursor.x,
			cursorY: cursor.y,
			cursorZ: cursor.z,
			insideBlock: false,
			worldBorderHit: false,
			sequence: ++this.sequence,
		});
		this.bot.swingArm("right");
	}
	activateEntity(networkId: number, hand = 0): void {
		this.write("use_entity", {
			target: networkId,
			mouse: 0,
			sneaking: false,
			hand,
			location: toMineflayerVec3({ x: 0, y: 0, z: 0 }),
		});
	}
	linkHolder(entityId: number): number | null {
		return this.linkHolders.get(entityId) ?? null;
	}
	useItem(hand: number): void {
		this.write("use_item", {
			hand,
			sequence: ++this.sequence,
			rotation: { x: ((Math.PI - this.bot.entity.yaw) * 180) / Math.PI, y: (-this.bot.entity.pitch * 180) / Math.PI },
		});
		this.bot.usingHeldItem = true;
	}
	endUse(): void {
		this.write("block_dig", {
			status: 5,
			location: toMineflayerVec3({ x: 0, y: 0, z: 0 }),
			face: 0,
			sequence: ++this.sequence,
		});
		this.bot.usingHeldItem = false;
	}
	startDig(position: Vec3, face: number): void {
		this.dig(0, position, face);
	}
	finishDig(position: Vec3, face: number): void {
		this.dig(2, position, face);
	}
	cancelDig(position: Vec3, face: number): void {
		this.dig(1, position, face);
	}
	private dig(status: number, position: Vec3, face: number): void {
		this.write("block_dig", { status, location: toMineflayerVec3(position), face, sequence: ++this.sequence });
	}
	writeSign(position: Vec3, front: boolean, lines: SignText): void {
		this.write("update_sign", {
			location: toMineflayerVec3(position),
			isFrontText: front,
			text1: lines[0],
			text2: lines[1],
			text3: lines[2],
			text4: lines[3],
		});
	}
	/** 客户端权威载具（船）的位置同步：每拍一包，坐标由调用方的运动学递推。 */
	vehicleMove(position: Vec3, yaw: number, pitch = 0): void {
		// 协议角度单位是度（mineflayer 的 bot.look 内部换算，直写必须自己换）；
		// 弧度直发会被服务端的"位移方向 vs 朝向"校验拒收（真服实测马 0 位移）。
		// 1.21.11 的 vehicle_move 比 1.21.3 多了 onGround 字段：缺省会被服务端
		// 对马的位移校验拒绝（船宽容，所以早期船探针未暴露）。
		this.write("vehicle_move", {
			x: position.x,
			y: position.y,
			z: position.z,
			yaw: (yaw * 180) / Math.PI,
			pitch: (pitch * 180) / Math.PI,
			onGround: true,
		});
	}
	/** 服务端权威载具（马/猪/驼等）的键位输入；船忽略此包。 */
	vehicleInput(inputs: VehicleInputFlags): void {
		this.write("player_input", {
			inputs: {
				forward: inputs.forward === true,
				backward: inputs.backward === true,
				left: inputs.left === true,
				right: inputs.right === true,
				jump: inputs.jump === true,
				shift: inputs.shift === true,
				sprint: inputs.sprint === true,
			},
		});
	}
	/** 独立视角包（1.21.3+ position 包已无 yaw/pitch）：服务端权威载具转向走这里。 */
	look(yaw: number, pitch: number, onGround: boolean): void {
		// 协议角度单位是度（同 vehicleMove）。
		this.write("look", {
			yaw: (yaw * 180) / Math.PI,
			pitch: (pitch * 180) / Math.PI,
			flags: { onGround, hasHorizontalCollision: false },
		});
	}
	wakeUp(): void {
		this.write("entity_action", { entityId: this.bot.entity.id, actionId: 0, jumpBoost: 0 });
	}
}

const protocols = new WeakMap<MineflayerBot, DriverProtocol>();
export function protocolFor(bot: MineflayerBot): DriverProtocol {
	let protocol = protocols.get(bot);
	if (!protocol) {
		protocol = new Protocol12111(bot);
		protocols.set(bot, protocol);
	}
	return protocol;
}
