import { describe, expect, test } from "vitest";
import type { ClientFactView } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { CallFailure, Fact, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";

/**
 * 能力层查询 reader（capabilities §3）。
 *
 * 覆盖 doc 与实现的接缝：self 从同一份库存补 held/armor、inventory 的
 * counts/usedSlots/freeSlots、block@1 的 at/below 与"未加载 ≠ 空气"、
 * entities 的自身排除与分类过滤、item/recipe 的静态知识面与差额计划。
 */

const registry: RegistryLike = {
	version: { minecraftVersion: "1.21.11" },
	itemsByName: {
		air: { id: 0, name: "air" },
		stone: { id: 1, name: "stone", stackSize: 64 },
		oak_log: { id: 17, name: "oak_log", stackSize: 64 },
		stick: { id: 946, name: "stick", stackSize: 64 },
		oak_planks: { id: 5, name: "oak_planks", stackSize: 64 },
		apple: { id: 893, name: "apple", stackSize: 64 },
		diamond_sword: { id: 900, name: "diamond_sword", stackSize: 1, maxDurability: 1561 },
	},
	items: {
		0: { id: 0, name: "air" },
		5: { id: 5, name: "oak_planks" },
		17: { id: 17, name: "oak_log" },
		893: { id: 893, name: "apple" },
		900: { id: 900, name: "diamond_sword" },
		946: { id: 946, name: "stick" },
	},
	blocksByName: { stone: { id: 1, name: "stone" }, oak_log: { id: 17, name: "oak_log" } },
	foodsByName: { apple: { foodPoints: 4, saturation: 19.2 } },
	blockLoot: { oak_log: { block: "oak_log", drops: [{ item: "oak_log" }] } },
	entitiesByName: {
		zombie: { type: "hostile", category: "Hostile mobs" },
		cow: { type: "animal", category: "Passive mobs" },
	},
	recipes: {
		"5": [{ ingredients: [17], result: { id: 5, count: 4 } }],
		"946": [{ inShape: [[5], [5]], result: { id: 946, count: 4 } }],
	},
};

const knowledge = buildRegistryKnowledge(registry);
const capabilities = buildCapabilities({
	runtime: () => {
		throw new Error("runtime is not used by query readers");
	},
	gotoDirector: {} as never,
	knowledge: () => knowledge,
});

function readerOf(ref: string) {
	const reader = capabilities.readers.get(ref as `${string}@${string}`);
	if (reader == null) throw new Error(`no reader for ${ref}`);
	if (reader.kind === "static") return { kind: "static" as const, read: reader.read };
	return { kind: "current" as const, read: reader.read, cursor: reader.cursor ?? "observed" };
}

function fact<T>(value: T, unknown: string[] = []): Fact<T> {
	return {
		value,
		observedAt: "2026-01-01T00:00:00.000Z",
		source: "server",
		coverage: unknown.length > 0 ? "partial" : "complete",
		unknown,
		evidence: [],
	};
}

const self: SelfState = {
	place: { world: "wld:t", worldRevision: "wrev:t", dimension: "overworld", position: { x: 10, y: 64, z: 10 } },
	velocity: { x: 0, y: 0, z: 0 },
	health: 18,
	food: 17,
	onGround: true,
	maxHealth: null,
	saturation: null,
	oxygen: null,
	inWater: false,
	inLava: false,
	effects: [],
	xpLevel: 3,
	look: { yaw: 0, pitch: 0 },
};

const inventoryValue = {
	revision: 4,
	layout: {
		slotCount: 46,
		regions: [
			{ name: "armor", slots: [5, 6, 7, 8] },
			{ name: "main", slots: Array.from({ length: 27 }, (_, i) => 9 + i) },
			{ name: "hotbar", slots: Array.from({ length: 9 }, (_, i) => 36 + i) },
			{ name: "offhand", slots: [45] },
		],
	},
	slots: [
		{
			slot: 5,
			known: true,
			item: { name: "diamond_helmet", count: 1, stackSize: 1, durability: 20, components: null },
		},
		{ slot: 36, known: true, item: { name: "oak_log", count: 8, stackSize: 64, durability: null, components: null } },
		{ slot: 37, known: true, item: { name: "oak_log", count: 4, stackSize: 64, durability: null, components: null } },
		{ slot: 38, known: true, item: { name: "apple", count: 2, stackSize: 64, durability: null, components: null } },
		{ slot: 9, known: true, item: null },
	],
	selectedSlot: 0,
};

function makeView(overrides: Partial<ClientFactView> = {}): ClientFactView {
	const view = {
		scope: () => ({ binding: "bind:t", world: "wld:t", worldRevision: "wrev:t", dimension: "overworld" }),
		self: () => fact(self),
		inventory: () => fact(inventoryValue),
		block: () => fact({ target: { place: self.place, block: { x: 0, y: 0, z: 0 } }, state: null, sign: null }),
		sections: () => fact({ sections: [] }),
		entities: () => fact({ extent: "tracked", entities: [], selfRef: null }),
		world: () =>
			fact({
				dimension: "overworld",
				timeOfDay: "day",
				ticks: 4000,
				dayCount: 3,
				weather: "clear",
				biome: "plains",
				difficulty: "normal",
				gameMode: "survival",
				spawn: null,
			}),
		searchBlocks: () => fact({ matches: [], scanned: { radius: 32, chunksLoaded: 0 }, capped: false }),
		players: () => fact(null, ["players not implemented"]),
		map: () => fact(null, ["map not implemented"]),
		window: () => fact(null, ["window not implemented"]),
	} as unknown as ClientFactView;
	return { ...view, ...overrides } as ClientFactView;
}

function failureOf(fn: () => unknown): CallFailure {
	try {
		fn();
	} catch (err) {
		return err as CallFailure;
	}
	throw new Error("expected a CallFailure");
}

describe("self@1", () => {
	test("held/armor 保留库存物品的完整字段，未知来源由库存事实提供", () => {
		const reader = readerOf("self@1");
		if (reader.kind !== "current") throw new Error("self must be a current reader");
		const result = reader.read(makeView(), {} as JsonValue) as Fact<{
			held?: { name: string };
			armor: Record<string, { name: string }>;
			health: number | null;
		}>;
		expect(result.value.held).toMatchObject({
			name: "oak_log",
			count: 8,
			stackSize: 64,
			durability: null,
			components: null,
		});
		expect(result.value.armor.head).toMatchObject({
			name: "diamond_helmet",
			count: 1,
			components: null,
			durability: 20,
		});
		expect(result.value.armor.chest).toBeUndefined();
		expect(result.unknown.some((entry) => entry.includes("not captured"))).toBe(false);
		expect(result.value.health).toBe(18);
	});
});

describe("inventory@1", () => {
	test("counts 按物品聚合；usedSlots/freeSlots 只算主背包+快捷栏", () => {
		const reader = readerOf("inventory@1");
		if (reader.kind !== "current") throw new Error("inventory must be a current reader");
		const result = reader.read(makeView(), {} as JsonValue) as Fact<{
			counts: Record<string, number>;
			usedSlots: number;
			freeSlots: number;
			slots: { slot: number }[];
		}>;
		expect(result.value.counts).toEqual({ diamond_helmet: 1, oak_log: 12, apple: 2 });
		expect(result.value.usedSlots).toBe(3);
		expect(result.value.freeSlots).toBe(33);
		expect(result.value.slots.map((slot) => slot.slot)).toEqual([5, 36, 37, 38]);
	});
});

describe("block@1", () => {
	test("at 明确给出时按格读取；未加载如实 unknown（不是空气）", () => {
		const reader = readerOf("block@1");
		if (reader.kind !== "current") throw new Error("block must be a current reader");
		const result = reader.read(makeView(), { at: { x: 3, y: 64, z: -2 } } as JsonValue) as Fact<{
			block: { name: string; position: { x: number } } | null;
		}>;
		expect(result.value.block).toBeNull();
		expect(result.unknown.some((entry) => entry.includes("not loaded"))).toBe(true);
	});

	test("below 以脚下格为基准向下数", () => {
		let captured: { x: number; y: number; z: number } | null = null;
		const reader = readerOf("block@1");
		if (reader.kind !== "current") throw new Error("block must be a current reader");
		const view = makeView({
			block: ((target: { block: { x: number; y: number; z: number } }) => {
				captured = target.block;
				return fact({
					target,
					state: { name: "stone", properties: {} },
					sign: null,
				});
			}) as never,
		});
		reader.read(view, { below: 2 } as JsonValue);
		expect(captured).toEqual({ x: 10, y: 62, z: 10 });
	});
});

describe("blocks@1", () => {
	test("按 limit 截断、count 是命中数、capped 进 truncated", () => {
		const reader = readerOf("blocks@1");
		if (reader.kind !== "current") throw new Error("blocks must be a current reader");
		const matches = Array.from({ length: 6 }, (_, i) => ({ position: { x: i, y: 64, z: 0 }, name: "oak_log" }));
		const view = makeView({
			searchBlocks: () => fact({ matches, scanned: { radius: 32, chunksLoaded: 4 }, capped: false }),
		});
		const result = reader.read(view, { name: "oak_log", limit: 2 } as JsonValue) as Fact<{
			blocks: unknown[];
			count: number;
			truncated: boolean;
		}>;
		expect(result.value.blocks).toHaveLength(2);
		expect(result.value.count).toBe(6);
		expect(result.value.truncated).toBe(true);
	});
});

describe("entities@1", () => {
	const base = {
		extent: "tracked" as const,
		selfRef: { connection: "c", incarnation: "i", appearance: "a", networkId: 1 },
		entities: [
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 1 },
				uuid: null,
				type: "player",
				position: { x: 0, y: 64, z: 0 },
				velocity: null,
				metadata: null,
				item: null,
			},
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 7 },
				uuid: null,
				type: "zombie",
				position: { x: 3, y: 64, z: 4 },
				velocity: null,
				metadata: null,
				item: null,
			},
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 8 },
				uuid: null,
				type: "cow",
				position: { x: 30, y: 64, z: 0 },
				velocity: null,
				metadata: null,
				item: null,
			},
			{
				ref: { connection: "c", incarnation: "i", appearance: "a", networkId: 9 },
				uuid: null,
				type: "zombie",
				position: { x: 1, y: 64, z: 1 },
				velocity: null,
				metadata: null,
				item: null,
			},
		],
	};

	test("排除自身实体、按半径过滤、按分类筛选并按距离排序", () => {
		const reader = readerOf("entities@1");
		if (reader.kind !== "current") throw new Error("entities must be a current reader");
		// 自身在 (10,64,10)：两只僵尸 9.2 / 12.7 格可达，牛 30 格排除。
		const result = reader.read(makeView({ entities: () => fact(base) }), {
			radius: 16,
			kind: "hostile",
		} as JsonValue) as Fact<{ entities: { name: string; distance: number }[]; scanned: { radius: number } }>;
		expect(result.value.entities.map((entry) => entry.name)).toEqual(["zombie", "zombie"]);
		expect(result.value.entities[0]?.distance).toBeLessThan(result.value.entities[1]?.distance ?? 0);
		expect(result.value.entities.some((entry: { name: string }) => entry.name === "player")).toBe(false);
	});
});

