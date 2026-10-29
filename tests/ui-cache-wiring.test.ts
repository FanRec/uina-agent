/**
 * 缓存命中率与 Provider Usage 接线测试：
 * 验证从 usage_update / turn_end 携带的真实缓存数据能够一路抵达 UIHost、
 * InputLine（底栏徽章）与 ContextBarComponent（悬停明细），
 * 且在 context_update 与回合结束静止态下不发生“误清空”。
 */
import { describe, expect, it } from "vitest";
import { createInteractiveUI } from "../src/ui/tui.js";
import { createSilentTerminal, getTestUIHost, record } from "./harness/index.js";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const createTestUI = () =>
	createInteractiveUI({ modelName: "deepseek-chat", terminal: createSilentTerminal(100, 30).terminal });

describe("InteractiveTUI：缓存命中率与真实用量接线", () => {
	it("usage_update 携带 cacheRead 时，InputLine 底栏成功渲染缓存命中率徽章，contextBar 包含明细", () => {
		const tui = createTestUI();
		tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "查资料" }));

		// 收到服务端真实用量：cacheRead = 8500, promptTokens = 1500 (总输入 10000，命中率 85.0%)
		tui.consume(
			record({
				type: "usage_update",
				usage: {
					callId: "call-1",
					promptTokens: 1500,
					outputTokens: 100,
					cacheRead: 8500,
					cacheWrite: 0,
					totalTokens: 10100,
				},
			}),
		);

		// 1. 验证 InputLine 渲染行包含缓存命中率
		const inputLines = getTestUIHost(tui).inputLine.render(100).map(plain);
		const bottomLine = inputLines.at(-1) ?? "";
		expect(bottomLine).toContain("缓存 85.0%");

		// 2. 验证 contextBar 悬停时包含真实缓存读与输入
		getTestUIHost(tui).contextBar.setHovered(true);
		const ctxBarLines = getTestUIHost(tui).contextBar.render(100).map(plain);
		const ctxBarText = ctxBarLines.join(" ");
		expect(ctxBarText).toContain("缓存读 8.5k");
		expect(ctxBarText).toContain("输入 1.5k");
	});

	it("context_update 派发新上下文快照时，不破坏已报回的缓存命中率（消除重构误伤）", () => {
		const tui = createTestUI();
		tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "查资料" }));
		tui.consume(
			record({
				type: "usage_update",
				usage: {
					callId: "call-1",
					promptTokens: 2000,
					outputTokens: 50,
					cacheRead: 8000,
					totalTokens: 10050,
				},
			}),
		);

		expect(plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "")).toContain("缓存 80.0%");

		// 随后派发 context_update（如请求预估或基线更新）
		tui.consume(
			record({
				type: "context_update",
				snapshot: {
					projectionId: "p1",
					modelKey: "deepseek-chat",
					basis: "active_request",
					source: "test",
					inputTokens: 10050,
					contextWindow: 65536,
					measurementKind: "exact",
				},
			}),
		);

		// 关键断言：缓存命中率不被刷新为 undefined
		const bottomLine = plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "");
		expect(bottomLine).toContain("缓存 80.0%");
		getTestUIHost(tui).contextBar.setHovered(true);
		expect(plain(getTestUIHost(tui).contextBar.render(100).join(" "))).toContain("缓存读 8.0k");
	});

	it("回合结束后（turn_end）静止阅读状态，缓存命中率徽章继续稳定保留", () => {
		const tui = createTestUI();
		tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "做运算" }));
		tui.consume(
			record({
				type: "usage_update",
				usage: {
					callId: "call-1",
					promptTokens: 1000,
					outputTokens: 20,
					cacheRead: 9000,
					totalTokens: 10020,
				},
			}),
		);
		tui.consume(
			record({
				type: "turn_end",
				turnNumber: 1,
				requestUsage: {
					callId: "call-1",
					promptTokens: 1000,
					outputTokens: 20,
					cacheRead: 9000,
					totalTokens: 10020,
				},
			}),
		);

		// 回合结束后的 idle baseline 更新
		tui.consume(
			record({
				type: "context_update",
				snapshot: {
					projectionId: "p1",
					modelKey: "deepseek-chat",
					basis: "idle_baseline",
					source: "test",
					inputTokens: 10020,
					contextWindow: 65536,
					measurementKind: "exact",
				},
			}),
		);

		const bottomLine = plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "");
		expect(bottomLine).toContain("缓存 90.0%");
	});

	it("turn_start 只把上下文读数标为估算，不抹掉上一轮真实缓存事实", () => {
		const tui = createTestUI();
		tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "第一问" }));
		tui.consume(
			record({
				type: "usage_update",
				usage: {
					callId: "call-1",
					promptTokens: 1000,
					cacheRead: 9000,
				},
			}),
		);
		expect(plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "")).toContain("缓存 90.0%");

		// 新回合开始：上下文读数转为估算，但上一轮 usage 仍是最近一次真实事实。
		tui.consume(record({ type: "turn_start", turnNumber: 2, userText: "第二问" }));
		const bottomLine = plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "");
		expect(bottomLine).toContain("缓存 90.0%");
		getTestUIHost(tui).contextBar.setHovered(true);
		expect(plain(getTestUIHost(tui).contextBar.render(100).join(" "))).toContain("缓存读 9.0k");
	});

	it("会话回溯（session_rewind）时，旧缓存数据正确重置", () => {
		const tui = createTestUI();
		tui.consume(record({ type: "turn_start", turnNumber: 1, userText: "第一问" }));
		tui.consume(
			record({
				type: "usage_update",
				usage: {
					callId: "call-1",
					promptTokens: 1000,
					cacheRead: 9000,
				},
			}),
		);
		expect(plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "")).toContain("缓存 90.0%");

		// 会话回溯，当前用量失效重置
		tui.consume(
			record({
				type: "session_rewind",
				requestId: "req-1",
				rewindId: "rewind-1",
				fromId: "entry-2",
				targetId: "entry-1",
				entries: [],
			}),
		);
		const bottomLine = plain(getTestUIHost(tui).inputLine.render(100).at(-1) ?? "");
		expect(bottomLine).not.toContain("缓存");
		expect(plain(getTestUIHost(tui).contextBar.render(100).join(" "))).not.toContain("缓存读");
	});
});
