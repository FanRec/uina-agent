/**
 * smelt 的显式可持久模式（§5.9 首个消费者 / C14 / C21 / C23）。
 *
 * 钉住四件事：
 * 1. `wait:"durable"` 装好料就交还世界，抛的是挂起请求而不是返回"待会儿自己取"；
 * 2. 续段只观察与取产物，**不再装一次料**（重复投料是真服会多生产一份的真缺口）；
 * 3. 别的能力的检查点一律拒绝，不拿它推算"已经装了多少"；
 * 4. 炉子停了就如实 TARGET_NOT_MET，不靠挂起假装还在等。
 */
import { afterEach, expect, test, vi } from "vitest";
import type { BodyCallScope, CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import {
	type DurableSuspendRequest,
	getSuspendRequest,
	type JsonValue,
} from "../../.uina/worlds/minecraft/contracts/values.js";
import { buildRegistryKnowledge, type RegistryLike } from "../../.uina/worlds/minecraft/driver/facts/knowledge.js";
import { failureOf, type HarnessState, makeHarness } from "./mc-capability-harness.js";
import { type FixtureStack, furnaceLayout, stack, WindowFixture } from "./mc-window-fixture.js";

const at = { x: 11, y: 64, z: 10 };
const itemNames = ["raw_iron", "iron_ingot", "coal", "furnace"];
const items = Object.fromEntries(itemNames.map((name, id) => [name, { id, name, stackSize: 64 }]));
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

function rig(player: FixtureStack[]) {
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
	let body = false;
	const close = window.close.bind(window);
	// 服务端只在窗口关着的时候"烧"：50ms/件，把刻数换成可推进的假时钟。
	window.close = async () => {
		await close();
		const input = window.item(0);
		if (vi.isFakeTimers() && input != null && window.item(1) != null) {
			const count = input.count;
			setTimeout(() => {
				window.set(0, null);
				window.set(1, null);
				window.set(2, stack("iron_ingot", count));
				window.properties = { "0": 0 };
				sync(window);
			}, 50 * count);
		}
	};
	const harness = makeHarness(state, {
		knowledge: {
			...knowledge,
			recipesFor: (name: string) => knowledge.recipesFor(name).map((r) => ({ ...r, cookTicks: 1 })),
		},
		openWindow: () => window,
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
	return { ...harness, ctx, window, state, controller, body: () => body };
}

afterEach(() => vi.useRealTimers());

async function suspendOf(work: Promise<unknown>): Promise<DurableSuspendRequest> {
	try {
		await work;
	} catch (error) {
		const suspend = getSuspendRequest(error);
		if (suspend != null) return suspend;
		throw error;
	}
	throw new Error("the call returned instead of suspending");
}

test("durable mode loads one batch and hands the furnace back instead of waiting in-process", async () => {
	const h = rig([stack("raw_iron", 2), stack("coal", 2)]);
	const suspend = await suspendOf(
		h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at, wait: "durable" }),
	);
	expect(suspend.reason).toContain("iron_ingot");
	expect(suspend.checkpoint).toMatchObject({
		kind: "smelt@1",
		item: "iron_ingot",
		wanted: 2,
		completed: 0,
		outstanding: 2,
		loaded: { input: { item: "raw_iron", count: 2 }, fuel: { item: "coal" } },
		at: { position: at },
	});
	expect(suspend.recheckAfterMs).toBeGreaterThan(0);
	// 料确实进了炉子，玩家背包里那份已经不在（没有重复投料的余地）。
	expect(h.window.item(0)).toMatchObject({ name: "raw_iron", count: 2 });
	expect(h.body()).toBe(false);
});

test("the resumed segment takes the output without loading a second batch", async () => {
	vi.useFakeTimers();
	const h = rig([stack("raw_iron", 2), stack("coal", 2)]);
	const suspend = await suspendOf(
		h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at, wait: "durable" }),
	);
	// 窗口关着的时候炉子烧完了；恢复段只该取走产物。
	await vi.advanceTimersByTimeAsync(200);
	expect(h.window.item(2)).toMatchObject({ name: "iron_ingot", count: 2 });
	const pending = h
		.callable("smelt@1")
		.invoke({ ...h.ctx, checkpoint: suspend.checkpoint as JsonValue } as CallContext, {
			item: "iron_ingot",
			count: 2,
			fuel: "coal",
			at,
			wait: "durable",
		});
	await vi.runAllTimersAsync();
	const resumed = (await pending) as { produced: Record<string, number>; consumed: { input: { count: number } } };
	expect(resumed.produced).toEqual({ iron_ingot: 2 });
	// 关键：消耗量等于上次装的量，恢复段没有再往炉里放一次料，输入槽也不会再被填。
	expect(resumed.consumed.input.count).toBe(2);
	expect(h.window.item(0)).toBeNull();
});

test("a checkpoint from another capability is refused instead of guessing what was loaded", async () => {
	const h = rig([stack("raw_iron", 2), stack("coal", 2)]);
	const failure = await failureOf(
		h.callable("smelt@1").invoke({ ...h.ctx, checkpoint: { kind: "craft@1", at } } as CallContext, {
			item: "iron_ingot",
			count: 2,
			fuel: "coal",
			at,
			wait: "durable",
		}),
	);
	expect(failure).toMatchObject({ code: "WRONG_STATE" });
	expect(h.window.clicks).toBe(0);
});

test("a furnace that stopped before producing is reported, not suspended again", async () => {
	vi.useFakeTimers();
	const h = rig([stack("raw_iron", 2), stack("coal", 2)]);
	const suspend = await suspendOf(
		h.callable("smelt@1").invoke(h.ctx, { item: "iron_ingot", count: 2, fuel: "coal", at, wait: "durable" }),
	);
	// 有人把这一炉的产出全取走了：炉子空、没有燃料、服务端报 lit=0。
	await vi.advanceTimersByTimeAsync(200);
	h.window.set(0, null);
	h.window.set(1, null);
	h.window.set(2, null);
	h.window.properties = { "0": 0 };
	const pending = failureOf(
		h.callable("smelt@1").invoke({ ...h.ctx, checkpoint: suspend.checkpoint as JsonValue } as CallContext, {
			item: "iron_ingot",
			count: 2,
			fuel: "coal",
			at,
			wait: "durable",
		}),
	);
	await vi.runAllTimersAsync();
	expect(await pending).toMatchObject({ code: "TARGET_NOT_MET" });
});
