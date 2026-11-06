import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// A* 启发式扩展偏置（astar.js heuristicWeight，补丁 hunk）：欧氏启发式在爬升地形
// 严重低估，无偏置搜索沿等值线泛洪。fixture = 曼哈顿锥形山（每水平格升 1，天然
// 1:1 可攀爬，峰站面 74），目标在山后同高（真服 24 格山头穿越的失败结构：
// 实测 w=1 泛洪 268 节点，w=3 收敛 33 节点）。断言：默认（未设字段）保持上游
// 原序；w=3 同样成功且节点数 ÷3 以上；cost 是真实 g（GoalNear 多终点下与 w=1
// 同量级）；searchRadius 的 maxCost 保持 raw 启发式尺度，加权下仍正常剪枝。
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

const stone = registry.blocksByName.stone;

// 锥形山：以 (12,0) 为中心 h = max(0, 10 - (|x-12| + |z|))，站面 64+h。
const heights = new Map();
for (let x = -2; x <= 30; x++) {
	for (let z = -16; z <= 16; z++) {
		heights.set(x + "," + z, Math.max(0, 10 - (Math.abs(x - 12) + Math.abs(z))));
	}
}

function fixture() {
	const bot = new EventEmitter();
	bot.registry = registry;
	bot.entity = { position: new Vec3(0, 64, 0), effects: {} };
	bot.inventory = { items: () => [], slots: [] };
	bot.pathfinder = { bestHarvestTool: () => null };
	bot.game = { minY: -64 };
	bot.blockAt = (position) => {
		const h = heights.get(position.x + "," + position.z);
		const isSolid = h != null && position.y <= 63 + h;
		const block = Block.fromStateId(isSolid ? stone.minStateId : 0, 0);
		block.position = position;
		return block;
	};
	const movements = new Movements(bot);
	movements.canDig = false;
	movements.allow1by1towers = false;
	movements.allowParkour = false;
	return { bot, movements };
}

function search(movements, weight, goalAt = { x: 24, y: 64, z: 0 }, searchRadius = -1) {
	if (weight != null) movements.heuristicWeight = weight;
	const start = new Vec3(0, 64, 0);
	const goal = new goals.GoalNear(goalAt.x, goalAt.y, goalAt.z, 1);
	const astar = new AStar(start, movements, goal, 5000, 40, searchRadius);
	// 驱动到终态：tickTimeout 分块在并行负载下会先返回 partial，与断言无关。
	let result = astar.compute();
	while (result.status === "partial") result = astar.compute();
	assert.equal(result.status, "success", "fixture must be solvable at weight " + (weight ?? "default"));
	return result;
}

// 1) 默认（未设 heuristicWeight）= 上游原序：与显式 w=1 同一扩展规模
{
	const implicit = search(fixture().movements, undefined).visitedNodes;
	const explicit1 = search(fixture().movements, 1).visitedNodes;
	assert.equal(implicit, explicit1, "missing field must default to 1");
}
// 2) w=3 同样成功（合法性不动），扩展节点显著更少（本 fixture 实测 ÷8）
{
	const base = search(fixture().movements, 1);
	const weighted = search(fixture().movements, 3);
	assert.ok(
		weighted.visitedNodes <= base.visitedNodes / 3,
		"weighted should expand far fewer nodes: " + weighted.visitedNodes + " vs " + base.visitedNodes,
	);
}
// 3) cost 是真实 g：GoalNear 多终点下允许小幅差异，但不允许次优翻倍
{
	const base = search(fixture().movements, 1);
	const weighted = search(fixture().movements, 3);
	assert.ok(
		Math.abs(weighted.cost - base.cost) <= base.cost * 0.5,
		"suboptimality must stay bounded: " + weighted.cost + " vs " + base.cost,
	);
}
// 4) searchRadius 的 maxCost 保持 raw 启发式尺度：加权 + 半径 40 到峰顶仍可达
{
	const result = search(fixture().movements, 3, { x: 12, y: 74, z: 0 }, 40);
	assert.ok(result.cost > 0);
}
`;

describe("astar heuristic weight", () => {
	test("default keeps upstream ordering; weighted succeeds with far fewer expansions and bounded true cost", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
