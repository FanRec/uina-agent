/**
 * 富文本与物品显示解析（纯函数，无状态）。
 *
 * 唯一消费面：driver/ui/projection.ts（界面投影）与 facts 的聊天事件。
 * 事实边界：
 * - 1.21.11 文本组件在线上是 NBT（字段 snake_case：click_event / hover_event），
 *   部分插件仍写旧 JSON 字符串（camelCase clickEvent）；两种都解析，不猜第三种。
 * - 翻译键按本机 minecraft-data 语言表展开；表里没有就保留 key，不编造译文。
 * - 文本/样式/可点击动作只是服务器显示数据，不推断业务含义，也不是给 Agent 的指令。
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ItemValue } from "../../contracts/body.js";
import type { ItemDisplay, RichActionKind, RichText, RichTextAction, RichTextStyle } from "../../contracts/ui.js";
import type { JsonValue } from "../../contracts/values.js";

const require = createRequire(import.meta.url);

let languageCache: Record<string, string> | null | undefined;

/** 本机语言表（minecraft-data 1.21.11）；缺失时返回 null，调用方保留翻译键。 */
export function translations(): Record<string, string> | null {
	if (languageCache !== undefined) return languageCache;
	try {
		const dataRoot = dirname(require.resolve("minecraft-data"));
		languageCache = require(join(dataRoot, "minecraft-data", "data", "pc", "1.21.11", "language.json")) as Record<
			string,
			string
		>;
	} catch {
		languageCache = null;
	}
	return languageCache;
}

const EMPTY_STYLE: RichTextStyle = {
	color: null,
	bold: null,
	italic: null,
	underlined: null,
	strikethrough: null,
	obfuscated: null,
};

/** NBT 布尔是 byte：1/0 与 true/false 都接受；其它值如实忽略。 */
function flag(raw: unknown): boolean | null {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") return raw !== 0;
	if (typeof raw === "string") return raw === "true" ? true : raw === "false" ? false : null;
	return null;
}

function styleOf(raw: Record<string, unknown>, parent: RichTextStyle): RichTextStyle {
	const color = typeof raw.color === "string" ? raw.color : parent.color;
	return {
		color,
		bold: flag(raw.bold) ?? parent.bold,
		italic: flag(raw.italic) ?? parent.italic,
		underlined: flag(raw.underlined) ?? parent.underlined,
		strikethrough: flag(raw.strikethrough) ?? parent.strikethrough,
		obfuscated: flag(raw.obfuscated) ?? parent.obfuscated,
	};
}

const ACTION_KINDS: ReadonlySet<string> = new Set([
	"run_command",
	"suggest_command",
	"show_dialog",
	"custom",
	"open_url",
	"copy_to_clipboard",
	"change_page",
]);

function actionKind(raw: unknown): RichActionKind {
	return typeof raw === "string" && ACTION_KINDS.has(raw) ? (raw as RichActionKind) : "unknown";
}

/**
 * 点击动作：run_command/suggest_command 取 command；open_url 取 url；
 * copy_to_clipboard 取 value；change_page 取 page；show_dialog 取 dialog（内联或注册表 id）；
 * custom 取 id + payload。字段缺失时 value=null，不编造可执行内容。
 */
