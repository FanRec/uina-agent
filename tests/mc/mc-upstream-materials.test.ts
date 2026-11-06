import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// minecraft-data 3.117.0 的 1.21.11 数据给 108 种方块标了 incorrect_for_*_tool
// 材料（"该等级以下不可采"被错填成材料键），prismarine-block digTime 查速度表
// 时查不到真实材料，铁镐挖铁矿算出 ~4.55s（实际 0.75s）。修正后挖速与工具等级
// 约束都应落在真实值上。附魔链（enchants）另有专测：mc-pathfinder-enchanted-tool。
const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fixToolTierMaterials } from ${JSON.stringify(new URL("../../.uina/worlds/minecraft/driver/mineflayer/upstream-fixes.ts", import.meta.url).href)};
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const registry = mf("prismarine-registry")("1.21.11");
const Block = mf("prismarine-block")(registry);
const ironOreInfo = registry.blocksArray.find((b) => b.name === "iron_ore");
assert.ok(ironOreInfo.harvestTools != null);
const ironPickaxeId = registry.itemsByName["iron_pickaxe"].id;
assert.ok(ironOreInfo.harvestTools[ironPickaxeId] != null);

const digTimeOf = (info, toolId) => Block.fromStateId(info.minStateId, 0).digTime(toolId, false, false, false, [], {});
const before = digTimeOf(ironOreInfo, ironPickaxeId);
const fixed = fixToolTierMaterials(registry);
assert.ok(fixed >= 100, "should correct the known incorrect_for_* family, got " + fixed);
assert.equal(ironOreInfo.material, "mineable/pickaxe");
const after = digTimeOf(ironOreInfo, ironPickaxeId);
assert.ok(before > after * 3, "tool-gated dig time must drop materially, " + before + " -> " + after);
assert.ok(after <= 1000, "iron pickaxe on iron ore should be ~0.75s, got " + after);
// 等级约束保留：木镐（不在 harvestTools 名单）仍比铁镐慢
const wooden = digTimeOf(ironOreInfo, registry.itemsByName["wooden_pickaxe"].id);
assert.ok(wooden > after, "wooden pickaxe must stay slower than iron");
// 幂等：再跑一遍不再改
assert.equal(fixToolTierMaterials(registry), 0);
`;

describe("registry tool-tier materials (1.21.11 incorrect_for_* defect)", () => {
	test("iron_ore material is restored and iron pickaxe dig time drops to ~0.75s", () => {
		// registry 是进程局部的：真依赖修正放 vmThreads 之外（同 mc-pathfinder-placement）。
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
