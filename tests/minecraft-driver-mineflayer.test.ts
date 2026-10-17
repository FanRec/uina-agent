/**
 * Mineflayer 适配层单元测试。
 *
 * 用结构化 fake mineflayer 对象验证"协议对象 → ClientBot 纯值/动作"的映射；
 * 不连接真实服务器，因此不证明实服行为（那属于真实服务器验收）。
 */

import { describe, expect, it } from "vitest";
import { createDriver } from "../.uina/worlds/minecraft/driver/index.js";
import {
	MineflayerClientBot,
	type MineflayerBlock,
	type MineflayerBot,
	type MineflayerColumn,
	type MineflayerEntity,
	type MineflayerItem,
	type MineflayerWindow,
} from "../.uina/worlds/minecraft/driver/mineflayer/client-bot.js";
import { createMineflayerBot } from "../.uina/worlds/minecraft/driver/mineflayer/index.js";

type Listener = (...args: never[]) => void;

class FakeWindow implements MineflayerWindow {
	readonly #listeners = new Map<string, Set<Listener>>();
	readonly selectedItem: MineflayerItem | null = null;

	constructor(
		readonly id: number,
		readonly type: string,
		readonly slots: (MineflayerItem | null)[],
	) {}

	on(event: "updateSlot", listener: Listener): unknown {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}

