import { describe, expect, it } from "vitest";
import { ContextViewport } from "../src/extensions/app-framework/context-viewport.js";
import { assertEventFrameContext, EVENT_FRAME_TOOL_NAME } from "../src/extensions/event-frames/protocol.js";
import type { AppRuntime } from "../src/extensions/app-framework/types.js";
import type { ChatMsg } from "../src/core/types.js";

describe("App Framework: Context Viewport tail frame", () => {
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

	it("全 hidden 状态下：返回 undefined（0 帧 0 token）", async () => {
		const r1 = createMockRuntime("jukebox", "hidden");
		const r2 = createMockRuntime("live2d", "hidden");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1, r2],
		});

		expect(await viewport.buildTailFrame()).toBeUndefined();
	});

	it("ambient 状态：三消息组承载视口快照，tool 回执含横幅与渲染文本", async () => {
		const r1 = createMockRuntime("jukebox", "ambient");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1],
		});

		const frame = await viewport.buildTailFrame();
		expect(frame).toBeDefined();
		const [notice, call, receipt] = frame!;
		expect(frame!.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

		// notice：瞬态快照声明，非用户输入、无需回应
		expect(notice!.content).toContain("应用视口瞬态快照");
		expect(notice!.content).toContain("非用户输入");
		expect(notice!.content).toContain("无需直接回应");

		// 合成调用与配对
		const calls = "tool_calls" in call! ? call!.tool_calls : undefined;
		expect(calls?.length).toBe(1);
		expect(calls![0]!.name).toBe(EVENT_FRAME_TOOL_NAME);

		// 回执正文：外部来源标注 + 视口文本
		const body = JSON.parse(receipt!.content) as { eventId: string; source: { kind: string; type: string; origin: string }; text: string };
		expect(body.source).toEqual({ kind: "runtime", type: "app-viewport", origin: "external" });
		expect(body.text).toContain("【运行中的应用程序 / Running Apps】");
		expect(body.text).toContain("[jukebox: 正在后台轻量运行]");

		expect(() => assertEventFrameContext(frame!)).not.toThrow();
	});

	it("expanded 状态：回执正文含完整面板数据", async () => {
		const r1 = createMockRuntime("jukebox", "expanded");
		const viewport = new ContextViewport({
			getRuntimes: () => [r1],
		});

		const frame = await viewport.buildTailFrame();
		const body = JSON.parse(frame![2]!.content) as { text: string };
		expect(body.text).toContain("[App: jukebox]");
		expect(body.text).toContain("状态: 正常");
		expect(body.text).toContain("<data>测试数据</data>");
	});

	it("确定性：同内容两次构建产出逐字节相同的帧组；内容变化 ⇒ eventId/callId 变化", async () => {
		const r1 = createMockRuntime("jukebox", "ambient");
		const viewport = new ContextViewport({ getRuntimes: () => [r1] });

		const a = await viewport.buildTailFrame();
		const b = await viewport.buildTailFrame();
		expect(a).toEqual(b);

		// 内容变化（模拟进度 tick）
		r1.definition.render = () => "[jukebox: 正在播放另一首歌]";
		const c = await viewport.buildTailFrame();
		expect(c).not.toEqual(a);
		const callIdOf = (frame: ChatMsg[]) => (frame[1]! as Extract<ChatMsg, { tool_calls?: unknown }>).tool_calls![0]!.id;
		expect(callIdOf(c!)).not.toBe(callIdOf(a!));
		// 两组帧共存仍通过协议校验（多组并存的上下文合法）
		expect(() => assertEventFrameContext([...a!, ...c!])).not.toThrow();
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

	it("render 抛错容错：应用异常不阻断回合，回执正文降级错误提示", async () => {
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

		const frame = await viewport.buildTailFrame();
		const body = JSON.parse(frame![2]!.content) as { text: string };
		expect(body.text).toContain("[App: brokenApp] (界面渲染失败: 外部服务超时)");
	});
});
