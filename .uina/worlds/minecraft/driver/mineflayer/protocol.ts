/** Connection-bound protocol seam. Other Driver modules consume decoded facts, never wire packets. */
import { createRequire } from "node:module";
import type { ItemValue, MerchantOfferValue, SignText, WindowSnapshot } from "../../contracts/body.js";
import type { MapIconValue } from "../../contracts/client-facts.js";
import type { JsonValue, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { fixedLayout } from "../window/layout.js";
import { windowStateFor } from "../window/state.js";
import { type MineflayerBot, toMineflayerVec3 } from "./adapter.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const prismarineNbt = mf("prismarine-nbt") as {
	proto: {
		sizeOf(value: unknown, type: string): number;
		write(value: unknown, buffer: Buffer, offset: number, type: string): void;
	};
};
export type NativeWindow = NonNullable<MineflayerBot["currentWindow"]>;
export type ProtocolNotice =
	| {
			kind: "full";
			windowId: number;
			items: (JsonValue | null)[];
			cursor: JsonValue | null;
			/** 服务端状态代次（1.17.1+）；用于把 full 回执归因到某次 click，缺失时保持 null。 */
			stateId: number | null;
	  }
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
	/**
	 * 原始 open_window：窗口身份从这一包开始（不是延迟的 windowOpen）。
	 * title 是文本组件（NBT 已解成纯 JSON）；inventoryType 是协议窗口类型 id。
	 */
	| {
			kind: "open_window";
			windowId: number;
			windowType: number;
			title: JsonValue | null;
			horse: boolean;
			slotCount: number | null;
	  }
	/** 游戏/配置阶段 Dialog：内联 NBT（data）或注册表引用（registryId）。 */
	| { kind: "dialog"; phase: "play" | "config"; data: JsonValue | null; registryId: number | null }
	| { kind: "dialog_clear"; phase: "play" | "config" }
	/** 配置阶段行为准则（原文 + 接受动作）。 */
	| { kind: "code_of_conduct"; contents: string }
	/** 配置阶段注册表数据（dialog 注册表条目用于解析 registryId 引用）。 */
	| { kind: "registry_data"; id: string; entries: { key: string; value: JsonValue | null }[] }
	| { kind: "objective"; name: string; action: number; display: JsonValue | null }
	| { kind: "score"; entry: string; objective: string; value: number; display: JsonValue | null }
	| { kind: "score_reset"; entry: string; objective: string | null }
	| { kind: "score_display"; position: number; objective: string }
	| {
			kind: "boss_bar";
			id: string;
			action: number;
			title: JsonValue | null;
			health: number | null;
			color: number | null;
			overlay: number | null;
			darkenSky: boolean | null;
			createFog: boolean | null;
	  }
	| { kind: "title_text"; target: "title" | "subtitle" | "action_bar"; text: JsonValue | null }
	| { kind: "titles_clear"; reset: boolean }
	| { kind: "tab_header"; header: JsonValue | null; footer: JsonValue | null }
	/** 自定义通道（1.21.11 custom_payload）：连接级协议扩展的唯一入站面。 */
	| { kind: "custom_payload"; channel: string; data: Uint8Array }
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
	// 真服探针（dev/window-probe.ts，Paper 1.21.11）：window_items 带单调递增 stateId。
	window_items: { windowId: number; items: unknown[]; carriedItem?: unknown; stateId?: number };
	set_slot: { windowId: number; slot: number; item: unknown };
	set_cursor_item: { contents: unknown };
	set_player_inventory: { slotId: number; contents: unknown };
	craft_progress_bar: { windowId: number; property: number; value: number };
	trade_list: { windowId: number; trades?: RawTrade[] };
	open_window: { windowId: number; inventoryType: number; windowTitle?: unknown };
	open_horse_window: { windowId: number; nbSlots: number };
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
	/** 1.21.11 自定义通道：channel 是 ResourceLocation，data 是剩余字节。 */
	custom_payload: { channel: string; data: Buffer };
	/** 1.21.11 界面/HUD 观察面（字段形状来自真服探针，见 dev/ui-live）。 */
	scoreboard_objective: { name: string; action: number; displayText?: unknown };
	scoreboard_score: { itemName: string; scoreName: string; value: number; display_name?: unknown };
	reset_score: { entity_name: string; objective_name?: string };
	scoreboard_display_objective: { position: number; name: string };
	boss_bar: {
		entityUUID: string;
		action: number;
		title?: unknown;
		health?: number;
		color?: number;
		dividers?: number;
		flags?: number;
	};
	set_title_text: { text: unknown };
	set_title_subtitle: { text: unknown };
	clear_titles: { reset: boolean };
	action_bar: { text: unknown };
	playerlist_header: { header: unknown; footer: unknown };
	show_dialog: { dialog: unknown };
	clear_dialog: Record<string, never>;
	code_of_conduct: { contents: string };
	registry_data: { id: string; entries: { key: string; value?: unknown }[] };
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
	/**
	 * G7 槽位增量标记：每槽位最后一次内容变更时的 inventory revision，与 playerSnapshot().slots 对齐；
	 * 未同步回 null（不猜）。光标移动只推 revision，不算槽位变更。
	 */
	playerSlotMarks(): number[] | null;
	/** 唯一的 mode-0 窗口点击编码（物品 CAS 与 UI 按钮共用；只发一次，不自动补发）。 */
	click(window: NativeWindow, slot: number, button: number): void;
	/**
	 * 1.21.11 serverbound custom_click_action：Dialog 自定义按钮与聊天 custom 动作的
	 * 唯一出站编码。payload 是 NBT 纯值（会按协议 typed-NBT 写入）；无 payload 时不带字段。
	 */
	customClickAction(id: string, payload: JsonValue | null, floatKeys?: readonly string[]): void;
	/** 以玩家身份发送命令（不带前导斜杠）；只承诺进入发送边界。 */
	chatCommand(command: string): void;
	/** 配置阶段行为准则接受（serverbound accept_code_of_conduct）。 */
	acceptCodeOfConduct(): void;
	/** 当前协议阶段；配置阶段交互与游戏阶段动作据此分流。 */
	protocolState(): "login" | "configuration" | "play" | "unknown";
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
	/**
	 * 自定义通道入站（1.21.11 clientbound custom_payload）。
	 * 只在连接存活期间回调；调用方负责连接作用域（见 driver/protocol-extension.ts）。
	 */
	onCustomPayload(listener: (notice: { channel: string; data: Uint8Array }) => void): () => void;
	/**
	 * 声明本连接可接收的插件通道（1.13+ `minecraft:register`）。
	 * 服务端只向已声明的通道投递 clientbound custom_payload：不注册就收不到回包。
	 * 未进入 play 阶段时排队，login 后自动补发；重复声明按连接去重。
	 */
	registerChannels(channels: readonly string[]): void;
	/**
	 * 自定义通道出站（serverbound custom_payload）。
	 * 只是"把包交给底层写"：调用方必须已经过 Runtime 授权的 BodyScope。
	 * channel 必须是合法 ResourceLocation，否则在发送前显式失败。
	 */
	customPayload(channel: string, data: string | Uint8Array): void;
}

