/**
 * 窗口替身：一个只有 mode-0 点击语义的小服务端。
 *
 * 为什么要它：craft@1 与 smelt@1 的核心是"摆格 → 点结果槽 → 产物入包"和"装料 → 等 → 取"，
 * 这两条循环必须能脱离真服反复跑。替身只实现协议语义（左键全取、右键 1 个/一半、异名交换、
 * revision 逐次推进），产品的产出规则由每个场景的 hook 决定，不内建玩法假设。
 */

import type {
	ItemSelector,
	StackExpectation,
	WindowClickReceipt,
	WindowSession,
	WindowSnapshot,
} from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";

export interface FixtureStack {
	name: string;
	count: number;
	stackSize?: number;
	components?: JsonValue;
	durability?: number;
}

export function stack(name: string, count = 1, stackSize = 64): FixtureStack {
	return { name, count, stackSize };
}

const clone = <T>(value: T): T => (value == null ? value : (JSON.parse(JSON.stringify(value)) as T));

function fail(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string; dispatch: string; source: string };
	error.name = "CallFailure";
	error.code = code;
	error.dispatch = "not_sent";
	error.source = "capability";
	return error;
}

function matchesExpectation(item: FixtureStack | null, expected: StackExpectation): boolean {
	if (expected.item === null) return item === null && expected.count === 0;
	if (item == null) return false;
	const selector: ItemSelector = expected.item;
	return item.name === selector.name.replace(/^minecraft:/, "") && item.count === expected.count;
}

/** 原版 mode-0 语义：只做"取/放/叠加/交换"，不认业务含义。 */
function applyClick(
	slot: FixtureStack | null,
	cursor: FixtureStack | null,
	button: number,
): [FixtureStack | null, FixtureStack | null] {
	if (cursor == null) {
		if (slot == null) return [null, null];
		const taken = button === 0 ? slot.count : Math.ceil(slot.count / 2);
		return [taken >= slot.count ? null : { ...slot, count: slot.count - taken }, { ...slot, count: taken }];
	}
	if (slot == null) {
		const placed = button === 0 ? cursor.count : 1;
		return [{ ...cursor, count: placed }, placed >= cursor.count ? null : { ...cursor, count: cursor.count - placed }];
	}
	if (slot.name === cursor.name && (slot.components ?? null) === (cursor.components ?? null)) {
		const room = (slot.stackSize ?? 64) - slot.count;
		const placed = Math.min(button === 0 ? cursor.count : 1, room);
		if (placed > 0) {
			return [
				{ ...slot, count: slot.count + placed },
				placed >= cursor.count ? null : { ...cursor, count: cursor.count - placed },
			];
		}
	}
	return [cursor, slot];
}

export interface WindowFixtureHooks {
	/** 点击落账后：合成结果槽重算、熔炉推进等。 */
	afterClick?: (fixture: WindowFixture, slot: number, button: number) => void;
	/** 每次 snapshot 之前：熔炉按轮询推进时间。 */
	beforeSnapshot?: (fixture: WindowFixture) => void;
}

export class WindowFixture implements WindowSession {
	cursor: FixtureStack | null = null;
	properties: Record<string, JsonValue> = {};
	revision = 1;
	clicks = 0;
	closed = 0;
	/** 从第 N 次点击起返回 unknown（模拟服务端不回话）；undefined = 永不知晓。 */
	unknownFrom: number | undefined;

	constructor(
		readonly type: string,
		readonly layout: WindowSnapshot["layout"],
		readonly slots: (FixtureStack | null)[],
		readonly hooks: WindowFixtureHooks = {},
	) {}

	item(slot: number): FixtureStack | null {
		return this.slots[slot] ?? null;
	}

	set(slot: number, item: FixtureStack | null): void {
		this.slots[slot] = item;
	}

