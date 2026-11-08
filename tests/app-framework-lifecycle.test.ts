import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import { defineWorld } from "../src/extensions/world-framework/index.js";
import { worldSucceeded } from "../src/extensions/world-framework/result.js";
import type { ServiceCompanionContext } from "../src/extensions/world-framework/types.js";
import { WorldRegistry } from "../src/extensions/world-framework/world-registry.js";
import type { Tool } from "../src/tools/broker.js";

describe("World Framework: Lifecycle & Registry", () => {
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

	it("defineWorld: 自动注册门面工具并在注销时拔除", async () => {
		const mock = createMockExtensionAPI();
		const onStart = vi.fn();
		const onStop = vi.fn();

		const unregister = await defineWorld(mock.pi, {
			name: "jukebox",
			description: "网易云点歌机",
			onStart,
			onStop,
			actions: {
				play: {
					description: "播放",
					run: () => worldSucceeded("播放中"),
				},
			},
		});

		// 验证工具已被注册
		expect(mock.pi.registerTool).toHaveBeenCalled();
		expect(mock.tools.has("jukebox")).toBe(true);
		expect(onStart).toHaveBeenCalled();

		// 注销世界
		await unregister();

		// 验证工具已被拔除，onStop 被调用
		expect(mock.tools.has("jukebox")).toBe(false);
		expect(onStop).toHaveBeenCalled();
	});

	it("enable / disable 动态生命周期与 onStart / onStop 联动", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);

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

	it("World 事件保留 deferred render，并带来源与投递模式", async () => {
		const mock = createMockExtensionAPI();
		let emitEvent:
			| ((event: {
					id: string;
					type: string;
					channel: "world";
					delivery: "queued" | "urgent";
					origin: "external" | "internal";
					render: () => string;
			  }) => Promise<void>)
			| undefined;
		const inputs: Array<Record<string, unknown>> = [];
		(mock.pi as any).submitInput = vi.fn(async (input: Record<string, unknown>) => {
			inputs.push(input);
		});
		const unregister = await defineWorld(mock.pi, {
			name: "event-world",
			description: "event test",
			onStart: (ctx) => {
				emitEvent = ctx.emitEvent as typeof emitEvent;
			},
			actions: {},
		});
		let state = "old";
		await emitEvent!({
			id: "event-1",
			type: "changed",
			channel: "world",
			delivery: "queued",
			origin: "external",
			render: () => state,
		});
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.mode).toBe("followUp");
		expect((inputs[0]?.source as { origin?: string }).origin).toBe("external");
		expect((inputs[0]?.source as { channel?: string }).channel).toBe("world");
		expect(state).toBe("old");
		state = "new";
		const deferred = inputs[0]?.render as () => string;
		expect(await deferred()).toBe("new");
		await unregister();
		expect(await deferred()).toBeNull();
	});

	it("emitEvent：既无 text 也无 render 的事件显式抛错，不静默丢弃", async () => {
		const mock = createMockExtensionAPI();
		let emitEvent: NonNullable<ServiceCompanionContext["emitEvent"]> | undefined;
		const inputs: Array<Record<string, unknown>> = [];
		(mock.pi as any).submitInput = vi.fn(async (input: Record<string, unknown>) => {
			inputs.push(input);
		});
		const unregister = await defineWorld(mock.pi, {
			name: "invalid-event-world",
			description: "invalid event test",
			onStart: (ctx) => {
				emitEvent = ctx.emitEvent;
			},
			actions: {},
		});
		await expect(emitEvent!({ id: "bad-1", type: "changed", channel: "world", origin: "external" })).rejects.toThrow(
			"必须提供 text 或 render",
		);
		expect(inputs).toHaveLength(0);
		await unregister();
	});

	it("emitEvent 回答的是「事件还归不归我」：停用与拒收都不算交付", async () => {
		const mock = createMockExtensionAPI();
		let emitEvent: NonNullable<ServiceCompanionContext["emitEvent"]> | undefined;
		let refuse: string | null = null;
		(mock.pi as any).submitInput = vi.fn(async () => {
			if (refuse) throw new Error(refuse);
		});
		const unregister = await defineWorld(mock.pi, {
			name: "submission-world",
			description: "submission test",
			onStart: (ctx) => {
				emitEvent = ctx.emitEvent;
			},
			actions: {},
		});
		const event = {
			id: "ev-1",
			type: "changed",
			channel: "world" as const,
			origin: "external" as const,
			text: "世界变了",
		};
		expect(await emitEvent!(event)).toEqual({ accepted: true });
		refuse = "宿主正在关闭";
		expect(await emitEvent!(event)).toEqual({ accepted: false, reason: "宿主正在关闭", retryable: true });
		await unregister();
		// 停用后事件仍在世界手里：宿主不该以为已经交出去了。
		expect(await emitEvent!(event)).toEqual({ accepted: false, reason: "世界已停用", retryable: false });
	});

	it("disable：先取消并等待动作，再执行 onStop", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);
		const order: string[] = [];
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});

		await registry.register({
			name: "ordered",
			description: "ordered",
			onStop: () => {
				order.push("stop");
			},
			actions: {
				wait: {
					description: "wait",
					run: async (_params, ctx) => {
						order.push("started");
						await released;
						order.push(ctx.signal.aborted ? "aborted" : "finished");
						return worldSucceeded("done");
					},
				},
			},
		});

		const work = mock.tools.get("ordered")!.run({ action: "wait", params: {} }, undefined, undefined as never);
		await vi.waitFor(() => expect(order).toEqual(["started"]));
		const stopping = registry.disable("ordered");
		await Promise.resolve();
		expect(order).toEqual(["started"]);
		release();
		await stopping;
		await work;
		expect(order).toEqual(["started", "aborted", "stop"]);
	});

	it("disposeAll：等待式回收全部伴生服务与工具（由 ResourceScope await，非 fire-and-forget）", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);

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

		// 显式等待回收（生命周期收拢后由 ResourceScope 调用 activation 返回的 dispose）
		await registry.disposeAll();

		// 两个世界的 onStop 均被调用，且工具被全部拔除
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
		const registry = new WorldRegistry(mock.pi);

		const onStart = vi.fn();
		const onStop = vi.fn();

		await registry.register({
			name: "partitioned",
			description: "可回滚世界",
			onStart,
			onStop,
			defaultState: { enabled: false },
			actions: {
				do: { description: "执行", parameters: { type: "object" }, run: () => worldSucceeded("ok") },
			},
		});

		// 启用：注册工具抛错 → 应回滚 onStop，且异常上抛
		await expect(registry.enable("partitioned")).rejects.toThrow("工具重名");
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(onStop).toHaveBeenCalledTimes(1); // 补偿回滚
		expect(registry.get("partitioned")?.enabled).toBe(false); // 状态未提交
		expect(mock.tools.has("partitioned")).toBe(false);
	});

	it("重复注册同名世界应报错", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);

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
		).rejects.toThrow('世界 "dup" 已被注册');
	});

	it("持久化状态测试：disable/enable 写入 .uina/worlds.json 并在下次启动时恢复", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "uina-app-persist-test-"));
		try {
			const mock1 = createMockExtensionAPI(tempDir);
			const registry1 = new WorldRegistry(mock1.pi);

			// 注册一个默认启用的世界
			await registry1.register({
				name: "jukebox",
				description: "点歌机",
				defaultState: { enabled: true },
				actions: {},
			});
			expect(mock1.tools.has("jukebox")).toBe(true);

			// 用户/前端停用该世界
			await registry1.disable("jukebox");
			expect(mock1.tools.has("jukebox")).toBe(false);

			// 等落盘完成。原先用固定 20ms：持久化是异步链式写入（saveTail → 临时文件 → rename），
			// 全量并发负载下 20ms 并不总是够，曾反复造成门禁假失败。
			// 测试应当等条件而不是等一个猜出来的时长——这里改为有界轮询。
			const statePath = join(tempDir, ".uina", "worlds.json");
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

			// 模拟进程重启：创建新的 WorldRegistry 实例（相同 cwd）
			const mock2 = createMockExtensionAPI(tempDir);
			const registry2 = new WorldRegistry(mock2.pi);

			// 重新注册该世界（即使 defaultState 是 enabled: true）
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

	it("停止一个 App 只取消它自己的动作", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);
		let aStarted = false;
		let bStarted = false;
		let bFinished = false;
		let releaseB!: () => void;
		const bReleased = new Promise<void>((resolve) => {
			releaseB = resolve;
		});

		await registry.register({
			name: "a",
			description: "a",
			defaultState: { enabled: false },
			actions: {
				wait: {
					description: "wait",
					run: async (_params, ctx) => {
						aStarted = true;
						await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
						return worldSucceeded("a");
					},
				},
			},
		});
		await registry.register({
			name: "b",
			description: "b",
			defaultState: { enabled: false },
			actions: {
				wait: {
					description: "wait",
					run: async (_params, ctx) => {
						bStarted = true;
						await bReleased;
						bFinished = !ctx.signal.aborted;
						return worldSucceeded("b");
					},
				},
			},
		});
		await registry.enable("a");
		await registry.enable("b");

		const aWork = mock.tools.get("a")!.run({ action: "wait", params: {} }, undefined, undefined as never);
		const bWork = mock.tools.get("b")!.run({ action: "wait", params: {} }, undefined, undefined as never);
		await vi.waitFor(() => expect(aStarted && bStarted).toBe(true));
		await registry.disable("a");
		releaseB();
		await Promise.all([aWork, bWork]);

		expect(bFinished).toBe(true);
	});

	it("onStop 失败不会伪装成成功停用", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);
		await registry.register({
			name: "broken-stop",
			description: "broken stop",
			onStop: () => {
				throw new Error("stop failed");
			},
			actions: {},
		});

		await expect(registry.disable("broken-stop")).rejects.toThrow("世界停用失败");
		expect(registry.get("broken-stop")?.enabled).toBe(false);
		expect(mock.tools.has("broken-stop")).toBe(false);
	});

	it("关闭开始后拒绝新的注册和启用", async () => {
		const mock = createMockExtensionAPI();
		const registry = new WorldRegistry(mock.pi);
		await registry.register({ name: "existing", description: "existing", actions: {} });
		const closing = registry.disposeAll();

		await expect(registry.register({ name: "late", description: "late", actions: {} })).rejects.toThrow("closing");
		await expect(registry.enable("existing")).rejects.toThrow("closing");
		await closing;
	});
});
