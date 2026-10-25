import { describe, expect, test } from "vitest";
import type { WindowItemValue, WindowSession, WindowSnapshot } from "../../.uina/worlds/minecraft/contracts/body.js";
import { transferWindow } from "../../.uina/worlds/minecraft/capabilities/shared/window-transfer.js";
import { containerCallable, transferCallable } from "../../.uina/worlds/minecraft/capabilities/actions/containers.js";
import type { CallContext } from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { CapabilityDeps } from "../../.uina/worlds/minecraft/capabilities/deps.js";
import { fact, self } from "./mc-capability-harness.js";

function stack(name: string, count: number, stackSize = 64): WindowItemValue {
	return { name, count, stackSize, components: [], durability: null };
}

function windowFixture(container: (WindowItemValue | null)[], player: (WindowItemValue | null)[]) {
	let revision = 1;
	let cursor: WindowItemValue | null = null;
	const items = structuredClone([...container, ...player]);
	const clicks: number[] = [];
	let unknown = false;
	let unknownAfter = Infinity;
	const value = (): WindowSnapshot => ({
		window: "win:t",
		type: "minecraft:generic_9x3",
		revision,
		layout: {
			slotCount: items.length,
			regions: [
				{ name: "container", slots: container.map((_, i) => i) },
				{ name: "player", slots: player.map((_, i) => i + container.length) },
			],
		},
		properties: {},
		slots: items.map((item, slot) => ({ slot, item: item as never })),
		cursor: cursor as never,
	});
	const session: WindowSession = {
		async snapshot() {
			return {
				value: structuredClone(value()),
				source: "server",
				observedAt: new Date().toISOString(),
				coverage: "complete",
				unknown: [],
				evidence: [],
			};
		},
		async click(input) {
			expect(input.expectedRevision).toBe(revision);
			clicks.push(input.slot);
			if (unknown || clicks.length >= unknownAfter)
				return { effect: "eff:unknown", dispatch: "sent", completion: "unknown", evidence: [], needsSnapshot: true };
			const target = items[input.slot] ?? null;
			if (cursor == null) {
				if (target != null) {
					const take = input.button === 1 ? Math.ceil(target.count / 2) : target.count;
					cursor = { ...target, count: take };
					items[input.slot] = target.count === take ? null : { ...target, count: target.count - take };
				}
			} else {
				const room = (cursor.stackSize ?? 64) - (target?.count ?? 0);
				const put = Math.min(input.button === 1 ? 1 : cursor.count, room);
				items[input.slot] = { ...cursor, count: (target?.count ?? 0) + put };
				cursor = cursor.count === put ? null : { ...cursor, count: cursor.count - put };
			}
			revision++;
			return {
				effect: `eff:${revision}`,
				dispatch: "sent",
				completion: "met",
				evidence: [],
				needsSnapshot: false,
				confirmed: { slots: value().slots, cursor: value().cursor },
			};
		},
		async close() {},
	};
	return {
		session,
		items,
		clicks,
		setUnknown: () => {
			unknown = true;
		},
		setUnknownAfter: (click: number) => {
			unknownAfter = click;
		},
	};
}

describe("窗口搬移：服务端快照上的固定清单", () => {
	test("存入精确数量，余量回原槽，光标清空", async () => {
		const f = windowFixture([null, null], [stack("dirt", 12), null]);
		expect(await transferWindow(f.session, { direction: "to", item: "dirt", count: 5 })).toEqual({
			moved: { dirt: 5 },
			remaining: {},
		});
		expect(f.items[0]?.count).toBe(5);
		expect(f.items[2]?.count).toBe(7);
		expect((await f.session.snapshot()).value.cursor).toBeNull();
	});
	test("取出数量省略时固定源清单并跨堆合并", async () => {
		const f = windowFixture([stack("dirt", 3), stack("dirt", 4)], [stack("dirt", 60), null]);
		expect(await transferWindow(f.session, { direction: "from", item: "dirt" })).toEqual({
			moved: { dirt: 7 },
			remaining: {},
		});
		expect(f.items.slice(2).map((i) => i?.count)).toEqual([64, 3]);
	});
	test("目标空间不足保留实际 moved 与 remaining", async () => {
		const f = windowFixture([stack("dirt", 63)], [stack("dirt", 5)]);
		await expect(transferWindow(f.session, { direction: "to", item: "dirt", count: 5 })).rejects.toMatchObject({
			code: "INVENTORY_FULL",
			progress: { moved: { dirt: 1 }, remaining: { dirt: 4 } },
		});
		expect(f.items.map((i) => i?.count)).toEqual([64, 4]);
	});
	test("源不足只搬实际量，差额保留", async () => {
		const f = windowFixture([stack("dirt", 2)], [null]);
		await expect(transferWindow(f.session, { direction: "from", item: "dirt", count: 5 })).rejects.toMatchObject({
			code: "MISSING_MATERIAL",
			progress: { moved: { dirt: 2 }, remaining: { dirt: 3 } },
		});
	});
	test("点击未知不重复派发、不计 moved", async () => {
		const f = windowFixture([null], [stack("dirt", 5)]);
		f.setUnknown();
		await expect(transferWindow(f.session, { direction: "to", item: "dirt", count: 2 })).rejects.toMatchObject({
			code: "TARGET_NOT_MET",
			dispatch: "unknown",
		});
		expect(f.clicks).toHaveLength(1);
	});
	test("all 只搬容器区域，不包含玩家已有物品", async () => {
		const f = windowFixture([stack("dirt", 2), stack("apple", 1)], [stack("stone", 3), null, null]);
		expect(await transferWindow(f.session, { direction: "from", all: true })).toEqual({
			moved: { dirt: 2, apple: 1 },
			remaining: {},
		});
		expect(f.items[2]?.name).toBe("stone");
	});
	test("逐个放置时后续点击未知，也保留先前已确认的部分量", async () => {
		const f = windowFixture([null], [stack("dirt", 12)]);
		f.setUnknownAfter(3);
		await expect(transferWindow(f.session, { direction: "to", item: "dirt", count: 5 })).rejects.toMatchObject({
			code: "TARGET_NOT_MET",
			progress: { moved: { dirt: 1 }, remaining: { dirt: 4 } },
		});
		expect(f.clicks).toHaveLength(3);
	});
});

