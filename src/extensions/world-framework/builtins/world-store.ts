import type { WorldRegistry } from "../world-registry.js";
import type { WorldDef } from "../types.js";
import { worldFailed, worldSucceeded } from "../result.js";

export function createWorldStoreWorld(registry: WorldRegistry): WorldDef {
	return {
		name: "world_store",
		description:
			"发现和维护已安装 World；主体已有可用能力时不要调用。list/search 查询，enable/disable 改变能力生命周期并返回启停结果。",
		defaultState: { enabled: true },
		actions: {
			list: {
				description: "列出已安装 World 及启用状态",
				run: () => {
					const worlds = registry.list();
					return worldSucceeded(
						worlds.length
							? worlds
									.map(
										(w) =>
											`- ${w.definition.name}: ${w.enabled ? "enabled" : "disabled"} - ${w.definition.description}`,
									)
									.join("\n")
							: "当前没有已安装 World。",
					);
				},
			},
			search: {
				description: "按名称或描述搜索 World",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				validate: (p: any) =>
					typeof p?.query === "string" && p.query.trim() ? { valid: true } : { valid: false, error: "query 不能为空" },
				run: (p: any) => {
					const q = String(p.query).trim().toLowerCase();
					const m = registry
						.list()
						.filter((w) =>
							[w.definition.name, w.definition.description].some((v) =>
								v.toLowerCase().includes(q),
							),
						);
					return worldSucceeded(
						m.length
							? m
									.map(
										(w) =>
											`- ${w.definition.name}: ${w.enabled ? "enabled" : "disabled"} - ${w.definition.description}`,
									)
									.join("\n")
							: `未找到匹配的 World: ${p.query}`,
					);
				},
			},
			enable: {
				description: "启用指定 World",
				parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
				validate: (p: any) =>
					typeof p?.name === "string" && p.name.trim() ? { valid: true } : { valid: false, error: "name 不能为空" },
				run: async (p: any) => {
					const name = String(p.name).trim();
					if (!registry.has(name)) return worldFailed(`未找到 World: ${name}`, { reason: "world_not_found" });
					await registry.enable(name);
					return worldSucceeded(`World 已启用: ${name}`, undefined, "applied");
				},
			},
			disable: {
				description: "停用指定 World 并释放其资源",
				parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
				validate: (p: any) =>
					typeof p?.name === "string" && p.name.trim() ? { valid: true } : { valid: false, error: "name 不能为空" },
				run: async (p: any) => {
					const name = String(p.name).trim();
					if (name === "world_store") return worldFailed("不能停用 world_store。", { reason: "protected_world" });
					if (!registry.has(name)) return worldFailed(`未找到 World: ${name}`, { reason: "world_not_found" });
					await registry.disable(name);
					return worldSucceeded(`World 已停用: ${name}`, undefined, "applied");
				},
			},
		},
	};
}
