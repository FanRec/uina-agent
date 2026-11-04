/**
 * remember@1 / forget@1 能力语义：真临时 SQLite + 真 builtinCatalog.bind（内置目录绑定）。
 * 覆盖：创建/同名覆盖（CAS 落库）、显式维度保留、名字校验、forget 的
 * removed/NOT_FOUND、关闭重开后地点仍在。CAS 与存储的真值由
 * mc-world-records.test.ts 用同一存储路径证明；这里验证能力层的换算与校验边界。
 */

import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { builtinCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { ClientFactsPort } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

const capabilities = builtinCatalog.bind({
	surface: () => null,
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused");
	},
});
const binding = { binding: "bind:t:1", world: "world:t:1", worldRevision: "wrev:t:1" };

function callableOf(ref: string) {
	const found = capabilities.callables.find((entry) => entry.descriptor.ref === ref);
	if (found == null) throw new Error(`no callable ${ref}`);
	return found;
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "uina-places-cap-"));
	const h = makeFactsHarness({
		bot: makeBot({
			_client: new EventEmitter(),
			entity: { position: { x: 10, y: 64, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
			registry: { effects: {} },
			game: { dimension: "overworld" },
			entities: {},
		}),
	});
	const facts: ClientFactsPort = {
		sample: (fn) => h.facts.sample(fn),
		subscribe: (fn, options) => h.facts.subscribe(fn, options),
	};
	const world = new MinecraftWorld({
		facts,
		readers: capabilities.readers,
		validators: capabilities.validators,
		queries: capabilities.queries,
		dbPath: join(root, "history.db"),
		binding,
		namespace: "places-cap",
	});
	const ctx = {
		run: "run:t:1",
		segment: "seg:t:1",
		callId: "call:t:1",
		signal: new AbortController().signal,
		progress: async () => undefined,
		world,
	} as unknown as CallContext;
	return { world, ctx };
}

test("remember creates, overwrites by name, keeps explicit dimension and validates names", async () => {
	const { world, ctx } = await setup();
	try {
		const remember = callableOf("remember@1");
		// at 省略 → 当前 self 位置（10,64,10 / overworld / world:t:1）。
		const created = await remember.invoke(ctx, { name: "base", kind: "home", note: "main" } as JsonValue);
		expect(created).toMatchObject({
			name: "base",
			at: { position: { x: 10, y: 64, z: 10 }, dimension: "overworld" },
			kind: "home",
		});
		const first = await world.readRecord("place:base");
		expect(first).toMatchObject({ revision: 1, value: { note: "main", savedAt: expect.any(String) } });

		// 同名覆盖：位置更新，revision 前进，不产生第二条记录。
		const overwritten = await remember.invoke(ctx, {
			name: "base",
			at: { x: 20, y: 64, z: 20 },
			kind: "home",
		} as JsonValue);
		expect(overwritten).toMatchObject({ at: { position: { x: 20, y: 64, z: 20 } } });
		const second = await world.readRecord("place:base");
		expect(second.revision).toBe(2);

		// 显式维度照存（§2.2：跨维度地点不简化成三个数）。
		await remember.invoke(ctx, {
			name: "fortress",
			at: { position: { x: 100, y: 64, z: 100 }, dimension: "minecraft:the_nether" },
			kind: "mine",
		} as JsonValue);
		const nether = await world.readRecord("place:fortress");
		expect(nether.value).toMatchObject({ at: { dimension: "minecraft:the_nether" }, kind: "mine" });

		const places = await world.read<{ places: { name: string; at: { dimension: string } }[] }>({
			ref: "places@1",
			input: {},
		});
		expect(places.value.places.map((p) => `${p.name}@${p.at.dimension}`)).toEqual([
			"base@overworld",
			"fortress@minecraft:the_nether",
		]);

		await expect(remember.invoke(ctx, { name: "  " } as JsonValue)).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(remember.invoke(ctx, { name: "x".repeat(33) } as JsonValue)).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(remember.invoke(ctx, { name: "bad\u0000name" } as JsonValue)).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	} finally {
		await world.close();
	}
});

test("forget removes exactly the named record and reports NOT_FOUND afterwards", async () => {
	const { world, ctx } = await setup();
	try {
		const remember = callableOf("remember@1");
		const forget = callableOf("forget@1");
		await remember.invoke(ctx, { name: "gone", kind: "farm" } as JsonValue);
		expect(await forget.invoke(ctx, { name: "gone" } as JsonValue)).toEqual({ removed: true });
		await expect(forget.invoke(ctx, { name: "gone" } as JsonValue)).rejects.toMatchObject({ code: "NOT_FOUND" });
		// 忘记未知名字是 NOT_FOUND，不是静默成功；名字校验先于存在性检查。
		await expect(forget.invoke(ctx, { name: "never-was" } as JsonValue)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(forget.invoke(ctx, { name: "" } as JsonValue)).rejects.toMatchObject({ code: "INVALID_INPUT" });
	} finally {
		await world.close();
	}
});

test("remembered places survive a full world close/reopen on the same data root", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-places-reopen-"));
	const path = join(root, "history.db");
	const remember = callableOf("remember@1");
	const open = () => {
		const h = makeFactsHarness({
			bot: makeBot({
				_client: new EventEmitter(),
				entity: { position: { x: 10, y: 64, z: 10 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
				registry: { effects: {} },
				game: { dimension: "overworld" },
				entities: {},
			}),
		});
		const facts: ClientFactsPort = {
			sample: (fn) => h.facts.sample(fn),
			subscribe: (fn, options) => h.facts.subscribe(fn, options),
		};
		const world = new MinecraftWorld({
			facts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			dbPath: path,
			binding,
			namespace: `places-reopen-${process.pid}`,
		});
		const ctx = {
			run: "run:t:1",
			segment: "seg:t:1",
			callId: "call:t:1",
			signal: new AbortController().signal,
			progress: async () => undefined,
			world,
		} as unknown as CallContext;
		return { world, ctx };
	};

	const first = open();
	try {
		await remember.invoke(first.ctx, { name: "base", kind: "home" } as JsonValue);
		expect((await first.world.readRecord("place:base")).revision).toBe(1);
	} finally {
		await first.world.close();
	}

	const second = open();
	try {
		expect(await second.world.readRecord("place:base")).toMatchObject({ ref: "place:base", revision: 1 });
		const places = await second.world.read<{ places: { name: string; kind: string }[] }>({
			ref: "places@1",
			input: {},
		});
		expect(places.value.places).toEqual([
			expect.objectContaining({ name: "base", kind: "home", at: expect.objectContaining({ dimension: "overworld" }) }),
		]);
	} finally {
		await second.world.close();
	}
});

test("persistent CAS conflict is bounded: remember fails CONFLICT instead of retrying forever", async () => {
	const { world, ctx } = await setup();
	try {
		const remember = callableOf("remember@1");
		// 令 world.writeRecord 永远冲突：验证重试有界，调用方拿到如实的 CONFLICT。
		const conflicting: CallContext = {
			...ctx,
			world: {
				// self@1 读取走真 World；只有记录读/写被替换成恒定冲突的窄替身。
				read: world.read.bind(world),
				readRecord: async () => {
					throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
				},
				writeRecord: async () => {
					throw Object.assign(new Error("moved again"), { code: "CONFLICT" });
				},
			} as never,
		} as CallContext;
		await expect(remember.invoke(conflicting, { name: "racy" } as JsonValue)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	} finally {
		await world.close();
	}
});