function capabilityFixture() {
	const empty = windowFixture([null], [stack("dirt", 5)]);
	const matching = windowFixture([stack("dirt", 63)], [stack("dirt", 5)]);
	const windows = new Map([
		[11, empty],
		[12, matching],
	]);
	const opened: number[] = [];
	let closed = 0;
	let navigation = 0;
	const player = {
		async openContainer(target: { block: { x: number } }) {
			opened.push(target.block.x);
			const w = windows.get(target.block.x) ?? empty;
			return {
				...w.session,
				async close() {
					closed++;
				},
			};
		},
	};
	const ctx = {
		signal: new AbortController().signal,
		run: "r:t",
		segment: "s:t",
		callId: "c:t",
		world: {
			async read(query: { ref: string; input: { name?: string } }) {
				if (query.ref === "self@1") return fact(self);
				if (query.ref === "block@1") return fact({ block: { name: "barrel", properties: {} } });
				if (query.ref === "blocks@1")
					return fact({
						blocks:
							query.input.name === "barrel"
								? [{ position: { x: 11, y: 64, z: 10 } }, { position: { x: 12, y: 64, z: 10 } }]
								: [],
					});
				if (query.ref === "entities@1") return fact({ entities: [] });
				throw new Error(query.ref);
			},
		},
		async withBody(work: (scope: unknown) => Promise<unknown>) {
			return work({ ...ctx, player });
		},
		async call() {
			navigation++;
		},
		async progress() {},
	} as unknown as CallContext;
	return { ctx, player, opened, windows, closed: () => closed, navigation: () => navigation };
}

describe("容器能力接线", () => {
	test("nearest 存物先核验后选择已有同类的箱子，窗口全部关闭", async () => {
		const f = capabilityFixture();
		const value = await transferCallable({} as CapabilityDeps).invoke(f.ctx, { to: "nearest", item: "dirt", count: 1 });
		expect(value).toMatchObject({ moved: { dirt: 1 }, remaining: {}, containersChecked: 2 });
		expect(f.opened).toEqual([11, 12, 12]);
		expect(f.closed()).toBe(3);
	});
	test("近距祖先身体复用，不启动独立导航", async () => {
		const f = capabilityFixture();
		Object.assign(f.ctx, { player: f.player });
		await containerCallable({} as CapabilityDeps).invoke(f.ctx, { at: { x: 11, y: 64, z: 10 } });
		expect(f.navigation()).toBe(0);
		expect(f.opened).toEqual([11]);
		expect(f.closed()).toBe(1);
	});
	test("远距祖先身体在新副作用前拒绝，资格保持调用方持有", async () => {
		const f = capabilityFixture();
		Object.assign(f.ctx, { player: f.player });
		await expect(
			containerCallable({} as CapabilityDeps).invoke(f.ctx, { at: { x: 30, y: 64, z: 10 } }),
		).rejects.toMatchObject({ code: "CONTROL_CONFLICT", dispatch: "not_sent" });
		expect(f.opened).toEqual([]);
		expect(f.navigation()).toBe(0);
		expect((f.ctx as unknown as { player: unknown }).player).toBe(f.player);
	});
	test("预取消不导航、不开窗口", async () => {
		const f = capabilityFixture();
		Object.assign(f.ctx, { signal: AbortSignal.abort() });
		await expect(
			containerCallable({} as CapabilityDeps).invoke(f.ctx, { at: { x: 11, y: 64, z: 10 } }),
		).rejects.toMatchObject({ code: "INTERRUPTED" });
		expect(f.opened).toEqual([]);
	});
});
