import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

// prismarine-item 1.18.0 的 enchants getter 在组件时代（1.20.5+）返回原始 wire
// 形状 {enchantments:[{id,level}]}（非数组），mineflayer digTime / prismarine-block
// getEnchantmentLevel 对它 concat / for..of 会 TypeError。补丁后 getter 规范化为
// 与 nbt 分支一致的 [{name,lvl}]。线上形状已从 protocol 表定谳（SlotComponentType
// 13 → "enchantments"，data 为 {enchantments:[{id:varint,level:varint}]}）。
const program = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const registry = mf("prismarine-registry")("1.21.11");
const Item = mf("prismarine-item")(registry);
const efficiencyId = Object.values(registry.enchantments).find((e) => e.name === "efficiency").id;
assert.ok(efficiencyId >= 0);

// 模拟 Item.fromNotch：slot 包组件 → componentMap（真实链路同款形状）
const enchanted = new Item(registry.itemsByName.diamond_pickaxe.id, 1, null, null, true);
enchanted.components = [{ type: "enchantments", data: { enchantments: [{ id: efficiencyId, level: 3 }] } }];
enchanted.componentMap = new Map(enchanted.components.map((c) => [c.type, c]));

const enchants = enchanted.enchants;
assert.equal(Array.isArray(enchants), true, "component enchants must normalize to an array");
assert.deepEqual(enchants, [{ lvl: 3, name: "efficiency" }]);

const block = registry.blocksArray.find((b) => b.name === "stone");
const Block = mf("prismarine-block")(registry);
const stone = Block.fromStateId(registry.blocksByName.stone.minStateId, 0);
stone.position = null; // digTime 不依赖 position
const slow = stone.digTime(enchanted.type, false, false, false, [], {});
const fast = stone.digTime(enchanted.type, false, false, false, enchants, {});
assert.ok(fast < slow * 0.6, "efficiency III must speed up dig time, " + slow + " -> " + fast);
// 无附魔组件的物品照常返回空数组
const plain = new Item(registry.itemsByName.diamond_pickaxe.id, 1, null, null, true);
assert.deepEqual(plain.enchants, []);
// nbt 时代路径不受影响：旧版 nbt 形状走原分支（此处 1.21.11 无 nbt，只需不抛）
assert.equal(Array.isArray(plain.enchants), true);
`;

describe("prismarine-item component enchants normalization", () => {
	test("component-form enchants normalize to [{name,lvl}] and power digTime", () => {
		execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: "pipe" });
	});
});