/** player_input 的键位面（1.21.2+ 载具键位申报：shift 下马/跳跃等服务端判定键；移动由 vehicle_move 承担）。 */
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

/**
 * prismarine-nbt 的 typed 表示（{type,value}）→ 纯 JSON。
 * 只保留文本/结构需要的标量、列表与 compound；数组类型（byte/int/long array）不参与
 * 显示投影，如实丢弃而不是编造字符串。布尔在 NBT 里是 byte，文本解析按 0/1 处理。
 */
function nbtPlain(raw: unknown): JsonValue | null {
	if (raw == null) return null;
	if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
	if (Array.isArray(raw)) {
		const items: JsonValue[] = [];
		for (const entry of raw) {
			const value = nbtPlain(entry);
			if (value !== null) items.push(value);
		}
		return items;
	}
	if (typeof raw !== "object") return null;
	const rec = raw as { type?: unknown; value?: unknown };
	if (typeof rec.type === "string") {
		if (rec.type === "list") {
			const list = rec.value as { value?: unknown[] } | undefined;
			return Array.isArray(list?.value) ? (nbtPlain(list.value) as JsonValue) : null;
		}
		if (rec.type === "compound") {
			const value = rec.value;
			if (value == null || typeof value !== "object") return null;
			const out: Record<string, JsonValue> = {};
			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
				const plainEntry = nbtPlain(entry);
				if (plainEntry !== null) out[key] = plainEntry;
			}
			return out;
		}
		if (rec.type === "byteArray" || rec.type === "intArray" || rec.type === "longArray") return null;
		if (rec.type === "end") return null;
		return nbtPlain(rec.value);
	}
	const out: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
		const plainEntry = nbtPlain(entry);
		if (plainEntry !== null) out[key] = plainEntry;
	}
	return out;
}

