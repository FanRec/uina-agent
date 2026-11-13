import { describe, expect, it } from "vitest";
import { ContextCardComponent, type ContextCardData } from "../src/ui/components/transcript/context-card.js";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import { PromptOverlay } from "../src/ui/features/overlays/prompt-overlay.js";

const prompt: ContextCardData = {
	kind: "prompt",
	basis: "prepared",
	requestId: "stream-2-1",
	modelKey: "mock/mock",
	systemPrompt: "BASE PROMPT\n[Memory] keep the user context",
	messageCount: 4,
	toolCount: 2,
	measurement: { inputTokens: 1_234, kind: "approximate" },
	sources: [
		{ owner: "builtin:memory", id: "facts", kind: "observation", status: "included" },
		{ owner: "builtin:gone", id: "g", kind: "guidance", status: "unregistered", reason: "已注销" },
	],
};

describe("ContextCardComponent", () => {
	it("renders a readable prepared-request card and expands the system prompt", () => {
		const card = new ContextCardComponent(prompt);
		const collapsed = stripAnsi(card.render(80).join("\n"));
		expect(collapsed).toContain("最近请求准备");
		expect(collapsed).toContain("builtin:memory/facts");
		expect(collapsed).toContain("未提供"); // Wire 未提供时不伪造
		expect(collapsed).not.toContain("keep the user context");
		expect(collapsed).not.toContain("已发送");

		card.toggle();
		const expanded = stripAnsi(card.render(80).join("\n"));
		expect(expanded).toContain("keep the user context");
	});

	it("renders external input as a source-labeled card", () => {
		const card = new ContextCardComponent({
			kind: "external",
			inputId: "e1",
			source: { kind: "runtime", type: "file-changed", origin: "external" },
			receivedAt: "2026-10-04T12:00:00.000Z",
			text: "文件发生变化",
		});
		const rendered = stripAnsi(card.render(80).join("\n"));
		expect(rendered).toContain("外部注入");
		expect(rendered).toContain("file-changed");
		expect(rendered).toContain("文件发生变化");
		expect(rendered).not.toContain("❯");
	});

	it("keeps every rendered line within a narrow terminal", () => {
		const card = new ContextCardComponent({ ...prompt, systemPrompt: "中文🙂".repeat(30) });
		card.toggle();
		for (const line of card.render(42)) expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(42);
	});
	it("/prompt 面板展示最近准备请求；无请求记录时显示明确标注的预览", async () => {
		const port = {
			requestObservation: async () => prompt as never,
			inspectRequest: async () =>
				({
					kind: "prompt",
					basis: "preview",
					modelKey: "mock/mock",
					systemPrompt: "PREVIEW PROMPT",
					messageCount: 1,
					toolCount: 0,
					sources: [],
				}) as never,
		};
		const prepared = new PromptOverlay(port);
		await prepared.ready;
		const rendered = stripAnsi(prepared.render(100).join("\n"));
		expect(rendered).toContain("最近请求准备");
		expect(rendered).toContain("BASE PROMPT");
		expect(rendered).toContain("keep the user context");

		const preview = new PromptOverlay({
			requestObservation: async () => undefined,
			inspectRequest: (port as { inspectRequest: () => Promise<never> }).inspectRequest,
		});
		await preview.ready;
		const previewText = stripAnsi(preview.render(100).join("\n"));
		expect(previewText).toContain("当前预览");
		expect(previewText).toContain("未发送");
	});
});
