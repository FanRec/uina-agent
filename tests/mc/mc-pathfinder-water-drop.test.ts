/**
 * 落水下落必须受 maxDropDown 约束（driver/mineflayer/pathfinder.ts 的 MOVEMENTS_POLICY）。
 *
 * 真服归因（G28，dev/water-probe 一次性探针）：平台架在 y≈199、正下方 y≈62 是海面。
 * 上游 `infiniteLiquidDropdownDistance = true` 让"从平台边缘落进海里"成为 cost 1 的
 * 合法一步，于是目标不可达时 A* 把整片海面搜完：同一几何 70,916 节点 / 5s think
 * budget 超时；关掉后 1,922 节点 / 1352ms 诚实 noPath。
 *
 * 两条断言分开：策略常量（适配层真的关掉它）+ 真实 Movements 行为（同一几何下
 * 深水不再生成候选、浅水照常）。fixture 走子进程——与 mc-pathfinder-doors-water
 * 同一套装载口径，避免 ESM/CJS 双份 registry。
 */

import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { MOVEMENTS_POLICY } from "../../.uina/worlds/minecraft/driver/mineflayer/pathfinder.js";

const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const { Movements } = pfRequire("mineflayer-pathfinder");
const { Vec3 } = mf("vec3");
const Block = mf("prismarine-block")(registry);

const stone = registry.blocksByName.stone.minStateId;
const water = registry.blocksByName.water.minStateId;

// 平台在 y=199（x -2..0, z -2..2），海面在 seaY：平台边缘往外一步就是深落差。
function fixture(seaY) {
	const cells = new Map();
	for (let x = -2; x <= 0; x++) for (let z = -2; z <= 2; z++) cells.set(new Vec3(x, 199, z).toString(), stone);
	for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) cells.set(new Vec3(x, seaY, z).toString(), water);
	const bot = {
		registry,
		entity: { position: new Vec3(0, 200, 0), effects: {} },
		game: { minY: -64 },
		inventory: { items: () => [], slots: [] },
		pathfinder: { bestHarvestTool: () => null },
		blockAt: (position) => {
			const block = Block.fromStateId(cells.get(position.toString()) ?? 0, 0);
			block.position = position;
			return block;
		},
	};
	return new Movements(bot);
}

function drops(movements, node) {
	const neighbors = [];
	movements.getMoveDropDown(node, { x: 1, z: 0 }, neighbors);
	return neighbors;
}

const node = { x: 0, y: 200, z: 0, remainingBlocks: 0, hash: "0,200,0" };

// 1) 上游默认（true）：137 格落水被当成一步合法移动——这就是搜索泛洪的来源。
{
	const movements = fixture(61);
	assert.equal(movements.infiniteLiquidDropdownDistance, true);
	assert.ok(drops(movements, node).length > 0, "upstream default should allow the deep drop (documents the defect)");
}
// 2) 适配层策略（false）：同一几何不再生成 137 格落水。
{
	const movements = fixture(61);
	movements.infiniteLiquidDropdownDistance = false;
	assert.deepEqual(drops(movements, node), []);
}
// 3) 浅水对照：3 格落差照常允许，策略没有把水边正常上下岸一并禁掉。
{
	const movements = fixture(196);
	movements.infiniteLiquidDropdownDistance = false;
	assert.ok(drops(movements, node).length > 0, "a 3-block water drop must stay legal");
}
`;

describe("落水下落策略", () => {
	test("适配层固定关闭无限深水下落", () => {
		expect(MOVEMENTS_POLICY.infiniteLiquidDropdownDistance).toBe(false);
		// 同一处策略里其余三项也是"规划与执行一致"的固定口径。
		expect(MOVEMENTS_POLICY.allowParkour).toBe(false);
		expect(MOVEMENTS_POLICY.canOpenDoors).toBe(true);
		expect(MOVEMENTS_POLICY.heuristicWeight).toBe(3);
	});

	test("深水不再生成候选，浅水照常（真实 Movements 行为）", () => {
		expect(() =>
			execFileSync(process.execPath, ["--input-type=module", "-e", program], {
				cwd: process.cwd(),
				stdio: "pipe",
				timeout: 60_000,
			}),
		).not.toThrow();
	});
});
