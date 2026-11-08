import { describe, expect, test } from "vitest";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { EntityRef } from "../../.uina/worlds/minecraft/contracts/body.js";
import type {
	ClientEntitiesValue,
	ClientFactView,
	ClientPlayersValue,
} from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { Fact, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

/**
 * players@1 能力层（capabilities.md §players）：过滤/排序/截断/tracked join，
 * 以及 entities@1 的玩家名覆写（批16）。
 */

const capabilities = createCapabilityCatalog().bind({
	surface: () => null,
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused runtime");
	},
});

function readerOf(ref: string) {
	const reader = capabilities.readers.get(ref as `${string}@${string}`);
	if (reader == null) throw new Error(`no reader for ${ref}`);
	if (reader.kind !== "current") throw new Error(`${ref} must be a current reader`);
	return reader.read;
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

const selfRef: EntityRef = { connection: "conn:t", incarnation: "inc:t", appearance: "ap:7", networkId: 7 };
const kiteRef: EntityRef = { connection: "conn:t", incarnation: "inc:t", appearance: "ap:42", networkId: 42 };

const self = {
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

function entityEntry(id: number, type: string, position: { x: number; y: number; z: number } | null) {
	return {
		ref: { connection: "conn:t", incarnation: "inc:t", appearance: `ap:${id}`, networkId: id } as EntityRef,
		uuid: `uuid-${id}`,
		type,
		position,
		velocity: null,
		metadata: null,
		item: null,
		ignited: null,
	};
}

function rosterOf(players: ClientPlayersValue["players"]): Fact<ClientPlayersValue> {
	return fact({ extent: "server_listed", players });
}

function entitiesOf(entries: ReturnType<typeof entityEntry>[]): Fact<ClientEntitiesValue> {
	return fact({ extent: "tracked", entities: entries, selfRef });
}

function makeView(
	overrides: {
		players?: Fact<ClientPlayersValue | null>;
		entities?: Fact<ClientEntitiesValue>;
		self?: Fact<unknown>;
	} = {},
): ClientFactView {
	return {
		scope: () => ({ binding: "bind:t", world: "wld:t", worldRevision: "wrev:t", dimension: "overworld" }),
		self: () => overrides.self ?? fact(self),
		entities: () => overrides.entities ?? entitiesOf([]),
		players: () =>
			overrides.players ??
			rosterOf([
				{
					name: "Kite",
					uuid: "uuid-kite",
					displayName: "Kite",
					latencyMs: 40,
					gameMode: "survival",
					entity: { ...kiteRef },
				},
				{ name: "alpha", uuid: "uuid-alpha", displayName: null, latencyMs: null, gameMode: null, entity: null },
				{
					name: "Beta",
					uuid: "uuid-beta",
					displayName: "Beta",
					latencyMs: 1,
					gameMode: "creative",
					entity: { connection: "conn:t", incarnation: "inc:t", appearance: "ap:99", networkId: 99 },
				},
			]),
	} as unknown as ClientFactView;
}

interface PlayerRow {
	name: string;
	uuid: string | null;
	tracked: { ref: EntityRef; position: { x: number; y: number; z: number }; distance: number } | null;
}

function readPlayers(
	input: JsonValue,
	view: ClientFactView,
): Fact<{ players: PlayerRow[]; listedCount: number; truncated: boolean }> {
	return readerOf("players@1")(view, input) as Fact<{
		players: PlayerRow[];
		listedCount: number;
		truncated: boolean;
	}>;
}

describe("players@1：过滤、排序与截断", () => {
	test("结果按 name 稳定排序；tracked 关联与距离取当前跟踪代次", () => {
		const view = makeView({
			entities: entitiesOf([entityEntry(42, "player", { x: 13, y: 64, z: 14 })]),
		});
		const result = readPlayers({}, view);
		expect(result.value.players.map((row) => row.name)).toEqual(["Beta", "Kite", "alpha"]);
		const kite = result.value.players.find((row) => row.name === "Kite");
		// dist({13,64,14},{10,64,10}) = 5；join 命中跟踪代次内的实体。
		expect(kite?.tracked).toEqual({ ref: kiteRef, position: { x: 13, y: 64, z: 14 }, distance: 5 });
		// Beta 的名单实体（networkId 99）不在跟踪集合里：tracked=null + unknown。
		expect(result.value.players.find((row) => row.name === "Beta")?.tracked).toBeNull();
		expect(result.unknown).toContain(
			"tracked entity refs of some listed players were not observed in the current tracking generation",
		);
	});

	test("name 大小写不敏感精确筛选；listedCount 不受 limit 截断", () => {
		const view = makeView();
		const hit = readPlayers({ name: "kite" }, view);
		expect(hit.value.players.map((row) => row.name)).toEqual(["Kite"]);
		expect(hit.value.listedCount).toBe(1);
		expect(hit.value.truncated).toBe(false);
		const miss = readPlayers({ name: "kit" }, view);
		expect(miss.value.players).toEqual([]);
		expect(miss.value.listedCount).toBe(0);
		expect(miss.value.truncated).toBe(false);
		const capped = readPlayers({ limit: 1 }, view);
		expect(capped.value.players).toHaveLength(1);
		expect(capped.value.listedCount).toBe(3);
		expect(capped.value.truncated).toBe(true);
	});

	test("名单未到：空表 + 继承 unknown，不冒充空服", () => {
		const view = makeView({ players: fact(null, ["server roster has not arrived yet"]) });
		const result = readPlayers({}, view);
		expect(result.value).toEqual({ extent: "server_listed", players: [], listedCount: 0, truncated: false });
		expect(result.unknown).toContain("server roster has not arrived yet");
		expect(result.coverage).toBe("partial");
	});

	test("自身位置缺失：tracked 全部为 null + unknown，名单本身仍可读", () => {
		const view = makeView({ self: fact(null, ["entity not available"]) });
		const result = readPlayers({}, view);
		expect(result.value.players.every((row) => row.tracked === null)).toBe(true);
		expect(result.unknown).toContain("self position unavailable; tracked positions not resolved");
	});

	test("descriptor：可等待、非 feedback（合同口径）", () => {
		const descriptor = capabilities.queries.find((query) => query.ref === "players@1");
		expect(descriptor?.watchable).toBe(true);
		expect(descriptor?.feedback).toBe(false);
	});
});

describe("entities@1 玩家名覆写（批16）", () => {
	test("名单 join 命中：name 输出用户名，kind 仍按底层 type 判定", () => {
		const view = makeView({ entities: entitiesOf([entityEntry(42, "player", { x: 13, y: 64, z: 14 })]) });
		const result = readerOf("entities@1")(view, { kind: "player" } as JsonValue) as Fact<{
			entities: { name: string; kind: string }[];
		}>;
		expect(result.value.entities).toHaveLength(1);
		expect(result.value.entities[0]).toMatchObject({ name: "Kite", kind: "player" });
	});

	test("名单未到：回退 'player'，kind 筛选不受影响", () => {
		const view = makeView({
			players: fact(null, ["server roster has not arrived yet"]),
			entities: entitiesOf([entityEntry(42, "player", { x: 13, y: 64, z: 14 })]),
		});
		const result = readerOf("entities@1")(view, { kind: "player" } as JsonValue) as Fact<{
			entities: { name: string; kind: string }[];
		}>;
		expect(result.value.entities).toHaveLength(1);
		expect(result.value.entities[0]).toMatchObject({ name: "player", kind: "player" });
	});

	test("名单有但关联不上（范围外玩家）：该实体名保持 'player'", () => {
		const roster = rosterOf([
			{ name: "alpha", uuid: null, displayName: null, latencyMs: null, gameMode: null, entity: null },
		]);
		const result = readerOf("entities@1")(
			makeView({
				players: roster,
				entities: entitiesOf([entityEntry(42, "player", { x: 13, y: 64, z: 14 })]),
			}),
			{ kind: "player" } as JsonValue,
		) as Fact<{ entities: { name: string; kind: string }[] }>;
		expect(result.value.entities[0]).toMatchObject({ name: "player", kind: "player" });
	});
});
