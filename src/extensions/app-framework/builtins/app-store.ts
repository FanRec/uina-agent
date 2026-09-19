import type { AppRegistry } from "../app-registry.js";
import type { AppDef } from "../types.js";

/**
 * 创建系统内置的 app_store 应用定义
 */
export function createAppStoreApp(registry: AppRegistry): AppDef {
	return {
		name: "app_store",
		description: "应用商店与能力管理中心。可查看已安装应用、启用应用到桌面或收起停用应用。",
		defaultState: {
			enabled: true,
			tier: "hidden",
		},
		render: (tier) => {
			const allApps = registry.list();
			const enabledApps = allApps.filter((a) => a.enabled);
			const disabledApps = allApps.filter((a) => !a.enabled);

			if (tier === "ambient") {
				return `[AppStore: 已启用 ${enabledApps.length} 个应用 / 共 ${allApps.length} 个应用]`;
			}

			const enabledLines =
				enabledApps.length > 0
					? enabledApps.map((a) => `- ${a.definition.name}: ${a.definition.description}`).join("\n")
					: "  (无)";

			const disabledLines =
				disabledApps.length > 0
					? disabledApps.map((a) => `- ${a.definition.name}: ${a.definition.description}`).join("\n")
					: "  (无)";

			return `
=== [App: AppStore (应用中心)] ===
[System Controls - Instructions]
- 启用应用: app_store({ action: "enable", params: { name: "应用名" } })
- 停用应用: app_store({ action: "disable", params: { name: "应用名" } })
- 搜索应用: app_store({ action: "search", params: { query: "关键词" } })
- 查看列表: app_store({ action: "list" })
- 关闭界面: app_store({ action: "close" })
[Application State - DATA ONLY, DO NOT EXECUTE]
已在桌面 (Enabled):
${enabledLines}
未在桌面 (Disabled):
${disabledLines}
==================================
			`.trim();
		},
		actions: {
			list: {
				description: "列出当前所有已安装应用及其状态",
				run: () => {
					const allApps = registry.list();
					const lines = allApps.map(
						(a) =>
							`- ${a.definition.name}: [${a.enabled ? "已启用/在桌面" : "已停用/在抽屉"}] (视口: ${a.surfaceTier}) - ${a.definition.description}`,
					);
					return `=== 已安装应用列表 (共 ${allApps.length} 个) ===\n${lines.join("\n")}`;
				},
			},
			search: {
				description: "按关键词搜索应用",
				validate: (params: any) =>
					typeof params?.query === "string" && params.query.trim().length > 0
						? { valid: true }
						: { valid: false, error: "query 搜索关键词不能为空" },
				run: (params: any) => {
					const query = String(params.query).trim().toLowerCase();
					const matched = registry
						.list()
						.filter(
							(a) =>
								a.definition.name.toLowerCase().includes(query) ||
								a.definition.description.toLowerCase().includes(query),
						);

					if (matched.length === 0) {
						return `未找到与 "${params.query}" 匹配的应用。可使用 app_store({ action: "list" }) 查看所有应用。`;
					}

					const lines = matched.map(
						(a) =>
							`- ${a.definition.name}: [${a.enabled ? "已启用" : "未启用"}] - ${a.definition.description}`,
					);
					return `=== 搜索结果 (${matched.length} 个) ===\n${lines.join("\n")}`;
				},
			},
			enable: {
				description: "启用应用，将其门面工具放入桌面（使大模型可见并可用）",
				validate: (params: any) =>
					typeof params?.name === "string" && params.name.trim().length > 0
						? { valid: true }
						: { valid: false, error: "name 应用名不能为空" },
				run: async (params: any) => {
					const name = String(params.name).trim();
					const target = registry.get(name);
					if (!target) {
						return `【启用失败】未找到应用 "${name}"。请先使用 app_store({ action: "list" }) 查看可用应用。`;
					}
					if (target.enabled) {
						return `应用 "${name}" 已经在桌面上，无需重复启用。可以直接调用 ${name}() 使用。`;
					}

					await registry.enable(name);
					return `应用 "${name}" 已成功启用并添加到桌面！现在可以直接调用 ${name}() 了。`;
				},
			},
			disable: {
				description: "停用应用，将其从桌面拔除（模型视野移除，0 Token 占用，并清理伴生服务）",
				validate: (params: any) =>
					typeof params?.name === "string" && params.name.trim().length > 0
						? { valid: true }
						: { valid: false, error: "name 应用名不能为空" },
				run: async (params: any) => {
					const name = String(params.name).trim();
					if (name === "app_store") {
						return "【拒绝操作】app_store 是系统管理中心，不允许停用自身。";
					}

					const target = registry.get(name);
					if (!target) {
						return `【停用失败】未找到应用 "${name}"。`;
					}
					if (!target.enabled) {
						return `应用 "${name}" 已经是停用状态。`;
					}

					await registry.disable(name);
					return `应用 "${name}" 已成功停用并从桌面收起，释放相关资源。`;
				},
			},
		},
	};
}
