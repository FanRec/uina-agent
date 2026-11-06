/**
 * 上游依赖的数据修正：装配期一次性修正 registry 数据表。
 *
 * 与 patches/ 的代码补丁同一职责面（driver.md §9.2）：这里是"数据缺陷"，用
 * 运行时修正比 patch 巨型 JSON 数据文件更小更稳（上游修数后本函数自然空转）。
 * 每项修正必须带缺陷证据与来源记录（patches/README.md 台账）。
 */

/** Mineflayer registry 的最小修正面（bot.registry）。 */
interface FixableRegistry {
	blocksArray: Array<{
		name: string;
		material?: string;
		harvestTools?: Record<string, unknown>;
	}>;
	items: Record<number, { name?: string } | undefined>;
	materials?: Record<string, Record<string, number>>;
}

/** minecraft-data 1.21.11 的工具名 → mineable/<kind> 材料键。 */
function toolKindOfItem(name: string): string | null {
	if (name.endsWith("_pickaxe")) return "pickaxe";
	if (name.endsWith("_axe")) return "axe";
	if (name.endsWith("_shovel")) return "shovel";
	if (name.endsWith("_hoe")) return "hoe";
	return null;
}

/**
 * 1.21.11 的 minecraft-data 给 108 种方块的 material 标成了
 * `incorrect_for_<tier>_tool`（正确语义是"该等级以下不可采"），prismarine-block
 * 的 digTime 按材料键查挖掘速度表时查不到真实材料，铁镐挖铁矿被算成
 * 4.55s（实际 0.75s）。按 harvestTools 推回 `mineable/<kind>`，保留工具等级
 * 约束不变。来源：Cortico mineflayer-fixes fixToolTierMaterials 判据
 * （E:/Uina/Research/Cortico，MIT），按 Uina 目标版本 1.21.11 重新核实。
 */
export function fixToolTierMaterials(registry: FixableRegistry): number {
	const blocks = registry.blocksArray;
	const materials = registry.materials;
	if (!Array.isArray(blocks) || materials == null) return 0;
	let fixed = 0;
	for (const block of blocks) {
		if (typeof block.material !== "string" || !block.material.startsWith("incorrect_for_")) continue;
		const toolKinds = new Set(
			Object.keys(block.harvestTools ?? {}).map((id) => toolKindOfItem(registry.items[Number(id)]?.name ?? "")),
		);
		toolKinds.delete(null);
		if (toolKinds.size !== 1) continue;
		const kind = toolKinds.values().next().value;
		if (kind == null || materials[`mineable/${kind}`] == null) continue;
		block.material = `mineable/${kind}`;
		fixed++;
	}
	return fixed;
}
