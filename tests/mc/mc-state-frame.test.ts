import { describe, expect, test } from "vitest";
import type { ClientFactView } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { CurrentReader, StateFrameOptions } from "../../.uina/worlds/minecraft/world/state-frame.js";
import { sampleStateFrame } from "../../.uina/worlds/minecraft/world/state-frame.js";

/**
 * 请求前状态帧：同一 facts.sample 边界的三个段落、整数坐标、背包折叠、段落降级、断线如实。
 * 这里没有任何定时器/订阅/去重——状态不是消息，采样一次就返回一次。
 */

function reader(value: unknown, unknown: string[] = []): CurrentReader {
	return {
		kind: "current",
		read: () => ({ value, observedAt: "t", source: "server", coverage: "complete", unknown, evidence: [] }),
	} as unknown as CurrentReader;
}

function failingReader(message: string): CurrentReader {
	return {
		kind: "current",
		read: () => {
			throw new Error(message);
		},
	} as unknown as CurrentReader;
}

function rig(
	overrides: Partial<StateFrameOptions["readers"]> = {},
	options: { failSample?: string } = {},
): StateFrameOptions {
	return {
		facts: {
			sample: <T>(read: (view: ClientFactView) => T) => {
				if (options.failSample) throw Object.assign(new Error(options.failSample), { code: options.failSample });
				return { value: read({} as ClientFactView), stamp: {}, scope: {}, evidenceThrough: {} };
			},
		} as unknown as StateFrameOptions["facts"],
		readers: {
			self: reader({
				place: { dimension: "minecraft:overworld", position: { x: 10.6, y: 64.2, z: -3.2 } },
				health: 16,
				maxHealth: 20,
				food: 18,
				onGround: true,
				held: { name: "oak_log", count: 12 },
			}),
			inventory: reader({
				revision: 4,
				counts: { oak_log: 12, torch: 18, raw_iron: 4 },
				usedSlots: 3,
				freeSlots: 33,
			}),
			world: reader({ timeOfDay: "night", dayCount: 3, weather: "clear", biome: "plains" }),
			...overrides,
		},
	};
}

describe("state frame", () => {
	test("三段同一采样边界；站位取脚下那格、维度去掉命名空间、手持与背包同帧", () => {
		const frame = sampleStateFrame(rig());
		expect(frame.connected).toBe(true);
		expect(frame.text).toBe(
			[
				// 10.6 → 10、-3.2 → -4：与全世界 Math.floor 的方块坐标一致，不是四舍五入。
				"overworld (10,64,-4) 生命16/20 饥饿18/20 在地面 手持oak_log×12",
				"night·第3天·clear·plains",
				"背包3种/3格 空33格：torch×18 oak_log×12 raw_iron×4",
			].join("\n"),
		);
	});

	test("背包按数量降序并折叠：超过上限只报种类数与剩余项", () => {
		const counts: Record<string, number> = {};
		for (let index = 0; index < 14; index++) counts[`item_${index}`] = 14 - index;
		const frame = sampleStateFrame(rig({ inventory: reader({ counts, usedSlots: 14, freeSlots: 22 }) }));
		expect(frame.text).toContain("item_0×14");
		expect(frame.text).toContain("item_9×5");
		expect(frame.text).not.toContain("item_10×4");
		expect(frame.text).toContain("背包14种/14格 空22格");
		expect(frame.text).toContain("…+4种");
	});

	test("背包为空只说一次空，不写 0种/0格：空 这种自相矛盾的格式", () => {
		const frame = sampleStateFrame(rig({ inventory: reader({ counts: {}, usedSlots: 0, freeSlots: 36 }) }));
		expect(frame.text).toContain("背包：空（36格全空）");
	});

	test("单段读取失败只降级该段，其余段落仍然可用", () => {
		const frame = sampleStateFrame(rig({ self: failingReader("boom") }));
		expect(frame.connected).toBe(true);
		expect(frame.unknown).toEqual(["self"]);
		expect(frame.text).not.toContain("生命");
		expect(frame.text).toContain("night·第3天");
		expect(frame.text).toContain("背包3种");
	});

	test("读取器报的字段级缺口不进 unknown（在地面上没有氧气是正常的，不是降级）", () => {
		const frame = sampleStateFrame(
			rig({ self: reader({ health: 20, maxHealth: 20, food: 20 }, ["oxygen not received"]) }),
		);
		expect(frame.unknown).toEqual([]);
		expect(frame.text).toContain("生命20/20");
	});

	test("生命没收到时说未知，不留白让模型当成满血", () => {
		const frame = sampleStateFrame(rig({ self: reader({ health: null, maxHealth: 20, food: null }) }));
		expect(frame.text).toContain("生命未知");
		expect(frame.text).toContain("饥饿未知");
		expect(frame.text).not.toContain("生命0");
	});

	test("三段全读不到时明确说出不可读，不返回空正文", () => {
		const frame = sampleStateFrame(
			rig({ self: failingReader("a"), inventory: failingReader("b"), world: failingReader("c") }),
		);
		expect(frame.connected).toBe(true);
		expect(frame.text).toBe("Minecraft 状态不可读（缺失段落：self、inventory、world）");
	});

	test("未附着活连接：connected=false 且明确要求不要按旧坐标行动", () => {
		const frame = sampleStateFrame(rig({}, { failSample: "WRONG_STATE" }));
		expect(frame.connected).toBe(false);
		expect(frame.text).toContain("Minecraft 未连接");
		expect(frame.text).toContain("不要按旧坐标");
		expect(frame.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("非连接原因采样失败如实带出原因，不冒充未连接", () => {
		const frame = sampleStateFrame(rig({}, { failSample: "INTERNAL" }));
		expect(frame.connected).toBe(false);
		expect(frame.text).toContain("Minecraft 状态不可用：INTERNAL");
	});

	test("危险状态压过在地面/在水里，氧气只在水中报", () => {
		const lava = sampleStateFrame(
			rig({ self: reader({ place: { position: { x: 0, y: 0, z: 0 } }, inLava: true, onGround: false }) }),
		);
		expect(lava.text).toContain("在岩浆里");
		expect(lava.text).not.toContain("在下落");
		const water = sampleStateFrame(
			rig({ self: reader({ place: { position: { x: 0, y: 0, z: 0 } }, inWater: true, oxygen: 12, onGround: false }) }),
		);
		expect(water.text).toContain("在水里(氧12)");
	});

	// 刚连上时物理还没跑第一拍：onGround 是 false，人却站在地上。说"悬在空中"会让模型
	// 去解释一件没发生的事（真模型第一轮就照着这行说了"人正悬在空中"）。
	test("离地只在真下落时说，刚连上的 false 不当成空中", () => {
		const settled = sampleStateFrame(
			rig({
				self: reader({
					place: { position: { x: 0, y: 64, z: 0 } },
					onGround: false,
					velocity: { x: 0, y: 0, z: 0 },
					health: 20,
					maxHealth: 20,
					food: 20,
				}),
			}),
		);
		expect(settled.text).not.toContain("在下落");
		expect(settled.text).not.toContain("在空中");
		const falling = sampleStateFrame(
			rig({
				self: reader({
					place: { position: { x: 0, y: 64, z: 0 } },
					onGround: false,
					velocity: { x: 0, y: -0.4, z: 0 },
					health: 20,
					maxHealth: 20,
					food: 20,
				}),
			}),
		);
		expect(falling.text).toContain("在下落");
	});
});