function clickAction(raw: unknown, ref: string): RichTextAction | null {
	if (raw == null || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	const kind = actionKind(rec.action);
	const pick = (): string | null => {
		switch (kind) {
			case "run_command":
			case "suggest_command":
				return typeof rec.command === "string" ? rec.command : null;
			case "open_url":
				return typeof rec.url === "string" ? rec.url : null;
			case "copy_to_clipboard":
				return typeof rec.value === "string" ? rec.value : null;
			case "change_page":
				return rec.page == null ? null : String(rec.page);
			case "custom":
				return typeof rec.id === "string" ? rec.id : null;
			case "show_dialog": {
				const dialog = rec.dialog;
				if (typeof dialog === "string") return dialog;
				return null;
			}
			default:
				return null;
		}
	};
	const payload =
		kind === "show_dialog" && rec.dialog != null && typeof rec.dialog === "object"
			? (rec.dialog as JsonValue)
			: kind === "custom" && rec.payload != null
				? // custom 的载荷可能是 compound，也可能是一个标量标签（adventure 的 custom(key, snbt)）；
					// 原样保留，编码时按 typed 标签处理，不替服务器改写。
					(rec.payload as JsonValue)
				: null;
	return { ref, kind, value: pick(), payload };
}

/**
 * DialogAction 的 static 形态：1.21.11 直接内联 ClickEvent，字段是 `type`（不是 `action`）。
 * 真服实测 `{type:"minecraft:run_command", command:"/uina_say dialog-close"}`；
 * 不是 `{type:"minecraft:static", action:{...}}`，按后者解析会让按钮动作整个丢失。
 */
export function clickEventAction(raw: unknown, ref: string): RichTextAction | null {
	if (raw == null || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.type !== "string") return null;
	const kind = rec.type.replace(/^minecraft:/, "");
	if (!ACTION_KINDS.has(kind)) return null;
	return clickAction({ ...rec, action: kind }, ref);
}

/** 旧版 § 颜色/样式串：切成带样式的文本片段（不解析 JSON，不猜语义）。 */
const LEGACY_CODES: Record<string, Partial<RichTextStyle>> = {
	"0": { color: "black" },
	"1": { color: "dark_blue" },
	"2": { color: "dark_green" },
	"3": { color: "dark_aqua" },
	"4": { color: "dark_red" },
	"5": { color: "dark_purple" },
	"6": { color: "gold" },
	"7": { color: "gray" },
	"8": { color: "dark_gray" },
	"9": { color: "blue" },
	a: { color: "green" },
	b: { color: "aqua" },
	c: { color: "red" },
	d: { color: "light_purple" },
	e: { color: "yellow" },
	f: { color: "white" },
	l: { bold: true },
	o: { italic: true },
	n: { underlined: true },
	m: { strikethrough: true },
	k: { obfuscated: true },
	r: {},
};

/** § 文本没有可点击动作，refPrefix 只为与 parseComponent 的签名保持一致（不使用）。 */
export function parseLegacyText(text: string, _refPrefix: string): RichText {
	const children: RichText[] = [];
	let style: RichTextStyle = { ...EMPTY_STYLE };
	let buffer = "";
	const flush = () => {
		if (buffer.length === 0) return;
		children.push({
			text: buffer,
			translate: null,
			style: { ...style },
			actions: [],
			children: [],
		});
		buffer = "";
	};
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char !== "§" || i + 1 >= text.length) {
			buffer += char;
			continue;
		}
		const code = text[++i].toLowerCase();
		const patch = LEGACY_CODES[code];
		if (patch === undefined) {
			buffer += `§${text[i]}`;
			continue;
		}
		flush();
		style = { ...style, ...patch };
	}
	flush();
	if (children.length === 0)
		children.push({ text: "", translate: null, style: { ...EMPTY_STYLE }, actions: [], children: [] });
	return {
		text: children.map((child) => child.text).join(""),
		translate: null,
		style: { ...EMPTY_STYLE },
		actions: [],
		children,
	};
}

/**
 * prismarine-nbt typed 形态 {type, value}：物品组件（custom_name / lore）与部分数据包里的
 * 文本组件都以它到达，真服实测 custom_name = {type:"compound", value:{text:{type:"string", value:"..."}}}。
 *
 * 只在"这个对象整体就是一个 NBT 标签"时解包（键只有 type/name/value），
 * 避免把本身带 type 字段的业务对象（Dialog 的 type、click_event 的 action）误当标签。
 */
function unwrapTag(raw: unknown): unknown {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const rec = raw as { type?: unknown; value?: unknown };
	if (typeof rec.type !== "string" || !("value" in rec)) return raw;
	for (const key of Object.keys(rec)) {
		if (key !== "type" && key !== "name" && key !== "value") return raw;
	}
	switch (rec.type) {
		case "compound": {
			const value = rec.value;
			if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
			const out: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = unwrapTag(entry);
			return out;
		}
		case "list": {
			const list = rec.value as { value?: unknown } | undefined;
			return Array.isArray(list?.value) ? list.value.map(unwrapTag) : null;
		}
		case "byteArray":
		case "intArray":
		case "longArray":
		case "end":
			return null;
		default:
			return rec.value;
	}
}

/**
 * 解析一个文本组件节点。refPrefix 决定 actionRef 命名空间：
 * 同一事件/界面内稳定，跨连接/跨观察不复用（上层在失效时丢弃旧引用）。
 */
