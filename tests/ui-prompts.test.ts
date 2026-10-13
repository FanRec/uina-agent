import { describe, expect, it } from "vitest";
import { createExtensionUIContext, type UIHostContextPort } from "../src/ui/extension-ui-context.js";
import type { ExtensionUIContext } from "../src/extensions/ui-contract.js";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import type { Component, OverlayHandle } from "../src/ui/core/types.js";
import { CURSOR_MARKER } from "../src/ui/core/types.js";

function capturePrompt<T>(open: (ui: ExtensionUIContext) => Promise<T>): {
	component: Component;
	result: Promise<T>;
	isHidden(): boolean;
} {
	let component: Component | undefined;
	let hidden = true;
	const host = {
		requestRender() {},
		notify() {},
		showOverlay(next: Component, _options?: unknown, dispose?: () => void): OverlayHandle {
			component = next;
			hidden = false;
			return {
				hide: () => {
					hidden = true;
					dispose?.();
				},
				requestRender() {},
				setHidden() {},
				isHidden: () => hidden,
				focus() {},
				unfocus() {},
				isFocused: () => true,
			};
		},
	} as unknown as UIHostContextPort;
	const result = open(createExtensionUIContext(host));
	if (!component) throw new Error("prompt did not open its overlay");
	return { component, result, isHidden: () => hidden };
}

const openConfirm = (title: string, message: string) => capturePrompt((ui) => ui.confirm(title, message));

describe("confirmation prompt behavior", () => {
	it("defaults to rejection on Enter and accepts only after an explicit Yes", async () => {
		const rejected = openConfirm("Trust server?", "This server can execute commands.");
		rejected.component.handleInput?.("\r");
		expect(await rejected.result).toBe(false);

		const approved = openConfirm("Trust server?", "This server can execute commands.");
		approved.component.handleInput?.("y");
		expect(await approved.result).toBe(true);
	});

	it("wraps the complete risk message instead of truncating its ending", () => {
		const message =
			"来源: .uina/extensions/mcp.json\n端点: local tool runner\n\n此服务可以在本机执行命令并以当前用户权限访问网络。";
		const { component } = openConfirm("允许项目服务？", message);
		const rendered = component
			.render(40)
			.map((line) => stripAnsi(line))
			.join("\n");
		const flattened = rendered.replace(/\s+/g, "");

		expect(flattened).toContain("来源:.uina/extensions/mcp.json");
		expect(flattened).toContain("端点:localtoolrunner");
		expect(flattened).toContain("当前用户");
		expect(flattened).toContain("权限访问网络");
	});

	it("keeps confirm, select, and input prompts within narrow and short viewports", () => {
		const confirm = openConfirm("授权危险服务", "第一段说明\n\n" + "该服务可能访问网络并写入文件。".repeat(8));
		const select = capturePrompt((ui) =>
			ui.select(
				"选择服务",
				Array.from({ length: 20 }, (_, i) => `服务-${i}`),
			),
		);
		const input = capturePrompt((ui) => ui.input("输入名称", "请输入"));
		for (const component of [confirm.component, select.component, input.component]) {
			const rows = component.render(40, 8);
			expect(rows.length).toBeLessThanOrEqual(8);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
		}
	});

	it("scrolls long selection lists to keep the selected item visible", async () => {
		const prompt = capturePrompt((ui) =>
			ui.select(
				"选择",
				Array.from({ length: 20 }, (_, i) => `服务-${i}`),
			),
		);
		for (let index = 0; index < 12; index++) prompt.component.handleInput?.("\x1b[B");
		const rendered = stripAnsi(prompt.component.render(40, 8).join("\n"));
		expect(rendered).toContain("服务-12");
		expect(rendered).toContain("↓");
		prompt.component.handleInput?.("\r");
		expect(await prompt.result).toBe("服务-12");
	});

	it("settles each prompt when its owner aborts and removes the overlay", async () => {
		const controller = new AbortController();
		const select = capturePrompt((ui) => ui.select("选择", ["a"], { signal: controller.signal }));
		const confirm = capturePrompt((ui) => ui.confirm("确认", "continue?", { signal: controller.signal }));
		const input = capturePrompt((ui) => ui.input("输入", "value", { signal: controller.signal }));

		controller.abort();

		expect(await Promise.all([select.result, confirm.result, input.result])).toEqual([undefined, false, undefined]);
		expect([select.isHidden(), confirm.isHidden(), input.isHidden()]).toEqual([true, true, true]);
	});

	it("moves and deletes a complete grapheme in the input prompt", async () => {
		const prompt = capturePrompt((ui) => ui.input("输入内容"));
		prompt.component.handleInput?.("Hello👋🏻");
		prompt.component.handleInput?.("\x1b[D");
		prompt.component.handleInput?.("\x1b[3~");
		prompt.component.handleInput?.("\r");

		expect(await prompt.result).toBe("Hello");
	});

	it("keeps the input cursor visible when the prompt text exceeds the terminal width", () => {
		const prompt = capturePrompt((ui) => ui.input("输入名称"));
		prompt.component.handleInput?.("abcdefghijklmnopqrstuvwxyz0123456789");
		const rows = prompt.component.render(40, 8);
		const rendered = stripAnsi(rows.join("\n"));
		expect(rows.join("\n")).toContain(CURSOR_MARKER);
		expect(rendered).toContain("…");
		expect(rendered).toContain("9");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
	});
});
