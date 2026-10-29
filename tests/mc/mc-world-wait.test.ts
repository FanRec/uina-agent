import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { ClientFactNotice, ClientFactsPort } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { EventPage } from "../../.uina/worlds/minecraft/contracts/world.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

const capabilities = buildCapabilities({
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused");
	},
});
const binding = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-world-wait-"));
	const h = makeFactsHarness({
		bot: makeBot({
			_client: new EventEmitter(),
			entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
			registry: { effects: {} },
			game: { dimension: "overworld" },
			entities: {},
		}),
	});
	const listeners = new Set<(notice: ClientFactNotice) => void>();
	const facts: ClientFactsPort = {
		sample: (fn) => h.facts.sample(fn),
		subscribe: (fn, options) => {
			listeners.add(fn);
			const subscription = h.facts.subscribe(fn, options);
			return {
				...subscription,
				close: () => {
					listeners.delete(fn);
					subscription.close();
				},
			};
		},
	};
	const push = (notice: ClientFactNotice) => {
		for (const fn of listeners) fn(notice);
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
	return { h, open, push };
}
const signal = () => AbortSignal.timeout(2000);

test("observation versions bind query parameters and descriptor watchability", async () => {
	const { open } = await setup();
	const w = open("current");
	try {
		const inv = { ref: "inventory@1" as const, input: {} };
		const a = await w.read(inv);
		const other = await w.watch({ ref: "self@1", input: {} }, a.cursor!, signal());
		expect(await other.next(a.cursor!, signal())).toMatchObject({ kind: "reset", reason: "stream_changed" });
		await other.close();
		await expect(w.watch({ ref: "blocks@1", input: { name: "stone" } }, a.cursor!, signal())).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		const q = { ref: "entities@1" as const, input: { radius: 8 } };
		const entity = await w.read(q);
		const changedQuery = await w.watch({ ...q, input: { radius: 9 } }, entity.cursor!, signal());
		expect(await changedQuery.next(entity.cursor!, signal())).toMatchObject({ kind: "reset" });
		await changedQuery.close();
	} finally {
		await w.close();
	}
});

test("current watches catch the read/subscribe gap, reset sources and close with World", async () => {
	const { h, open } = await setup();
	const w = open("current");
	const q = { ref: "inventory@1" as const, input: {} };
	try {
		const a = await w.read(q);
		h.bot().emit("health");
		const watch = await w.watch(q, a.cursor!, signal());
		expect(await watch.next(a.cursor!, signal())).toMatchObject({ kind: "changed" });
		const b = await w.read(q);
		const next = watch.next(b.cursor!, signal());
		h.disconnect();
		expect(await next).toMatchObject({ kind: "reset" });
		expect(await watch.next(b.cursor!, signal())).toMatchObject({ kind: "reset" });
		const current = await w.read({ ref: "events@1", input: {} });
		expect(current.cursor).toBeNull();
		await watch.close();
	} finally {
		await w.close();
	}
	const w2 = open("close");
	const a = await w2.read<EventPage>({ ref: "events@1", input: {} });
	const q2 = { ref: "events@1" as const, input: { after: a.value.after! } };
	const b = await w2.read(q2);
	const watch = await w2.watch(q2, b.cursor!, signal());
	const pending = watch.next(b.cursor!, signal());
	const rejected = expect(pending).rejects.toMatchObject({ code: "INTERRUPTED" });
	await w2.close();
	await rejected;
});

