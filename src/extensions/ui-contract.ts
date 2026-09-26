/**
 * 扩展体系核心契约与渲染器类型定义（对齐 Pi ExtensionUIContext 规范）。
 */

import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "../ui/core/types.js";
export type { Component, OverlayHandle, OverlayOptions, WidgetPlacement };

/** 模型选择器的一组条目（provider 分组）。官方 /model 命令与选择器共享此形状。 */
export interface ModelPickerModel {
	id: string;
	name: string;
	description: string;
	provider: string;
}
export interface ModelPickerGroup {
	id: string;
	name: string;
	description: string;
	models: ModelPickerModel[];
}

/** 自定义消息：进入会话历史，也参与模型上下文 */
export interface CustomMessage<T = unknown> {
	customType: string;
	content: string;
 images?: import("../core/content.js").ImageContent[];
	display?: boolean;
	details?: T;
}

/** 自定义条目：仅用于 capability 私有持久化（auxiliary），不参与模型上下文与呈现 */
export interface CustomEntry<T = unknown> {
	customType: string;
	data?: T;
}

export interface MessageRenderOptions {
	expanded?: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
) => Component | undefined;

/** 斜杠命令定义 */
export interface LocalCommand {
	name: string;
	description: string;
	keybinding?: string;
	argumentHint?: string;
	tag?: string;
	hasArgs?: boolean;
	handler?: (args: string) => void | Promise<void>;
}

export interface PromptOptions {
	signal?: AbortSignal;
}

/** 扩展可访问的窄 UI 接口 */
export interface ExtensionUIContext {
	/** 显示选择器对话框并返回用户选择项 */
	select(title: string, options: string[], promptOptions?: PromptOptions): Promise<string | undefined>;

	/** 显示确认对话框 */
	confirm(title: string, message: string, promptOptions?: PromptOptions): Promise<boolean>;

	/** 显示单行文本输入对话框 */
	input(title: string, placeholder?: string, promptOptions?: PromptOptions): Promise<string | undefined>;

	/** 向用户发送瞬态通知（悬浮于输入框右上角呼吸空隙，零高度不污染历史） */
	notify(message: string, type?: "info" | "warning" | "error", timeoutMs?: number): void;

	/** 清除当前的瞬态通知 */
	clearNotification(): void;

	/** 设置状态栏/底栏文本（传 undefined 表示清除） */
	setStatus(key: string, text: string | undefined): void;

	/** 设置由当前扩展拥有的原子工作指示器；undefined 删除该指示器。 */
	setWorking(key: string, message: string | undefined): void;

	/** 挂载或更新小部件 */
	setWidget(
		key: string,
		component: Component | undefined,
		options?: { placement?: WidgetPlacement; priority?: number },
	): void;

	/** 设置自定义顶部组件（传 undefined 恢复默认 Banner） */
	setHeader(component: Component | undefined): void;

	/** 设置自定义底部组件 */
	setFooter(component: Component | undefined): void;

	/** 打开通用覆盖层 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;

	/** 向编辑器粘贴文本（支持折叠芯片） */
	pasteToEditor(text: string): void;

	/** 设置编辑器文本 */
	setEditorText(text: string): void;

	/** 获取编辑器当前文本 */
	getEditorText(): string;

	/** 监听终端原生键盘输入（返回取消监听函数） */
	onTerminalInput(handler: (data: string) => void): () => void;

	/** 获取右侧导航轨模式 (scrollbar / timeline) */
	getGutterMode(): "scrollbar" | "timeline";

	/** 设置右侧导航轨模式 */
	setGutterMode(mode: "scrollbar" | "timeline"): void;

	/** 是否存在真实交互式 UI。非 TTY 兜底实现返回 false，扩展据此分支，
	 * 而不是把 undefined/false 当成用户的选择（Pi: ExtensionUIContext.hasUI）。 */
	hasUI(): boolean;

	openFeature?(name: string, payload?: unknown): boolean;
	toggleThinking?(): void;
	clearTranscript?(): void;

	/** 右侧导航轨滑块样式 */
	getScrollbarThumbStyle?(): "slim" | "block" | "wide";
	setScrollbarThumbStyle?(style: "slim" | "block" | "wide"): void;
}

/** A pure view of one tool invocation; execution and persisted facts remain outside UI. */
export interface ToolRenderData {
 readonly name: string;
 readonly callId?: string;
 readonly args?: unknown;
 readonly result?: string;
 readonly status: 'running' | import('../core/types.js').ToolResultStatus;
 readonly details?: unknown;
 readonly images?: readonly import('../core/content.js').ImageContent[];
}
export type ToolRenderer = (tool: ToolRenderData, options: { expanded: boolean; hovered: boolean; width: number; elapsedMs: number }) => Component | undefined;
export type MarkdownTransformer = (markdown: string, context: { role: 'user' | 'assistant'; streaming: boolean; width: number }) => string;
