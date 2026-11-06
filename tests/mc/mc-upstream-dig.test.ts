import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// 补丁后的挖掘生命周期（mineflayer digging.js）：终态唯一且互斥——
// 成功=服务端把该格改成类型不同的方块（留水也算；纯状态变化与 (null,null) 不算）；
// 取消=stopDigging；超时=预算 max(8s, digTime×3)。本地不再伪造空气（旧实现
// _updateBlockState(pos,0) 让 bot.dig 永远成功）。targetDigBlock 保持到终态，
// 确认窗口内 stopDigging 仍可取消（旧实现 finish 包发出即清空 → 取消通道失灵）。
// heldItem 用钻石镐（stone ≈200ms）：预算收敛为下限 8000ms，测试可快进。
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const injectDigging = require("mineflayer/lib/plugins/digging.js") as (bot: object) => void;
const registry = mf("prismarine-registry")("1.21.11") as {
	blocksByName: Record<string, { minStateId: number; id: number }>;
	itemsByName: Record<string, { id: number }>;
};
const Block = mf("prismarine-block")(registry) as { fromStateId(id: number, meta: number): DigBlock };
const vec3 = mf("vec3") as { Vec3: new (x: number, y: number, z: number) => DigVec3 };

interface DigVec3 {
	x: number;
	y: number;
	z: number;
	toString(): string;
	offset(x: number, y: number, z: number): DigVec3;
}
interface DigBlock {
	type: number;
	name: string;
	position: DigVec3;
	shapes: number[][];
	digTime(...args: unknown[]): number;
}

const STONE = registry.blocksByName.stone.minStateId;
const AIR = 0;
const WATER = registry.blocksByName.water.minStateId;

function blockAt(id: number, position: DigVec3): DigBlock {
	const block = Block.fromStateId(id, 0);
	block.position = position;
	return block;
}

function makeBot() {
	const packets: Array<{ name: string; input: Record<string, unknown> }> = [];
	const updateBlockStates: Array<[DigVec3, number]> = [];
	const completed: unknown[] = [];
	const aborted: unknown[] = [];
	const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
	const world = (position: DigVec3): DigBlock | null =>
		position.y < 64 ? blockAt(STONE, position) : blockAt(AIR, position);
	bot.registry = registry;
	bot.entity = { position: new vec3.Vec3(0, 64, 0), onGround: true, eyeHeight: 1.62, effects: {} };
	bot.game = { gameMode: "survival" };
	bot.inventory = { slots: [] };
	bot.getEquipmentDestSlot = (dest: string) => (dest === "head" ? 6 : 5);
	bot.heldItem = { type: registry.itemsByName.diamond_pickaxe.id, enchants: [] };
	bot.blockAt = (position: DigVec3) => world(position);
	bot._client = {
		write: (name: string, input: Record<string, unknown>) => packets.push({ name, input }),
		on: () => {},
		removeListener: () => {},
	};
	bot.lookAt = async () => {};
	bot.swingArm = () => {};
	bot._updateBlockState = (position: DigVec3, state: number) => {
		updateBlockStates.push([position, state]);
	};
	bot.on("diggingCompleted", (block: unknown) => completed.push(block));
	bot.on("diggingAborted", (block: unknown) => aborted.push(block));
	injectDigging(bot);
	return { bot, packets, updateBlockStates, completed, aborted };
}

function digStoneAt(
	bot: EventEmitter & Record<string, unknown>,
	position: DigVec3,
): { promise: Promise<unknown>; block: DigBlock } {
	const block = blockAt(STONE, position);
	const dig = bot.dig as (b: DigBlock, look: boolean) => Promise<unknown>;
	// dig() 的 lookAt 是一个微任务：调用方需先 flushDig() 让 dig 主体跑完
	// （注册 blockUpdate 监听器、装定时器）再发服务端事件。
	return { promise: dig(block, true), block };
}

const flushDig = async (): Promise<void> => {
	await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("patched digging lifecycle", () => {
	test("server type change (air) completes; local world is never written", async () => {
		const { bot, updateBlockStates, completed } = makeBot();
		const { promise, block } = digStoneAt(bot, new vec3.Vec3(0, 63, 0));
		await flushDig();
		bot.emit(`blockUpdate:${block.position}`, block, blockAt(AIR, block.position));
		await expect(promise).resolves.toBeUndefined();
		expect(updateBlockStates).toEqual([]);
		expect(completed).toHaveLength(1);
	});

	test("water replacement completes the dig", async () => {
		const { bot, completed } = makeBot();
		const { promise, block } = digStoneAt(bot, new vec3.Vec3(0, 63, 0));
		await flushDig();
		bot.emit(`blockUpdate:${block.position}`, block, blockAt(WATER, block.position));
		await expect(promise).resolves.toBeUndefined();
		expect(completed).toHaveLength(1);
	});

	test("state-only updates and world unload do not complete; budget then rejects", async () => {
		const { bot, completed } = makeBot();
		const { promise, block } = digStoneAt(bot, new vec3.Vec3(0, 63, 0));
		await flushDig();
		// 同类型更新（如朝向变化）不算完成；世界卸载 (null,null) 也不算成功
		bot.emit(`blockUpdate:${block.position}`, block, blockAt(STONE, block.position));
		bot.emit(`blockUpdate:${block.position}`, null, null);
		expect(completed).toHaveLength(0);
		// 预算（heldItem=钻石镐 → waitTime≈400ms → 预算取下限 8000ms）到点拒绝；
		// 先挂接拒绝断言再快进，避免瞬间 unhandled rejection
		const rejection = expect(promise).rejects.toThrow(/did not confirm/);
		await vi.advanceTimersByTimeAsync(8100);
		await rejection;
		expect(completed).toHaveLength(0);
	});

	test("targetDigBlock survives the confirmation window and stopDigging still cancels", async () => {
		const { bot, packets, completed, aborted } = makeBot();
		const { promise, block } = digStoneAt(bot, new vec3.Vec3(0, 63, 0));
		await flushDig();
		await vi.advanceTimersByTimeAsync(1500); // finish 包已发出（waitTime≈400ms），仍在确认窗口
		expect(bot.targetDigBlock).not.toBeNull();
		(bot.stopDigging as () => void)();
		await expect(promise).rejects.toThrow(/aborted/);
		expect(aborted).toHaveLength(1);
		const cancels = packets.filter((p) => p.name === "block_dig" && p.input.status === 1);
		expect(cancels).toHaveLength(1);
		expect(bot.targetDigBlock).toBeNull();
		// 迟到的确认不能触发第二个终态
		bot.emit(`blockUpdate:${block.position}`, block, blockAt(AIR, block.position));
		expect(completed).toHaveLength(0);
		expect(aborted).toHaveLength(1);
	});

	test("late confirmation after unconfirmed budget does not double-settle", async () => {
		const { bot, completed } = makeBot();
		const { promise, block } = digStoneAt(bot, new vec3.Vec3(0, 63, 0));
		await flushDig();
		const rejection = expect(promise).rejects.toThrow(/did not confirm/);
		await vi.advanceTimersByTimeAsync(8100);
		await rejection;
		bot.emit(`blockUpdate:${block.position}`, block, blockAt(AIR, block.position));
		expect(completed).toHaveLength(0);
	});
});
