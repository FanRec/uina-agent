/**
 * 扩展体系核心契约与渲染器类型定义（对齐 Pi ExtensionUIContext 规范）。
 */

import type { Component, OverlayHandle, OverlayOptions, WidgetPlacement } from "../ui/core/types.js";
import type { ContextSnapshot, ThinkingLevel } from "../core/types.js";
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
	clearNotification(): void;

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
	getGutterMode(): "scrollbar" | "timeline";

	/** 设置右侧导航轨模式 */
	setGutterMode(mode: "scrollbar" | "timeline"): void;

	/** 是否存在真实交互式 UI。非 TTY 兜底实现返回 false，扩展据此分支，
	 * 而不是把 undefined/false 当成用户的选择（Pi: ExtensionUIContext.hasUI）。 */
	hasUI(): boolean;

	// —— 消费者可选富能力（官方内置命令与项目扩展同一张脸；不支持的消费者留空即可）——

	/** 打开帮助菜单（快捷键总览） */
	openHelpMenu?(): void;
	/** 展开/折叠深度思考过程 */
	toggleThinking?(): void;
	/** 清空当前屏幕转录流 */
	clearTranscript?(): void;
	/** 打开模型选择面板（两级 provider 下钻）；onPick 回传复合键 providerId/modelId */
	openModelPicker?(currentModel: string, groups: ModelPickerGroup[], onPick: (name: string) => Promise<void> | void): void;
	/** 打开思考强度滑杆 */
	openEffortSlider?(currentLevel: ThinkingLevel | undefined, declaredLevels: ThinkingLevel[], onChange: (level: ThinkingLevel) => void): void;
	/** 后台任务看板 */
	openTasks?(): void;
	/** 子代理看板 */
	openSubagents?(): void;
	/** 审计轨迹时序看板 */
	openTrajectory?(): void;
	/** 会话历史分支看板 */
	openHistory?(): void;
	/** 底栏模型名同步 */
	setModel?(name: string): void;
	/** 底栏思考档位元数据同步 */
	setThinkingLevels?(levels?: readonly ThinkingLevel[]): void;
	/** 底栏当前思考档位同步 */
	setReasoningEffort?(level?: ThinkingLevel): void;
	/** 当前模型语义 RequestProjection 的上下文快照。 */
	setContext?(snapshot: ContextSnapshot): void;
	/** 右侧导航轨滑块样式 */
	getScrollbarThumbStyle?(): "slim" | "block" | "wide";
	setScrollbarThumbStyle?(style: "slim" | "block" | "wide"): void;
	/** 转录流追加一条折叠的压缩摘要卡片 */
	addCompaction?(record: { status?: "completed" | "failed" | "cancelled" | "noop"; summary: string; turnsCount: number; tokensBefore: number; collapsed: boolean }): void;
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
