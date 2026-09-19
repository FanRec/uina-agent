import { describe, expect, it, vi } from "vitest";
import { AppRegistry } from "../src/extensions/app-framework/app-registry.js";
import { defineApp } from "../src/extensions/app-framework/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { Tool } from "../src/tools/broker.js";

describe("App Framework: Lifecycle & Registry", () => {
	function createMockExtensionAPI() {
		const tools = new Map<string, Tool>();
		const hooks: Record<string, Function[]> = {};
		const abortController = new AbortController();
		const errors: unknown[] = [];

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
			reportError: vi.fn((err: unknown) => {
				errors.push(err);
			}),
		} as unknown as ExtensionAPI;

		return {
			pi,
			tools,
			hooks,
			abort: () => abortController.abort(),
			errors,
		};
	}

	it("defineApp: 自动注册门面工具并在注销时拔除", async () => {
		const mock = createMockExtensionAPI();
		const onStart = vi.fn();
		const onStop = vi.fn();

		const unregister = await defineApp(mock.pi, {
			name: "jukebox",
			description: "网易云点歌机",
			onStart,
			onStop,
			actions: {
				play: {
					description: "播放",
					run: () => "播放中",
				},
			},
		});


		// 验证工具已被注册
		expect(mock.pi.registerTool).toHaveBeenCalled();
		expect(mock.tools.has("jukebox")).toBe(true);
		expect(onStart).toHaveBeenCalled();

		// 注销应用
		await unregister();

		// 验证工具已被拔除，onStop 被调用
		expect(mock.tools.has("jukebox")).toBe(false);
		expect(onStop).toHaveBeenCalled();
	});

	it("enable / disable 动态生命周期与 onStart / onStop 联动", async () => {
		const mock = createMockExtensionAPI();
		const registry = new AppRegistry(mock.pi);

		const onStart = vi.fn();
		const onStop = vi.fn();

		await registry.register({
			name: "live2d",
			description: "Live2D 控制台",
			onStart,
			onStop,
			defaultState: { enabled: false }, // 默认不启用
			actions: {},
		});

		// 初始状态：未启用，不挂载工具，不调用 onStart
		expect(mock.tools.has("live2d")).toBe(false);
		expect(onStart).not.toHaveBeenCalled();

		// 启用 live2d
		await registry.enable("live2d");
		expect(mock.tools.has("live2d")).toBe(true);
		expect(onStart).toHaveBeenCalledTimes(1);

		// 停用 live2d
		await registry.disable("live2d");
		expect(mock.tools.has("live2d")).toBe(false);
		expect(onStop).toHaveBeenCalledTimes(1);

		// 再次启用 live2d
		await registry.enable("live2d");
		expect(mock.tools.has("live2d")).toBe(true);
		expect(onStart).toHaveBeenCalledTimes(2);
	});

	it("pi.signal 中止时自动清理所有伴生服务", async () => {
		const mock = createMockExtensionAPI();
		const registry = new AppRegistry(mock.pi);

		const onStop1 = vi.fn();
		const onStop2 = vi.fn();

		await registry.register({
			name: "app1",
			description: "App 1",
			onStop: onStop1,
			actions: {},
		});

		await registry.register({
			name: "app2",
			description: "App 2",
			onStop: onStop2,
			actions: {},
		});

		expect(mock.tools.size).toBe(2);

		// 模拟宿主/扩展中止信号触发
		mock.abort();

		// 等待异步清理结算
		await new Promise((r) => setTimeout(r, 10));

		// 验证两个应用的 onStop 均被调用，且工具被全部拔除
		expect(onStop1).toHaveBeenCalled();
		expect(onStop2).toHaveBeenCalled();
		expect(mock.tools.size).toBe(0);
	});

	it("重复注册同名应用应报错", async () => {
		const mock = createMockExtensionAPI();
		const registry = new AppRegistry(mock.pi);

		await registry.register({
			name: "dup",
			description: "dup",
			actions: {},
		});

		await expect(
			registry.register({
				name: "dup",
				description: "dup2",
				actions: {},
			}),
		).rejects.toThrow('应用 "dup" 已被注册');
	});
});