describe("item@1 / recipe@1", () => {
	test("item 是静态读取：未知物品 NOT_FOUND，已知物品带 dataVersion", () => {
		const reader = readerOf("item@1");
		if (reader.kind !== "static") throw new Error("item must be static");
		expect(failureOf(() => reader.read({ name: "nope" } as JsonValue)).code).toBe("NOT_FOUND");
		const result = reader.read({ name: "apple" } as JsonValue) as Fact<{ dataVersion: string; food: unknown }>;
		expect(result.value.dataVersion).toBe("1.21.11");
		expect(result.value.food).toEqual({ hunger: 4, saturation: 19.2 });
	});

	test("recipe 带差额计划：need/have/missing 按当前库存实算", () => {
		const reader = readerOf("recipe@1");
		if (reader.kind !== "current") throw new Error("recipe must be a current reader");
		expect(reader.cursor).toBe("none");
		const result = reader.read(makeView(), { item: "oak_planks", count: 8 } as JsonValue) as Fact<{
			plan: {
				need: Record<string, number>;
				have: Record<string, number>;
				missing: Record<string, number>;
				steps: unknown[];
			};
		}>;
		expect(result.value.plan.need).toEqual({ oak_log: 2 });
		expect(result.value.plan.have.oak_log).toBe(12);
		expect(result.value.plan.missing).toEqual({});
	});
});

describe("目录完整性", () => {
	test("10 个查询声明齐全；历史由 World 读取（无 reader）", () => {
		expect(capabilities.queries.map((query) => query.ref).sort()).toEqual([
			"block@1",
			"blocks@1",
			"container.last@1",
			"entities@1",
			"events@1",
			"inventory@1",
			"item@1",
			"recipe@1",
			"self@1",
			"world@1",
		]);
		expect(capabilities.readers.has("events@1")).toBe(false);
		expect(capabilities.readers.has("container.last@1")).toBe(false);
	});

	test("13 个动作齐备，ref 不重复", () => {
		expect(capabilities.refs.sort()).toEqual([
			"attack@1",
			"chat@1",
			"collect@1",
			"container@1",
			"drop@1",
			"eat@1",
			"equip@1",
			"goto@1",
			"mine@1",
			"pickup@1",
			"place@1",
			"transfer@1",
			"use@1",
		]);
	});
});
