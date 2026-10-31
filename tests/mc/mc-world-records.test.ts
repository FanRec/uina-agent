/**
 * 领域记录存储（批11 G1）：真临时 SQLite 走完整 MinecraftWorld 路径。
 * 覆盖：CAS 矩阵、分区隔离、悬空证据拒绝、关闭重开持久化、places@1
 * kind/near 过滤与 record_version 观察、旧版本库拒绝。
 * 不需要真服；事实来源是同一 world-history.db。
 */

import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { ClientFactsPort } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { DomainRecord } from "../../.uina/worlds/minecraft/contracts/world.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";
import { PLACE_SCHEMA, placeRef, type PlaceValue } from "../../.uina/worlds/minecraft/world/places.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

const capabilities = buildCapabilities({
	surface: () => null,
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused");
	},
});
const binding = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-world-records-"));
	const h = makeFactsHarness({
		bot: makeBot({
			_client: new EventEmitter(),
			entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
			registry: { effects: {} },
			game: { dimension: "overworld" },
			entities: {},
		}),
	});
	const facts: ClientFactsPort = {
		sample: (fn) => h.facts.sample(fn),
		subscribe: (fn, options) => h.facts.subscribe(fn, options),
	};
	const open = (namespace: string, dbPath = join(root, "history.db")) =>
		new MinecraftWorld({
			facts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			dbPath,
			binding,
			namespace,
		});
	return { open };
}

function placeValue(overrides: Partial<PlaceValue> = {}): PlaceValue {
	return {
		name: "base",
		at: { position: { x: 10, y: 64, z: -20 }, dimension: "overworld" },
		kind: "home",
		savedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

type RecordWriteInput = Parameters<MinecraftWorld["writeRecord"]>[0];

function writeOf(value: PlaceValue, expectedRevision: number | null, evidence: string[] = []): RecordWriteInput {
	return {
		ref: placeRef(value.name),
		schema: PLACE_SCHEMA,
		world: binding.world,
		worldRevision: binding.worldRevision,
		expectedRevision,
		value: value as unknown as JsonValue,
		evidence,
	};
}

test("record CAS: null creates once, updates require the exact revision, schema cannot migrate", async () => {
	const { open } = await setup();
	const w = open("cas");
	try {
		const created = await w.writeRecord(writeOf(placeValue(), null));
		expect(created).toMatchObject({ ref: "place:base", revision: 1, schema: PLACE_SCHEMA });
		await expect(w.writeRecord(writeOf(placeValue(), null))).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(w.writeRecord(writeOf(placeValue(), 99))).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			w.writeRecord({
				...writeOf(placeValue(), 1),
				ref: placeRef("missing"),
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			w.writeRecord({
				...writeOf(placeValue(), 1),
				schema: "minecraft:place@2",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const updated = await w.writeRecord(
			writeOf(placeValue({ at: { position: { x: 1, y: 2, z: 3 }, dimension: "overworld" } }), 1),
		);
		expect(updated.revision).toBe(2);
		const read = await w.readRecord(placeRef("base"));
		expect(read).toMatchObject({ revision: 2, value: { name: "base", kind: "home" } });
		const removed = await w.removeRecord(placeRef("base"));
		expect(removed).toEqual({ removed: true });
		await expect(w.readRecord(placeRef("base"))).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await w.removeRecord(placeRef("base"))).toEqual({ removed: false });
	} finally {
		await w.close();
	}
});

test("records are partition-isolated and survive close/reopen; dangling evidence is rejected", async () => {
	const { open } = await setup();
	const root = await mkdtemp(join(tmpdir(), "uina-world-records-iso-"));
	const path = join(root, "history.db");
	const a = open("iso:a", path);
	try {
		await a.writeRecord(writeOf(placeValue({ name: "kept" }), null));
		// 分区隔离：同一 world 不同 worldRevision 互不可见（写走当前绑定，读同库手动核验分区列）。
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const rows = db.prepare("SELECT world, world_revision, ref FROM records").all();
			expect(rows).toEqual([{ world: binding.world, world_revision: binding.worldRevision, ref: "place:kept" }]);
		} finally {
			db.close();
		}
		await expect(
			a.writeRecord(writeOf(placeValue({ name: "dangling" }), null, ["ev:not-captured"])),
		).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
	} finally {
		await a.close();
	}
	const b = open("iso:b", path);
	try {
		const read = await b.readRecord(placeRef("kept"));
		expect(read).toMatchObject({ ref: "place:kept", revision: 1 });
	} finally {
		await b.close();
	}
});

test("places@1 filters by kind and near (same dimension only) and its watch fires on record writes", async () => {
	const { open } = await setup();
	const w = open("places");
	try {
		const write = (
			name: string,
			overrides: Partial<PlaceValue>,
			revision: number | null = null,
		): Promise<DomainRecord> => w.writeRecord(writeOf(placeValue({ name, ...overrides }), revision));
		await write("home-far", { kind: "home", at: { position: { x: 500, y: 64, z: 0 }, dimension: "overworld" } });
		await write("home-near", { kind: "home", at: { position: { x: 5, y: 64, z: 0 }, dimension: "overworld" } });
		await write("mine-nether", {
			kind: "mine",
			at: { position: { x: 5, y: 64, z: 0 }, dimension: "minecraft:the_nether" },
		});
		await write("farm-near", { kind: "farm", at: { position: { x: 8, y: 64, z: 0 }, dimension: "overworld" } });

		const all = await w.read<{ places: PlaceValue[] }>({ ref: "places@1", input: {} });
		expect(all.value.places.map((p) => p.name)).toEqual(["farm-near", "home-far", "home-near", "mine-nether"]);
		expect(all.cursor).not.toBeNull();

		const homes = await w.read<{ places: PlaceValue[] }>({ ref: "places@1", input: { kind: "home" } });
		expect(homes.value.places.map((p) => p.name)).toEqual(["home-far", "home-near"]);

		const near = await w.read<{ places: PlaceValue[] }>({ ref: "places@1", input: { near: 16 } });
		// near 只看当前维度（overworld）的距离；跨维度地点不被"附近的"过滤返回。
		expect(near.value.places.map((p) => p.name)).toEqual(["farm-near", "home-near"]);

		const watch = await w.watch({ ref: "places@1", input: {} }, all.cursor!, AbortSignal.timeout(2000));
		const next = watch.next(all.cursor!, AbortSignal.timeout(2000));
		await w.writeRecord(writeOf(placeValue({ name: "late" }), null));
		expect(await next).toMatchObject({ kind: "changed" });
		await watch.close();
	} finally {
		await w.close();
	}
});

test("history v3 store is rejected without migration; record ops fail explicitly while current reads live", async () => {
	const { open } = await setup();
	const root = await mkdtemp(join(tmpdir(), "uina-records-v3-"));
	const path = join(root, "history.db");
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO meta VALUES('schema_version','3')");
	db.close();
	const w = open("old", path);
	try {
		expect(await w.historyReady).toBe("unavailable");
		await expect(w.readRecord(placeRef("base"))).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
		await expect(w.writeRecord(writeOf(placeValue(), null))).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
		await expect(w.read({ ref: "places@1", input: {} })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
	} finally {
		await w.close();
	}
});
