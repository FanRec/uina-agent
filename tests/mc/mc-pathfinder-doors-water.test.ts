import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// 门与水规则（movements.js 补丁）：
// - 闭木门/栅栏门 → useOne（canOpenDoors 开启时）；开着的门 → 可穿直走，不再
//   "再 use 一下"（=关门）也不被当墙挖；铁门不 useOne；上半扇不当落脚格；
//   斜穿门格的候选被剔除。
// - 深水（脚下无实底）禁垫；浅水（脚下有实底）可垫塔并计 liquidCost。
//   getMoveUp 原版开头 `if (block1.liquid) return` 已随补丁移除。
const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const { Movements } = pfRequire("mineflayer-pathfinder");
const { Vec3 } = mf("vec3");
const Block = mf("prismarine-block")(registry);

const oakDoor = registry.blocksByName["oak_door"];
const ironDoor = registry.blocksByName["iron_door"];
// 找到 open=true 的下半扇 stateId（Block.fromStateId 的属性由 state 决定）
function doorStateId(blockName, open, half) {
	for (let id = registry.blocksByName[blockName].minStateId; id <= registry.blocksByName[blockName].maxStateId; id++) {
		const props = Block.fromStateId(id, 0).getProperties();
		if (props.open === open && props.half === half) return id;
	}
	throw new Error("state not found for " + blockName);
}
const closedLower = doorStateId("oak_door", false, "lower");
const openLower = doorStateId("oak_door", true, "lower");
const closedUpper = doorStateId("oak_door", false, "upper");

function fixture(cells) {
	const bot = {
		registry,
		entity: { position: new Vec3(0, 64, 0), effects: {} },
		inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 10 }], slots: [] },
		pathfinder: { bestHarvestTool: () => null },
		blockAt: (position) => {
			const cell = cells.get(position.toString());
			const id = cell !== undefined ? cell : (position.y < 64 ? registry.blocksByName.stone.minStateId : 0);
			const block = Block.fromStateId(id, 0);
			block.position = position;
			return block;
		},
	};
	return new Movements(bot);
}
const air = 0;
const stone = registry.blocksByName.stone.minStateId;
const water = registry.blocksByName.water.minStateId;

// 1) 闭木门：canOpenDoors → useOne
{
	const movements = fixture(new Map([
		[new Vec3(1, 64, 0).toString(), closedLower],
		[new Vec3(1, 65, 0).toString(), closedUpper],
		[new Vec3(1, 63, 0).toString(), stone],
	]));
	movements.canOpenDoors = true;
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 0;
	const neighbors = [];
	movements.getMoveForward(node, { x: 1, z: 0 }, neighbors);
	const uses = neighbors.flatMap((mv) => mv.toPlace).filter((p) => p.useOne);
	assert.equal(uses.length, 1, "closed door must generate a useOne");
}
// 2) 开着的门：可穿直走，不 useOne（否则等于关门）也不挖
{
	const movements = fixture(new Map([
		[new Vec3(1, 64, 0).toString(), openLower],
		[new Vec3(1, 63, 0).toString(), stone],
	]));
	movements.canOpenDoors = true;
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 0;
	const neighbors = [];
	movements.getMoveForward(node, { x: 1, z: 0 }, neighbors);
	assert.equal(neighbors.length, 1, "open door is walkable");
	assert.deepEqual(neighbors[0].toPlace, []);
	assert.deepEqual(neighbors[0].toBreak, []);
}
// 3) 铁门：不 useOne（不可开）
{
	const movements = fixture(new Map([
		[new Vec3(1, 64, 0).toString(), ironDoor.minStateId],
	]));
	movements.canOpenDoors = true;
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 0;
	const neighbors = [];
	movements.getMoveForward(node, { x: 1, z: 0 }, neighbors);
	assert.equal(neighbors.flatMap((mv) => mv.toPlace).filter((p) => p.useOne).length, 0);
}
// 4) 门上半扇不是落脚格
{
	const movements = fixture(new Map([
		[new Vec3(1, 64, 0).toString(), closedLower],
		[new Vec3(1, 65, 0).toString(), closedUpper],
	]));
	movements.canOpenDoors = true;
	const node = new Vec3(0, 65, 0); // 站在与上半扇同层
	node.remainingBlocks = 0;
	const neighbors = [];
	movements.getMoveForward(node, { x: 1, z: 0 }, neighbors);
	assert.equal(neighbors.length, 0, "upper door half must not be a landing cell");
}
// 5) 斜穿门格被剔除
{
	const movements = fixture(new Map([
		[new Vec3(1, 64, 1).toString(), closedLower],
		[new Vec3(1, 65, 1).toString(), closedUpper],
	]));
	movements.canOpenDoors = true;
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 0;
	const neighbors = [];
	movements.getMoveDiagonal(node, { x: 1, z: 1 }, neighbors);
	assert.equal(neighbors.length, 0, "diagonal into a door cell must be filtered");
}
// 6) 深水禁垫（脚下无实底）：不生成搭桥放置
{
	const movements = fixture(new Map([
		[new Vec3(0, 64, 0).toString(), water],
		[new Vec3(0, 63, 0).toString(), water],
		[new Vec3(1, 63, 0).toString(), air],
	]));
	movements.canDig = false;
	movements.allow1by1towers = true;
	movements.scafoldingBlocks = [registry.itemsByName.dirt.id];
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 10;
	const neighbors = [];
	movements.getMoveForward(node, { x: 1, z: 0 }, neighbors);
	assert.equal(neighbors.flatMap((mv) => mv.toPlace).length, 0, "no bridging while swimming over deep water");
}
// 7) 浅水垫塔：脚下有实底 → getMoveUp 生成跳垫，且计入 liquidCost
{
	const movements = fixture(new Map([
		[new Vec3(0, 64, 0).toString(), water],
		[new Vec3(0, 63, 0).toString(), stone],
	]));
	movements.allow1by1towers = true;
	movements.scafoldingBlocks = [registry.itemsByName.dirt.id];
	const node = new Vec3(0, 64, 0);
	node.remainingBlocks = 10;
	const neighbors = [];
	movements.getMoveUp(node, neighbors);
	assert.equal(neighbors.length, 1, "shallow water tower must generate");
	assert.equal(neighbors[0].toPlace.length, 1);
	// 对照：同几何干地无 liquidCost
	const dry = fixture(new Map([
		[new Vec3(0, 64, 0).toString(), air],
		[new Vec3(0, 63, 0).toString(), stone],
	]));
	dry.allow1by1towers = true;
	dry.scafoldingBlocks = [registry.itemsByName.dirt.id];
	const dryNeighbors = [];
	dry.getMoveUp(new Vec3(0, 64, 0), dryNeighbors);
	assert.equal(dryNeighbors[0].cost, neighbors[0].cost - movements.liquidCost, "water tower must pay liquidCost");
}
`;

describe("movements door & water rules", () => {
	test("closed doors open, open doors pass, iron doors wall, upper half not landing, deep water no bridge, shallow water tower", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
