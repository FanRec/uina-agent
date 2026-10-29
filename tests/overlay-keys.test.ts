// 覆盖层按键决策的纯内核钉住：isMouseReport / isToggleKey / confirmChoice。
import { describe, expect, it } from "vitest";
import { FocusManager } from "../src/ui/core/focus.js";
import { Key, matchesKey } from "../src/ui/core/keys.js";
import { OverlayStack } from "../src/ui/core/overlay.js";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import { confirmChoice, isMouseReport, isToggleKey } from "../src/ui/extension-ui-context.js";

const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ENTER = "\r";
const ESCAPE = "\x1b";

describe("isMouseReport / isToggleKey", () => {
	it("Ctrl+L is a real terminal key for the context details affordance", () => {
		expect(matchesKey("\x0c", Key.ctrl("l"))).toBe(true);
	});

	it("鼠标上报前缀", () => {
		expect(isMouseReport("\x1b[<0;1;1M")).toBe(true);
		expect(isMouseReport("\x1b[M !!")).toBe(true);
		expect(isMouseReport("a")).toBe(false);
	});

	it("←/→/Tab 为切换键", () => {
		expect(isToggleKey(ARROW_LEFT)).toBe(true);
		expect(isToggleKey(ARROW_RIGHT)).toBe(true);
		expect(isToggleKey("\t")).toBe(true);
		expect(isToggleKey("y")).toBe(false);
		expect(isToggleKey(ENTER)).toBe(false);
	});
});

describe("confirmChoice", () => {
	it("y/Y 恒真，n/N 恒假（无视焦点）", () => {
		expect(confirmChoice("y", false)).toBe(true);
		expect(confirmChoice("Y", false)).toBe(true);
		expect(confirmChoice("n", true)).toBe(false);
		expect(confirmChoice("N", true)).toBe(false);
	});

	it("Enter 随当前焦点，Esc 取消为假", () => {
		expect(confirmChoice(ENTER, true)).toBe(true);
		expect(confirmChoice(ENTER, false)).toBe(false);
		expect(confirmChoice(ESCAPE, true)).toBe(false);
	});

	it("其余输入 undefined = 无动作", () => {
		expect(confirmChoice("x", true)).toBeUndefined();
		expect(confirmChoice(ARROW_LEFT, true)).toBeUndefined();
	});
});

describe("ModelPicker 边框闭合与选定行为", () => {
	const sampleGroups = [
		{
			id: "deepseek",
			name: "deepseek",
			description: "DeepSeek",
			models: [
				{
					id: "deepseek/deepseek-flash",
					name: "deepseek-flash",
					description: "默认配置模型 · openai-compatible",
					provider: "deepseek",
				},
				{ id: "deepseek/deepseek-chat", name: "deepseek-chat", description: "Chat 模型", provider: "deepseek" },
			],
		},
		{
			id: "anthropic",
			name: "anthropic",
			description: "Anthropic",
			models: [
				{ id: "anthropic/claude-3-5-sonnet", name: "claude-3-5-sonnet", description: "Sonnet", provider: "anthropic" },
			],
		},
	];

	it("各行可见宽度严格相等，右边框与右下角闭合对齐", async () => {
		const { ModelPicker } = await import("../src/ui/features/overlays/model-picker.js");
		const { visibleWidth } = await import("../src/ui/core/utils.js");

		// 测试 groups 层级
		const picker = new ModelPicker("deepseek/deepseek-flash", sampleGroups);
		for (const width of [60, 80, 100, 120]) {
			const lines = picker.formatLines(width);
			const expectedW = visibleWidth(lines[0]!);
			for (let i = 0; i < lines.length; i++) {
				expect(visibleWidth(lines[i]!), `Width ${width} line ${i} mismatch`).toBe(expectedW);
			}
		}

		// 测试 models 层级
		picker.confirm(); // 下钻到 models
		for (const width of [60, 80, 100, 120]) {
			const lines = picker.formatLines(width);
			const expectedW = visibleWidth(lines[0]!);
			for (let i = 0; i < lines.length; i++) {
				expect(visibleWidth(lines[i]!), `Width ${width} line ${i} mismatch`).toBe(expectedW);
			}
		}
	});

	it("窄终端不截断模型选择边框", async () => {
		const { ModelPicker } = await import("../src/ui/features/overlays/model-picker.js");
		const picker = new ModelPicker("deepseek/deepseek-flash", sampleGroups);

		for (const width of [36, 40, 50]) {
			for (const [index, line] of picker.formatLines(width).entries()) {
				expect(visibleWidth(line), `width=${width} row=${index}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("短视口保持当前分组可见并标出滚动余量", async () => {
		const { ModelPicker } = await import("../src/ui/features/overlays/model-picker.js");
		const groups = Array.from({ length: 12 }, (_, index) => ({
			id: `provider-${index}`,
			name: `provider-${index}`,
			description: `Provider ${index}`,
			models: [{ id: `provider-${index}/model`, name: "model", description: "model", provider: `provider-${index}` }],
		}));
		const picker = new ModelPicker("provider-0/model", groups);
		for (let index = 0; index < 5; index++) picker.navigateDown();

		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(picker);
		const rendered = stripAnsi(stack.renderAbove(60, 6).join("\n"));

		expect(rendered).toContain("provider-5");
		expect(rendered).toContain("↑");
		expect(rendered).toContain("↓");
	});

	it("Enter 选定模型触发 onPick", async () => {
		const { ModelPicker } = await import("../src/ui/features/overlays/model-picker.js");
		const picker = new ModelPicker("deepseek/deepseek-flash", sampleGroups);

		let pickedModel: string | undefined;
		picker.onPick = (id) => {
			pickedModel = id;
		};

		// 第一次 Enter 下钻
		picker.handleInput(ENTER);
		expect(pickedModel).toBeUndefined();

		// 第二次 Enter 选定模型
		picker.handleInput(ENTER);
		expect(pickedModel).toBe("deepseek/deepseek-flash");
	});
});