export function parseComponent(raw: unknown, refPrefix: string, parent: RichTextStyle = EMPTY_STYLE): RichText | null {
	raw = unwrapTag(raw);
	if (raw == null) return null;
	if (typeof raw === "number" || typeof raw === "boolean") {
		const text = String(raw);
		return { text, translate: null, style: { ...parent }, actions: [], children: [] };
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return parseComponent(JSON.parse(trimmed) as unknown, refPrefix, parent);
			} catch {
				// 不是 JSON：按旧版 § 文本处理，不把坏 JSON 当结构。
			}
		}
		return parseLegacyText(raw, refPrefix);
	}
	if (Array.isArray(raw)) {
		const children = raw
			.map((entry) => parseComponent(entry, refPrefix, parent))
			.filter((v): v is RichText => v != null);
		return {
			text: children.map((child) => child.text).join(""),
			translate: null,
			style: { ...parent },
			actions: [],
			children,
		};
	}
	if (typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	const style = styleOf(rec, parent);
	const actions: RichTextAction[] = [];
	const click = rec.click_event ?? rec.clickEvent;
	if (click != null) {
		const action = clickAction(click, `${refPrefix}/a${actions.length}`);
		if (action != null) actions.push(action);
	}
	let text = "";
	let translate: string | null = null;
	if (typeof rec.text === "string") {
		text = rec.text;
	} else if (typeof rec.translate === "string") {
		translate = rec.translate;
		const table = translations();
		const args = Array.isArray(rec.with) ? rec.with : [];
		const rendered = args.map((entry) => parseComponent(entry, `${refPrefix}/w`, style)?.text ?? "");
		const template = table?.[translate] ?? null;
		if (template != null) {
			// 先处理 %1$s 形式，再按顺序填 %s；参数不足保留占位符（不编造）。
			let index = 0;
			text = template
				.replace(/%(\d+)\$s/g, (_m, n: string) => rendered[Number(n) - 1] ?? _m)
				.replace(/%s/g, (m) => (index < rendered.length ? rendered[index++] : m));
		} else {
			text = translate;
		}
	} else if (typeof rec.keybind === "string") {
		text = rec.keybind;
	} else if (typeof rec.selector === "string") {
		text = rec.selector;
	} else if (rec.score != null && typeof rec.score === "object") {
		const score = rec.score as { name?: unknown; objective?: unknown };
		text = `${String(score.name ?? "?")}:${String(score.objective ?? "?")}`;
	}
	const children: RichText[] = [];
	const extra = rec.extra;
	if (Array.isArray(extra)) {
		for (const entry of extra) {
			const child = parseComponent(entry, `${refPrefix}/e${children.length}`, style);
			if (child != null) children.push(child);
		}
	}
	for (const child of children) actions.push(...child.actions);
	const plain = text + children.map((child) => child.text).join("");
	return { text: plain, translate, style, actions, children };
}

function componentList(raw: unknown): unknown[] | null {
	if (Array.isArray(raw)) return raw;
	if (raw != null && typeof raw === "object") {
		const rec = raw as { value?: unknown };
		if (Array.isArray(rec.value)) return rec.value;
	}
	return null;
}

interface AddedComponent {
	type?: unknown;
	data?: unknown;
}

function addedComponents(item: ItemValue): AddedComponent[] {
	const components = item.components;
	if (components == null || typeof components !== "object" || Array.isArray(components)) return [];
	const added = (components as { added?: unknown }).added;
	return Array.isArray(added) ? (added as AddedComponent[]) : [];
}

function removedComponents(item: ItemValue): string[] {
	const components = item.components;
	if (components == null || typeof components !== "object" || Array.isArray(components)) return [];
	const removed = (components as { removed?: unknown }).removed;
	if (!Array.isArray(removed)) return [];
	return removed.map((entry) => (typeof entry === "string" ? entry : String((entry as { type?: unknown }).type ?? "")));
}

/**
 * 物品显示名与 Lore：只读组件，不拿物品注册名冒充自定义名。
 * 1.21.11 里 custom_name/lore 的 data 可能是 JSON 字符串、§ 文本或 NBT compound，
 * 三种都走同一个组件解析器。
 */
export function itemDisplay(item: ItemValue | null, refPrefix: string): ItemDisplay | null {
	if (item == null) return null;
	const added = addedComponents(item);
	const removed = new Set(removedComponents(item));
	const find = (type: string): unknown => {
		if (removed.has(type)) return null;
		const entry = added.find((part) => part.type === type);
		return entry?.data;
	};
	const name = parseComponent(find("custom_name"), `${refPrefix}/name`);
	const itemName = parseComponent(find("item_name"), `${refPrefix}/item`);
	const loreRaw = find("lore");
	const loreList = componentList(loreRaw);
	const lore =
		loreList == null
			? null
			: loreList
					.map((entry, index) => parseComponent(entry, `${refPrefix}/lore${index}`))
					.filter((value): value is RichText => value != null);
	return { name, lore, itemName };
}

/**
 * 槽位点击前态摘要：内容 + 显示文本 + 动作。价格/说明刷新会改变摘要，
 * 从而让旧观察的点击在派发前被拒（UI_STALE），不靠时间猜测。
 */
export function slotDigest(item: ItemValue | null, display: ItemDisplay | null): string | null {
	if (item == null) return null;
	const payload = JSON.stringify({
		name: item.name,
		count: item.count,
		components: item.components,
		display:
			display == null
				? null
				: { name: display.name?.text ?? null, lore: display.lore?.map((line) => line.text) ?? null },
	});
	return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}