	value(): WindowSnapshot {
		return {
			window: "window:fixture",
			type: this.type,
			revision: this.revision,
			layout: this.layout,
			properties: clone(this.properties),
			slots: this.slots.map((item, slot) => ({ slot, item: clone(item) as unknown as JsonValue })),
			cursor: clone(this.cursor) as unknown as JsonValue,
		};
	}

	async snapshot(): Promise<Fact<WindowSnapshot>> {
		this.hooks.beforeSnapshot?.(this);
		return {
			value: clone(this.value()),
			observedAt: "2026-01-01T00:00:00.000Z",
			source: "server",
			coverage: "complete",
			unknown: [],
			evidence: [],
		};
	}

	async click(input: {
		slot: number;
		button: number;
		mode: number;
		expectedRevision: number;
		expectedSlots: { slot: number; stack: StackExpectation }[];
		expectedCursor: StackExpectation;
	}): Promise<WindowClickReceipt> {
		if (input.mode !== 0) throw fail("INVALID_INPUT", "fixture supports mode 0 only");
		if (input.expectedRevision !== this.revision) throw fail("CONFLICT", "revision changed");
		const clicked = input.expectedSlots.find((entry) => entry.slot === input.slot);
		if (clicked != null && !matchesExpectation(this.item(input.slot), clicked.stack))
			throw fail("CONFLICT", "slot expectation changed");
		if (!matchesExpectation(this.cursor, input.expectedCursor)) throw fail("CONFLICT", "cursor expectation changed");
		if (this.unknownFrom != null && this.clicks >= this.unknownFrom) {
			this.clicks++;
			return { effect: "eff:fixture", dispatch: "sent", completion: "unknown", needsSnapshot: true, evidence: [] };
		}
		const [nextSlot, nextCursor] = applyClick(this.item(input.slot), this.cursor, input.button);
		this.set(input.slot, nextSlot);
		this.cursor = nextCursor;
		this.revision++;
		this.clicks++;
		this.hooks.afterClick?.(this, input.slot, input.button);
		return {
			effect: "eff:fixture",
			dispatch: "sent",
			completion: "met",
			needsSnapshot: false,
			evidence: [],
			confirmed: clone(this.value()),
		};
	}

	async close(): Promise<void> {
		this.closed++;
	}
}

const range = (start: number, count: number): number[] => Array.from({ length: count }, (_, i) => start + i);

export function handLayout(): WindowSnapshot["layout"] {
	return {
		slotCount: 46,
		regions: [
			{ name: "result", slots: [0] },
			{ name: "crafting", slots: range(1, 4) },
			{ name: "armor", slots: range(5, 4) },
			{ name: "player", slots: range(9, 36) },
			{ name: "offhand", slots: [45] },
		],
	};
}

export function tableLayout(): WindowSnapshot["layout"] {
	return {
		slotCount: 46,
		regions: [
			{ name: "result", slots: [0] },
			{ name: "crafting", slots: range(1, 9) },
			{ name: "player", slots: range(10, 36) },
		],
	};
}

export function furnaceLayout(): WindowSnapshot["layout"] {
	return {
		slotCount: 39,
		regions: [
			{ name: "input", slots: [0] },
			{ name: "fuel", slots: [1] },
			{ name: "result", slots: [2] },
			{ name: "player", slots: range(3, 36) },
		],
	};
}

export interface CraftingOptions {
	/** 背包（玩家区）的初始物品，key 是槽号。 */
	player?: Record<number, FixtureStack>;
	/** 网格判定：给定网格里的物品（含 null），返回结果槽内容。 */
	match: (grid: (FixtureStack | null)[]) => FixtureStack | null;
	/** 每次点击后把窗口状态同步给外部（测试用它更新 inventory@1）。 */
	onChange?: (fixture: WindowFixture) => void;
}

