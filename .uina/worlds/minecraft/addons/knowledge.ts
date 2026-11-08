/**
 * 包内静态知识与连接注册表的受控组合。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §3.3。优先级固定：
 * 当前服务器注册表 > Addon 声明。冲突不按包加载顺序静默覆盖：
 * 注册表已有同名项时以注册表为准并记录冲突；两个包声明同名项时该项不参与组合。
 * 只补"身份"字段；掉落、碰撞、配方、来源类别保持未知（sourcesComplete=false）。
 */

import type { KnowledgeItem, RegistryKnowledge } from "../contracts/knowledge.js";
import type { AddonKnowledgeItem } from "./sdk.js";
import type { AddonKnowledgeSet } from "./loader.js";

export interface AddonKnowledgeConflict {
	addonId: string;
	item: string;
	reason: "registry" | "addon";
}

export interface ComposedKnowledge {
	knowledge: RegistryKnowledge | null;
	conflicts: AddonKnowledgeConflict[];
}

function addonItem(declared: AddonKnowledgeItem): KnowledgeItem {
	return {
		name: declared.name,
		displayName: declared.displayName,
		stackSize: declared.stackSize,
		placeAs: declared.placeAs ?? null,
		tool: null,
		food: null,
		fuel: null,
		// 包只声明身份，不声明获取途径；sources 为空且 sourcesComplete=false。
		sources: [],
		sourcesComplete: false,
	};
}

/** 裸名只在唯一时解析；歧义保持 null，不猜。 */
function uniqueByPath(items: ReadonlyMap<string, KnowledgeItem>, path: string): string | null {
	const matches = [...items.keys()].filter((name) => name.slice(name.indexOf(":") + 1) === path);
	return matches.length === 1 ? matches[0] : null;
}

export function composeKnowledge(
	base: RegistryKnowledge | null,
	sets: readonly AddonKnowledgeSet[],
): ComposedKnowledge {
	if (base == null || sets.length === 0) return { knowledge: base, conflicts: [] };
	const conflicts: AddonKnowledgeConflict[] = [];
	const claimed = new Map<string, string>();
	const declared = new Map<string, KnowledgeItem>();
	for (const set of sets) {
		for (const item of set.items) {
			const owner = claimed.get(item.name);
			if (owner != null) {
				conflicts.push({ addonId: set.addonId, item: item.name, reason: "addon" });
				declared.delete(item.name);
				continue;
			}
			claimed.set(item.name, set.addonId);
			if (base.item(item.name) != null) {
				conflicts.push({ addonId: set.addonId, item: item.name, reason: "registry" });
				continue;
			}
			declared.set(item.name, addonItem(item));
		}
	}
	if (declared.size === 0) return { knowledge: base, conflicts };
	const knowledge: RegistryKnowledge = {
		dataVersion: base.dataVersion,
		item: (name) => base.item(name) ?? declared.get(name) ?? null,
		recipesFor: (item) => base.recipesFor(item),
		blockDrops: (block) => base.blockDrops(block),
		canonicalItemName: (name) => base.canonicalItemName(name) ?? uniqueByPath(declared, name),
		entityKind: (name) => base.entityKind(name),
		enchantment: (id) => base.enchantment(id),
	};
	return { knowledge, conflicts };
}