/**
 * 1.21.11 的 custom_click_action 线上形态：
 *   Identifier + VarInt 长度 + （TAG_End(0x00) 表示无载荷，否则就是一个完整的匿名 NBT 标签）
 * 服务端类 ServerboundCustomClickActionPacket 的 codec 是
 * `optionalTagCodec(...).apply(lengthPrefixed(65536))`，长度前缀包住整个可选标签。
 * minecraft-data 3.117.0 把该字段记成 ["option","anonymousNbt"]：既少了外层长度前缀，
 * 又把"缺失"记成 bool=false。按定义直写会被服务端判 DecoderException 直接踢人（真服实测）。
 * 所以这里自己拼包体：借 protodef 拿到 [包 id][id 字符串] 的头，再接自己编码的载荷块。
 */
const TAG_TYPES: ReadonlySet<string> = new Set([
	"end",
	"byte",
	"short",
	"int",
	"long",
	"float",
	"double",
	"byteArray",
	"string",
	"list",
	"compound",
	"intArray",
	"longArray",
]);

function encodeAnonymousNbt(value: JsonValue, floatKeys?: ReadonlySet<string>): Buffer {
	// 组件里的 payload 可能已经是 prismarine-nbt 的 typed 标签（例如 custom 动作带回原始 tag）：
	// 那种情况直接照抄，不能再包一层 compound。
	const rec =
		value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	const typed =
		rec != null && typeof rec.type === "string" && TAG_TYPES.has(rec.type) && "value" in rec
			? rec
			: nbtTyped(value, floatKeys);
	const size = prismarineNbt.proto.sizeOf(typed, "anonymousNbt");
	const buffer = Buffer.alloc(size);
	prismarineNbt.proto.write(typed, buffer, 0, "anonymousNbt");
	return buffer;
}

/** VarInt（LEB128）编码，只用于包体内部的长度前缀。 */
function varint(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value;
	do {
		const byte = rest & 0x7f;
		rest >>>= 7;
		bytes.push(rest === 0 ? byte : byte | 0x80);
	} while (rest !== 0);
	return Buffer.from(bytes);
}

/** 纯 JSON → prismarine-nbt typed 表示（anonymousNbt 写入需要）。 */
function nbtTyped(value: JsonValue, floatKeys?: ReadonlySet<string>, key?: string): Record<string, unknown> {
	if (typeof value === "string") return { type: "string", value };
	if (typeof value === "boolean") return { type: "byte", value: value ? 1 : 0 };
	if (typeof value === "number") {
		if (key != null && floatKeys?.has(key)) return { type: "float", value };
		return Number.isInteger(value) ? { type: "int", value } : { type: "double", value };
	}
	if (Array.isArray(value)) {
		const items = value.map((entry) => nbtTyped(entry));
		const type = items[0]?.type ?? "end";
		return { type: "list", value: { type, value: items } };
	}
	const fields: Record<string, unknown> = {};
	for (const [entryKey, entry] of Object.entries(value as Record<string, JsonValue>))
		fields[entryKey] = nbtTyped(entry, floatKeys, entryKey);
	return { type: "compound", name: "", value: fields };
}

/** 自定义通道语法（ResourceLocation）与 1.21.11 plugin message 上限。 */
const CHANNEL_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const MAX_CUSTOM_PAYLOAD = 32767;

