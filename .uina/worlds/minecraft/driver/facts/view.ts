/**
 * Client Facts 视图构建：prismarine 运行时 → 合同值（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1、modules/driver.md §11。
 * 这里只做"读 + 成形"：不造值——读不到就 null + unknown 条目，不猜默认值。
 * map 在 I1 明确未实现，一律 null + unknown；players 投影服务器实际公告的
 * 名单（bot.players），未收到任何名单事件前同样 null + unknown；库存来自
 * 协议捕获的服务端快照，物品组件/耐久按统一 ItemValue 保留，未捕获字段如实未知。
 * 全部构建发生在 sample() 的同一同步边界内，闭包不外泄。
 */

import type {
	ClientBlockSearchRequest,
	ClientBlockSearchValue,
	ClientBlockValue,
	ClientEntitiesValue,
	ClientFactScope,
	ClientFactStamp,
	ClientFactView,
	ClientInventoryValue,
	ClientListedPlayer,
	ClientMapValue,
	ClientPlayersValue,
	ClientSectionsValue,
	ClientSlotValue,
	ClientWorldValue,
	SectionTarget,
} from "../../contracts/client-facts.js";
import type {
	BlockStateValue,
	BlockTarget,
	EntityRef,
	SelfState,
	StatusEffectValue,
	WindowSnapshot,
} from "../../contracts/body.js";
import type { Fact, FactSource, Vec3 } from "../../contracts/values.js";
import { protocolFor } from "../mineflayer/protocol.js";
import { effectiveAttribute, trackVitals } from "./vitals.js";
import { fromMineflayerVec3, toMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";

export interface FactViewContext {
	bot: MineflayerBot;
	scope: ClientFactScope;
	stamp: ClientFactStamp;
	window?: Fact<WindowSnapshot> | null;
	/** 本连接是否已收到至少一条玩家名单公告（player_info 事件）。 */
	rosterSeen: boolean;
}

/** 一次采样的只读视图；每个方法都是一次独立读取，不共享中间状态。 */
export function createView(ctx: FactViewContext): ClientFactView {
	return {
		scope: () => ctx.scope,
		self: () => selfFact(ctx),
		inventory: () => inventoryFact(ctx),
		block: (target) => blockFact(ctx, target),
		sections: (targets) => sectionsFact(ctx, targets),
		entities: () => entitiesFact(ctx),
		world: () => worldFact(ctx),
		searchBlocks: (request) => searchBlocksFact(ctx, request),
		players: () => playersFact(ctx),
		map: (_id) => absent<ClientMapValue>("map data not implemented in I1"),
		window: () =>
			ctx.window == null
				? absent<WindowSnapshot>("no authoritative open window snapshot")
				: (JSON.parse(JSON.stringify(ctx.window)) as Fact<WindowSnapshot>),
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

/** 覆盖度与来源的公共底座：unknown 非空即 partial。 */
function factBase(
	unknown: string[],
	source: FactSource | "mixed" = "server",
): Pick<Fact<never>, "observedAt" | "source" | "coverage" | "unknown" | "evidence"> {
	return {
		observedAt: nowIso(),
		source,
		coverage: unknown.length > 0 ? "partial" : "complete",
		unknown,
		evidence: [],
	};
}

/** I1 未实现的读数：值与 unknown 都如实，不给假值。 */
function absent<T>(reason: string): Fact<T | null> {
	return { value: null, ...factBase([reason]) } as Fact<T | null>;
}

/** 方块状态属性统一经 getProperties() 收敛为字符串记录（prismarine 值可为 boolean/number）。 */
function blockStateOf(block: NonNullable<ReturnType<MineflayerBot["blockAt"]>>): BlockStateValue {
	const raw = block.getProperties() as Record<string, string | number | boolean>;
	const properties: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) properties[k] = String(v);
	return { name: block.name, properties };
}

// ---- self ----

function selfFact(ctx: FactViewContext): Fact<SelfState | null> {
	const { bot, scope, stamp } = ctx;
	const pos = fromMineflayerVec3(bot.entity?.position);
	if (pos == null || bot.entity == null) return absent<SelfState>("entity not available; self state unknown");

	const unknown: string[] = [];
	const velocity = fromMineflayerVec3(bot.entity.velocity) ?? { x: 0, y: 0, z: 0 };
	const health = typeof bot.health === "number" ? bot.health : null;
	const food = typeof bot.food === "number" ? bot.food : null;
	if (health == null) unknown.push("health not received");
	if (food == null) unknown.push("food not received");

	// maxHealth：尝试读实体属性（版本键名差异大），读不到如实 unknown。
	let maxHealth: number | null = null;
	const attrs = (bot.entity as unknown as { attributes?: Record<string, unknown> }).attributes;
	const maxKey =
		attrs != null ? Object.keys(attrs).find((k) => k.endsWith("max_health") || k.endsWith("maxHealth")) : undefined;
	if (maxKey != null) maxHealth = effectiveAttribute(attrs?.[maxKey]);
	if (maxHealth == null) {
		unknown.push("maxHealth attribute not available");
	}

	const saturation =
		typeof (bot as unknown as { foodSaturation?: number }).foodSaturation === "number"
			? (bot as unknown as { foodSaturation: number }).foodSaturation
			: null;
	if (saturation == null) unknown.push("saturation not received");

	const oxygen = typeof bot.oxygenLevel === "number" ? Math.max(0, Math.min(20, bot.oxygenLevel)) : null;
	if (oxygen == null) unknown.push("oxygen not received");

	// inWater/inLava：读客户端物理每 tick 写在实体上的判定结果（prediction）。
	// 原版按 AABB 与流体判据覆盖 waterlogged / 气泡柱 / 流动水，比脚部方块名准确；
	// prismarine-physics 未跑到该 tick 时字段缺失，如实 null + unknown。
	const entity = bot.entity as unknown as { isInWater?: unknown; isInLava?: unknown };
	const inWater = typeof entity.isInWater === "boolean" ? entity.isInWater : null;
	const inLava = typeof entity.isInLava === "boolean" ? entity.isInLava : null;
	if (inWater == null) unknown.push("inWater not observed: client physics has not resolved water contact yet");
	if (inLava == null) unknown.push("inLava not observed: client physics has not resolved lava contact yet");

	const effects: StatusEffectValue[] = [];
	for (const rec of trackVitals(bot).effects()) {
		if (typeof rec.id !== "number") {
			unknown.push("effect entry without id");
			continue;
		}
		const name = bot.registry.effects[rec.id]?.name;
		if (name == null) {
			unknown.push(`effect id ${rec.id} not in registry`);
			continue;
		}
		effects.push({
			name: name
				.replace(/([a-z])([A-Z])/g, "$1_$2")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_"),
			amplifier: rec.amplifier ?? 0,
			seconds: rec.seconds,
		});
	}
	const xpLevel = bot.experience?.level ?? null;
	if (xpLevel == null) unknown.push("xp level not received");
	const yaw = typeof bot.entity.yaw === "number" ? bot.entity.yaw : null;
	const pitch = typeof bot.entity.pitch === "number" ? bot.entity.pitch : null;
	if (yaw == null || pitch == null) unknown.push("look direction not received");

	const value: SelfState = {
		place: {
			world: scope.world,
			worldRevision: scope.worldRevision,
			dimension: bot.game.dimension ?? "unknown",
			position: pos,
		},
		velocity,
		health,
		food,
		onGround: bot.entity.onGround === true,
		maxHealth,
		saturation,
		oxygen,
		inWater,
		inLava,
		effects: bot.entity.effects == null ? null : effects,
		xpLevel,
		look: yaw == null || pitch == null ? null : { yaw, pitch },
	};
	// 来源：位置/速度/落地是客户端预测；其余来自服务器包 → mixed + basis。
	return {
		value,
		...factBase(unknown, "mixed"),
		basis: [
			{
				paths: ["/place/position", "/velocity", "/onGround", "/inWater", "/inLava", "/look"],
				source: "prediction",
				observedAt: nowIso(),
				evidence: [],
			},
			{
				paths: ["/health", "/food", "/saturation", "/oxygen", "/effects", "/xpLevel", "/place/dimension"],
				source: "server",
				observedAt: nowIso(),
				evidence: [],
			},
		],
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<SelfState | null>;
}

// ---- inventory ----

function inventoryFact(ctx: FactViewContext): Fact<ClientInventoryValue | null> {
	const { bot, stamp } = ctx;
	const snapshot = protocolFor(bot).playerSnapshot();
	if (snapshot == null) return absent<ClientInventoryValue>("authoritative inventory has not arrived");
	const unknown: string[] = [];
	const slots: ClientSlotValue[] = snapshot.slots.map((entry) => ({
		slot: entry.slot,
		known: true,
		item: entry.item as unknown as import("../../contracts/body.js").ItemValue | null,
	}));
	if (slots.some((slot) => slot.item != null && slot.item.components == null))
		unknown.push("some item components unavailable");
	const value: ClientInventoryValue = {
		revision: snapshot.revision,
		layout: {
			slotCount: snapshot.layout.slotCount,
			regions: [
				{ name: "crafting", slots: [0, 1, 2, 3, 4] },
				{ name: "armor", slots: [5, 6, 7, 8] },
				{ name: "main", slots: range(9, 35) },
				{ name: "hotbar", slots: range(36, 44) },
				{ name: "offhand", slots: snapshot.layout.slotCount > 45 ? [45] : [] },
			],
		},
		slots,
		selectedSlot: typeof bot.quickBarSlot === "number" ? bot.quickBarSlot : null,
	};
	return {
		value,
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientInventoryValue | null>;
}

// ---- block ----

function blockFact(ctx: FactViewContext, target: BlockTarget): Fact<ClientBlockValue> {
	const { bot, stamp } = ctx;
	const block = bot.blockAt(toMineflayerVec3(target.block));
	if (block == null) {
		return {
			value: { target, state: null, sign: null },
			...factBase([`block at ${fmtVec(target.block)} not loaded`]),
		} as Fact<ClientBlockValue>;
	}
	const state: BlockStateValue = blockStateOf(block);
	const unknown: string[] = [];
	// 牌面数据未捕获：null + unknown，不当空白牌面。
	if (block.name.includes("sign")) unknown.push("sign text not captured in I1");
	return {
		value: { target, state, sign: null },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientBlockValue>;
}

// ---- sections ----

/** 逐格扫描建 palette+indices（与 mineflayer findBlocks 同一策略；代价随体量线性增长）。 */
function sectionsFact(ctx: FactViewContext, targets: SectionTarget[]): Fact<ClientSectionsValue> {
	const { bot, stamp } = ctx;
	const sections: ClientSectionsValue["sections"] = [];
	const unknown: string[] = [];
	for (const target of targets) {
		const origin = target.section;
		const baseOriginX = origin.x * 16;
		const baseOriginY = origin.y * 16;
		const baseOriginZ = origin.z * 16;
		const palette: BlockStateValue[] = [];
		const paletteIndex = new Map<string, number>();
		const indices: (number | null)[] = new Array(4096).fill(null);
		let loaded = true;
		for (let y = 0; y < 16 && loaded; y++) {
			for (let z = 0; z < 16 && loaded; z++) {
				for (let x = 0; x < 16 && loaded; x++) {
					const block = bot.blockAt(toMineflayerVec3({ x: baseOriginX + x, y: baseOriginY + y, z: baseOriginZ + z }));
					if (block == null) {
						loaded = false;
						break;
					}
					const state: BlockStateValue = blockStateOf(block);
					const key = state.name + JSON.stringify(state.properties);
					let idx = paletteIndex.get(key);
					if (idx == null) {
						idx = palette.length;
						palette.push(state);
						paletteIndex.set(key, idx);
					}
					indices[y * 256 + z * 16 + x] = idx;
				}
			}
		}
		if (!loaded) {
			unknown.push(`section ${fmtVec(origin)} not fully loaded`);
			sections.push({ target, revision: `sec-rev:${stamp.sequence}`, base: null, patches: [] });
			continue;
		}
		sections.push({ target, revision: `sec-rev:${stamp.sequence}`, base: { palette, indices }, patches: [] });
	}
	return {
		value: { sections },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientSectionsValue>;
}

// ---- entities ----

/**
 * 掉落物实体 → 物品栈。走 prismarine-entity 的版本无关取法（内部按
 * supportFeature('metadataIxOfItem') 定位 notch Slot），不手写元数据索引。
 * 解析不出来就是 null：元数据可能还没到，不能猜成"空物品"。
 */
function droppedItemOf(entity: unknown): { name: string; count: number } | null {
	const candidate = entity as {
		getDroppedItem?: () => { name?: unknown; count?: unknown } | null;
	};
	try {
		const stack = candidate.getDroppedItem?.();
		if (stack == null || typeof stack.name !== "string") return null;
		return { name: stack.name, count: typeof stack.count === "number" ? stack.count : 1 };
	} catch {
		return null;
	}
}

/** 实体引用方案（§5.1）：连接 + 化身 + 外观代次 + 网络 id。 */
function entityRefOf(id: number, stamp: ClientFactStamp): EntityRef {
	return {
		connection: stamp.connection ?? "unknown",
		incarnation: stamp.incarnation ?? "unknown",
		appearance: `ap:${id}`,
		networkId: id,
	};
}

function entitiesFact(ctx: FactViewContext): Fact<ClientEntitiesValue> {
	const { bot, stamp } = ctx;
	const entities: ClientEntitiesValue["entities"] = [];
	// 实体元数据只取了掉落物栈，其余仍未采集；coverage 保持 partial 是事实，不是保守。
	const unknown: string[] = ["entity metadata other than item stacks is not captured"];
	const unresolved: number[] = [];
	for (const entity of Object.values(bot.entities)) {
		const e = entity as unknown as {
			id: number;
			type?: string;
			name?: string;
			uuid?: string;
			position?: { x: number; y: number; z: number };
			velocity?: { x: number; y: number; z: number };
		};
		if (e?.id == null) continue;
		const ref: EntityRef = entityRefOf(e.id, stamp);
		const item = droppedItemOf(entity);
		if (item == null && (e.name === "item" || e.type === "item")) unresolved.push(e.id);
		entities.push({
			ref,
			uuid: e.uuid ?? null,
			type: e.name ?? e.type ?? null,
			position: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
			velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
			metadata: null,
			item,
		});
	}
	if (unresolved.length > 0) {
		unknown.push(`dropped item stack not parsed yet for network ids: ${unresolved.slice(0, 8).join(",")}`);
	}
	const selfId = (bot.entity as unknown as { id?: number } | undefined)?.id;
	const selfRef: EntityRef | null = selfId == null ? null : entityRefOf(selfId, stamp);
	return {
		value: { extent: "tracked", entities, selfRef },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientEntitiesValue>;
}

// ---- players（服务器公告名单） ----

const GAME_MODE_NAMES: Record<number, string> = { 0: "survival", 1: "creative", 2: "adventure", 3: "spectator" };

/**
 * 名单 = 服务器实际公告的 player_info 花名册（bot.players），采样时刻同步投影。
 * 未收到任何名单事件时 null + unknown（名单未到 ≠ 空服，capabilities.md §players）。
 * 关联实体按采样时刻重新解析：mineflayer 的 player.entity 只在 player_info 时刷新，
 * 实体离开跟踪范围后可能滞留旧引用，不能直接信任。
 */
function playersFact(ctx: FactViewContext): Fact<ClientPlayersValue | null> {
	if (!ctx.rosterSeen) return absent<ClientPlayersValue>("server roster has not arrived yet");
	const { bot, stamp } = ctx;
	const unknown: string[] = [];
	const roster = (bot as unknown as { players?: Record<string, unknown> }).players ?? {};
	const trackedPlayers = new Map<string, number>();
	for (const entity of Object.values(bot.entities)) {
		const e = entity as unknown as { id?: number; type?: string; username?: string };
		if (e?.id == null || e.type !== "player" || typeof e.username !== "string") continue;
		trackedPlayers.set(e.username, e.id);
	}
	const players: ClientListedPlayer[] = [];
	let someGameModeUnknown = false;
	for (const raw of Object.values(roster)) {
		const player = raw as {
			username?: unknown;
			uuid?: unknown;
			displayName?: { toString?: unknown } | null;
			gamemode?: unknown;
			ping?: unknown;
		};
		// 名单键就是 username；无名条目无法成形，跳过并如实计入 unknown。
		if (typeof player.username !== "string" || player.username.length === 0) {
			unknown.push("a listed player entry without username was skipped");
			continue;
		}
		const gameMode = typeof player.gamemode === "number" ? (GAME_MODE_NAMES[player.gamemode] ?? null) : null;
		if (gameMode == null) someGameModeUnknown = true;
		const entityId = trackedPlayers.get(player.username) ?? null;
		players.push({
			name: player.username,
			uuid: typeof player.uuid === "string" && player.uuid.length > 0 ? player.uuid : null,
			displayName: chatTextOf(player.displayName),
			latencyMs: typeof player.ping === "number" ? player.ping : null,
			gameMode,
			entity: entityId == null ? null : entityRefOf(entityId, stamp),
		});
	}
	if (someGameModeUnknown) unknown.push("game mode of some listed players not received yet");
	return {
		value: { extent: "server_listed", players },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientPlayersValue | null>;
}

/** ChatMessage 纯文本化；形状不符时如实 null（mineflayer 恒给 ChatMessage，此处只防形变）。 */
function chatTextOf(value: { toString?: unknown } | null | undefined): string | null {
	if (value == null) return null;
	const toString = value.toString;
	// 裸对象会继承 Object.prototype.toString，产出 "[object Object]" 垃圾值——与没有一样。
	if (typeof toString !== "function" || toString === Object.prototype.toString) return null;
	try {
		const text = (toString as () => string).call(value);
		return typeof text === "string" ? text : null;
	} catch {
		return null;
	}
}

// ---- world（环境读数） ----

/** 原版时间轴分桶：0 日出、6000 正午、12000 日落、18000 午夜。 */
function timeBucket(ticks: number): NonNullable<ClientWorldValue["timeOfDay"]> {
	const t = ((ticks % 24000) + 24000) % 24000;
	if (t < 1000 || t >= 23000) return "dawn";
	if (t < 5000) return "day";
	if (t < 7000) return "noon";
	if (t < 12000) return "day";
	if (t < 14000) return "dusk";
	return "night";
}

function worldFact(ctx: FactViewContext): Fact<ClientWorldValue> {
	const { bot, stamp } = ctx;
	const unknown: string[] = [];
	const time = (bot as unknown as { time?: { timeOfDay?: number; day?: number } }).time;
	const ticks = typeof time?.timeOfDay === "number" ? time.timeOfDay : null;
	const dayCount = typeof time?.day === "number" ? time.day : null;
	if (ticks == null) unknown.push("world time not received");
	if (dayCount == null) unknown.push("world day count not received");

	const thunder =
		typeof (bot as unknown as { thunderState?: number }).thunderState === "number"
			? (bot as unknown as { thunderState: number }).thunderState
			: null;
	const raining =
		typeof (bot as unknown as { isRaining?: boolean }).isRaining === "boolean"
			? (bot as unknown as { isRaining: boolean }).isRaining
			: null;
	if (thunder == null && raining == null) unknown.push("weather state not received");
	let weather: ClientWorldValue["weather"] = null;
	if (thunder != null && thunder > 0) weather = "thunder";
	else if (raining === true) weather = "rain";
	else if (raining === false || thunder === 0) weather = "clear";

	let biome: string | null = null;
	const pos = bot.entity?.position;
	if (pos != null) {
		const bx = Math.floor(pos.x);
		const by = Math.floor(pos.y);
		const bz = Math.floor(pos.z);
		// prismarine-biome 对未登记的 id 会退回空名字；这里直接取 chunk 的 biome id
		// 再查注册表（同一版本数据），读不到才如实 unknown。
		const column = bot.world.getColumn(bx >> 4, bz >> 4) as unknown as {
			getBiome?: (point: { x: number; y: number; z: number }) => number;
		} | null;
		const biomeId = column?.getBiome?.({ x: bx & 15, y: by, z: bz & 15 });
		const registry = bot.registry as unknown as { biomes?: Record<string, { name?: string }> };
		const byId = biomeId == null ? undefined : registry.biomes?.[String(biomeId)];
		if (typeof byId?.name === "string" && byId.name.length > 0) {
			biome = byId.name.toLowerCase();
		} else {
			const feet = bot.blockAt(toMineflayerVec3({ x: bx, y: by, z: bz }));
			const resolved = (feet as unknown as { biome?: { name?: string } } | null)?.biome?.name;
			if (typeof resolved === "string" && resolved.length > 0) biome = resolved.toLowerCase();
		}
	}
	if (biome == null) unknown.push("biome not resolved from loaded chunk");

	const value: ClientWorldValue = {
		dimension: bot.game.dimension ?? "unknown",
		timeOfDay: ticks == null ? null : timeBucket(ticks),
		ticks,
		dayCount,
		weather,
		biome,
		difficulty: bot.game.difficulty ?? null,
		gameMode: bot.game.gameMode ?? null,
		// 服务端未单独下发重生点维度；不按当前维度猜一个 Place。
		spawn: null,
	};
	if (value.difficulty == null) unknown.push("difficulty not received");
	if (value.gameMode == null) unknown.push("game mode not received");
	if (value.spawn == null) unknown.push("spawn point/dimension not reported by protocol");
	// 时间与天气来自服务端包，维度来自 game state；生物群系来自已加载区块。
	return {
		value,
		...factBase(unknown),
		basis: [
			{
				paths: ["/ticks", "/dayCount", "/weather", "/difficulty", "/gameMode"],
				source: "server",
				observedAt: nowIso(),
				evidence: [],
			},
			{ paths: ["/biome"], source: "server", observedAt: nowIso(), evidence: [] },
			{ paths: ["/dimension"], source: "server", observedAt: nowIso(), evidence: [] },
		],
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientWorldValue>;
}

// ---- searchBlocks（按名字扫方块） ----

/** 名字规范化：注册表名不带命名空间，输入允许带 minecraft: 前缀。 */
function stripNamespace(name: string): string {
	return name.replace(/^minecraft:/, "");
}

function searchBlocksFact(ctx: FactViewContext, request: ClientBlockSearchRequest): Fact<ClientBlockSearchValue> {
	const { bot, stamp } = ctx;
	const name = stripNamespace(request.name);
	const unknown: string[] = [];
	const empty: ClientBlockSearchValue = {
		matches: [],
		scanned: { radius: request.radius, chunksLoaded: 0 },
		capped: false,
	};
	const registry = bot.registry as unknown as {
		blocksByName?: Record<string, { minStateId?: number; maxStateId?: number }>;
	};
	const info = registry.blocksByName?.[name];
	if (info == null || info.minStateId == null || info.maxStateId == null) {
		return { value: empty, ...factBase([`unknown block name: ${name}`]) } as Fact<ClientBlockSearchValue>;
	}
	const minState = info.minStateId;
	const maxState = info.maxStateId;

	const position = bot.entity?.position;
	if (position == null)
		return { value: empty, ...factBase(["entity position not available"]) } as Fact<ClientBlockSearchValue>;

	const px = position.x;
	const py = position.y;
	const pz = position.z;
	const radiusSq = request.radius * request.radius;
	const cap = Math.max(1, Math.min(request.limit, 4096));
	const excluded = new Set(request.exclude.map(fmtVec));
	const game = bot.game as unknown as { height?: number; minY?: number };
	const sectionCount = Math.max(1, Math.floor((game.height ?? 384) / 16));
	const minY = typeof game.minY === "number" ? game.minY : -64;

	const cxMin = Math.floor((px - request.radius) / 16);
	const cxMax = Math.floor((px + request.radius) / 16);
	const czMin = Math.floor((pz - request.radius) / 16);
	const czMax = Math.floor((pz + request.radius) / 16);

	interface CandidateSection {
		cx: number;
		cz: number;
		index: number;
		originY: number;
		distanceSq: number;
	}
	const sections: CandidateSection[] = [];
	let chunksLoaded = 0;
	for (let cx = cxMin; cx <= cxMax; cx++) {
		for (let cz = czMin; cz <= czMax; cz++) {
			const column = bot.world.getColumn(cx, cz) as unknown as { sections?: unknown[] } | null;
			if (column?.sections == null) continue;
			chunksLoaded++;
			for (let index = 0; index < sectionCount; index++) {
				const originY = minY + index * 16;
				// 用这一段的"最近点"而不是中心排序：玩家常常正好站在段边界上，
				// 按中心排会让脚下这段排到后面，命中上限时反而把最近的方块漏掉。
				const nearestX = Math.min(Math.max(px, cx * 16), cx * 16 + 15);
				const nearestY = Math.min(Math.max(py, originY), originY + 15);
				const nearestZ = Math.min(Math.max(pz, cz * 16), cz * 16 + 15);
				sections.push({
					cx,
					cz,
					index,
					originY,
					distanceSq: (nearestX - px) ** 2 + (nearestY - py) ** 2 + (nearestZ - pz) ** 2,
				});
			}
		}
	}
	// 近段先扫：命中上限时留下的就是最近的一批。
	sections.sort((a, b) => a.distanceSq - b.distanceSq);

	const matches: { position: { x: number; y: number; z: number }; name: string }[] = [];
	let capped = false;
	const distSqOf = (point: { x: number; y: number; z: number }): number =>
		(point.x - px) ** 2 + (point.y - py) ** 2 + (point.z - pz) ** 2;
	const sortMatches = (): void => {
		matches.sort((a, b) => distSqOf(a.position) - distSqOf(b.position));
	};
	for (const section of sections) {
		// 已经够数时，只有"最近点比已保留的最远一条还近"的段才值得继续扫。
		if (
			matches.length >= cap &&
			section.distanceSq > distSqOf(matches[matches.length - 1]?.position ?? { x: 0, y: 0, z: 0 })
		) {
			break;
		}
		const column = bot.world.getColumn(section.cx, section.cz) as unknown as { sections: unknown[] };
		const raw = column.sections[section.index] as { palette?: number[] } | undefined;
		if (raw == null) continue;
		// 调色板跳过：不含目标状态 id 的段不可能有该方块。
		if (raw.palette != null) {
			let present = false;
			for (const stateId of raw.palette) {
				if (stateId >= minState && stateId <= maxState) {
					present = true;
					break;
				}
			}
			if (!present) continue;
		}
		const baseX = section.cx * 16;
		const baseZ = section.cz * 16;
		for (let y = 0; y < 16; y++) {
			for (let z = 0; z < 16; z++) {
				for (let x = 0; x < 16; x++) {
					const wx = baseX + x;
					const wy = section.originY + y;
					const wz = baseZ + z;
					const dx = wx - px;
					const dy = wy - py;
					const dz = wz - pz;
					if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
					const point = { x: wx, y: wy, z: wz };
					if (excluded.has(fmtVec(point))) continue;
					const block = bot.blockAt(toMineflayerVec3(point));
					if (block?.name !== name) continue;
					matches.push({ position: point, name });
				}
			}
		}
		if (matches.length > cap) {
			sortMatches();
			matches.length = cap;
			capped = true;
		}
	}

	matches.sort((a, b) => {
		const da = (a.position.x - px) ** 2 + (a.position.y - py) ** 2 + (a.position.z - pz) ** 2;
		const db = (b.position.x - px) ** 2 + (b.position.y - py) ** 2 + (b.position.z - pz) ** 2;
		if (da !== db) return da - db;
		return a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z;
	});
	if (capped) unknown.push(`search stopped at the ${cap}-match cap; more blocks may exist in range`);

	return {
		value: { matches, scanned: { radius: request.radius, chunksLoaded }, capped },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientBlockSearchValue>;
}

function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = from; i <= to; i++) out.push(i);
	return out;
}

function fmtVec(v: Vec3): string {
	return `${v.x},${v.y},${v.z}`;
}
