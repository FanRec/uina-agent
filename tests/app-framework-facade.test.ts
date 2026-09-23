import { describe, expect, it } from "vitest";
import { createFacadeTool } from "../src/extensions/app-framework/facade-tool.js";
import type { AppDef, AppRuntime, SurfaceTier } from "../src/extensions/app-framework/types.js";

describe("App Framework: Facade Tool", () => {
	function createMockApp(overrides: Partial<AppDef> = {}) {
		let currentTier: SurfaceTier = "hidden";
		const mockDef: AppDef = {
			name: "jukebox",
			description: "网易云点歌机",
			actions: {
				play: {
					description: "播放歌曲",
					validate: (params: any) =>
						typeof params?.keyword === "string" && params.keyword.length > 0
							? { valid: true }
							: { valid: false, error: "keyword 不能为空" },
					run: async (params: any, ctx) => {
						ctx.setTier("ambient");
						return `已播放《${params.keyword}》`;
					},
				},
				throwError: {
					description: "抛出异常测试",
					run: () => {
						throw new Error("硬件失联");
					},
				},
			},
			...overrides,
		};

		const runtime: AppRuntime = {
			definition: mockDef,
			enabled: true,
			surfaceTier: currentTier,
			lastActiveTurn: 0,
		};

		const tool = createFacadeTool(mockDef, {
			getRuntime: () => runtime,
			setTier: (tier) => {
				currentTier = tier;
				runtime.surfaceTier = tier;
			},
		});

		return { tool, mockDef, runtime, getTier: () => currentTier };
	}

	it("空参调用：展开视口并返回成功", async () => {
		const { tool, getTier } = createMockApp();
		expect(getTier()).toBe("hidden");

		const result = await tool.run({});
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("界面已展开");
		expect(getTier()).toBe("expanded");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/open",
			appName: "jukebox",
			action: "open",
		});
	});

	it("内置动作 close：关闭视口", async () => {
		const { tool, getTier } = createMockApp();
		await tool.run({}); // 先展开
		expect(getTier()).toBe("expanded");

		const result = await tool.run({ action: "close" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("界面已关闭");
		expect(getTier()).toBe("hidden");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/close",
			appName: "jukebox",
			action: "close",
		});
	});

	it("内置动作 ambient：切入后台轻量感知", async () => {
		const { tool, getTier } = createMockApp();
		const result = await tool.run({ action: "ambient" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("后台轻量感知模式");
		expect(getTier()).toBe("ambient");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/ambient",
		});
	});

	it("内置动作 help：返回可用指令说明", async () => {
		const { tool } = createMockApp();
		const result = await tool.run({ action: "help" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("播放歌曲");
		expect(result.result).toContain("close:");
		expect(result.result).toContain("ambient:");
	});

	it("未知 action：Fail Fast 报错，且不擅自改变视口状态", async () => {
		const { tool, getTier } = createMockApp();
		expect(getTier()).toBe("hidden");

		const result = await tool.run({ action: "non_existent_action" });
		expect(result.status).toBe("failed");
		expect(result.result).toContain("未知操作: \"non_existent_action\"");
		expect(result.result).toContain("可用操作列表");
		// 验证没有自作聪明修改视口
		expect(getTier()).toBe("hidden");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/non_existent_action",
			error: "unknown_action",
		});
	});

	it("业务动作执行：带参穿透与 setTier 联动", async () => {
		const { tool, getTier } = createMockApp();
		const result = await tool.run({
			action: "play",
			params: { keyword: "晴天" },
		});

		expect(result.status).toBe("succeeded");
		expect(result.result).toBe("已播放《晴天》");
		// 验证 handler 内部调用的 setTier('ambient') 生效
		expect(getTier()).toBe("ambient");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/play",
			appName: "jukebox",
			action: "play",
		});
	});

	it("参数校验失败：返回 failed 并附带校验信息", async () => {
		const { tool } = createMockApp();
		const result = await tool.run({
			action: "play",
			params: { keyword: "" },
		});

		expect(result.status).toBe("failed");
		expect(result.result).toContain("keyword 不能为空");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/play",
			error: "invalid_parameters",
		});
	});

	it("业务执行抛出异常：捕获并返回 failed，不让进程崩溃", async () => {
		const { tool } = createMockApp();
		const result = await tool.run({ action: "throwError" });

		expect(result.status).toBe("failed");
		expect(result.result).toContain("硬件失联");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/throwError",
		});
	});

	it("信号中止：返回 cancelled 状态", async () => {
		const { tool } = createMockApp();
		const controller = new AbortController();
		controller.abort();

		const result = await tool.run({ action: "play", params: { keyword: "晴天" } }, controller.signal);
		expect(result.status).toBe("cancelled");
		expect(result.result).toContain("已被取消");
		expect(result.details).toMatchObject({
			operationIdentity: "app:jukebox/play",
		});
	});

	it("Handler 返回 ToolExecutionResult 对象：保留完整结果字段", async () => {
		const { tool } = createMockApp({
			actions: {
				complex: {
					description: "复杂返回",
					run: () => ({
						result: "复杂数据",
						status: "succeeded",
						details: { extra: 123 },
					}),
				},
			},
		});

		const result = await tool.run({ action: "complex" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toBe("复杂数据");
		expect(result.details).toMatchObject({
			extra: 123,
			operationIdentity: "app:jukebox/complex",
		});
	});

	it("内置动作 close：若此前已处于 hidden 状态，诚实返回无需重复关闭", async () => {
		const { tool, getTier } = createMockApp();
		expect(getTier()).toBe("hidden");

		const result = await tool.run({ action: "close" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("此前已处于关闭状态 (hidden)，无需重复关闭");
		expect(getTier()).toBe("hidden");
	});

	it("ActionContext.getTier：动作内部可准确读取当前视口档位", async () => {
		let detectedTier = "";
		const { tool } = createMockApp({
			actions: {
				checkTier: {
					description: "检测档位",
					run: (_params, ctx) => {
						detectedTier = ctx.getTier();
						return `当前档位是: ${detectedTier}`;
					},
				},
			},
		});

		const r1 = await tool.run({ action: "checkTier" });
		expect(r1.result).toBe("当前档位是: hidden");

		await tool.run({}); // 展开
		const r2 = await tool.run({ action: "checkTier" });
		expect(r2.result).toBe("当前档位是: expanded");
	});
});


describe("App Framework: Facade Tool 取消语义", () => {
	function createAbortableApp() {
		let currentTier: SurfaceTier = "hidden";
		const def: AppDef = {
			name: "slowapp",
			description: "取消语义测试",
			actions: {
				slow: {
					description: "挂起直到被取消",
					run: (_params, ctx) =>
						new Promise<string>((_, reject) => {
							ctx.signal.addEventListener("abort", () => reject(new Error("operation aborted")), { once: true });
						}),
				},
			},
		};
		const runtime: AppRuntime = { definition: def, enabled: true, surfaceTier: currentTier, lastActiveTurn: 0 };
		const tool = createFacadeTool(def, {
			getRuntime: () => runtime,
			setTier: (tier) => {
				currentTier = tier;
				runtime.surfaceTier = tier;
			},
		});
		return tool;
	}

	it("执行中取消且 action 抛出：如实报告 unknown，不吞成 failed", async () => {
		const tool = createAbortableApp();
		const controller = new AbortController();
		const promise = tool.run({ action: "slow" }, controller.signal);
		controller.abort();
		const result = await promise;
		expect(result.status).toBe("unknown");
		expect(result.result).toContain("外部副作用状态未知");
	});

	it("执行开始前已取消：报告 cancelled", async () => {
		const tool = createAbortableApp();
		const controller = new AbortController();
		controller.abort();
		const result = await tool.run({ action: "slow" }, controller.signal);
		expect(result.status).toBe("cancelled");
	});
});