/** The only implemented version. A future adapter implements this same narrow port. */
class Protocol12111 implements DriverProtocol {
	private readonly listeners = new Set<(notice: ProtocolNotice) => void>();
	private readonly detach: (() => void)[] = [];
	private codec: ItemCodec | null = null;
	private itemNames: Map<number, string> | null = null;
	private player: WindowSnapshot | null = null;
	/** G7 槽位增量标记：每槽位最后一次内容变更时的 revision；与 player.slots 对齐，player 为 null 时清空。 */
	private slotMarks: number[] = [];
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
	/** 已向服务端声明、可接收 clientbound custom_payload 的通道（按连接去重）。 */
	private readonly registeredChannels = new Set<string>();
	/** play 阶段前登记的通道：login 后一次性补发，避免在错误协议状态写入。 */
	private readonly pendingChannels = new Set<string>();
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
		// 进入 play 阶段后再补发登记：attach 早于 login，提前写 custom_payload 会发错阶段。
		// 登记失败不致命：动作仍会尝试发送，回读不到时如实 EFFECT_UNCONFIRMED。
		const onLogin = () => {
			try {
				this.flushChannelRegistration();
			} catch (error) {
				console.warn(`[mc-protocol] channel registration failed after login: ${String(error)}`);
			}
		};
		bot._client.on("login", onLogin);
		this.detach.push(() => bot._client.removeListener("login", onLogin));
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
				const previous = this.player;
				const revision = (previous?.revision ?? 0) + 1;
				this.player = {
					window: "player-inventory",
					type: "minecraft:inventory",
					revision,
					layout: { slotCount: items.length, regions: inventory?.regions ?? [] },
					properties: {},
					slots: items.map((item: JsonValue | null, slot: number) => ({ slot, item })),
					cursor,
				};
				// G7：全量重同步只标内容真正变化的槽位；无前值（登录/重生）时全部视为已变。
				this.slotMarks = items.map((item: JsonValue | null, slot: number) => {
					const before =
						previous != null && previous.slots.length === items.length ? previous.slots[slot]?.item : undefined;
					if (before === undefined) return revision;
					return JSON.stringify(before) !== JSON.stringify(item) ? revision : (this.slotMarks[slot] ?? revision);
				});
			}
			if (packet.windowId !== 0 && window && items.length === window.slots.length && this.player) {
				for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++)
					this.updatePlayer(9 + slot - window.inventoryStart, items[slot]);
				if (window === current) {
					this.player.cursor = cursor;
					this.playerSynchronized = true;
				}
			}
			this.emit({
				kind: "full",
				windowId: packet.windowId,
				items,
				cursor,
				stateId: typeof packet.stateId === "number" ? packet.stateId : null,
			});
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
		raw("open_window", (packet: { windowId: number; inventoryType: number; windowTitle?: unknown }) => {
			this.lastClosedWindow = null;
			// 窗口身份从这里开始：先发原始元数据（含标题），再由上层 window_open 补 native 身份。
			this.emit({
				kind: "open_window",
				windowId: packet.windowId,
				windowType: packet.inventoryType,
				title: nbtPlain(packet.windowTitle),
				horse: false,
				slotCount: null,
			});
			this.emit({ kind: "replacement" });
		});
		raw("open_horse_window", (packet: { windowId: number; nbSlots: number }) => {
			this.lastClosedWindow = null;
			this.emit({
				kind: "open_window",
				windowId: packet.windowId,
				windowType: -1,
				title: null,
				horse: true,
				slotCount: packet.nbSlots,
			});
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
		// ---- 界面/HUD 观察面（1.21.11 真服探针：字段形状见 tmp/ui-wire-probe*.mts） ----
		raw("scoreboard_objective", (p) =>
			this.emit({ kind: "objective", name: p.name, action: p.action, display: nbtPlain(p.displayText) }),
		);
		raw("scoreboard_score", (p) =>
			this.emit({
				kind: "score",
				entry: p.itemName,
				objective: p.scoreName,
				value: p.value,
				display: nbtPlain(p.display_name),
			}),
		);
		raw("reset_score", (p) =>
			this.emit({ kind: "score_reset", entry: p.entity_name, objective: p.objective_name ?? null }),
		);
		raw("scoreboard_display_objective", (p) =>
			this.emit({ kind: "score_display", position: p.position, objective: p.name }),
		);
		raw("boss_bar", (p) =>
			this.emit({
				kind: "boss_bar",
				id: p.entityUUID,
				action: p.action,
				title: nbtPlain(p.title),
				health: typeof p.health === "number" ? p.health : null,
				color: typeof p.color === "number" ? p.color : null,
				overlay: typeof p.dividers === "number" ? p.dividers : null,
				darkenSky: typeof p.flags === "number" ? (p.flags & 1) !== 0 : null,
				createFog: typeof p.flags === "number" ? (p.flags & 2) !== 0 : null,
			}),
		);
		raw("set_title_text", (p) => this.emit({ kind: "title_text", target: "title", text: nbtPlain(p.text) }));
		raw("set_title_subtitle", (p) => this.emit({ kind: "title_text", target: "subtitle", text: nbtPlain(p.text) }));
		raw("action_bar", (p) => this.emit({ kind: "title_text", target: "action_bar", text: nbtPlain(p.text) }));
		raw("clear_titles", (p) => this.emit({ kind: "titles_clear", reset: p.reset === true }));
		raw("playerlist_header", (p) =>
			this.emit({ kind: "tab_header", header: nbtPlain(p.header), footer: nbtPlain(p.footer) }),
		);
		// Dialog：play 用 registryEntryHolder（{data}|{dialog}），config 直接是 NBT。
		raw("show_dialog", (p) => {
			const phase = this.protocolState() === "configuration" ? "config" : "play";
			const holder = p.dialog as { data?: unknown; dialog?: number } | undefined;
			const inline = phase === "config" ? p.dialog : holder?.data;
			this.emit({
				kind: "dialog",
				phase,
				data: nbtPlain(inline),
				registryId: typeof holder?.dialog === "number" ? holder.dialog : null,
			});
		});
		raw("clear_dialog", () => {
			const phase = this.protocolState() === "configuration" ? "config" : "play";
			this.emit({ kind: "dialog_clear", phase });
		});
		raw("code_of_conduct", (p) => this.emit({ kind: "code_of_conduct", contents: String(p.contents ?? "") }));
		raw("registry_data", (p) => {
			if (typeof p.id !== "string") return;
			this.emit({
				kind: "registry_data",
				id: p.id,
				entries: (p.entries ?? []).map((entry) => ({ key: entry.key, value: nbtPlain(entry.value) })),
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
		raw("custom_payload", (p) => {
			if (typeof p.channel !== "string" || !Buffer.isBuffer(p.data)) return;
			this.emit({ kind: "custom_payload", channel: p.channel, data: p.data });
		});
		native("windowOpen", (window: NativeWindow) => this.emit({ kind: "window_open", window }));
		native("windowClose", (window: NativeWindow | null) => {
			if (window && window.id !== 0) this.lastClosedWindow = window;
			this.emit({ kind: "window_close", window });
		});
		native("respawn", () => {
			this.player = null;
			this.slotMarks = [];
			this.lastClosedWindow = null;
			this.activeBobber = null;
		});
		native("end", () => {
			this.ended = true;
			this.player = null;
			this.slotMarks = [];
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
	playerSlotMarks(): number[] | null {
		return this.player == null || !this.playerSynchronized ? null : [...this.slotMarks];
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
			this.slotMarks[slot] = this.player.revision;
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
		// 真服 SHELTER 二分：发送 window.selectedItem 反而让工作台点击被拒
		// （selectedItem 不是 Uina 的权威 cursor）。保持 baseline 的 null，
		// cursor 一致性由上层"CURSOR_NOT_EMPTY / 先清空再写"约束保证。
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
	protocolState(): "login" | "configuration" | "play" | "unknown" {
		const state = (this.bot._client as { state?: string }).state;
		if (state === "login" || state === "configuration" || state === "play") return state;
		return "unknown";
	}
	/**
	 * custom_click_action：Identifier + lengthPrefixed(optional anonymous NBT)。
	 * 编码细节与"为什么不能直接用 protodef 定义"见 encodeAnonymousNbt 上方的说明。
	 */
	customClickAction(id: string, payload: JsonValue | null, floatKeys?: readonly string[]): void {
		this.check();
		if (!CHANNEL_PATTERN.test(id))
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `custom click action id ${JSON.stringify(id)} is not a ResourceLocation (namespace:path)`,
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		const client = this.bot._client as unknown as {
			serializer: { createPacketBuffer(packet: unknown): Buffer };
			writeRaw(buffer: Buffer): void;
		};
		// protodef 用同一个包名编出 [包 id][id 字符串][option 标记]，末字节就是可选标记；
		// 去掉它，换成"长度前缀 + 可选标记 + 载荷"的块，其余头部原样复用。
		const probe = client.serializer.createPacketBuffer({ name: "custom_click_action", params: { id } });
		if (probe.length === 0 || probe[probe.length - 1] !== 0x00)
			throw fail({
				code: "INTERNAL",
				source: "environment",
				message: "custom_click_action packet layout is not the expected [id][optional flag] shape",
				dispatch: "not_sent",
				effects: [],
				recoverable: false,
			});
		// 可选载荷没有独立的"存在"标志字节：整个 Optional 就是一个标签，
		// 用 TAG_End(0x00) 表示缺失（真服实测：多写一个 0x01 会被读成 Byte 标签的值）。
		const body =
			payload == null
				? Buffer.from([0x00])
				: encodeAnonymousNbt(payload, floatKeys == null ? undefined : new Set(floatKeys));
		client.writeRaw(Buffer.concat([probe.subarray(0, probe.length - 1), varint(body.length), body]));
	}
	/** 命令走 chat_command（不带前导斜杠）；只承诺进入发送边界。 */
	chatCommand(command: string): void {
		this.check();
		const text = command.startsWith("/") ? command.slice(1) : command;
		if (text.length === 0)
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "command must not be empty",
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		this.write("chat_command", { command: text });
	}
	acceptCodeOfConduct(): void {
		this.check();
		this.write("accept_code_of_conduct", {});
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
	onCustomPayload(listener: (notice: { channel: string; data: Uint8Array }) => void): () => void {
		return this.subscribe((notice) => {
			if (notice.kind === "custom_payload") listener({ channel: notice.channel, data: notice.data });
		});
	}
	registerChannels(channels: readonly string[]): void {
		this.check();
		for (const channel of channels) {
			if (!CHANNEL_PATTERN.test(channel))
				throw fail({
					code: "INVALID_INPUT",
					source: "input",
					message: `custom payload channel ${JSON.stringify(channel)} is not a ResourceLocation (namespace:path)`,
					dispatch: "not_sent",
					effects: [],
					recoverable: true,
				});
			if (!this.registeredChannels.has(channel)) this.pendingChannels.add(channel);
		}
		this.flushChannelRegistration();
	}
	/** 服务端只向已登记的通道投递；未到 play 阶段就留到 login。 */
	private flushChannelRegistration(): void {
		if (this.pendingChannels.size === 0) return;
		if ((this.bot._client as { state?: string }).state !== "play") return;
		const channels = [...this.pendingChannels];
		// 传统 minecraft:register 负载：NUL 分隔的通道名（末尾 NUL 与客户端实现一致）。
		this.write("custom_payload", {
			channel: "minecraft:register",
			data: Buffer.from(`${channels.join("\0")}\0`, "utf8"),
		});
		// 只有真的写出去才记为已登记：失败时留在 pending，下一次发送/重连还能补。
		this.pendingChannels.clear();
		for (const channel of channels) this.registeredChannels.add(channel);
	}
	customPayload(channel: string, data: string | Uint8Array): void {
		this.check();
		// ResourceLocation 语法与 32767 字节上限由协议决定：非法输入在发送前失败，
		// 不把"服务端静默丢弃"伪装成已生效。
		if (!CHANNEL_PATTERN.test(channel))
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `custom payload channel ${JSON.stringify(channel)} is not a ResourceLocation (namespace:path)`,
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		if (bytes.length > MAX_CUSTOM_PAYLOAD)
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `custom payload is ${bytes.length} bytes; limit is ${MAX_CUSTOM_PAYLOAD}`,
				dispatch: "not_sent",
				effects: [],
				recoverable: true,
			});
		// 不注册就收不到服务端回包：发送前确保本通道已被服务端认知（同一连接内只发一次）。
		this.registerChannels([channel]);
		this.write("custom_payload", { channel, data: bytes });
	}
}

const protocols = new WeakMap<MineflayerBot, DriverProtocol>();
export function protocolFor(bot: MineflayerBot): DriverProtocol {
	let protocol = protocols.get(bot);
	if (!protocol) {
		const created = new Protocol12111(bot);
		protocols.set(bot, created);
		// 连接级界面状态必须从连接建立就开始观察：菜单可能由 /menu、NPC 或聊天链接打开，
		// 等到 uiAct/ui() 才建档就会丢掉 open_window 与 HUD 的初始包。
		windowStateFor(created);
		protocol = created;
	}
	return protocol;
}
