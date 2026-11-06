import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// 搜索级方块缓存（movements.js getBlock / safeOrBreak / safeToBreak +
// astar.js compute 挂载）：一次 compute 内同位置只物化一个 Block（上游每次
// getBlock 都 new Vec3 + 新 Block），未加载列的 stub 不缓存（列加载后必须
// 立即可见），labor 按方块类型记忆，getMoveJumpUp 不得突变共享 Block。
const program = `
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const { Movements, goals } = pfRequire("mineflayer-pathfinder");
const AStar = pfRequire("mineflayer-pathfinder/lib/astar.js");
const { Vec3 } = mf("vec3");
const Block = mf("prismarine-block")(registry);

function fixture(worldFn, inventory) {
	let blockAtCalls = 0;
	const bot = new EventEmitter();
	bot.registry = registry;
	bot.entity = { position: new Vec3(0, 64, 0), effects: {} };
	bot.inventory = { items: () => inventory ?? [], slots: [] };
	bot.pathfinder = { bestHarvestTool: () => null };
	bot.game = { minY: -64 };
	bot.blockAt = (position) => {
		blockAtCalls++;
		return worldFn(position);
	};
	const movements = new Movements(bot);
	movements.canDig = true;
	return { bot, movements, calls: () => blockAtCalls };
}

const stoneAt = (position) => {
	const block = Block.fromStateId(position.y < 64 ? registry.blocksByName.stone.minStateId : 0, 0);
	block.position = position;
	return block;
};

const newCache = () => ({ blocks: new Map(), breakable: new Map(), labor: new Map() });

// 1) 缓存命中：同位置同对象，blockAt 只走一次
{
	const f = fixture(stoneAt);
	f.movements.__sliceCache = newCache();
	const a = f.movements.getBlock({ x: 0, y: 63, z: 0 }, 0, 0, 0);
	const b = f.movements.getBlock({ x: 0, y: 63, z: 0 }, 0, 0, 0);
	assert.equal(a, b);
	assert.equal(f.calls(), 1);
}
// 2) 无缓存（compute 外）：每次新读新对象
{
	const f = fixture(stoneAt);
	const a = f.movements.getBlock({ x: 0, y: 63, z: 0 }, 0, 0, 0);
	const b = f.movements.getBlock({ x: 0, y: 63, z: 0 }, 0, 0, 0);
	assert.notEqual(a, b);
	assert.equal(f.calls(), 2);
}
// 3) 未加载 stub 不缓存：列加载后同一缓存窗口内立刻读到真块
{
	let loaded = false;
	const f = fixture((position) => (loaded ? stoneAt(position) : null));
	f.movements.__sliceCache = newCache();
	const stub = f.movements.getBlock({ x: 40, y: 63, z: 40 }, 0, 0, 0);
	assert.equal(stub.type, undefined);
	loaded = true;
	const real = f.movements.getBlock({ x: 40, y: 63, z: 40 }, 0, 0, 0);
	assert.equal(real.type, registry.blocksByName.stone.id);
}
// 4) labor 按类型记忆：同类型两次 safeOrBreak 只调一次 bestHarvestTool
{
	const f = fixture(stoneAt, [{ type: registry.itemsByName.diamond_pickaxe.id, count: 1, enchants: [] }]);
	f.movements.__sliceCache = newCache();
	let toolCalls = 0;
	const original = f.bot.pathfinder.bestHarvestTool;
	f.bot.pathfinder.bestHarvestTool = (block) => { toolCalls++; return original(block); };
	const stone = f.movements.getBlock({ x: 0, y: 63, z: 0 }, 0, 0, 0);
	f.movements.safeOrBreak(stone, []);
	f.movements.safeOrBreak(stone, []);
	assert.equal(toolCalls, 1);
}
// 5) getMoveJumpUp 不突变共享 Block：两次生成同一落点高度
{
	const f = fixture(stoneAt, [{ type: registry.itemsByName.dirt.id, count: 10 }]);
	f.movements.allow1by1towers = true;
	f.movements.__sliceCache = newCache();
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 10;
	const first = [];
	f.movements.getMoveJumpUp(node, { x: 1, z: 0 }, first);
	assert.equal(first.length, 1, "jump-up with placement should generate");
	const second = [];
	f.movements.getMoveJumpUp(node, { x: 1, z: 0 }, second);
	assert.equal(second.length, 1, "second call must still generate (no cached height poisoning)");
}
// 6) compute 挂载/卸载：compute 后缓存必须被丢弃（外部读不到陈旧块）
{
	const f = fixture(stoneAt);
	const start = new Vec3(0, 64, 0);
	const goal = new goals.GoalNear(3, 64, 0, 1);
	const astar = new AStar(start, f.movements, goal, 5000, 40, -1);
	const result = astar.compute();
	assert.ok(["success", "noPath", "partial", "timeout"].includes(result.status));
	assert.equal(f.movements.__sliceCache, undefined);
}
`;

describe("search-scoped block cache", () => {
	test("dedupe within compute, no stub caching, labor memo, no shared-block mutation, cache detached after compute", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
