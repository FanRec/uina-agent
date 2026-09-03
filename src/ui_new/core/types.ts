/**
 * UI 核心契约与类型定义（借鉴 pi-tui Component 架构）。
 */

/**
 * 零宽转义标记：用于在自绘假光标处标记位置，
 * 渲染器扫描此标记将真实物理光标移动至该坐标，
 * 彻底解决操作系统中文/日文 IME 输入法候选框漂移问题。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** 原子可渲染组件契约（零 Virtual DOM，只产出行数组） */
export interface Component {
	/**
	 * 接收当前可用字符宽度，返回渲染后的行数组。
	 * 铁律：返回的每一行实际可见宽度不得超过 width。
	 */
	render(width: number): string[];

	/** 键盘/终端输入处理（若组件获取焦点） */
	handleInput?(data: string): void;

	/** 使缓存失效（标记需要重新计算） */
	invalidate?(): void;
}

/** 焦点感知组件接口（用于光标与 IME 同步） */
export interface Focusable {
	focused: boolean;
}

export function isFocusable(c: unknown): c is Focusable {
	return (
		typeof c === "object" && c !== null && "focused" in c && typeof (c as Focusable).focused === "boolean"
	);
}

/** 小部件挂载槽位 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 小部件项 */
export interface WidgetItem {
	id: string;
	component: Component;
	placement: WidgetPlacement;
	priority?: number; // 越小越靠近输入框
}

/** 外部主循环/Agent 投递给 UI 的消息事件 */
export type UinaUIMsg =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn_start"; n: number; text: string }
	| { type: "turn_end"; n: number; usage?: { usedTokens: number; contextWindow: number } }
	| { type: "tool_start"; name: string; args: unknown; ts: number }
	| { type: "tool_done"; name: string; result: string; ts: number; elapsedMs?: number }
	| { type: "notice"; text: string }
	| { type: "error"; text: string };