test("events wait on committed history, paginate explicitly and preserve after across reopen", async () => {
	const { h, open } = await setup();
	let w = open("history:first");
	let after = "";
	let oldVersion;
	try {
		const initial = await w.read<EventPage>({ ref: "events@1", input: { kinds: ["chat"] } });
		after = initial.value.after!;
		const q = { ref: "events@1" as const, input: { after, limit: 1 } };
		const a = await w.read<EventPage>(q);
		expect(a.cursor).not.toBeNull();
		oldVersion = a.cursor!;
		const watch = await w.watch(q, a.cursor!, signal());
		const next = watch.next(a.cursor!, signal());
		h.emitMessage("first");
		expect(await next).toMatchObject({ kind: "changed" });
		await watch.close();
		h.emitMessage("second");
		const page = await w.read<EventPage>(q);
		expect(page.value.next).toBeDefined();
		expect(page.cursor).toBeNull();
		await expect(w.watch(q, oldVersion, signal())).rejects.toMatchObject({ code: "INVALID_INPUT" });
		const tail = await w.read<EventPage>({ ref: "events@1", input: { cursor: page.value.next! } });
		after = tail.value.after!;
		expect(tail.value.events).toHaveLength(1);
	} finally {
		await w.close();
	}
	w = open("history:second");
	try {
		const q = { ref: "events@1" as const, input: { after } };
		const a = await w.read<EventPage>(q);
		expect(a.value.events).toEqual([]);
		const watch = await w.watch(q, oldVersion!, signal());
		expect(await watch.next(oldVersion!, signal())).toMatchObject({ kind: "reset" });
		await watch.close();
		h.emitMessage("third");
		expect((await w.read<EventPage>(q)).value.events).toHaveLength(1);
	} finally {
		await w.close();
	}
});

test("new gaps wake history once and old after tokens cannot cross database identity", async () => {
	const { h, open, push } = await setup();
	const w = open("gaps");
	let after = "";
	try {
		h.emitMessage("register source");
		const first = await w.read<EventPage>({ ref: "events@1", input: {} });
		after = first.value.after!;
		const q = { ref: "events@1" as const, input: { after } };
		const initial = await w.read(q);
		const watch = await w.watch(q, initial.cursor!, signal());
		const next = watch.next(initial.cursor!, signal());
		push({
			kind: "evidence_gap",
			ref: "gap:wait:1",
			stream: h.facts.evidenceThrough.stream,
			after: h.facts.evidenceThrough.sequence,
			through: 100,
			reason: "test lost tail",
		});
		expect(await next).toMatchObject({ kind: "changed" });
		await watch.close();
		const withGap = await w.read<EventPage>(q);
		expect(withGap.value.gaps.map((g) => g.ref)).toEqual(["gap:wait:1"]);
		expect(withGap.value.gaps[0]).toMatchObject({ after: null, through: null });
		after = withGap.value.after!;
		expect((await w.read<EventPage>({ ref: "events@1", input: { after } })).value.gaps).toEqual([]);
	} finally {
		await w.close();
	}
	const root = await mkdtemp(join(tmpdir(), "uina-wait-other-"));
	const other = open("other", join(root, "history.db"));
	try {
		await expect(other.read({ ref: "events@1", input: { after } })).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });
		expect((await other.read<EventPage>({ ref: "events@1", input: {} })).value.events).toEqual([]);
	} finally {
		await other.close();
	}
});

test("unknown-to-known facts wake every observer and cancelling one next consumes no shared change", async () => {
	const { h, open } = await setup();
	const w = open("unknown");
	try {
		const q = { ref: "self@1" as const, input: {} };
		const first = await w.read<{ health: number | null }>(q);
		expect(first.value.health).toBeNull();
		const a = await w.watch(q, first.cursor!, signal()),
			b = await w.watch(q, first.cursor!, signal());
		const abort = new AbortController();
		const cancelled = a.next(first.cursor!, abort.signal);
		const rejected = expect(cancelled).rejects.toBeDefined();
		abort.abort();
		await rejected;
		const one = a.next(first.cursor!, signal()),
			two = b.next(first.cursor!, signal());
		h.bot().health = 12;
		h.bot().emit("health");
		expect(await one).toMatchObject({ kind: "changed" });
		expect(await two).toMatchObject({ kind: "changed" });
		expect((await w.read<{ health: number }>(q)).value.health).toBe(12);
		await a.close();
		await b.close();
	} finally {
		await w.close();
	}
});

test("history v1 is rejected without migration while current reads remain usable", async () => {
	const { open } = await setup();
	const root = await mkdtemp(join(tmpdir(), "uina-history-v1-"));
	const path = join(root, "history.db");
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO meta VALUES('schema_version','1')");
	db.close();
	const world = open("old", path);
	try {
		expect(await world.historyReady).toBe("unavailable");
		await expect(world.read({ ref: "events@1", input: {} })).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
		expect((await world.read({ ref: "inventory@1", input: {} })).cursor).not.toBeNull();
	} finally {
		await world.close();
	}
	const check = new DatabaseSync(path, { readOnly: true });
	try {
		expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toMatchObject({ value: "1" });
	} finally {
		check.close();
	}
});
