import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// A2 修复链的第二环（pathfinder 侧）：bestHarvestTool（index.js）与
// safeOrBreak（movements.js）旧代码从 tool.nbt 读附魔——1.20.5+ 组件物品 nbt
// 为空，附魔被整体忽略（选具失误、挖掘代价虚高）。补丁后统一走
// prismarine-item 规范化的 tool.enchants。本测试锚定：组件附魔的镐在
// bestHarvestTool 中胜过同型无附魔镐，且 safeOrBreak 的代价反映效率附魔。
const program = `
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const pfRequire = createRequire(require.resolve("mineflayer-pathfinder/package.json"));
const registry = mf("prismarine-registry")("1.21.11");
const Item = mf("prismarine-item")(registry);
const { pathfinder, Movements } = pfRequire("mineflayer-pathfinder");
const { Vec3 } = mf("vec3");
const efficiencyId = Object.values(registry.enchantments).find((e) => e.name === "efficiency").id;
assert.ok(efficiencyId >= 0);

function makePickaxe(level) {
	const item = new Item(registry.itemsByName.diamond_pickaxe.id, 1, null, null, true);
	if (level != null) {
		item.components = [{ type: "enchantments", data: { enchantments: [{ id: efficiencyId, level }] } }];
		item.componentMap = new Map(item.components.map((c) => [c.type, c]));
	}
	return item;
}

function fixture(inventoryItems) {
	const bot = new EventEmitter();
	bot.registry = registry;
	bot.entity = { position: new Vec3(0, 64, 0), effects: {} };
	bot.inventory = { items: () => inventoryItems, slots: [] };
	bot.loadPlugin = (plugin) => plugin(bot);
	const Block = mf("prismarine-block")(registry);
	bot.blockAt = (position) => {
		const solid = position.y < 64;
		const block = Block.fromStateId(solid ? registry.blocksByName.stone.minStateId : 0, 0);
		block.position = position;
		return block;
	};
	bot.loadPlugin(pathfinder);
	return bot;
}

const stoneNode = { x: 0, y: 63, z: 0 };

// 1) 选具：附魔镐胜过同型无附魔镐（旧实现两者同速，谁先在背包谁被选中）
const bothBot = fixture([makePickaxe(null), makePickaxe(3)]);
const stone = new Movements(bothBot).getBlock(stoneNode, 0, 0, 0);
const chosen = bothBot.pathfinder.bestHarvestTool(stone);
assert.equal(chosen.enchants?.[0]?.name, "efficiency");

// 2) 代价：效率 III 降低挖掘代价（labor 是 safeOrBreak 里唯一随附魔变化的项）
const laborOf = (bot) => {
	const movements = new Movements(bot);
	movements.canDig = true;
	return movements.safeOrBreak(movements.getBlock(stoneNode, 0, 0, 0), []);
};
const plain = laborOf(fixture([makePickaxe(null)]));
const magic = laborOf(fixture([makePickaxe(3)]));
assert.ok(magic < plain * 0.8, "efficiency III must cut labor cost, " + plain + " -> " + magic);
`;

describe("pathfinder enchant chain (bestHarvestTool / safeOrBreak)", () => {
	test("component-enchanted pickaxe wins tool selection and lowers dig labor", () => {
		// 真依赖检查放 vmThreads 之外（同 mc-pathfinder-placement）。
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