	off(event: "updateSlot", listener: Listener): unknown {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	items(): MineflayerItem[] {
		return this.slots.filter((item): item is MineflayerItem => item !== null);
	}

	updateSlot(slot: number, item: MineflayerItem | null): void {
		this.slots[slot] = item;
		for (const listener of [...(this.#listeners.get("updateSlot") ?? [])]) {
			(listener as unknown as (slot: number, old: MineflayerItem | null, item: MineflayerItem | null) => void)(
				slot,
				null,
				item,
			);
		}
	}
}

const item = (name: string, count = 1, extra: Partial<MineflayerItem> = {}): MineflayerItem => ({
	name,
	count,
	...extra,
});

class FakeMineflayerBot implements MineflayerBot {
	readonly version = "1.21.4";
	readonly #listeners = new Map<string, Set<Listener>>();
	readonly control = new Map<string, boolean>();
	readonly calls: { name: string; args: unknown[] }[] = [];

	physicsEnabled = true;
	entity: MineflayerEntity = {
		id: 1,
		uuid: "self-uuid",
		type: "player",
		position: { x: 10, y: 64, z: -3 },
		velocity: { x: 0, y: 0, z: 0 },
		yaw: 1.5,
		pitch: -0.2,
		onGround: true,
	};
	entities: Record<string, MineflayerEntity> = {
		"1": this.entity,
		"7": {
			id: 7,
			uuid: "mob-uuid",
			type: "mob",
			position: { x: 12, y: 64, z: -3 },
			velocity: { x: 0.1, y: 0, z: 0 },
		},
	};
	readonly game = { dimension: "overworld" };
	readonly health = 18;
	readonly food = 15;
	readonly quickBarSlot = 2;
	readonly inventory = new FakeWindow(0, "minecraft:inventory", new Array(46).fill(null));
	currentWindow: MineflayerWindow | null = null;
	readonly world: { getColumn(chunkX: number, chunkZ: number): MineflayerColumn | null } = {
		getColumn: () => this.column,
	};
	column: MineflayerColumn | null = null;
	readonly usingHeldItem = false;
	blocks = new Map<string, MineflayerBlock>();

	on(event: string, listener: Listener): unknown {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}

	off(event: string, listener: Listener): unknown {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.#listeners.get(event) ?? [])]) {
			(listener as unknown as (...a: unknown[]) => void)(...args);
		}
	}

	record(name: string, ...args: unknown[]): void {
		this.calls.push({ name, args });
	}

	setControlState(key: string, on: boolean): void {
		this.control.set(key, on);
		this.record("setControlState", key, on);
	}

	getControlState(key: string): boolean {
		return this.control.get(key) ?? false;
	}

	clearControlStates(): void {
		this.control.clear();
		this.record("clearControlStates");
	}

	async look(yaw: number, pitch: number, force?: boolean): Promise<void> {
		this.record("look", yaw, pitch, force);
	}

	blockAt(point: { x: number; y: number; z: number }): MineflayerBlock | null {
		return this.blocks.get(`${point.x},${point.y},${point.z}`) ?? null;
	}

	chat(text: string): void {
		this.record("chat", text);
	}

	async dig(block: MineflayerBlock, forceLook?: boolean | "ignore"): Promise<void> {
		this.record("dig", block, forceLook);
	}

	/** 上游 digging.js 完成挖掘后的本地写入入口（blocks.js L246 → emit blockUpdate）。 */
	_updateBlockState(point: { x: number; y: number; z: number }, stateId: number): void {
		this.record("_updateBlockState", point, stateId);
		const next = blockAtState(stateId, point);
		if (next) this.blocks.set(`${point.x},${point.y},${point.z}`, next);
		this.emit("blockUpdate", null, next);
	}

	stopDigging(): void {
		this.record("stopDigging");
	}

	attack(entity: MineflayerEntity): void {
		this.record("attack", entity.id);
	}

	activateItem(offHand?: boolean): void {
		this.record("activateItem", offHand);
	}

	deactivateItem(): void {
		this.record("deactivateItem");
	}

	async activateBlock(block: MineflayerBlock, direction?: unknown, cursorPos?: unknown): Promise<void> {
		this.record("activateBlock", block.position, direction, cursorPos);
	}

	async activateEntity(entity: MineflayerEntity): Promise<void> {
		this.record("activateEntity", entity.id);
	}

	async equip(chosen: MineflayerItem, destination: "hand" | "off-hand"): Promise<void> {
		this.record("equip", chosen.name, destination);
	}

	async clickWindow(slot: number, mouseButton: number, mode: number): Promise<void> {
		this.record("clickWindow", slot, mouseButton, mode);
	}

	async closeWindow(window: MineflayerWindow): Promise<void> {
		this.record("closeWindow", window.id);
	}

	quit(): void {
		this.record("quit");
	}
}

function block(name: string, x: number, y: number, z: number, properties = {}): MineflayerBlock {
	return { name, position: { x, y, z }, getProperties: () => properties };
}

/** 上游 _updateBlockState 的 stateId → Block 映射：0 是空气，其余一律当石头（测试只需形状）。 */
function blockAtState(stateId: number, point: { x: number; y: number; z: number }): MineflayerBlock | null {
	return stateId === 0 ? block("air", point.x, point.y, point.z) : block("stone", point.x, point.y, point.z);
}

describe("MineflayerClientBot", () => {
	it("自身/方块/实体采样转换为纯值，且排除自身实体", () => {
		const raw = new FakeMineflayerBot();
		raw.blocks.set("10,63,-3", block("stone", 10, 63, -3, { axis: "y", waterlogged: false }));
		const bot = new MineflayerClientBot(raw);

		expect(bot.self()).toEqual({
			position: { x: 10, y: 64, z: -3 },
			velocity: { x: 0, y: 0, z: 0 },
			yaw: 1.5,
			pitch: -0.2,
			onGround: true,
			health: 18,
			food: 15,
			dimension: "minecraft:overworld",
		});
		// 属性统一为字符串：false → "false"，不把 boolean 泄漏进 Block State 合同。
		expect(bot.blockAt({ x: 10, y: 63, z: -3 })).toEqual({
			name: "stone",
			properties: { axis: "y", waterlogged: "false" },
		});
		expect(bot.blockAt({ x: 0, y: 0, z: 0 })).toBeNull();
		expect(bot.entities()).toEqual([
			{
				networkId: 7,
				uuid: "mob-uuid",
				type: "mob",
				position: { x: 12, y: 64, z: -3 },
				velocity: { x: 0.1, y: 0, z: 0 },
			},
		]);
	});

	it("库存选中槽换算为绝对槽位，窗口内容按代次暴露", () => {
		const raw = new FakeMineflayerBot();
		raw.inventory.slots[38] = item("iron_pickaxe", 1, { maxDurability: 250, durabilityUsed: 10 });
		const window = new FakeWindow(3, "minecraft:chest", [item("dirt", 64), null]);
		raw.currentWindow = window;
		const bot = new MineflayerClientBot(raw);

		const inventory = bot.inventorySlots();
		expect(inventory.slotCount).toBe(46);
		expect(inventory.selectedSlot).toBe(38);
		expect(inventory.slots[38]).toEqual({
			name: "iron_pickaxe",
			count: 1,
			components: null,
			remainingDurability: 240,
		});
		expect(bot.currentWindow()).toEqual({
			id: 3,
			type: "minecraft:chest",
			slotCount: 2,
			slots: [{ name: "dirt", count: 64, components: null, remainingDurability: null }, null],
			cursor: null,
			properties: {},
		});
	});

	it("section 生成 palette + indices，blockUpdate 推进 revision", () => {
		const raw = new FakeMineflayerBot();
		const data = { get: (index: number) => (index === 0 ? 5 : 5) };
		raw.column = { minY: -64, sections: [] };
		raw.column.sections[8] = { data };
		raw.blocks.set("0,64,0", block("stone", 0, 64, 0, { axis: "y" }));
		const bot = new MineflayerClientBot(raw);

		const first = bot.section({ x: 0, y: 4, z: 0 });
		expect(first?.base?.palette).toEqual([{ name: "stone", properties: { axis: "y" } }]);
		expect(first?.base?.indices).toHaveLength(4096);
		expect(first?.base?.indices.every((value) => value === 0)).toBe(true);

		raw.emit("blockUpdate", null, block("stone", 0, 64, 0));
		const afterBlock = bot.section({ x: 0, y: 4, z: 0 })?.revision;
		expect(afterBlock).not.toBe(first?.revision);
		// chunkColumnLoad 给的是区块角（x*16, z*16），必须归一到区块坐标才能命中同一 revision 键。
		raw.emit("chunkColumnLoad", { x: 0, y: 0, z: 0 });
		expect(bot.section({ x: 0, y: 4, z: 0 })?.revision).not.toBe(afterBlock);
		expect(bot.section({ x: 0, y: 9, z: 0 })).toBeNull();
	});

	it("dig 的 forceLook 映射：target=true，preserve='ignore'；未加载格拒绝", async () => {
		const raw = new FakeMineflayerBot();
		raw.blocks.set("1,64,1", block("oak_log", 1, 64, 1));
		const bot = new MineflayerClientBot(raw);

		await bot.dig({ x: 1, y: 64, z: 1 }, { forceLook: true });
		await bot.dig({ x: 1, y: 64, z: 1 }, { forceLook: false });
		expect(raw.calls.filter((c) => c.name === "dig").map((c) => c.args[1])).toEqual([true, "ignore"]);
		await expect(bot.dig({ x: 9, y: 9, z: 9 }, { forceLook: true })).rejects.toThrow(/未加载/);
	});

	it("攻击/交互按网络 ID 解析实体，未跟踪实体明确失败", () => {
		const raw = new FakeMineflayerBot();
		const bot = new MineflayerClientBot(raw);

		bot.attack(7);
		bot.activateEntity(7);
		expect(raw.calls.filter((c) => c.name === "attack")).toEqual([{ name: "attack", args: [7] }]);
		expect(() => bot.attack(404)).toThrow(/实体未跟踪/);
	});

	it("本地写入期间的 blockUpdate 标为 prediction，服务器入包标为 server", () => {
		const raw = new FakeMineflayerBot();
		raw.blocks.set("2,64,2", block("stone", 2, 64, 2));
		const bot = new MineflayerClientBot(raw);
		const seen: (readonly [string, string])[] = [];
		bot.on("blockUpdate", (pos, _info, source) => seen.push([source, `${pos.x},${pos.y},${pos.z}`]));

		// digging.js L158 的本地写入 → 预测；服务端 block_change 不经 _updateBlockState → 确认。
		raw._updateBlockState({ x: 2, y: 64, z: 2 }, 0);
		raw.emit("blockUpdate", block("stone", 3, 64, 3), block("dirt", 3, 64, 3));

		expect(seen).toEqual([
			["prediction", "2,64,2"],
			["server", "3,64,3"],
		]);
	});

	it("窗口打开/槽位更新/关闭按协议窗口 ID 派发", () => {
		const raw = new FakeMineflayerBot();
		const bot = new MineflayerClientBot(raw);
		const opened: unknown[] = [];
		const slots: unknown[] = [];
		const closed: unknown[] = [];
		bot.on("windowOpen", (window) => opened.push(window));
		bot.on("setSlot", (windowId, slot, stack, cursor) => slots.push([windowId, slot, stack, cursor]));
		bot.on("windowClose", (windowId) => closed.push(windowId));

		const window = new FakeWindow(3, "minecraft:chest", [null, null]);
		raw.currentWindow = window;
		raw.emit("windowOpen", window);
		window.updateSlot(1, item("dirt", 64));
		raw.currentWindow = null;
		raw.emit("windowClose", window);

		expect(opened).toEqual([
			{
				id: 3,
				type: "minecraft:chest",
				slotCount: 2,
				slots: [null, null],
				cursor: null,
				properties: {},
			},
		]);
		expect(slots).toEqual([[3, 1, { name: "dirt", count: 64, components: null, remainingDurability: null }, null]]);
		expect(closed).toEqual([3]);
	});

	it("窗口点击校验窗口代次；equip 支持替换名与剩余耐久，components 显式拒绝", async () => {
		const raw = new FakeMineflayerBot();
		raw.inventory.slots[10] = item("iron_pickaxe", 1, { maxDurability: 250, durabilityUsed: 200 });
		raw.inventory.slots[11] = item("diamond_pickaxe", 1, { maxDurability: 1561, durabilityUsed: 1 });
		const window = new FakeWindow(5, "minecraft:chest", []);
		raw.currentWindow = window;
		const bot = new MineflayerClientBot(raw);

		await bot.clickWindow(5, 0, 0, 0);
		await expect(bot.clickWindow(6, 0, 0, 0)).rejects.toThrow(/窗口不存在/);

		await bot.equip({ name: "iron_pickaxe", substitutions: ["diamond_pickaxe"], minDurability: 100 }, "main");
		expect(raw.calls.filter((c) => c.name === "equip")).toEqual([{ name: "equip", args: ["diamond_pickaxe", "hand"] }]);
		await expect(bot.equip({ name: "iron_pickaxe", components: { damage: 0 } }, "main")).rejects.toThrow(/components/);
	});

	it("真实 Mineflayer 工厂建连失败如实 faulted，不制造假连接", async () => {
		// 组合根显式注入真实适配；127.0.0.1:1 无服务，连接被拒 → ClientHost faulted。
		const driver = createDriver(
			{ host: "127.0.0.1", port: 1, username: "uina-test" },
			{ botFactory: createMineflayerBot, attachTimeoutMs: 3_000, stallTimeoutMs: 1_000 },
		);
		for (let attempt = 0; attempt < 120 && driver.connectionState() !== "faulted"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(driver.connectionState()).toBe("faulted");
		await driver.close();
	}, 15_000);

	it("控制状态、视角与物理开关直接透传；quit 关闭连接", async () => {
		const raw = new FakeMineflayerBot();
		const bot = new MineflayerClientBot(raw);

		bot.setControlState("forward", true);
		expect(bot.getControlState("forward")).toBe(true);
		await bot.look(0.5, 0.1, true);
		bot.physicsEnabled = false;
		expect(raw.physicsEnabled).toBe(false);
		bot.clearControlStates();
		bot.quit();

		expect(raw.calls.map((c) => c.name)).toEqual(["setControlState", "look", "clearControlStates", "quit"]);
	});
});
