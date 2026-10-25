/**
 * 工具选择：一件方块该用哪把工具，以及"手上根本没有可用工具"的判定。
 *
 * 唯一定义来源：docs/proposals/mc/modules/capabilities.md §4 mine（工具按方块真实掉落要求选）。
 * mine 在派发前用它决定装备什么；collect 在移动前用它判断"这一趟注定白跑"。
 * 只回答"用哪件"，不碰身体、不碰库存顺序。
 */

import type { ItemSelector } from "../../contracts/body.js";
import type { RegistryKnowledge } from "../../contracts/knowledge.js";
import { fail, matchesItem } from "./targets.js";
import type { InventorySnapshot } from "./views.js";

/** 工具档位从低到高；索引即排名，非工具物品为 -1。 */
const TIERS = ["wooden", "stone", "iron", "golden", "diamond", "netherite"];

type ToolChoice =
	| { kind: "tool"; name: string }
	| { kind: "none"; required: string }
	| { kind: "unknown" }
	| { kind: "missing-requested"; name: string };

/** 唯一的判断实现：显式指定优先，否则按 requiredTool 找同类型且档位足够的最强工具。 */
function toolChoice(
	knowledge: RegistryKnowledge | null,
	inventory: InventorySnapshot,
	blockName: string,
	requested: string | ItemSelector | undefined,
): ToolChoice {
	if (requested != null) {
		const name = typeof requested === "string" ? requested : requested.name;
		const match = inventory.slots.some((slot) => matchesItem(requested, { name: slot.name, count: slot.count }));
		return match ? { kind: "tool", name } : { kind: "missing-requested", name };
	}
	const drops = knowledge?.blockDrops(blockName) ?? null;
	if (knowledge == null || drops == null) return { kind: "unknown" };
	if (drops.requiredTool == null) return { kind: "unknown" };
	const required = knowledge.item(drops.requiredTool);
	const requiredType = required?.tool?.type ?? null;
	const requiredRank = required?.tool?.tier == null ? -1 : TIERS.indexOf(required.tool.tier);
	let best: { name: string; rank: number } | null = null;
	for (const slot of inventory.slots) {
		const tool = knowledge.item(slot.name)?.tool;
		if (tool == null) continue;
		if (requiredType != null && tool.type !== requiredType) continue;
		const rank = tool.tier == null ? -1 : TIERS.indexOf(tool.tier);
		if (best == null || rank > best.rank) best = { name: slot.name, rank };
	}
	if (best == null || best.rank < requiredRank) return { kind: "none", required: drops.requiredTool };
	return { kind: "tool", name: best.name };
}

/**
 * 选工具并给出可执行的失败：显式请求不在包里 → MISSING_MATERIAL；
 * 没有能采这件方块的工具 → MISSING_TOOL（hint 带 required）。
 * 返回 null 表示知识数据不足，无法判断——此时不换工具，也不报错。
 */
export function chooseTool(
	knowledge: RegistryKnowledge | null,
	inventory: InventorySnapshot,
	blockName: string,
	requested: string | ItemSelector | undefined,
): string | null {
	const choice = toolChoice(knowledge, inventory, blockName, requested);
	if (choice.kind === "missing-requested") {
		fail("MISSING_MATERIAL", `requested tool ${choice.name} is not in the inventory`, {
			hint: `inventory holds: ${inventory.slots.map((slot) => slot.name).join(", ") || "nothing"}`,
		});
	}
	if (choice.kind === "none") {
		fail("MISSING_TOOL", `no inventory tool can harvest ${blockName}`, {
			hint: `required: ${choice.required}`,
		});
	}
	return choice.kind === "tool" ? choice.name : null;
}

/** 不抛错的版本：组合动作要一次判多个来源方块，不能因为一个不可采就中断。 */
export function canHarvest(
	knowledge: RegistryKnowledge | null,
	inventory: InventorySnapshot,
	blockName: string,
	requested: string | ItemSelector | undefined,
): boolean {
	const choice = toolChoice(knowledge, inventory, blockName, requested);
	return choice.kind === "tool" || choice.kind === "unknown";
}
