import { describe, expect, it } from "vitest";
import type { RequestObservation } from "../src/core/types.js";
import { ContextCardComponent, type ContextCardData } from "../src/ui/components/transcript/context-card.js";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import { PromptOverlay } from "../src/ui/features/overlays/prompt-overlay.js";

const prompt: ContextCardData = {
	kind: "prompt",
	turnNumber: 2,
	systemPrompt: "BASE PROMPT\n[Memory] keep the user context",
	injections: [
		{ extension: "builtin:base", kind: "systemPrompt", chars: 11, preview: "BASE PROMPT" },
		{ extension: "builtin:memory", kind: "messages", messageCount: 1, chars: 20, preview: "[Memory]" },
	],
	previousSystemPrompt: "BASE PROMPT",
};

describe("ContextCardComponent", () => {
	it("renders a readable collapsed prompt card and expands the full prompt", () => {
		const card = new ContextCardComponent(prompt);
		const collapsed = stripAnsi(card.render(80).join("\n"));
		expect(collapsed).toContain("提示词变更");
		expect(collapsed).toContain("builtin:memory");
		expect(collapsed).not.toContain("keep the user context");

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
	it("/prompt 面板直接展示最终 system prompt 正文", () => {
		const rendered = new PromptOverlay(prompt).render(100).join("\n");
		expect(stripAnsi(rendered)).toContain("BASE PROMPT");
		expect(stripAnsi(rendered)).toContain("keep the user context");
	});

	it("/prompt 显示最近一次请求的观察正文，并随新请求清空", () => {
		let observations: RequestObservation[] = [{ source: "minecraft", text: "overworld (10,64,-4)\n生命16/20" }];
		const overlay = new PromptOverlay(prompt, () => observations);
		const render = () => stripAnsi(overlay.render(80).join("\n"));
		expect(render()).toContain("最近一次模型请求 · 世界观察");
		expect(render()).toContain("overworld (10,64,-4)");
		expect(render()).toContain("生命16/20");
		observations = [];
		expect(render()).toContain("未附加世界观察");
		expect(render()).not.toContain("overworld");
	});
});
