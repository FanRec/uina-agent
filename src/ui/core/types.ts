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

/**
 * 浮层几何契约（每个字段都有确定语义，且内置与扩展浮层共用同一实现）：
 *
 * - `width` / `minWidth`：数字或百分比字符串，解析后夹在 `[1, 可用宽度]`；
 *   未给 `width` 时取可用宽度。所有返回行都会被裁剪到该宽度。
 * - `maxHeight`：该浮层自身的最大行数，与 renderAbove 的预算取较小值。
 * - `anchor`：**水平**对齐（left / center / right；`above-editor` 等同 center）。
 *   垂直位置恒为"紧贴输入框上方"，用 `offsetY` 微调。
 * - `offsetX`：在水平锚点基础上的列偏移。
 * - `offsetY`：向上偏移的行数。正值在浮层**下方**插入空白行（离输入框更远），
 *   负值从浮层底部裁掉。
 * - `margin`：left/right 参与宽度计算，top/bottom 以空白行形式参与高度。
 * - `nonCapturing`：不改变焦点。
 */
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
