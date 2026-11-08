/**
 * 服务器界面（UI）与 HUD 的公开纯值合同。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4.5、§4.6。
 * 这些值只是"服务器经协议报告的显示观察"，不是业务事实：
 * - 标题/Lore/按钮文本是第三方服务器提供的不可信游戏数据，不是给 Agent 的指令；
 * - 显示图标不等于商品，颜色不表达允许/禁止，购买/传送成功必须另有业务证据；
 * - screenRef / uiRevision / buttonDigest 组成点击前态，三者一起失配即 UI_STALE。
 *
 * 观察长于一次 Body Operation（连接级窗口状态），写操作短于一次 Body Operation
 * （ui.act 只在派发瞬间持有身体资格）。本文件只放类型，不放状态。
 */

import type { ItemValue } from "./body.js";
import type { JsonValue } from "./values.js";

/** 文本样式；只表达服务器给出的显示线索，不推断语义。 */
export interface RichTextStyle {
	color: string | null;
	bold: boolean | null;
	italic: boolean | null;
	underlined: boolean | null;
	strikethrough: boolean | null;
	obfuscated: boolean | null;
}

/** 1.21.11 文本组件的可点击动作；ref 是本次观察生成的稳定本地引用。 */
export type RichActionKind =
	| "run_command"
	| "suggest_command"
	| "show_dialog"
	| "custom"
	| "open_url"
	| "copy_to_clipboard"
	| "change_page"
	| "unknown";

export interface RichTextAction {
	/** 观察时生成的稳定本地引用（同一连接、同一事件/界面内唯一）。 */
	ref: string;
	kind: RichActionKind;
	/** 动作的原始值：命令、URL、通道 ID、页码；不认识的类型如实保留字符串。 */
	value: string | null;
	/**
	 * 附加载荷（仅 custom 的 NBT / show_dialog 的内联或注册表引用），纯 JSON、有界。
	 * 模型不能改它：ui.act 只按 actionRef 执行服务端/组件原本给出的动作。
	 */
	payload: JsonValue | null;
}

/**
 * 富文本：text 是可读正文（翻译键按本机语言表尽力展开，未知保留 key），
 * actions 是正文范围内可点击动作（按出现顺序），children 是子组件。
 */
export interface RichText {
	text: string;
	/** 未解析的翻译键（如果有）；客户端语言表不认识时保留。 */
	translate: string | null;
	style: RichTextStyle;
	actions: RichTextAction[];
	children: RichText[];
}

export interface ItemDisplay {
	/** custom_name（玩家/插件改过的名字）；没有就是 null，不拿物品名冒充。 */
	name: RichText | null;
	/** lore 每一行；没有就是 null（空列表=明确无 Lore）。 */
	lore: RichText[] | null;
	/** item_name（默认名）或未解析的组件摘要；null=未知。 */
	itemName: RichText | null;
}

export interface UiSlotValue {
	index: number;
	/** 协议布局给出的区域：容器业务槽 / 玩家背包 / 未知（未知布局只读）。 */
	region: "top" | "player" | "unknown";
	item: ItemValue | null;
	display: ItemDisplay | null;
	/** 点击前态摘要（内容 + 显示文本）；null=空槽。 */
	buttonDigest: string | null;
}

export interface UiLayoutView {
	status: "known" | "partial" | "unknown";
	slotCount: number;
	regions?: { name: string; slots: number[] }[];
}

export interface UiContainerView {
	windowType: string;
	/** 网络窗口号；只作诊断，不是屏幕身份。 */
	windowId: number;
	layout: UiLayoutView;
	slots: UiSlotValue[];
	cursor: ItemValue | null;
	cursorKnown: boolean;
	properties: Record<string, number>;
}

export type UiInputType = "text" | "boolean" | "single_option" | "number_range" | "unknown";

export interface UiInput {
	key: string;
	type: UiInputType;
	label: RichText | null;
	initial: JsonValue | null;
	options?: { id: string; label: RichText | null; initial: boolean }[];
	min?: number;
	max?: number;
	step?: number;
	maxLength?: number;
	multiline?: boolean | null;
}

