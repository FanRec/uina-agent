/**
 * Surface 能力声明与适配器契约（平台中立，只有形状，不实现任何 surface）。
 *
 * 扩展按能力降级（capabilities().overlays / images …），不靠 hasUI() 布尔猜。
 * 布局、按键字节、终端能力探测属于具体 Surface，不进入本层。
 */

export interface SurfaceCapabilities {
	/** 有真实交互回路（键盘/焦点/会话回路）；无头 surface 为 false。 */
	readonly interactive: boolean;
	/** 富文本（TUI 的 ANSI/Markdown 渲染；纯文本面与受限 DOM 为 false）。 */
	readonly richText: boolean;
	readonly images: boolean;
	/** 浮层/模态面板可用。 */
	readonly overlays: boolean;
	readonly pointer: boolean;
	readonly clipboard: boolean;
	/** 系统级通知（终端 bell、桌面通知等）；仅行内提示时为 false。 */
	readonly notifications: boolean;
}

export const HEADLESS_CAPABILITIES: SurfaceCapabilities = {
	interactive: false,
	richText: false,
	images: false,
	overlays: false,
	pointer: false,
	clipboard: false,
	notifications: false,
};

export const INTERACTIVE_TERMINAL_CAPABILITIES: SurfaceCapabilities = {
	interactive: true,
	richText: true,
	images: true,
	overlays: true,
	pointer: true,
	clipboard: true,
	notifications: true,
};

/**
 * Surface 适配器：接管 controller 的视图与意图。
 * 本次只保留形状（W2e 已交付 controller）；第二个 surface 接入时实现 attach。
 */
export interface SurfaceAdapter {
	readonly id: string;
	readonly capabilities: SurfaceCapabilities;
	/** 接管 controller 的视图与意图；返回 detach。 */
	attach(controller: import("./controller.js").PresentationController): () => void;
}