/** 工作台/手持窗口：点击结果槽时每个非空格消耗 1 件，并按剩余网格重算结果。 */
export function craftingWindow(kind: "hand" | "table", options: CraftingOptions): WindowFixture {
	const layout = kind === "hand" ? handLayout() : tableLayout();
	const slots: (FixtureStack | null)[] = Array.from({ length: layout.slotCount }, () => null);
	const grid = layout.regions.find((region) => region.name === "crafting")?.slots ?? [];
	for (const [slot, item] of Object.entries(options.player ?? {})) slots[Number(slot)] = clone(item);
	const fixture = new WindowFixture(kind === "hand" ? "minecraft:inventory" : "minecraft:crafting", layout, slots, {
		afterClick: (window, slot) => {
			if (slot === 0) {
				for (const gridSlot of grid) {
					const item = window.item(gridSlot);
					if (item == null) continue;
					window.set(gridSlot, item.count > 1 ? { ...item, count: item.count - 1 } : null);
				}
			}
			window.set(0, options.match(grid.map((gridSlot) => window.item(gridSlot))) ?? null);
			options.onChange?.(window);
		},
	});
	fixture.set(0, options.match(grid.map((gridSlot) => fixture.item(gridSlot))) ?? null);
	return fixture;
}

export interface FurnaceOptions {
	player?: Record<number, FixtureStack>;
	/** 每件产物的烹饪刻数（默认 200）。 */
	ticksPerItem?: number;
	/** 每次 snapshot 推进的刻数（默认恰好一件，测试不必等真实 10 秒）。 */
	ticksPerPoll?: number;
	/** 原料 → 产物；返回 null 表示烧不出来（用来测错误的原料）。 */
	cook: (input: FixtureStack) => { name: string; count: number } | null;
	/** 每次推进/点击后把窗口状态同步给外部。 */
	onChange?: (fixture: WindowFixture) => void;
}

/** 熔炉窗口：每次 snapshot 前推进时间，按燃烧/烹饪累计产出。 */
export function furnaceWindow(options: FurnaceOptions): WindowFixture {
	const slots: (FixtureStack | null)[] = Array.from({ length: 39 }, () => null);
	for (const [slot, item] of Object.entries(options.player ?? {})) slots[Number(slot)] = clone(item);
	const ticksPerItem = options.ticksPerItem ?? 200;
	const ticksPerPoll = options.ticksPerPoll ?? ticksPerItem;
	let burn = 0;
	let progress = 0;
	/** 燃料刚放进去时不能在同一 tick 就被吞掉：否则"放置已确认"的读数会变成 0。 */
	let ignitePending = false;
	const fixture = new WindowFixture("minecraft:furnace", furnaceLayout(), slots, {
		afterClick: (window) => {
			if (burn <= 0 && window.item(1) != null) ignitePending = true;
			options.onChange?.(window);
		},
		beforeSnapshot: (window) => {
			if (ignitePending) {
				ignitePending = false;
				return;
			}
			let pending = ticksPerPoll;
			while (pending > 0) {
				if (burn <= 0) {
					const fuel = window.item(1);
					if (fuel == null) break;
					window.set(1, fuel.count > 1 ? { ...fuel, count: fuel.count - 1 } : null);
					burn = 1600;
				}
				const step = Math.min(pending, burn);
				burn -= step;
				pending -= step;
				progress += step;
				if (progress < ticksPerItem) continue;
				progress -= ticksPerItem;
				const input = window.item(0);
				const result = input == null ? null : options.cook(input);
				if (input == null || result == null) {
					progress = 0;
					break;
				}
				window.set(0, input.count > 1 ? { ...input, count: input.count - 1 } : null);
				const produced = window.item(2);
				window.set(
					2,
					produced == null
						? { name: result.name, count: result.count, stackSize: 64 }
						: { ...produced, count: produced.count + result.count },
				);
			}
			window.properties = { "0": burn, "1": 1600, "2": progress, "3": ticksPerItem };
			options.onChange?.(window);
		},
	});
	return fixture;
}
