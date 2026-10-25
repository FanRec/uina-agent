import { afterEach, describe, expect, test, vi } from "vitest";
import type { BodyCallScope, CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";
import { FUEL_TICKS } from "../../.uina/worlds/minecraft/driver/facts/smelting.js";
import { failureOf, makeHarness, type HarnessState } from "./mc-capability-harness.js";
import { furnaceLayout, stack, WindowFixture, type FixtureStack } from "./mc-window-fixture.js";

const at = { x: 11, y: 64, z: 10 };
const itemNames = [
	"raw_iron",
	"iron_ingot",
	"coal",
	"bamboo",
	"stick",
	"lava_bucket",
	"furnace",
	"crimson_planks",
	"warped_planks",
	"crimson_stem",
	"warped_stem",
];
const items = Object.fromEntries(
	itemNames.map((name, id) => [name, { id, name, stackSize: name === "lava_bucket" ? 1 : 64 }]),
);
const registry = {
	version: { minecraftVersion: "1.21.11" },
	itemsByName: items,
	items: Object.fromEntries(Object.values(items).map((item) => [item.id, item])),
	blocksByName: {},
	recipes: {},
	blockLoot: {},
	entityLoot: {},
	entitiesByName: {},
} as RegistryLike;
const knowledge = buildRegistryKnowledge(registry);

function rig(player: FixtureStack[], options: { fast?: boolean; finish?: boolean } = {}) {
	const slots = Array.from<FixtureStack | null>({ length: 39 }).fill(null);
	player.forEach((item, index) => {
		slots[3 + index] = item;
	});
	const state: HarnessState = {
		blocks: new Map([["11,64,10", { name: "furnace", properties: {} }]]),
		inventory: { slots: [], counts: {} },
	};
	function sync(window: WindowFixture) {
		const entries = window.slots
			.slice(3)
			.flatMap((item, index) => (item == null ? [] : [{ ...item, slot: 9 + index }]));
		const counts: Record<string, number> = {};
		for (const item of entries) counts[item.name] = (counts[item.name] ?? 0) + item.count;
		state.inventory = { slots: entries, counts };
	}
	const window = new WindowFixture("minecraft:furnace", furnaceLayout(), slots, { afterClick: sync });
	window.properties = { "0": 0 };
	sync(window);
	const active: boolean[] = [];
	let body = false;
	let opens = 0;
	const close = window.close.bind(window);
	window.close = async () => {
		await close();
		const input = window.item(0);
		if (vi.isFakeTimers() && options.finish !== false && input != null && window.item(1) != null) {
			const count = input.count;
			setTimeout(
				() => {
					window.set(0, null);
					window.set(1, null);
					window.set(2, stack("iron_ingot", count));
					window.properties = { "0": 0 };
					sync(window);
				},
				options.fast ? 50 * count : 10000 * count,
			);
		}
	};
	const chosen = options.fast
		? {
				...knowledge,
				recipesFor: (name: string) => knowledge.recipesFor(name).map((recipe) => ({ ...recipe, cookTicks: 1 })),
			}
		: knowledge;
	const harness = makeHarness(state, {
		knowledge: chosen,
		openWindow: () => {
			opens++;
			active.push(body);
			return window;
		},
	});
	const withBody = harness.ctx.withBody.bind(harness.ctx);
	harness.ctx.withBody = async <T>(work: (scope: BodyCallScope) => Promise<T>) => {
		body = true;
		try {
			return await withBody(work);
		} finally {
			body = false;
		}
	};
	const controller = new AbortController();
	const ctx = { ...harness.ctx, signal: controller.signal } as CallContext;
	return { ...harness, ctx, window, state, controller, body: () => body, opens: () => opens, active };
}

afterEach(() => vi.useRealTimers());

describe("smelt repair", () => {
	test.each([undefined, "lava_bucket"])(
		"known lava burn tolerates its empty bucket residue (fuel=%s)",
		async (fuel) => {
			const h = rig([stack("raw_iron", 1)]);
			h.window.set(1, stack("bucket", 1, 16));
			h.window.properties = { "0": 1000 };
			const result = await h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", fuel, at, wait: false } as never);
			expect(result).toMatchObject({ loaded: { input: { count: 1 }, fuel: { count: 0 } } });
			expect(h.window.item(1)?.name).toBe("bucket");
		},
	);

	test("automatic fuel is chosen from the current window, not call-start inventory", async () => {
		const h = rig([stack("raw_iron", 1), stack("coal", 1), stack("bamboo", 4)]);
		const withBody = h.ctx.withBody;
		h.ctx.withBody = async (work) => {
			h.window.set(4, null);
			return withBody(work);
		};
		const result = await h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", at, wait: false });
		expect(result).toMatchObject({ loaded: { input: { count: 1 }, fuel: { item: "bamboo", count: 4 } } });
	});
	test("wait:false bounds bamboo by both fuel and input slot capacity", async () => {
		const h = rig([stack("raw_iron", 64), stack("bamboo", 64)]);
		const value = (await h
			.callable("smelt@1")
			.invoke(h.ctx, { item: "iron_ingot", count: 64, fuel: "bamboo", at, wait: false })) as {
			loaded: { input: { count: number }; fuel: { count: number } };
			remaining: number;
		};
		expect(value.loaded.input.count).toBe(16);
		expect(value.loaded.fuel.count).toBe(64);
		expect(value.remaining).toBe(48);
	});

	test.each(["crimson_planks", "warped_planks", "crimson_stem", "warped_stem"])("%s is not furnace fuel", (name) => {
		expect(FUEL_TICKS[name]).toBeUndefined();
		expect(knowledge.item(name)?.fuel).toBeNull();
	});

	test("a partial confirmed input load survives a later unknown click", async () => {
		const h = rig([stack("raw_iron", 3), stack("coal", 1)]);
		h.window.unknownFrom = 2;
		const failure = await failureOf(
			h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at }),
		);
		expect(failure.dispatch).toBe("unknown");
		expect(failure.progress).toMatchObject({
			loaded: { input: { count: 1 }, fuel: { count: 0 } },
			consumed: { input: { count: 1 }, fuel: { count: 0 } },
			produced: {},
			remaining: 2,
			at: { position: at },
		});
		expect(h.window.clicks).toBe(3);
	});

	test("waiting closes the window and releases its body; cancellation keeps confirmed loading", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 2), stack("coal", 1)]);
		const result = failureOf(h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at }));
		await vi.advanceTimersByTimeAsync(1);
		expect(h.window.closed).toBe(1);
		expect(h.body()).toBe(false);
		h.controller.abort();
		const failure = await result;
		expect(failure.code).toBe("INTERRUPTED");
		expect(failure.progress).toMatchObject({
			loaded: { input: { count: 2 }, fuel: { count: 1 } },
			produced: {},
			remaining: 2,
		});
		expect(h.opens()).toBe(1);
	});

	test("a later batch failure preserves earlier taken output and all confirmed loading", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 64), stack("raw_iron", 1), stack("coal", 2)], { fast: true });
		h.ctx.progress = async (value) => {
			if ((value.produced as { iron_ingot?: number })?.iron_ingot === 64 && h.window.unknownFrom == null)
				h.window.unknownFrom = h.window.clicks + 2;
		};
		const result = failureOf(
			h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 65, fuel: "coal", at, maxTimeMs: 30000 }),
		);
		await vi.runAllTimersAsync();
		const failure = await result;
		expect(failure.progress).toMatchObject({
			produced: { iron_ingot: 64 },
			consumed: { input: { count: 65 } },
			loaded: { input: { count: 65 } },
			remaining: 1,
		});
	});

	test("automatic selection stays one fuel kind per call and retains progress when that kind is exhausted", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 64), stack("raw_iron", 1), stack("coal", 1), stack("bamboo", 64)], { fast: true });
		const result = failureOf(
			h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 65, at, maxTimeMs: 30000 }),
		);
		await vi.runAllTimersAsync();
		const error = await result;
		expect(error).toMatchObject({
			code: "MISSING_MATERIAL",
			progress: { produced: { iron_ingot: 64 }, loaded: { fuel: { item: "coal", count: 1 } }, remaining: 1 },
		});
		expect(h.state.inventory.counts.bamboo).toBe(64);
	});

	test("all remaining minimal fuel durations match Paper's 200-tick base", () => {
		expect(FUEL_TICKS).toMatchObject({
			coal: 1600,
			charcoal: 1600,
			coal_block: 16000,
			blaze_rod: 2400,
			lava_bucket: 20000,
			stick: 100,
			bamboo: 50,
			dried_kelp_block: 4001,
		});
		for (const [name, ticks] of Object.entries(FUEL_TICKS))
			if (name.endsWith("_log") || name.endsWith("_planks")) expect(ticks).toBe(300);
	});

	test("wait:true repeats bounded batches until the new request is fulfilled", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 64), stack("raw_iron", 1), stack("coal", 2)], { fast: true });
		const result = h
			.callable("smelt@1")
			.invoke(h.ctx, { item: "iron_ingot", count: 65, fuel: "coal", at, maxTimeMs: 30000 });
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({
			produced: { iron_ingot: 65 },
			consumed: { input: { count: 65 }, fuel: { count: 2 } },
		});
		expect(h.window.closed).toBe(4);
	});

	test("clearing old target output does not reduce the new batch request", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 2), stack("coal", 1)], { fast: true });
		h.window.set(2, stack("iron_ingot", 3));
		const result = h
			.callable("smelt@1")
			.invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at, maxTimeMs: 10000 });
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({
			produced: { iron_ingot: 5 },
			consumed: { input: { count: 2 }, fuel: { count: 1 } },
		});
	});

	test("confirmed existing burn and fuel reduce the amount newly loaded", async () => {
		const h = rig([stack("raw_iron", 10), stack("coal", 1)]);
		h.window.set(1, stack("coal", 1));
		h.window.properties = { "0": 400 };
		const result = await h
			.callable("smelt@1")
			.invoke(h.ctx, { item: "iron_ingot", count: 10, fuel: "coal", at, wait: false });
		expect(result).toMatchObject({ loaded: { input: { count: 10 }, fuel: { count: 0 } } });
	});

	test("one confirmed lava bucket is a one-item fuel stack", async () => {
		const h = rig([stack("raw_iron", 64), stack("lava_bucket", 1, 1)]);
		const result = await h
			.callable("smelt@1")
			.invoke(h.ctx, { item: "iron_ingot", count: 64, fuel: "lava_bucket", at, wait: false });
		expect(result).toMatchObject({ loaded: { input: { count: 64 }, fuel: { count: 1 } } });
	});

	test("a conflict during fuel loading retains confirmed input progress", async () => {
		const h = rig([stack("raw_iron", 2), stack("coal", 1)]);
		const click = h.window.click.bind(h.window);
		h.window.click = async (input) => {
			if (input.slot === 4) h.window.revision++;
			return await click(input);
		};
		const failure = await failureOf(
			h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at }),
		);
		expect(failure.code).toBe("CONFLICT");
		expect(failure.progress).toMatchObject({ loaded: { input: { count: 2 } }, produced: {}, remaining: 2 });
	});

	test.each(["world", "worldRevision", "dimension"])(
		"a changed %s never reopens a different furnace",
		async (field) => {
			vi.useFakeTimers();
			const h = rig([stack("raw_iron", 1), stack("coal", 1)], { fast: true });
			const result = failureOf(h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", fuel: "coal", at }));
			await vi.advanceTimersByTimeAsync(1);
			const observation = await h.ctx.world.read<{ place: Record<string, unknown> }>({ ref: "self@1", input: {} });
			observation.value.place[field] = "changed";
			await vi.runAllTimersAsync();
			const failure = await result;
			expect(failure.code).toBe("REFERENCE_STALE");
			expect(failure.progress).toMatchObject({ loaded: { input: { count: 1 } }, produced: {}, remaining: 1 });
			expect(h.opens()).toBe(1);
		},
	);

	test.each(["connection", "incarnation"])("a changed %s prevents reuse of the original furnace", async (field) => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 1), stack("coal", 1)], { fast: true });
		const result = failureOf(h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", fuel: "coal", at }));
		await vi.advanceTimersByTimeAsync(1);
		const read = h.ctx.world.read.bind(h.ctx.world);
		h.ctx.world.read = async (query) => ({ ...(await read(query)), [field]: "changed" });
		await vi.runAllTimersAsync();
		expect((await result).code).toBe("REFERENCE_STALE");
		expect(h.opens()).toBe(1);
	});

	test("a removed original furnace does not trigger station fallback", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 1), stack("coal", 1)], { fast: true });
		const result = failureOf(h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", fuel: "coal", at }));
		await vi.advanceTimersByTimeAsync(1);
		h.state.blocks.set("11,64,10", null);
		await vi.runAllTimersAsync();
		expect((await result).code).toBe("REFERENCE_STALE");
		expect(h.opens()).toBe(1);
	});

	test("moving during world wait reapproaches the original furnace before collection", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 1), stack("coal", 1)], { fast: true });
		const result = h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", fuel: "coal", at });
		await vi.advanceTimersByTimeAsync(1);
		const observation = await h.ctx.world.read<{ place: { position: { x: number; y: number; z: number } } }>({
			ref: "self@1",
			input: {},
		});
		observation.value.place.position = { x: 100, y: 64, z: 10 };
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ produced: { iron_ingot: 1 } });
		expect(h.calls).toContain("goto:11,64,10");
		expect(h.opens()).toBe(2);
	});

	test("a lifetime deadline stops waiting without a reopen storm or extra batch", async () => {
		vi.useFakeTimers();
		const h = rig([stack("raw_iron", 64), stack("coal", 8)], { finish: false });
		const result = failureOf(
			h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 64, fuel: "coal", at, maxTimeMs: 1000 }),
		);
		await vi.advanceTimersByTimeAsync(1000);
		const failure = await result;
		expect(failure.code).toBe("TIMEOUT");
		expect(failure.progress).toMatchObject({
			loaded: { input: { count: 64 }, fuel: { count: 8 } },
			produced: {},
			remaining: 64,
		});
		expect(h.opens()).toBe(1);
		expect(h.body()).toBe(false);
	});
});
