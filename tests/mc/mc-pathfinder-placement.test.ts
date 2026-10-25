import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { configureMovements } from ${JSON.stringify(new URL("../../.uina/worlds/minecraft/driver/mineflayer/pathfinder.ts", import.meta.url).href)};
const require = createRequire(import.meta.url);
const mfRequire = createRequire(require.resolve("mineflayer"));
const registry = mfRequire("prismarine-registry")("1.21.11");
const Block = mfRequire("prismarine-block")(registry);
const { Vec3 } = mfRequire("vec3");

function fixture() {
	const bot = {
		registry,
		inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 10 }] },
		blockAt(position) {
			const physical = position.y < 64 && !(position.x === 1 && position.y === 63 && position.z === 0);
			const block = Block.fromStateId(physical ? registry.blocksByName.stone.minStateId : 0, 0);
			block.position = position;
			return block;
		},
		pathfinder: { movements: null, setMovements(value) { this.movements = value; } },
	};
	const placements = (method) => {
		const movements = bot.pathfinder.movements;
		const node = new Vec3(0, 64, 0);
		node.remainingBlocks = movements.countScaffoldingItems();
		const neighbors = [];
		if (method === "getMoveUp") movements[method](node, neighbors);
		else movements[method](node, { x: 1, z: 0 }, neighbors);
		return neighbors.flatMap((neighbor) => neighbor.toPlace);
	};
	return { bot, placements };
}
		const { bot, placements } = fixture();
		const configure = (placeToReach) => configureMovements(bot, { sprint: false, digThrough: false, placeToReach });
		configure(false);
		for (const method of ["getMoveForward", "getMoveJumpUp", "getMoveUp"]) assert.deepEqual(placements(method), []);
		assert.equal(bot.pathfinder.movements.getScaffoldingItem(), null);
		configure(true);
		assert.equal(bot.pathfinder.movements.countScaffoldingItems(), 10);
		assert.equal(placements("getMoveForward").length, 1);
		assert.ok(placements("getMoveJumpUp").length > 0);
		assert.equal(placements("getMoveUp").length, 1);
		configure(false);
		assert.deepEqual(placements("getMoveForward"), []);
`;

describe("placeToReach covers every material-consuming move", () => {
	test("false prohibits bridges, jump supports and towers; true restores material availability", () => {
		// The installed Prismarine class caches are process-local; keep this real dependency check outside vmThreads.
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
