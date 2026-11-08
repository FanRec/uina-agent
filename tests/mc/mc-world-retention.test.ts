import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type {
	CapturedClientFact,
	ClientWindowObservation,
} from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { EventPage } from "../../.uina/worlds/minecraft/contracts/world.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

const partition = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };
const prune = { partition, beforeStoreSeq: Number.MAX_SAFE_INTEGER };
const capabilities = createCapabilityCatalog().bind({
	surface: () => null,
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused");
	},
});
const events = { ref: "events@1" as const, input: {} };

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-world-retention-"));
	const dbPath = join(root, "world-history.db");
	const h = makeFactsHarness({ bot: makeBot({ _client: new EventEmitter() }) });
	const open = () =>
		new MinecraftWorld({
			facts: h.facts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			binding: partition,
			namespace: "retention",
			dbPath,
		});
	const sql = <T>(read: (db: DatabaseSync) => T): T => {
		const db = new DatabaseSync(dbPath);
		try {
			return read(db);
		} finally {
			db.close();
		}
	};
	let world = open();
	expect(await world.historyReady).toBe("ready");
	return {
		root,
		h,
		sql,
		get world() {
			return world;
		},
		async reopen() {
			await world.close();
			world = open();
			expect(await world.historyReady).toBe("ready");
		},
		async close() {
			await world.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("strong holds are durable, additive, idempotent and atomic; release permits explicit pruning", async () => {
	const s = await setup();
	try {
		s.h.emitMessage("one");
		s.h.emitMessage("two");
		s.h.emitMessage("three");
		const first = await s.world.read<EventPage>(events);
		const refs = first.value.events.filter((e) => (e.payload as { kind: string }).kind === "chat").map((e) => e.ref);
		const version = () => s.sql((db) => db.prepare("SELECT value FROM meta WHERE key='commit_version'").get()!.value);
		const before = version();
		await s.world.retain("run:one", [refs[0]!, refs[0]!]);
		await s.world.retain("run:one", [refs[1]!]);
		await expect(s.world.retain("run:failed", [refs[2]!, "evidence:missing"])).rejects.toMatchObject({
			code: "EVIDENCE_UNAVAILABLE",
		});
		expect(
			s.sql((db) => db.prepare("SELECT COUNT(*) AS n FROM evidence_holds WHERE owner='run:failed'").get()),
		).toMatchObject({ n: 0 });
		await s.world.retain("run:two", [refs[1]!]);
		expect(version()).toBe(before);
		await s.reopen();
		expect(await s.world.pruneHistory(prune)).toMatchObject({
			skippedRetained: 2,
			beforeStoreSeq: prune.beforeStoreSeq,
			oldestRetainedStoreSeq: expect.any(Number),
		});
		expect((await s.world.read<EventPage>(events)).value.events.map((e) => e.ref).sort()).toEqual(
			refs.slice(0, 2).sort(),
		);
		await s.world.release("run:one");
		await s.world.release("run:one");
		expect((await s.world.pruneHistory(prune)).removed).toBe(1);
		expect((await s.world.read<EventPage>(events)).value.events.map((e) => e.ref)).toEqual([refs[1]]);
		await s.world.release("run:two");
		expect((await s.world.pruneHistory(prune)).removed).toBe(1);
		await expect(s.world.retain("run:late", [refs[1]!])).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
		expect(s.world.availability().history.state).toBe("ready");
	} finally {
		await s.close();
	}
});

test("prune reports stable gaps, invalidates affected pages and watches, and never reuses the scan tail", async () => {
	const s = await setup();
	try {
		const baseline = await s.world.read<EventPage>(events);
		const after = baseline.value.after!;
		s.h.emitMessage("one");
		s.h.emitMessage("two");
		s.h.emitMessage("three");
		const page = await s.world.read<EventPage>({ ref: "events@1", input: { after, limit: 1 } });
		expect(page.value.next).toBeDefined();
		const all = await s.world.read<EventPage>(events);
		const tail = all.value.after!;
		const oldUpper = JSON.parse(Buffer.from(tail, "base64url").toString()).pos as number;
		const query = { ref: "events@1" as const, input: { after: tail } };
		const before = await s.world.read<EventPage>(query);
		const signal = AbortSignal.timeout(3000);
		const watch = await s.world.watch(query, before.cursor!, signal);
		const next = watch.next(before.cursor!, signal);
		const removed = await s.world.pruneHistory(prune);
		expect(removed.removed).toBeGreaterThan(0);
		expect(await next).toMatchObject({ kind: "changed" });
		await watch.close();
		await expect(s.world.read({ ref: "events@1", input: { cursor: page.value.next! } })).rejects.toMatchObject({
			code: "SNAPSHOT_EXPIRED",
		});
		const gap = await s.world.read<EventPage>(query);
		expect(gap.value.gaps).toHaveLength(1);
		expect(gap.value.gaps[0]).toMatchObject({ reason: "history_retention", after: null, through: null });
		expect((await s.world.read<EventPage>(query)).value.gaps).toEqual(gap.value.gaps);
		expect((await s.world.read<EventPage>({ ref: "events@1", input: { after: gap.value.after! } })).value.gaps).toEqual(
			[],
		);
		const empty = await s.world.read<EventPage>(events);
		expect(JSON.parse(Buffer.from(empty.value.after!, "base64url").toString()).pos).toBe(oldUpper);
		expect(await s.world.pruneHistory(prune)).toMatchObject({
			removed: 0,
			version: removed.version,
			skippedRetained: 0,
		});
		await s.reopen();
		s.h.emitMessage("after deletion");
		const newer = await s.world.read<EventPage>({ ref: "events@1", input: { after: empty.value.after! } });
		expect(newer.value.events).toHaveLength(1);
		const newest = s.sql((db) => db.prepare("SELECT MAX(store_seq) AS seq FROM evidence").get()!.seq) as number;
		expect(newest).toBeGreaterThan(oldUpper);
		expect(
			(await s.world.read<EventPage>({ ref: "events@1", input: { after: newer.value.after! } })).value.events,
		).toEqual([]);
	} finally {
		await s.close();
	}
});

test("retain/delete races serialize and active/current reads remain independent", async () => {
	const s = await setup();
	try {
		s.h.emitMessage("retained first");
		const first = (await s.world.read<EventPage>(events)).value.events.at(-1)!.ref;
		await Promise.all([s.world.retain("run:race", [first]), s.world.pruneHistory(prune)]);
		expect((await s.world.read<EventPage>(events)).value.events.map((e) => e.ref)).toEqual([first]);
		await s.world.release("run:race");
		const deleting = s.world.pruneHistory(prune);
		const late = expect(s.world.retain("run:late", [first])).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
		const current = await s.world.read({ ref: "inventory@1", input: {} });
		expect(current.cursor).not.toBeNull();
		await deleting;
		await late;
		s.h.emitMessage("active detached read");
		const [read] = await Promise.all([s.world.read<EventPage>(events), s.world.pruneHistory(prune)]);
		expect(read.value.events).toHaveLength(1);
		expect((read.value.events[0]!.payload as { text: string }).text).toBe("active detached read");
		await expect(s.world.pruneHistory({ ...prune, beforeStoreSeq: -1 })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	} finally {
		await s.close();
	}
});

function windowValue(count: number): ClientWindowObservation {
	return {
		target: {
			place: {
				world: partition.world,
				worldRevision: partition.worldRevision,
				dimension: "overworld",
				position: { x: 2, y: 64, z: 3 },
			},
			block: { x: 2, y: 64, z: 3 },
		},
		snapshot: {
			window: "win:retention",
			type: "minecraft:generic_9x3",
			revision: count,
			layout: { slotCount: 1, regions: [{ name: "container", slots: [0] }] },
			properties: {},
			slots: [{ slot: 0, item: { name: "stone", count, components: null } }],
			cursor: null,
		},
	};
}

test("prune isolates partitions and preserves last container observation while replay never resurrects deletions", async () => {
	const s = await setup();
	const captured: CapturedClientFact[] = [];
	const subscription = s.h.facts.subscribe((notice) => {
		if (notice.kind === "evidence") captured.push(...notice.records);
	});
	try {
		s.h.facts.publishWindow(windowValue(1));
		s.h.facts.publishWindow(windowValue(2));
		s.h.facts.publishWindow(null);
		s.h.emitMessage("remove");
		await s.world.read<EventPage>(events);
		const noMatch = await s.world.pruneHistory({ ...prune, partition: { ...partition, binding: "bind:other" } });
		expect(noMatch.removed).toBe(0);
		await s.world.pruneHistory(prune);
		const container = await s.world.read<{ counts: Record<string, number> }>({
			ref: "container.last@1",
			input: { at: { position: { x: 2, y: 64, z: 3 }, dimension: "overworld" } },
		});
		expect(container.value.counts).toEqual({ stone: 2 });
		expect(s.sql((db) => db.prepare("SELECT COUNT(*) AS n FROM evidence").get())).toMatchObject({ n: 1 });
		// A fresh subscriber replays the source's original identities, including a
		// material whose payload has been deleted; tombstones suppress its rebirth.
		const replayFacts = {
			sample: s.h.facts.sample.bind(s.h.facts),
			subscribe: (fn: Parameters<typeof s.h.facts.subscribe>[0]) => {
				fn({ kind: "evidence", records: captured });
				return s.h.facts.subscribe(fn);
			},
		};
		const replay = new MinecraftWorld({
			facts: replayFacts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			binding: partition,
			namespace: "replay",
			dbPath: s.sql((db) => String(db.prepare("PRAGMA database_list").get()!.file)),
		});
		try {
			expect((await replay.read<EventPage>(events)).value.events).toEqual([]);
		} finally {
			await replay.close();
		}
	} finally {
		subscription.close();
		await s.close();
	}
});

test("history v2 is rejected without migrating or changing current reads", async () => {
	const s = await setup();
	try {
		await s.world.close();
		s.sql((db) => db.exec("UPDATE meta SET value='2' WHERE key='schema_version'"));
		// reopen verifies ready, so construct directly to inspect the rejected state.
		const path = s.sql((db) => String(db.prepare("PRAGMA database_list").get()!.file));
		const rejected = new MinecraftWorld({
			facts: s.h.facts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			binding: partition,
			namespace: "old",
			dbPath: path,
		});
		try {
			expect(await rejected.historyReady).toBe("unavailable");
			await expect(rejected.retain("run:old", [])).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
			expect((await rejected.read({ ref: "inventory@1", input: {} })).cursor).not.toBeNull();
		} finally {
			await rejected.close();
		}
		expect(s.sql((db) => db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value)).toBe("2");
	} finally {
		await s.close();
	}
});

test("explicit maintenance CLI uses the same worker and honors exclusive cutoff across short batches", async () => {
	const s = await setup();
	try {
		for (let i = 0; i < 260; i++) s.h.emitMessage(`maintenance ${i}`);
		const all = await s.world.read<EventPage>({ ...events, input: { limit: 200 } });
		const keep = all.value.events.at(-1)!.ref;
		const cutoff = s.sql((db) => Number(db.prepare("SELECT store_seq FROM evidence WHERE ref=?").get(keep)!.store_seq));
		await s.world.close();
		const result = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve(".uina/worlds/minecraft/dev/history.ts"),
				"--",
				"--data-root",
				s.root,
				"--partition",
				JSON.stringify(Object.values(partition)),
				"--before-store-seq",
				String(cutoff),
			],
			{ cwd: resolve("."), encoding: "utf8", windowsHide: true, timeout: 10_000 },
		);
		expect(JSON.parse(result.trim())).toMatchObject({ removed: cutoff - 1, partition, beforeStoreSeq: cutoff });
		expect(s.sql((db) => db.prepare("SELECT ref FROM evidence").all())).toEqual([{ ref: keep }]);
		expect(s.sql((db) => db.prepare("SELECT COUNT(*) AS n FROM retention_gaps").get())).toMatchObject({ n: 2 });
	} finally {
		await s.close();
	}
});
