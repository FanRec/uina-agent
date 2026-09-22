import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppRegistry } from "../src/extensions/app-framework/app-registry.js";
import { defineApp } from "../src/extensions/app-framework/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { Tool } from "../src/tools/broker.js";

describe("App Framework: Lifecycle & Registry", () => {
	function createMockExtensionAPI(cwd?: string) {
		const tools = new Map<string, Tool>();
		const hooks: Record<string, Function[]> = {};
		const abortController = new AbortController();
		const errors: unknown[] = [];

		const pi = {
			cwd,
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

	it("disposeAll：等待式回收全部伴生服务与工具（由 ActivationScope await，非 fire-and-forget）", async () => {
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

		// 显式等待回收（生命周期收拢后由 ActivationScope 调用 activation 返回的 dispose）
		await registry.disposeAll();

		// 两个应用的 onStop 均被调用，且工具被全部拔除
		expect(onStop1).toHaveBeenCalled();
		expect(onStop2).toHaveBeenCalled();
		expect(mock.tools.size).toBe(0);
	});

	it("enable 补偿：onStart 已启动但工具装配失败 → onStop 回滚、enabled 保持 false、异常上抛", async () => {
		const mock = createMockExtensionAPI();
		// 让工具注册失败一次，模拟 ToolBroker 重名/非法场景
		const original = mock.pi.registerTool;
		(original as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("工具重名");
		});
		const registry = new AppRegistry(mock.pi);

		const onStart = vi.fn();
		const onStop = vi.fn();

		await registry.register({
			name: "partitioned",
			description: "可回滚应用",
			onStart,
			onStop,
			defaultState: { enabled: false },
			actions: {
				do: { description: "执行", parameters: { type: "object" }, run: () => "ok" },
			},
		});

		// 启用：注册工具抛错 → 应回滚 onStop，且异常上抛
		await expect(registry.enable("partitioned")).rejects.toThrow("工具重名");
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(onStop).toHaveBeenCalledTimes(1); // 补偿回滚
		expect(registry.get("partitioned")?.enabled).toBe(false); // 状态未提交
		expect(mock.tools.has("partitioned")).toBe(false);
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

	it("持久化状态测试：disable/enable 写入 .uina/apps.json 并在下次启动时恢复", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "uina-app-persist-test-"));
		try {
			const mock1 = createMockExtensionAPI(tempDir);
			const registry1 = new AppRegistry(mock1.pi);

			// 注册一个默认启用的应用
			await registry1.register({
				name: "jukebox",
				description: "点歌机",
				defaultState: { enabled: true },
				actions: {},
			});
			expect(mock1.tools.has("jukebox")).toBe(true);

			// 用户/前端停用该应用
			await registry1.disable("jukebox");
			expect(mock1.tools.has("jukebox")).toBe(false);

			// 等落盘完成。原先用固定 20ms：持久化是异步链式写入（saveTail → 临时文件 → rename），
			// 全量并发负载下 20ms 并不总是够，曾反复造成门禁假失败。
			// 测试应当等条件而不是等一个猜出来的时长——这里改为有界轮询。
			const statePath = join(tempDir, ".uina", "apps.json");
			const deadline = Date.now() + 3000;
			let persisted = "";
			while (Date.now() < deadline) {
				try {
					persisted = await readFile(statePath, "utf8");
					if (persisted.includes('"jukebox": false')) break;
				} catch {
					// 文件尚未写出，继续等
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(persisted).toContain('"jukebox": false');

			// 模拟进程重启：创建新的 AppRegistry 实例（相同 cwd）
			const mock2 = createMockExtensionAPI(tempDir);
			const registry2 = new AppRegistry(mock2.pi);

			// 重新注册该应用（即使 defaultState 是 enabled: true）
			await registry2.register({
				name: "jukebox",
				description: "点歌机",
				defaultState: { enabled: true },
				actions: {},
			});

			// 验证根据持久化状态，依然保持停用
			expect(mock2.tools.has("jukebox")).toBe(false);

			// 用户重新启用
			await registry2.enable("jukebox");
			expect(mock2.tools.has("jukebox")).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
