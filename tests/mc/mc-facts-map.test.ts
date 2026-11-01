import { describe, expect, test } from "vitest";
import { MapCache, MAP_CELLS, MAP_SIZE } from "../../.uina/worlds/minecraft/driver/facts/map-cache.js";
import type { MapNotice } from "../../.uina/worlds/minecraft/driver/facts/map-cache.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

/**
 * 地图事实（driver.md §11.8）：矩形增量列主序、icons 保留/清空语义、
 * 错误包不污染、重连清空当前覆盖；view.map 投影 null=未收到、0=收到的透明色。
 */

function notice(overrides: Partial<MapNotice> = {}): MapNotice {
	return {
		kind: "map",
		id: 3,
		scale: 0,
		locked: false,
		icons: undefined,
		columns: 0,
		rows: undefined,
		x: undefined,
		y: undefined,
		data: undefined,
		...overrides,
	};
}

describe("MapCache 增量应用", () => {
	test("矩形按列主序落到 z 行 x 列：data[col*rows+row] → (x+col, z+row)", () => {
		const cache = new MapCache();
		cache.apply(notice({ columns: 2, rows: 2, x: 10, y: 20, data: Uint8Array.from([4, 5, 6, 7]) }));
		const state = cache.get(3)!;
		expect(state.scale).toBe(0);
		expect(state.locked).toBe(false);
		// data[0]=(10,20) data[1]=(10,21) data[2]=(11,20) data[3]=(11,21)
		expect(state.colors[20 * MAP_SIZE + 10]).toBe(4);
		expect(state.colors[21 * MAP_SIZE + 10]).toBe(5);
		expect(state.colors[20 * MAP_SIZE + 11]).toBe(6);
		expect(state.colors[21 * MAP_SIZE + 11]).toBe(7);
		expect(state.received.filter((flag) => flag === 1)).toHaveLength(4);
	});

	test("icons：字段缺席保留旧值，空数组明确清空，数组整体替换", () => {
		const cache = new MapCache();
		cache.apply(notice({ icons: [{ type: "player", pixel: { x: 64, z: 64 }, direction: 0, label: null }] }));
		expect(cache.get(3)!.icons).toHaveLength(1);
		cache.apply(notice({ columns: 0 }));
		expect(cache.get(3)!.icons).toHaveLength(1);
		cache.apply(notice({ icons: [] }));
		expect(cache.get(3)!.icons).toEqual([]);
		cache.apply(notice({ icons: [{ type: "frame", pixel: { x: 1, z: 2 }, direction: 8, label: null }] }));
		expect(cache.get(3)!.icons).toEqual([{ type: "frame", pixel: { x: 1, z: 2 }, direction: 8, label: null }]);
	});

	test("columns=0 只更新 scale/locked 与图标，不触碰像素", () => {
		const cache = new MapCache();
		cache.apply(notice({ columns: 1, rows: 1, x: 0, y: 0, data: Uint8Array.from([46]) }));
		cache.apply(notice({ columns: 0, scale: 2, locked: true }));
		const state = cache.get(3)!;
		expect(state.scale).toBe(2);
		expect(state.locked).toBe(true);
		expect(state.received[0]).toBe(1);
	});

	test("矩形/长度不合法的包整包丢弃（scale/locked 已先应用），不污染其他图", () => {
		const cache = new MapCache();
		cache.apply(notice({ id: 1, columns: 1, rows: 1, x: 0, y: 0, data: Uint8Array.from([46]) }));
		cache.apply(notice({ id: 1, columns: 2, rows: 2, x: 0, y: 0, data: Uint8Array.from([1, 2, 3]) }));
		cache.apply(notice({ id: 1, columns: 130, rows: 1, x: 0, y: 0, data: Uint8Array.from([]) }));
		cache.apply(notice({ id: 1, columns: 2, rows: 2, x: 127, y: 0, data: Uint8Array.from([1, 2, 3, 4]) }));
		const state = cache.get(1)!;
		expect(state.received.filter((flag) => flag === 1)).toHaveLength(1);
		expect(state.colors[0]).toBe(46);
		cache.apply(notice({ id: 2, columns: 1, rows: 1, x: 0, y: 0, data: Uint8Array.from([48]) }));
		expect(cache.get(2)!.colors[0]).toBe(48);
	});

	test("clear() 后全部消失；MAP_CELLS 是 16384", () => {
		const cache = new MapCache();
		cache.apply(notice({ columns: 1, rows: 1, x: 0, y: 0, data: Uint8Array.from([46]) }));
		expect(cache.size).toBe(1);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get(3)).toBeNull();
		expect(MAP_CELLS).toBe(16384);
	});
});

