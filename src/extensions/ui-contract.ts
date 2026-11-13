/**
 * 扩展体系核心契约与渲染器类型定义（对齐 Pi ExtensionUIContext 规范）。
 */

import type { ThinkingLevel } from "../core/types.js";
import type { SlotAck } from "../presentation/composition/slots.js";
import type { SurfaceCapabilities } from "../presentation/surface.js";
import type { Component, OverlayHandle, OverlayOptions } from "../ui/core/types.js";

export type { SurfaceCapabilities } from "../presentation/surface.js";
export type { Component, OverlayHandle, OverlayOptions };

/** 模型选择器的一组条目（provider 分组）。官方 /model 命令与选择器共享此形状。 */ export interface ModelPickerModel {
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

/** TUI-only 消息渲染器：终端行组件模型，由 TerminalUIContext 提供。
 * 其他 surface 用各自的组件系统渲染 PresentationNode payload，不复用此契约。 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
) => Component | undefined;

/**
 * 命令处理器可返回的结构化结果：Router 不直接给 Subject 发消息，宿主把
 * `{ kind: "agent-input", ... }` 转成一条真实操作者输入。
 *
 * - `text`：模型真正接收的展开正文（进 Canonical User Message 的 content）；
 * - `displayText`：操作者原始命令（终端、远端、回放展示；缺省回退 text），
 *   不进 Provider 请求；
 * - `data`：机器可读上下文（沿输入记录持久化，不替代展示字段）。
 */
export interface CommandAgentInput {
	text: string;
	displayText?: string;
	data?: unknown;
}

export type CommandResult = { kind: "agent-input" } & CommandAgentInput;

/** 斜杠命令定义 */
export interface LocalCommand {
	name: string;
	description: string;
	keybinding?: string;
	argumentHint?: string;
	tag?: string;
	hasArgs?: boolean;
	handler?: (args: string) => void | Promise<void> | CommandResult | Promise<CommandResult>;
}

export interface PromptOptions {
	signal?: AbortSignal;
}

export interface ModelPickerAction {
	currentModel: string;
	groups: ModelPickerGroup[];
	onPick: (name: string, signal?: AbortSignal) => Promise<void> | void;
}

export interface EffortSliderAction {
	currentLevel?: ThinkingLevel;
	tiers: readonly (ThinkingLevel | { id: ThinkingLevel; name: string; description: string })[];
	onChange: (level: ThinkingLevel) => void;
}

/** Actions the shared application can express independently of terminal layout. */
export interface BuiltinUIActions {
	help: undefined;
	"toggle-thinking": undefined;
	"clear-transcript": undefined;
	"model-picker": ModelPickerAction;
	"effort-slider": EffortSliderAction;
	trajectory: undefined;
	history: undefined;
	prompt: undefined;
}

/** A complete typed application action, including the lifetime of any UI it opens. */
export type BuiltinUIActionRequest<Name extends keyof BuiltinUIActions = keyof BuiltinUIActions> = {
	[Action in Name]: BuiltinUIActions[Action] extends undefined
		? { readonly name: Action; readonly signal?: AbortSignal }
		: { readonly name: Action; readonly payload: BuiltinUIActions[Action]; readonly signal?: AbortSignal };
}[Name];

/** Terminal-only component lifecycle and renderer registration facet. */
export interface TerminalUIContext {
	setHeader(component: Component | undefined): void;
	setFooter(component: Component | undefined): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	openGutter(argument?: string): boolean;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	registerMessageRenderer<T = unknown>(
		customType: string,
		renderer: MessageRenderer<T>,
		options?: { replace?: boolean },
	): () => void;
	registerToolRenderer(name: string, renderer: ToolRenderer, options?: { replace?: boolean }): () => void;
	registerMarkdownTransformer(
		name: string,
		transformer: MarkdownTransformer,
		options?: { replace?: boolean },
	): () => void;
}

/** 扩展可访问的窄 UI 接口 */
export interface ExtensionUIContext {
	/** 显示选择器对话框并返回用户选择项 */
	select(title: string, options: string[], promptOptions?: PromptOptions): Promise<string | undefined>;

	/** 显示确认对话框 */
	confirm(title: string, message: string, promptOptions?: PromptOptions): Promise<boolean>;

	/** 显示单行文本输入对话框 */
	input(title: string, placeholder?: string, promptOptions?: PromptOptions): Promise<string | undefined>;

	/** 向用户发送瞬态通知（toast 队列，按 dedupeKey 去重、按等级排序）。
	 * 返回受理回执：accepted 表示已入队展示，shadowed 表示同键通知仍在展示中被去重。 */
	notify(message: string, type?: "info" | "warning" | "error", timeoutMs?: number): SlotAck;

	/** 清除当前的瞬态通知 */
	clearNotification(): void;

	/** 设置由当前扩展拥有的原子工作指示器；undefined 删除该指示器。
	 * 工作指示器按 priority 并列展示（最多 3 条 + “+N”），回执表示是否被受理。 */
	setWorking(key: string, message: string | undefined): SlotAck;

	/** 是否存在真实交互式 UI。由 capabilities().interactive 派生；非 TTY 兜底实现返回 false，
	 * 扩展据此分支，而不是把 undefined/false 当成用户的选择（Pi: ExtensionUIContext.hasUI）。 */
	hasUI(): boolean;

	/** 本 surface 的能力声明：扩展据此降级（无 overlays 时走行内表单，无 images 时不发图），
	 * 不再用 hasUI() 布尔猜。 */
	capabilities(): SurfaceCapabilities;

	/** Open a typed application action without exposing terminal panel geometry. */
	openFeature(action: BuiltinUIActionRequest): boolean;

	/** Terminal components, overlays, editor control and terminal renderers.
	 * 仅交互式终端 surface 提供；无头/未来 surface 为 undefined——扩展必须显式处理
	 * “无终端”分支，或在 activate 早期用 capabilities() 判断。 */
	readonly terminal?: TerminalUIContext;
}

/** A pure view of one tool invocation; execution and persisted facts remain outside UI. */
export interface ToolRenderData {
	readonly name: string;
	readonly callId?: string;
	readonly args?: unknown;
	readonly result?: string;
	readonly status: "running" | import("../core/types.js").ToolResultStatus;
	readonly details?: unknown;
	readonly images?: readonly import("../core/content.js").ImageContent[];
}
/** TUI-only 工具渲染器：与 MessageRenderer 同属终端行组件模型。 */
export type ToolRenderer = (
	tool: ToolRenderData,
	options: { expanded: boolean; hovered: boolean; width: number; elapsedMs?: number },
) => Component | undefined;
export type MarkdownTransformer = (
	markdown: string,
	context: { role: "user" | "assistant"; streaming: boolean; width: number },
) => string;
