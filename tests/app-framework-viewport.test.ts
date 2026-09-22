import { describe, expect, it } from "vitest";
import { ContextViewport } from "../src/extensions/app-framework/context-viewport.js";
import type { AppRuntime } from "../src/extensions/app-framework/types.js";
import type { ChatMsg } from "../src/core/types.js";

describe("App Framework: Context Viewport", () => {
	function createMockRuntime(name: string, tier: "hidden" | "ambient" | "expanded" = "hidden"): AppRuntime {
		return {
			definition: {
				name,
				description: `${name} 应用`,
				render: (t) =>
					t === "ambient"
						? `[${name}: 正在后台轻量运行]`
						: `=== [${name}] ===\n状态: 正常\n数据: <data>测试数据</data>`,
				actions: {},
			},
			enabled: true,
			surfaceTier: tier,
			lastActiveTurn: Date.now(),
		};
	}

	it("全 hidden 状态下：0 变更，原样返回消息列表", async () => {
		const r1 = createMockRuntime("jukebox", "hidden");
		const r2 = createMockRuntime("live2d", "hidden");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1, r2],
		});

		const input: ChatMsg[] = [
			{ role: "user", content: "你好初奈" },
			{ role: "assistant", content: "你好呀！" },
		];

		const output = await viewport.transformContext(input);
		expect(output).toEqual(input);
	});

	it("ambient 状态：独立追加一条 user 帧，不污染既有 user 消息", async () => {
		const r1 = createMockRuntime("jukebox", "ambient");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1],
		});

		const input: ChatMsg[] = [
			{ role: "user", content: "今天天气不错" },
		];

		const output = await viewport.transformContext(input);
		expect(output.length).toBe(2);
		// 原消息字节级不变（不伪装成 user 输入）。
		expect(output[0]).toEqual(input[0]);
		// 视口以独立消息追加。
		const injected = output[1];
		expect(injected.role).toBe("user");
		expect(injected.content).toContain("【运行中的应用程序 / Running Apps】");
		expect(injected.content).toContain("[jukebox: 正在后台轻量运行]");
	});

	it("expanded 状态：独立消息承载完整面板，原消息内容不变", async () => {
		const r1 = createMockRuntime("jukebox", "expanded");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1],
		});

		const input: ChatMsg[] = [
			{ role: "user", content: "放首歌" },
		];

		const output = await viewport.transformContext(input);
		expect(output.length).toBe(2);
		expect(output[0]).toEqual(input[0]);
		const injected = output[1];
		expect(injected.content).toContain("[App: jukebox]");
		expect(injected.content).toContain("状态: 正常");
		expect(injected.content).toContain("<data>测试数据</data>");
	});

	it("maxExpanded 限制与自动降级：超出上限时最旧应用降为 ambient", async () => {
		const r1 = createMockRuntime("app1", "expanded");
		r1.lastActiveTurn = 1000; // 最早活跃
		const r2 = createMockRuntime("app2", "expanded");
		r2.lastActiveTurn = 2000;
		const r3 = createMockRuntime("app3", "hidden");
		r3.lastActiveTurn = 3000;

		const runtimes = [r1, r2, r3];
		const viewport = new ContextViewport({
			maxExpanded: 2,
			getRuntimes: () => runtimes,
		});

		// 激活第 3 个应用为 expanded
		viewport.setTier(r3, "expanded");

		// 验证：r3 变为 expanded，最旧的 r1 被降为 ambient，r2 保持 expanded
		expect(r3.surfaceTier).toBe("expanded");
		expect(r1.surfaceTier).toBe("ambient");
		expect(r2.surfaceTier).toBe("expanded");
	});

	it("render 抛错容错：应用异常不阻断回合，输出降级错误提示", async () => {
		const buggyRuntime: AppRuntime = {
			definition: {
				name: "brokenApp",
				description: "异常应用",
				render: () => {
					throw new Error("外部服务超时");
				},
				actions: {},
			},
			enabled: true,
			surfaceTier: "expanded",
			lastActiveTurn: Date.now(),
		};

		const viewport = new ContextViewport({
			getRuntimes: () => [buggyRuntime],
		});

		const input: ChatMsg[] = [{ role: "user", content: "测试" }];
		const output = await viewport.transformContext(input);
		expect(output.length).toBe(2);
		expect(output[0]).toEqual(input[0]);
		expect(output[1].content).toContain("[App: brokenApp] (界面渲染失败: 外部服务超时)");
	});

	it("空消息列表输入时：仍独立生成一条承载视口文本的消息", async () => {
		const r1 = createMockRuntime("jukebox", "ambient");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1],
		});

		const output = await viewport.transformContext([]);
		expect(output.length).toBe(1);
		expect(output[0].role).toBe("user");
		expect(output[0].content).toContain("[jukebox: 正在后台轻量运行]");
	});
});