describe("FactsSource 的 map 事实", () => {
	type FakeClient = { emit(event: string, packet: unknown): void };

	function mapHarness() {
		return makeFactsHarness({
			bot: makeBot({ version: "1.21.11", registry: { mapIcons: { "0": { name: "player" }, "1": { name: "frame" } } } }),
		});
	}

	function clientOf(h: ReturnType<typeof mapHarness>): FakeClient {
		return h.bot()._client as FakeClient;
	}

	function packet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return { itemDamage: 3, scale: 0, locked: false, icons: null, columns: 0, ...overrides };
	}

	test("协议窄口 map 包 → view.map 投影；未收到 id 是 null + unknown", () => {
		const h = mapHarness();
		const absent = h.facts.sample((view) => view.map(9)).value;
		expect(absent.value).toBeNull();
		expect(absent.unknown).toHaveLength(1);
		clientOf(h).emit("map", packet({ columns: 2, rows: 1, x: 5, y: 6, data: Uint8Array.from([0, 46]) }));
		const fact = h.facts.sample((view) => view.map(3)).value;
		expect(fact.value).not.toBeNull();
		expect(fact.value.colors).toHaveLength(MAP_CELLS);
		expect(fact.value.colors[6 * MAP_SIZE + 5]).toBe(0); // 收到的透明色，不是 null
		expect(fact.value.colors[6 * MAP_SIZE + 6]).toBe(46);
		expect(fact.value.colors[0]).toBeNull(); // 未收到
		expect(fact.value.center).toBeNull();
		expect(fact.value.dimension).toBeNull();
	});

	test("icons 解码：类型名经 registry、displayName NBT → label；字段缺席保留旧值", () => {
		const h = mapHarness();
		clientOf(h).emit(
			"map",
			packet({
				icons: [
					{
						type: 0,
						x: 64,
						z: 64,
						direction: 8,
						displayName: { type: "compound", value: { text: { type: "string", value: "wp" } } },
					},
					{ type: 1, x: 10, z: 20, direction: 0, displayName: undefined },
				],
			}),
		);
		const first = h.facts.sample((view) => view.map(3)).value;
		expect(first.value.icons).toEqual([
			{ type: "player", pixel: { x: 64, z: 64 }, direction: 8, label: "wp" },
			{ type: "frame", pixel: { x: 10, z: 20 }, direction: 0, label: null },
		]);
		clientOf(h).emit("map", packet({}));
		const kept = h.facts.sample((view) => view.map(3)).value;
		expect(kept.value.icons).toHaveLength(2);
		clientOf(h).emit("map", packet({ icons: [] }));
		expect(h.facts.sample((view) => view.map(3)).value.value.icons).toEqual([]);
	});

	test("map 包推进观察版本；重连清空当前覆盖", () => {
		const h = mapHarness();
		const before = h.facts.sample(() => null).stamp.sequence;
		clientOf(h).emit("map", packet({ columns: 1, rows: 1, x: 0, y: 0, data: Uint8Array.from([46]) }));
		const after = h.facts.sample(() => null).stamp.sequence;
		expect(after).toBeGreaterThan(before);
		h.disconnect();
		expect(() => h.facts.sample(() => null)).toThrow(/DISCONNECTED|disconnected/);
		h.reconnect(makeBot({ version: "1.21.11", registry: { mapIcons: {} } }) as never);
		const reconnected = h.facts.sample((view) => view.map(3)).value;
		expect(reconnected.value).toBeNull(); // 旧覆盖不复活
	});
});
