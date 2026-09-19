import { describe, expect, it, vi } from "vitest";
import { AppRegistry } from "../src/extensions/app-framework/app-registry.js";
import { createAppStoreApp } from "../src/extensions/app-framework/builtins/app-store.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { Tool } from "../src/tools/broker.js";

describe("App Framework: app_store Builtin App", () => {
	function createMockExtensionAPI() {
		const tools = new Map<string, Tool>();
		const hooks: Record<string, Function[]> = {};
		const abortController = new AbortController();

		const pi = {
			signal: abortController.signal,
			registerTool: vi.fn((tool: Tool) => {
				tools.set(tool.def.function.name, tool);
				return () => {
					tools.delete(tool.def.function.name);
				};
			}),
			onHook: vi.fn((hook: string, handler: Function) => {
				if (!hooks[hook]) hooks[hook] = [];
				hooks[hook].push(handler);
				return () => {};
			}),
			reportError: vi.fn(),
		} as unknown as ExtensionAPI;

		const registry = new AppRegistry(pi);
		const storeAppDef = createAppStoreApp(registry);

		return {
			pi,
			tools,
			registry,
			storeAppDef,
		};
	}

	it("app_store: list 动作列出所有应用及状态", async () => {
		const { registry, storeAppDef } = createMockExtensionAPI();
		await registry.register(storeAppDef);

		await registry.register({
			name: "jukebox",
			description: "网易云点歌机",
			defaultState: { enabled: true },
			actions: {},
		});

		await registry.register({
			name: "weather",
			description: "天气预报查询",
			defaultState: { enabled: false },
			actions: {},
		});

		const listAction = storeAppDef.actions.list;
		const result = await listAction.run({}, {} as any);

		expect(result).toContain("已安装应用列表 (共 3 个)");
		expect(result).toContain("app_store: [已启用/在桌面]");
		expect(result).toContain("jukebox: [已启用/在桌面]");
		expect(result).toContain("weather: [已停用/在抽屉]");
	});

	it("app_store: search 动作按关键词检索应用", async () => {
		const { registry, storeAppDef } = createMockExtensionAPI();
		await registry.register(storeAppDef);
		await registry.register({
			name: "jukebox",
			description: "网易云点歌机",
			actions: {},
		});

		const searchAction = storeAppDef.actions.search;

		// 匹配成功
		const res1 = await searchAction.run({ query: "点歌" }, {} as any);
		expect(res1).toContain("搜索结果 (1 个)");
		expect(res1).toContain("jukebox");

		// 匹配失败
		const res2 = await searchAction.run({ query: "股票" }, {} as any);
		expect(res2).toContain('未找到与 "股票" 匹配的应用');
	});

	it("app_store: enable / disable 动态生命周期管理", async () => {
		const { registry, storeAppDef, tools } = createMockExtensionAPI();
		await registry.register(storeAppDef);
		await registry.register({
			name: "weather",
			description: "天气查询",
			defaultState: { enabled: false },
			actions: {},
		});

		// 初始 weather 未启用
		expect(tools.has("weather")).toBe(false);

		// 执行 enable
		const enableRes = await storeAppDef.actions.enable.run({ name: "weather" }, {} as any);
		expect(enableRes).toContain("已成功启用并添加到桌面");
		expect(tools.has("weather")).toBe(true);

		// 重复 enable
		const repeatRes = await storeAppDef.actions.enable.run({ name: "weather" }, {} as any);
		expect(repeatRes).toContain("已经在桌面上，无需重复启用");

		// 执行 disable
		const disableRes = await storeAppDef.actions.disable.run({ name: "weather" }, {} as any);
		expect(disableRes).toContain("已成功停用并从桌面收起");
		expect(tools.has("weather")).toBe(false);
	});

	it("app_store: 拒绝停用自身", async () => {
		const { registry, storeAppDef, tools } = createMockExtensionAPI();
		await registry.register(storeAppDef);

		const res = await storeAppDef.actions.disable.run({ name: "app_store" }, {} as any);
		expect(res).toContain("拒绝操作");
		expect(tools.has("app_store")).toBe(true);
	});

	it("app_store: render 视口渲染", async () => {
		const { registry, storeAppDef } = createMockExtensionAPI();
		await registry.register(storeAppDef);
		await registry.register({
			name: "weather",
			description: "天气预报",
			defaultState: { enabled: false },
			actions: {},
		});

		const ambient = await storeAppDef.render!("ambient");
		expect(ambient).toContain("[AppStore: 已启用 1 个应用 / 共 2 个应用]");

		const expanded = await storeAppDef.render!("expanded");
		expect(expanded).toContain("=== [App: AppStore (应用中心)] ===");
		expect(expanded).toContain("已在桌面 (Enabled):");
		expect(expanded).toContain("- app_store");
		expect(expanded).toContain("未在桌面 (Disabled):");
		expect(expanded).toContain("- weather");
	});
});
