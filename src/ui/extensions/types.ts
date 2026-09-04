/**
 * 扩展体系核心契约与渲染器类型定义（对齐 Pi ExtensionUIContext 规范）。
 */

import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "../core/types.js";

/** 自定义消息：进入会话历史，也参与模型上下文 */
export interface CustomMessage<T = unknown> {
	customType: string;
	content: string;
	display?: boolean;
	details?: T;
}

/** 自定义条目：仅用于会话持久化与终端呈现，不参与模型上下文 */
export interface CustomEntry<T = unknown> {
	customType: string;
	data?: T;
}

export interface MessageRenderOptions {
	expanded?: boolean;
}

export interface EntryRenderOptions {
	expanded?: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
) => Component | undefined;

/** 斜杠命令定义 */
export interface LocalCommand {
	name: string;
	description: string;
	argumentHint?: string;
	tag?: string;
	hasArgs?: boolean;
	handler?: (args: string) => void | Promise<void>;
}

/** 扩展可访问的窄 UI 接口 */
export interface ExtensionUIContext {
	/** 显示选择器对话框并返回用户选择项 */
	select(title: string, options: string[]): Promise<string | undefined>;

	/** 显示确认对话框 */
	confirm(title: string, message: string): Promise<boolean>;

	/** 显示单行文本输入对话框 */
	input(title: string, placeholder?: string): Promise<string | undefined>;

	/** 向用户发送瞬态通知（悬浮于输入框右上角呼吸空隙，零高度不污染历史） */
	notify(message: string, type?: "info" | "warning" | "error", timeoutMs?: number): void;

	/** 清除当前的瞬态通知 */
	clearNotification?(): void;

	/** 设置状态栏/底栏文本（传 undefined 表示清除） */
	setStatus(key: string, text: string | undefined): void;

	/** 设置流式运行期间的动态工作消息 */
	setWorkingMessage(message?: string): void;

	/** 显隐运行指示器 */
	setWorkingVisible(visible: boolean): void;

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
	getGutterMode?(): "scrollbar" | "timeline";

	/** 设置右侧导航轨模式 */
	setGutterMode?(mode: "scrollbar" | "timeline"): void;
}
