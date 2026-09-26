import { createInteractiveUI, InteractiveTUI, type InteractiveTUIOptions } from "../../../src/ui/tui.js";
import { UIHost } from "../../../src/ui/ui-host.js";
import { createSilentTerminal, type SilentTerminalResult } from "../environment/silent-terminal.js";
import type { Component } from "../../../src/ui/core/types.js";
import type { ModelGroup } from "../../../src/ui/features/overlays/index.js";
import type { VtScreen } from "../environment/vt-screen.js";

/** 常用键名到 ANSI 转义序列的映射 */
const KEY_MAP: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	escape: "\x1b",
	esc: "\x1b",
	backspace: "\x7f",
	delete: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	arrowup: "\x1b[A",
	arrowdown: "\x1b[B",
	arrowright: "\x1b[C",
	arrowleft: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};

/**
 * 交互式 TUI 测试门面（UITestHarness）：
 * 彻底消灭全局 process.stdin/process.stdout 劫持样板，
 * 提供确定性的键鼠输入仿真与真实屏幕可见性提取。
 */
export class UITestHarness {
	readonly tui: InteractiveTUI;
	readonly terminal: SilentTerminalResult;
	private disposed = false;

	constructor(tui: InteractiveTUI, terminal: SilentTerminalResult) {
		this.tui = tui;
		this.terminal = terminal;
	}

	get host(): UIHost {
		return this.tui.host;
	}

	get screen(): VtScreen {
		return this.terminal.screen;
	}

	/** 屏幕上当前可见的纯文本行（消除 ANSI 颜色与历史重绘残影） */
	get visibleText(): string {
		return this.terminal.getVisibleText();
	}

	/** 输入行当前包含的文本内容 */
	get inputText(): string {
		return this.host.inputLine.getText();
	}

	/** 当前活动的顶层捕获覆盖层组件（若有） */
	get activeOverlay(): Component | undefined {
		return this.host.overlayStack.topCapturing?.component;
	}

	/** 是否存在可见的覆盖层 */
	get hasOverlay(): boolean {
		return this.host.overlayStack.hasVisible;
	}

	/** 直接投递底层原始输入序列（如 ANSI 控制符） */
	feedInput(data: string): this {
		this.terminal.feedInput(data);
		return this;
	}

	/** 模拟用户逐字输入纯文本 */
	type(text: string): this {
		this.terminal.feedInput(text);
		return this;
	}

	/** 模拟按下特定功能键（如 "Enter"、"Tab"、"ArrowDown"、"Escape" 等） */
	press(key: string): this {
		const seq = KEY_MAP[key.toLowerCase()] ?? key;
		this.terminal.feedInput(seq);
		return this;
	}

	/** 模拟终端括号粘贴（Bracketed Paste） */
	paste(text: string): this {
		this.terminal.feedInput(`\x1b[200~${text}\x1b[201~`);
		return this;
	}

	/** 动态调整终端窗口尺寸并触发重绘 */
	resize(cols: number, rows: number): this {
		this.terminal.resize(cols, rows);
		return this;
	}

	/** 关闭 TUI 并释放资源 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.tui.close();
	}
}

export interface TestTUIOptions extends InteractiveTUIOptions {
	columns?: number;
	rows?: number;
}

/**
 * 构造轻量测试 TUI 实例：
 * 自动装配 SilentTerminal，无需对全局 process 做任何侵入式劫持。
 */
export function createTestTUI(options: TestTUIOptions = {}): UITestHarness {
	const terminal = createSilentTerminal({
		columns: options.columns ?? 120,
		rows: options.rows ?? 30,
		isTTY: true,
	});

	const tui = createInteractiveUI({
		...options,
		terminal: terminal.terminal,
	});

	tui.start();

	return new UITestHarness(tui, terminal);
}

/**
 * 微组件即时渲染辅助器：
 * 快速获取单个 Component 在指定宽度/行数下的渲染行输出。
 */
export function renderWidget(
	component: Component,
	options: { width?: number; height?: number } = {},
): string[] {
	const width = options.width ?? 80;
	return component.render(width);
}

/**
 * 共享的标准 ModelGroups Fixture：
 * 消除测试用例中重复手写的 40 行 Provider/Model 数据结构。
 */
export function mockModelGroups(): ModelGroup[] {
	return [
		{
			id: "deepseek",
			name: "deepseek",
			description: "https://api.deepseek.com",
			models: [
				{
					id: "deepseek-v4-flash",
					name: "deepseek-v4-flash",
					description: "默认模型",
					provider: "deepseek",
				},
			],
		},
		{
			id: "anthropic",
			name: "anthropic",
			description: "api.anthropic.com",
			models: [
				{
					id: "claude-3-7-sonnet",
					name: "claude-3-7-sonnet",
					description: "大模型",
					provider: "anthropic",
				},
				{
					id: "claude-3-5-haiku",
					name: "claude-3-5-haiku",
					description: "小模型",
					provider: "anthropic",
				},
			],
		},
	];
}
