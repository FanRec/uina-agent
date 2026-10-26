import { describe, expect, test, vi } from "vitest";
import type { SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { makeBot, makeFactsHarness } from "./mc-fake.js";

/**
 * self 事实回归（values.ts 非伪造原则 / driver.md §11）。
 *
 * 三个历史缺陷：
 * 1. health/food 未收到时填 0，同时又把字段列进 unknown —— 自相矛盾，调用方会把 0 当真实血量。
 * 2. inWater/inLava 由脚部方块名推导：waterlogged/气泡柱/流动水全错，且默认 blockAt 失败即 unknown。
 * 3. sampleSelf() 声明返回 Fact<SelfState> 却在实体未就绪时给 null，类型在说谎。
 */

function entity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		position: { x: 10.5, y: 64, z: -3.25 },
		velocity: { x: 0, y: 0, z: 0 },
		onGround: true,
		effects: {},
		...overrides,
	};
}

function readSelf(h: ReturnType<typeof makeFactsHarness>): Fact<SelfState | null> {
	// sample 返回捕获包装（stamp/scope/evidenceThrough + value）；这里只看事实本身
	return h.facts.sample((view) => view.self()).value;
}

describe("self：缺失即 null + unknown", () => {
	test("health/food 未收到：值为 null 并列入 unknown，不得填 0", () => {
		const bot = makeBot({ entity: entity(), game: { dimension: "overworld" }, registry: { effects: {} } });
		const h = makeFactsHarness({ bot });
		const self = readSelf(h);
		expect(self.value).not.toBeNull();
		expect(self.value?.health).toBeNull();
		expect(self.value?.food).toBeNull();
		expect(self.unknown).toContain("health not received");
		expect(self.unknown).toContain("food not received");
	});

	test("health/food 已收到：原样保留数值", () => {
		const bot = makeBot({
			entity: entity(),
			health: 18,
			food: 17,
			foodSaturation: 5,
			game: { dimension: "overworld" },
			registry: { effects: {} },
		});
		const h = makeFactsHarness({ bot });
		const self = readSelf(h);
		expect(self.value?.health).toBe(18);
		expect(self.value?.food).toBe(17);
		expect(self.unknown).not.toContain("health not received");
	});
});

describe("self：inWater/inLava 取客户端物理判定", () => {
	test("实体布尔被采信：true 即 true，不再看脚部方块", () => {
		const bot = makeBot({
			entity: entity({ isInWater: true, isInLava: false }),
			game: { dimension: "overworld" },
			registry: { effects: {} },
			// 故意给一个"水面方块"：旧实现会把它当唯一依据
			blockAt: () => ({ name: "water", getProperties: () => ({}) }),
		});
		const h = makeFactsHarness({ bot });
		const self = readSelf(h);
		expect(self.value?.inWater).toBe(true);
		expect(self.value?.inLava).toBe(false);
		expect(self.unknown).not.toContain("inWater not observed: client physics has not resolved water contact yet");
	});

	test("物理尚未写入：null + unknown，不按方块名推导", () => {
		const bot = makeBot({
			entity: entity(), // 无 isInWater/isLava
			game: { dimension: "overworld" },
			registry: { effects: {} },
			blockAt: () => ({ name: "water", getProperties: () => ({}) }),
		});
		const h = makeFactsHarness({ bot });
		const self = readSelf(h);
		expect(self.value?.inWater).toBeNull();
		expect(self.value?.inLava).toBeNull();
		expect(self.unknown).toContain("inWater not observed: client physics has not resolved water contact yet");
		expect(self.unknown).toContain("inLava not observed: client physics has not resolved lava contact yet");
	});

	test("basis 把 inWater/inLava 归到 prediction 路径", () => {
		const bot = makeBot({
			entity: entity({ isInWater: false, isInLava: false }),
			game: { dimension: "overworld" },
			registry: { effects: {} },
		});
		const h = makeFactsHarness({ bot });
		const self = readSelf(h);
		const prediction = self.basis?.find((entry) => entry.source === "prediction");
		expect(prediction?.paths).toContain("/inWater");
		expect(prediction?.paths).toContain("/inLava");
	});
});

describe("sampleSelf：实体未就绪时值可为 null", () => {
	test("有连接但无实体：value=null 且列入 unknown，不抛错", () => {
		const bot = makeBot({ game: { dimension: "overworld" }, registry: { effects: {} } });
		const h = makeFactsHarness({ bot });
		const self = h.facts.sampleSelf();
		expect(self).not.toBeNull();
		expect(self?.value).toBeNull();
		expect(self?.unknown.length).toBeGreaterThan(0);
	});

	test("未附着连接：返回 null（无源，不是未知值）", () => {
		const h = makeFactsHarness({ state: "disconnected" });
		expect(h.facts.sampleSelf()).toBeNull();
	});
});

test("installed Mineflayer attribute and oxygen shapes produce usable vitals", () => {
	const bot = makeBot({
		entity: entity({
			attributes: {
				"minecraft:max_health": {
					value: 20,
					modifiers: [
						{ operation: 0, amount: 4 },
						{ operation: 1, amount: 0.5 },
						{ operation: 2, amount: 0.5 },
					],
				},
			},
		}),
		oxygenLevel: 3,
		health: 6,
		game: { dimension: "overworld" },
		registry: { effects: {} },
	});
	const h = makeFactsHarness({ bot });
	const self = readSelf(h);
	expect(self.value?.oxygen).toBe(3);
	expect(self.value?.maxHealth).toBe(54);
});

test("received breathing immunity expires and respawn discards the previous body's effects", () => {
	const now = vi.spyOn(performance, "now").mockReturnValue(0);
	try {
		const bot = makeBot({
			entity: entity(),
			game: { dimension: "overworld" },
			registry: { effects: { 1: { name: "WaterBreathing" } } },
		});
		const h = makeFactsHarness({ bot });
		bot.emit("entityEffect", bot.entity, { id: 1, amplifier: 0, duration: 2 });
		expect(readSelf(h).value?.effects?.[0]?.name).toBe("water_breathing");
		now.mockReturnValue(101);
		bot.emit("physicsTick");
		expect(readSelf(h).value?.effects).toEqual([]);
		bot.emit("entityEffect", bot.entity, { id: 1, amplifier: 0, duration: -1 });
		expect(readSelf(h).value?.effects).toHaveLength(1);
		bot.emit("respawn");
		expect(readSelf(h).value?.effects).toEqual([]);
	} finally {
		now.mockRestore();
	}
});
