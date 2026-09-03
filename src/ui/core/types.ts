/**
 * UI 核心契约与类型定义（对齐 Pi 架构规范与 Uina 终端特性）。
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

	/** 是否需要接收键位释放事件 */
	wantsKeyRelease?: boolean;
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

/** 浮层锚点定位方式 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "above-editor";

export type SizeValue = number | `${number}%`;

export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export interface OverlayOptions {
	width?: SizeValue;
	minWidth?: number;
	maxHeight?: SizeValue;
	anchor?: OverlayAnchor;
	offsetX?: number;
	offsetY?: number;
	margin?: OverlayMargin | number;
	nonCapturing?: boolean;
}

/** showOverlay 返回的操作句柄 */
export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
	isFocused(): boolean;
}

/** 小部件挂载槽位 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface WidgetItem {
	id: string;
	component: Component;
	placement: WidgetPlacement;
	priority?: number;
}

/** 运行时向 UI 投递的标准化事件类型 */
export type UinaUIMsg =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn_start"; n: number; text: string }
	| { type: "turn_end"; n: number; usage?: { usedTokens: number; contextWindow?: number } }
	| { type: "tool_start"; name: string; args: unknown; ts?: number; callId?: string }
	| { type: "tool_done"; name: string; result: string; ts?: number; elapsedMs?: number; callId?: string }
	| { type: "notice"; text: string }
	| { type: "error"; text: string }
	| { type: "queue"; items: readonly { text: string }[] };
