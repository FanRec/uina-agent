/**
 * Client Facts 视图构建：prismarine 运行时 → 合同值（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.1、modules/driver.md §11。
 * 这里只做"读 + 成形"：不造值——读不到就 null + unknown 条目，不猜默认值。
 * players/map/window 在 I1 明确未实现，一律 null + unknown；实体 metadata 与
 * item components 未捕获，同样如实为 null。
 * 全部构建发生在 sample() 的同一同步边界内，闭包不外泄。
 */

import type {
	ClientBlockValue,
	ClientEntitiesValue,
	ClientFactScope,
	ClientFactStamp,
	ClientFactView,
	ClientInventoryValue,
	ClientMapValue,
	ClientPlayersValue,
	ClientSectionsValue,
	ClientSlotValue,
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
import { fromMineflayerVec3, toMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";

export interface FactViewContext {
	bot: MineflayerBot;
	scope: ClientFactScope;
	stamp: ClientFactStamp;
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
		players: () => absent<ClientPlayersValue>("players list not implemented in I1"),
		map: (_id) => absent<ClientMapValue>("map data not implemented in I1"),
		window: () => absent<WindowSnapshot>("window snapshots not implemented in I1"),
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
	const attrs = (bot.entity as unknown as { attributes?: Record<string, { base?: number }> }).attributes;
	const maxKey =
		attrs != null ? Object.keys(attrs).find((k) => k.endsWith("max_health") || k.endsWith("maxHealth")) : undefined;
	if (maxKey != null && typeof attrs?.[maxKey]?.base === "number") {
		maxHealth = attrs[maxKey].base ?? null;
	} else {
		unknown.push("maxHealth attribute not available");
	}

	const saturation =
		typeof (bot as unknown as { foodSaturation?: number }).foodSaturation === "number"
			? (bot as unknown as { foodSaturation: number }).foodSaturation
			: null;
	if (saturation == null) unknown.push("saturation not received");

	const oxygen =
		typeof (bot as unknown as { oxygen?: number }).oxygen === "number"
			? (bot as unknown as { oxygen: number }).oxygen
			: null;
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
	for (const eff of Object.values(bot.entity.effects ?? {})) {
		const rec = eff as unknown as { id?: number; amplifier?: number; duration?: number };
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
			name: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
			amplifier: rec.amplifier ?? 0,
			seconds: typeof rec.duration === "number" ? rec.duration / 20 : null,
		});
	}
	const xpLevel = bot.experience?.level ?? null;
	if (xpLevel == null) unknown.push("xp level not received");

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
		effects,
		xpLevel,
	};
	// 来源：位置/速度/落地是客户端预测；其余来自服务器包 → mixed + basis。
	return {
		value,
		...factBase(unknown, "mixed"),
		basis: [
			{
				paths: ["/place/position", "/velocity", "/onGround", "/inWater", "/inLava"],
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
	const win = bot.inventory;
	if (win == null || win.slots == null) return absent<ClientInventoryValue>("inventory window not received");

	const slots: ClientSlotValue[] = [];
	for (let i = 0; i < win.slots.length; i++) {
		const item = win.slots[i];
		if (item == null) {
			slots.push({ slot: i, known: true, item: null });
			continue;
		}
		slots.push({ slot: i, known: true, item: { name: item.name, count: item.count, components: null } });
	}
	const unknown: string[] = ["item components not captured in I1"];
	const value: ClientInventoryValue = {
		revision: stamp.sequence,
		layout: {
			slotCount: win.slots.length,
			regions: [
				{ name: "crafting", slots: [0, 1, 2, 3, 4] },
				{ name: "armor", slots: [5, 6, 7, 8] },
				{ name: "main", slots: range(9, 35) },
				{ name: "hotbar", slots: range(36, 44) },
				{ name: "offhand", slots: win.slots.length > 45 ? [45] : [] },
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

function entitiesFact(ctx: FactViewContext): Fact<ClientEntitiesValue> {
	const { bot, stamp } = ctx;
	const entities: ClientEntitiesValue["entities"] = [];
	const unknown: string[] = ["entity metadata not captured in I1"];
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
		const ref: EntityRef = {
			connection: stamp.connection ?? "unknown",
			incarnation: stamp.incarnation ?? "unknown",
			appearance: `ap:${e.id}`,
			networkId: e.id,
		};
		entities.push({
			ref,
			uuid: e.uuid ?? null,
			type: e.name ?? e.type ?? null,
			position: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
			velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
			metadata: null,
		});
	}
	return {
		value: { extent: "tracked", entities },
		...factBase(unknown),
		connection: stamp.connection ?? undefined,
		incarnation: stamp.incarnation ?? undefined,
	} as Fact<ClientEntitiesValue>;
}

function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = from; i <= to; i++) out.push(i);
	return out;
}

function fmtVec(v: Vec3): string {
	return `${v.x},${v.y},${v.z}`;
}
