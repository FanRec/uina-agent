import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { ClientFactNotice, ClientWindowObservation } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import { resolveContainerQuery } from "../../.uina/worlds/minecraft/world/containers.js";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

function observation(count = 3): ClientWindowObservation {
	return {
		target: {
			place: { world: "world:t:1", worldRevision: "wrev:t:1", dimension: "overworld", position: { x: 2, y: 64, z: 3 } },
			block: { x: 2, y: 64, z: 3 },
		},
		snapshot: {
			window: "win:t:1",
			type: "minecraft:generic_9x3",
			revision: 1,
			layout: {
				slotCount: 3,
				regions: [
					{ name: "container", slots: [0, 1] },
					{ name: "player", slots: [2] },
				],
			},
			properties: {},
			slots: [
				{ slot: 0, item: { name: "stone", count, components: null } },
				{ slot: 1, item: null },
				{ slot: 2, item: { name: "diamond", count: 64, components: null } },
			],
			cursor: null,
		},
	};
}

const validators = buildCapabilities({
	knowledge: () => null,
	runtime: () => {
		throw new Error("unused");
	},
	gotoDirector: {} as never,
}).validators;

describe("window facts and container history", () => {
	test("current window snapshots are isolated values; close and source resets retain captured evidence", () => {
		const h = makeFactsHarness();
		const notices: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => notices.push(notice));
		const before = h.facts.sample((view) => view.window());
		const value = observation();
		h.facts.publishWindow(value);
		value.snapshot.slots[0]!.item = null;
		const first = h.facts.sample((view) => view.window());
		expect(first.stamp.sequence).toBeGreaterThan(before.stamp.sequence);
		expect(first.value.value!.slots[0]!.item).toMatchObject({ name: "stone", count: 3 });
		first.value.value!.slots[0]!.item = null;
		expect(h.facts.sample((view) => view.window()).value.value!.slots[0]!.item).toMatchObject({ count: 3 });
		h.facts.publishWindow(null);
		expect(h.facts.sample((view) => view.window()).value.value).toBeNull();
		h.facts.publishWindow(observation(4));
		h.disconnect();
		h.reconnect();
		expect(h.facts.sample((view) => view.window()).value.value).toBeNull();
		const windows = notices
			.flatMap((notice) => (notice.kind === "evidence" ? notice.records : []))
			.filter((record) => record.schema === "client.window@1");
		expect(windows).toHaveLength(2);
		expect(windows[0]!.fact.value).toMatchObject({
			snapshot: {
				slots: [
					{ slot: 0, item: { count: 3 } },
					{ slot: 1, item: null },
					{ slot: 2, item: { count: 64 } },
				],
			},
		});
		// Source changes seal old streams; they do not silently discard their pending payloads.
		const pending = (h.facts as unknown as { pendingEvidence: { record: { ref: string } }[] }).pendingEvidence;
		expect(pending.some((entry) => entry.record.ref === windows[0]!.ref)).toBe(true);
	});

	test("late evidence consumers replay original retained gap identities and payloads", () => {
		const h = makeFactsHarness();
		const original: ClientFactNotice[] = [];
		h.facts.subscribe((notice) => original.push(notice));
		for (let i = 0; i < 1030; i++) h.emitMessage(`before-consumer-${i}`);
		const replay: ClientFactNotice[] = [];
		const sub = h.facts.subscribe((notice) => replay.push(notice), { consumesEvidence: true });
		expect(replay.filter((notice) => notice.kind === "evidence_gap")).toEqual(
			original.filter((notice) => notice.kind === "evidence_gap"),
		);
		const records = replay.flatMap((notice) => (notice.kind === "evidence" ? notice.records : []));
		expect(records).toHaveLength(1024);
		expect(records.at(-1)!.mark).toEqual(sub.evidenceThrough);
		sub.acknowledge({
			receiver: "test",
			stream: sub.evidenceThrough.stream,
			durableThrough: sub.evidenceThrough.sequence,
		});
		const retained = h.facts as unknown as { pendingEvidence: unknown[]; pendingGaps: unknown[] };
		expect(retained.pendingEvidence).toHaveLength(0);
		expect(retained.pendingGaps).toHaveLength(0);
	});

	test("explicit dimensions resolve offline; relative coordinates use the current feet block", () => {
		const h = makeFactsHarness();
		h.disconnect();
		expect(
			resolveContainerQuery(
				{ at: { position: { x: -2, y: 64, z: 3 }, dimension: "nether" } },
				{ world: "w", worldRevision: "r" },
				h.facts,
			),
		).toEqual({ world: "w", worldRevision: "r", dimension: "nether", block: { x: -2, y: 64, z: 3 } });
		expect(() =>
			resolveContainerQuery({ at: { x: 2, y: 64, z: 3 } }, { world: "w", worldRevision: "r" }, h.facts),
		).toThrow();
		expect(() =>
			validators.get("container.last@1")!({ at: { position: { x: 2.5, y: 64, z: 3 }, dimension: "nether" } }),
		).toThrow(/integer/);
		h.reconnect(
			makeBot({
				entity: { position: { x: 10.5, y: 64, z: -3.25 }, velocity: { x: 0, y: 0, z: 0 } },
				game: { dimension: "overworld" },
				registry: { effects: {} },
			}),
		);
		const self = h.facts.sample((view) => view.self()).value.value!;
		expect(
			resolveContainerQuery({ at: { rel: { x: -1, y: 0, z: 2 } } }, { world: "w", worldRevision: "r" }, h.facts).block,
		).toEqual({
			x: Math.floor(self.place.position.x) - 1,
			y: Math.floor(self.place.position.y),
			z: Math.floor(self.place.position.z) + 2,
		});
	});

	test("real SQLite worker persists mixed-schema evidence across restart and isolates explicit scopes", () => {
		// A normal Node subprocess avoids vmThreads loader/worker identity differences.
		// The production FactsSource -> HistoryIngest -> SQLite worker path is exercised unchanged.
		const dir = mkdtempSync(join(tmpdir(), "uina-container-history-"));
		const source = (path: string) => pathToFileURL(resolve(path)).href;
		const program = `
import assert from "node:assert/strict";
import { makeFactsHarness } from ${JSON.stringify(source("tests/mc/mc-fake.ts"))};
import { MinecraftWorld } from ${JSON.stringify(source(".uina/worlds/minecraft/world/index.ts"))};
import { buildCapabilities } from ${JSON.stringify(source(".uina/worlds/minecraft/capabilities/index.ts"))};
const value = ${JSON.stringify(observation())};
const dbPath = ${JSON.stringify(join(dir, "history.db"))};
const binding = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };
const h = makeFactsHarness({ namespace: "capture-first" });
const validators = buildCapabilities({ knowledge: () => null, runtime: () => { throw new Error("unused"); }, gotoDirector: {} }).validators;
const makeWorld = (facts, b = binding, path = dbPath) => new MinecraftWorld({ facts, readers: new Map(), validators, dbPath: path, binding: b, namespace: "history" });
const query = (dimension = "overworld", position = { x: 2, y: 64, z: 3 }) => ({ ref: "container.last@1", input: { at: { position, dimension } } });
let world = makeWorld(h.facts);
try {
 assert.equal(await world.historyReady, "ready");
 h.emitMessage("event before window");
 h.facts.publishWindow(value);
 h.facts.publishWindow(null);
 let result = await world.read(query());
 assert.equal(result.source, "history"); assert.equal(result.cursor, null);
 assert.deepEqual(result.value.counts, { stone: 3 });
 assert.deepEqual(result.value.contents, [{ slot: 0, name: "stone", count: 3 }]);
 assert.equal(result.value.complete, true);
 assert.equal(result.value.source, "window");
 assert.equal(h.facts.pendingEvidence.length, 0); // pre-subscription connection capture also reached durable ACK
 value.snapshot.revision++;
 value.snapshot.slots[0].item.count = 5;
 h.facts.publishWindow(value);
 h.emitMessage("event after window");
 // Entity containers stay in the journal but cannot shadow a block lookup.
 h.facts.publishWindow({ ...value, target: { connection: "c", incarnation: "i", appearance: "a", networkId: 1 } });
 h.facts.publishWindow({ ...value, target: { ...value.target, place: { ...value.target.place, dimension: "nether" } }, snapshot: { ...value.snapshot, slots: [{slot: 0, item: {name: "coal", count: 8}}] } });
 h.facts.publishWindow(null);
 assert.deepEqual((await world.read(query())).value.counts, {stone: 5});
 assert.equal((await world.read(query("nether"))).value.complete, false);
 assert.equal((await world.read(query("the_end"))).value.found, false);
 assert.equal((await world.read(query("overworld", {x: 3, y: 64, z: 3}))).value.found, false);
 const events = await world.read({ref: "events@1", input: {}});
 assert.equal(events.value.events.filter(event => event.payload.kind === "chat").length, 2);
 await assert.rejects(world.watch(query(), {stream: "s", epoch: "e", sequence: 0}, new AbortController().signal), error => error.code === "INVALID_INPUT");
 // Shutdown must flush a just-captured window before its scheduled microtask runs.
 value.snapshot.slots[0].item.count = 7;
 h.facts.publishWindow(value);
 h.facts.publishWindow(null);
} finally { await world.close(); }
const offline = makeFactsHarness({namespace: "capture-restart"}); offline.disconnect();
for (const [b, found] of [
 [{...binding, binding: "bind:restart"}, true],
 [{...binding, world: "world:other"}, false],
 [{...binding, worldRevision: "wrev:other"}, false],
]) {
 world = makeWorld(offline.facts, b);
 try {
  assert.equal(await world.historyReady, "ready");
  const result = await world.read(query()); assert.equal(result.value.found, found);
  if (found) assert.deepEqual(result.value.counts, {stone: 7});
 } finally { await world.close(); }
}
world = makeWorld(offline.facts, binding, ${JSON.stringify(join(dir, "missing", "history.db"))});
try {
 assert.equal(await world.historyReady, "unavailable");
 await assert.rejects(world.read(query()), error => error.code === "STORE_UNAVAILABLE");
} finally { await world.close(); }
console.log("container history SQLite integration passed");
`;
		try {
			const script = join(dir, "verify.mjs");
			writeFileSync(script, program);
			const output = execFileSync(process.execPath, ["--import", "tsx", script], {
				cwd: resolve("."),
				encoding: "utf8",
				timeout: 25_000,
				windowsHide: true,
			});
			expect(output).toContain("container history SQLite integration passed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