export interface UiButton {
	/** 观察时生成的稳定本地引用；submit_dialog 只接受它。 */
	ref: string;
	label: RichText | null;
	tooltip: RichText | null;
	/** 按钮真实关联的动作；null=解析不出（禁止伪造执行）。 */
	action: RichTextAction | null;
}

export interface UiDialogView {
	/** play / config 阶段的真实 Dialog；local = 客户端本地 show_dialog 点击动作展示的界面。 */
	phase: "play" | "config" | "local";
	type: string;
	title: RichText | null;
	body: RichText[];
	inputs: UiInput[];
	buttons: UiButton[];
	/** 能否用 Esc 关闭；null=未收到该字段。 */
	dismissible: boolean | null;
	/** 未解析的注册表条目/字段说明。 */
	unknown: string[];
}

/**
 * 当前界面投影。kind="none" 是"确实没有界面"；连接未同步时 ui@1 直接失败
 * （UNKNOWN），不把两者混成一个空值。
 */
export interface UiSnapshot {
	kind: "none" | "container" | "dialog" | "book";
	/** 当前连接+本次打开唯一；不等于网络 windowId。 */
	screenRef: string | null;
	/** 界面可见语义版本：标题/槽位/光标/Dialog 内容变化才推进。 */
	uiRevision: number;
	title: RichText | null;
	coverage: "complete" | "partial";
	unknown: string[];
	container?: UiContainerView;
	dialog?: UiDialogView;
}

export interface HudScoreLine {
	entry: string;
	score: number;
	/** 1.20.3+ 的可选显示名；null=没有单独显示名。 */
	display: RichText | null;
}

export interface HudScoreboard {
	objective: string | null;
	display: "list" | "sidebar" | "below_name" | null;
	title: RichText | null;
	lines: HudScoreLine[];
}

export interface HudBossBar {
	id: string;
	title: RichText;
	progress: number;
	color: string | null;
	overlay: string | null;
	darkenSky: boolean | null;
	createWorldFog: boolean | null;
}

export interface HudSnapshot {
	scoreboard: HudScoreboard | null;
	bossBars: HudBossBar[];
	title: RichText | null;
	subtitle: RichText | null;
	actionBar: RichText | null;
	tab: { header: RichText | null; footer: RichText | null } | null;
	/** 最近一次 HUD 变更的服务器观察时间（本机时钟）。 */
	observedAt: string;
}

/**
 * ui.act@1 的判别联合。禁止无类型裸参数：每种写操作都绑定观察前态。
 * 物品搬运语义（Shift/数字键/丢弃/热键）刻意不在其中：它属于 WindowSession 的 CAS 事务。
 */
export type UiActInput =
	| {
			kind: "click_slot";
			screenRef: string;
			uiRevision: number;
			slot: number;
			button: "left" | "right";
			buttonDigest: string;
	  }
	| {
			kind: "submit_dialog";
			screenRef: string;
			uiRevision: number;
			buttonRef: string;
			values: Record<string, JsonValue>;
	  }
	| { kind: "activate_text"; eventRef: string; actionRef: string }
	| { kind: "close"; screenRef: string; uiRevision: number }
	| { kind: "book_page"; screenRef: string; uiRevision: number; page: number };

/**
 * UI 写操作回执。完成判据与物品 CAS 分开：
 * - screen_opened/screen_closed/updated 是"观察到界面转移"，不是业务成功；
 * - sent 是包已进入连接但窗口没有可归因变化（插件只执行命令是合法情况）；
 * - unknown 是没有可归属回执，绝不自动重试。
 */
export type UiActOutcome = "screen_opened" | "screen_closed" | "updated" | "sent" | "unknown" | "unsupported";

export interface UiActReceipt {
	effect: import("./values.js").Ref;
	dispatch: "sent" | "not_sent" | "unknown";
	completion: "met" | "not_met" | "unknown";
	outcome: UiActOutcome;
	/** 写操作后的界面观察（有界：只含新界面摘要，不是整份历史）。 */
	screen: UiSnapshot | null;
	diagnostics: {
		screenRef: string;
		uiRevisionBefore: number;
		uiRevisionAfter: number;
		elapsedMs: number;
		detail: string;
	};
	evidence: import("./values.js").Ref[];
}
