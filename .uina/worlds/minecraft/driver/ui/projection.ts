/**
 * 连接级界面投影：ConnectionWindowState → UiSnapshot / UiDialogView / HudSnapshot。
 *
 * 这是**投影**不是第二真值：所有字段都从 ConnectionWindowState 的当前观察派生，
 * 没有自己的游标、槽位缓存或可写状态。uiRevision 直接取状态里的界面修订。
 * 未知布局不抹掉界面：type/title/slots 照常可读，只是 layout.status 不是 known，
 * ui.act 会按 slot 区语义拒绝未验证的点击（见 capabilities/actions/ui.ts）。
 */

import type { ItemValue } from "../../contracts/body.js";
import type {
	HudBossBar,
	HudSnapshot,
	RichText,
	RichTextAction,
	UiButton,
	UiContainerView,
	UiDialogView,
	UiInput,
	UiSlotValue,
	UiSnapshot,
} from "../../contracts/ui.js";
import type { JsonValue } from "../../contracts/values.js";
import type { DialogState, HudState, ScreenState } from "../window/state.js";
import { clickEventAction, itemDisplay, parseComponent, slotDigest } from "./text.js";

/** 布局已知时给出区域语义；未知布局只报槽位数量（只读查看）。 */
function regionsOf(screen: ScreenState): { name: string; slots: number[] }[] | undefined {
	return screen.layout?.regions;
}

function regionOf(screen: ScreenState, index: number): "top" | "player" | "unknown" {
	const regions = regionsOf(screen);
	if (regions == null) return "unknown";
	// 只认区域里真的列出的槽号：布局之外/未覆盖的槽不冒充"上方业务区"。
	for (const region of regions) {
		if (!region.slots.includes(index)) continue;
		return region.name === "player" ? "player" : "top";
	}
	return "unknown";
}

function toItem(raw: JsonValue | null): ItemValue | null {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const rec = raw as unknown as ItemValue;
	return typeof rec.name === "string" && typeof rec.count === "number" ? rec : null;
}

export interface UiProjectionOptions {
	/** summary 只列非空槽（默认）；full 列全部槽位（受 includeEmptySlots 控制）。 */
	detail?: "summary" | "full";
	includeEmptySlots?: boolean;
	/** actionRef/digest 命名空间：同一 screenRef 内稳定。 */
	refPrefix?: string;
}

/**
 * 容器投影。槽位顺序即协议槽号；region 只来自已验证布局。
 * display 与 digest 都按当前内容计算：价格/Lore 改变会让旧 digest 失配。
 */
export function projectContainer(screen: ScreenState, options: UiProjectionOptions = {}): UiContainerView {
	const prefix = options.refPrefix ?? screen.screenRef;
	const includeEmpty = options.includeEmptySlots === true || options.detail === "full";
	const slots: UiSlotValue[] = [];
	const limit = Math.max(screen.slotCount, screen.slots.length);
	for (let index = 0; index < limit; index++) {
		const item = toItem(screen.slots[index] ?? null);
		if (item == null && !includeEmpty) continue;
		const display = itemDisplay(item, `${prefix}/s${index}`);
		slots.push({
			index,
			region: regionOf(screen, index),
			item,
			display,
			buttonDigest: slotDigest(item, display),
		});
	}
	return {
		windowType: screen.type ?? `window_type_${screen.windowType ?? "unknown"}`,
		windowId: screen.windowId,
		layout: {
			status: screen.layoutStatus,
			slotCount: screen.slotCount,
			...(screen.layout == null ? {} : { regions: screen.layout.regions }),
		},
		slots,
		cursor: toItem(screen.cursor),
		cursorKnown: screen.cursorKnown,
		properties: { ...screen.properties },
	};
}

function asRecord(raw: JsonValue | null): Record<string, JsonValue> | null {
	return raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JsonValue>) : null;
}

function asArray(raw: JsonValue | undefined): JsonValue[] {
	return Array.isArray(raw) ? raw : [];
}

/** 按钮/输入可能缺席（undefined）或显式 null；两者都按"没有"处理。 */
function asOptionalRecord(raw: JsonValue | undefined): Record<string, JsonValue> | null {
	return asRecord(raw ?? null);
}

/** 注册表条目包装 {key,value} 与内联 NBT 都解到同一层。 */
function unwrapRegistryEntry(raw: JsonValue | null): JsonValue | null {
	const rec = asRecord(raw);
	if (rec != null && typeof rec.key === "string" && "value" in rec) return rec.value ?? null;
	return raw;
}

/**
 * DialogAction → 可执行动作。只认真实编码（1.21.11 真服实测）：
 * - `minecraft:dynamic/run_command`（模板，提交时按输入展开）
 * - `minecraft:dynamic/custom`（提交时把输入写进 NBT）
 * - 其余已知种类是 **内联的 ClickEvent**：`{type:"minecraft:run_command", command:...}`，
 *   注意不是 `{type:"minecraft:static", action:{...}}`——按后者解析会让按钮动作整个丢失。
 * 其他类型如实 unknown，不降格成 /command。
 */
export interface ParsedDialogAction {
	kind: "static" | "dynamic_command" | "dynamic_custom" | "unknown";
	/** static 的 click event 解析结果。 */
	click: RichTextAction | null;
	/** dynamic_command 的模板。 */
	template: string | null;
	/** dynamic_custom 的通道 ID 与附加 NBT。 */
	id: string | null;
	additions: JsonValue | null;
	raw: JsonValue | null;
}

export function parseDialogAction(raw: JsonValue | null, ref: string): ParsedDialogAction {
	const rec = asRecord(raw);
	if (rec == null) return { kind: "unknown", click: null, template: null, id: null, additions: null, raw };
	const type = typeof rec.type === "string" ? rec.type : "";
	if (type === "minecraft:dynamic/run_command" || type === "dynamic/run_command") {
		return {
			kind: "dynamic_command",
			click: null,
			template: typeof rec.template === "string" ? rec.template : null,
			id: null,
			additions: null,
			raw,
		};
	}
	if (type === "minecraft:dynamic/custom" || type === "dynamic/custom") {
		return {
			kind: "dynamic_custom",
			click: null,
			template: null,
			id: typeof rec.id === "string" ? rec.id : null,
			additions: rec.additions ?? null,
			raw,
		};
	}
	const click = clickEventAction(rec, ref);
	if (click != null) return { kind: "static", click, template: null, id: null, additions: null, raw };
	return { kind: "unknown", click: null, template: null, id: null, additions: null, raw };
}

export interface ParsedDialogButton {
	ref: string;
	label: RichText | null;
	tooltip: RichText | null;
	action: ParsedDialogAction;
	/** 供投影展示的简化动作（静态 click 或模板/id 摘要）。 */
	view: RichTextAction | null;
}

export interface ParsedDialogInput {
	key: string;
	type: UiInput["type"];
	label: RichText | null;
	initial: JsonValue | null;
	options: { id: string; label: RichText | null; initial: boolean }[];
	min: number | null;
	max: number | null;
	step: number | null;
	maxLength: number | null;
	multiline: boolean | null;
}

export interface ParsedDialog {
	type: string;
	title: RichText | null;
	body: RichText[];
	inputs: ParsedDialogInput[];
	buttons: ParsedDialogButton[];
	dismissible: boolean | null;
	unknown: string[];
	raw: JsonValue | null;
}

function inputTypeOf(raw: string): UiInput["type"] {
	const type = raw.replace(/^minecraft:/, "");
	if (type === "text" || type === "boolean" || type === "single_option" || type === "number_range") return type;
	return "unknown";
}

/**
 * Dialog 解析（内联 NBT 或注册表条目；config/play 共用同一解析器）。
 * 字段名按 1.21.11 编码：type/title/body/inputs/can_close_with_escape/yes/no/actions/action。
 * 解不出的按钮不虚构：只保留 label，action=unknown。
 */
export function parseDialog(raw: JsonValue | null, refPrefix: string, unknown: string[] = []): ParsedDialog {
	const rec = asRecord(unwrapRegistryEntry(raw));
	if (rec == null) {
		unknown.push("dialog payload is not a compound");
		return { type: "unknown", title: null, body: [], inputs: [], buttons: [], dismissible: null, unknown, raw };
	}
	const type = typeof rec.type === "string" ? rec.type : "unknown";
	const title = parseComponent(rec.title, `${refPrefix}/title`);
	// body 是 Either<List<DialogBody>, DialogBody>：单个 body 时线上是裸 compound，不是单元素数组。
	const bodyEntries = Array.isArray(rec.body) ? rec.body : rec.body == null ? [] : [rec.body];
	const body: RichText[] = [];
	for (const [index, entry] of bodyEntries.entries()) {
		const bodyRec = asRecord(entry);
		if (bodyRec == null) continue;
		const bodyType = typeof bodyRec.type === "string" ? bodyRec.type : "";
		if (bodyType === "minecraft:plain_message" || bodyType === "plain_message") {
			const parsed = parseComponent(bodyRec.contents, `${refPrefix}/body${index}`);
			if (parsed != null) body.push(parsed);
		} else if (bodyType === "minecraft:item" || bodyType === "item") {
			const description = parseComponent(bodyRec.description, `${refPrefix}/body${index}`);
			if (description != null) body.push(description);
		} else unknown.push(`dialog body[${index}] type ${bodyType || "missing"} is not rendered`);
	}
	const inputs: ParsedDialogInput[] = [];
	for (const [index, entry] of asArray(rec.inputs).entries()) {
		const input = asRecord(entry);
		if (input == null || typeof input.key !== "string") {
			unknown.push(`dialog input[${index}] has no key`);
			continue;
		}
		const inputType = inputTypeOf(typeof input.type === "string" ? input.type : "");
		const options: { id: string; label: RichText | null; initial: boolean }[] = [];
		for (const [optionIndex, option] of asArray(input.options).entries()) {
			const optionRec = asRecord(option);
			if (optionRec == null || typeof optionRec.id !== "string") continue;
			options.push({
				id: optionRec.id,
				label: parseComponent(optionRec.display ?? optionRec.label, `${refPrefix}/in${index}o${optionIndex}`),
				initial: optionRec.initial === true,
			});
		}
		const number = (value: JsonValue | undefined): number | null => (typeof value === "number" ? value : null);
		inputs.push({
			key: input.key,
			type: inputType,
			label: parseComponent(input.label, `${refPrefix}/in${index}`),
			initial: input.initial ?? null,
			options,
			min: number(input.start),
			max: number(input.end),
			step: number(input.step),
			maxLength: number(input.max_length),
			multiline: typeof input.multiline === "object" && input.multiline != null ? true : null,
		});
		if (inputType === "unknown") unknown.push(`dialog input ${input.key} type is not supported`);
	}
	const buttons: ParsedDialogButton[] = [];
	const addButton = (entry: JsonValue | undefined, fallbackRef: string) => {
		const buttonRec = asOptionalRecord(entry);
		if (buttonRec == null) return;
		const ref = `${refPrefix}/b${buttons.length}`;
		const action = parseDialogAction(buttonRec.action ?? null, ref);
		const view: RichTextAction | null =
			action.click ??
			(action.kind === "dynamic_command" && action.template != null
				? { ref, kind: "run_command", value: action.template, payload: null }
				: action.kind === "dynamic_custom" && action.id != null
					? { ref, kind: "custom", value: action.id, payload: action.additions }
					: null);
		buttons.push({
			ref,
			label: parseComponent(buttonRec.label, `${ref}/label`) ?? parseComponent(fallbackRef, `${ref}/fallback`),
			tooltip: parseComponent(buttonRec.tooltip, `${ref}/tooltip`),
			action,
			view,
		});
	};
	for (const entry of asArray(rec.actions)) addButton(entry, "gui.ok");
	addButton(rec.yes ?? rec.yes_button, "gui.yes");
	addButton(rec.no ?? rec.no_button, "gui.no");
	addButton(rec.action, "gui.ok");
	addButton(rec.exit_action, "gui.back");
	if (buttons.length === 0 && type !== "minecraft:dialog_list" && type !== "minecraft:server_links")
		unknown.push("dialog exposes no executable buttons");
	return {
		type,
		title,
		body,
		inputs,
		buttons,
		dismissible: typeof rec.can_close_with_escape === "boolean" ? rec.can_close_with_escape : null,
		unknown,
		raw,
	};
}

export function projectDialog(dialog: DialogState, data: JsonValue | null, refPrefix: string): UiDialogView {
	const parsed = parseDialog(data, refPrefix);
	return {
		phase: dialog.phase,
		type: parsed.type,
		title: parsed.title,
		body: parsed.body,
		inputs: parsed.inputs.map((input) => ({
			key: input.key,
			type: input.type,
			label: input.label,
			initial: input.initial,
			...(input.options.length > 0 ? { options: input.options } : {}),
			...(input.min == null ? {} : { min: input.min }),
			...(input.max == null ? {} : { max: input.max }),
			...(input.step == null ? {} : { step: input.step }),
			...(input.maxLength == null ? {} : { maxLength: input.maxLength }),
			multiline: input.multiline,
		})),
		buttons: parsed.buttons.map(
			(button): UiButton => ({ ref: button.ref, label: button.label, tooltip: button.tooltip, action: button.view }),
		),
		dismissible: parsed.dismissible,
		unknown: parsed.unknown,
	};
}

export interface UiProjectionInput {
	screen: ScreenState | null;
	dialog: DialogState | null;
	dialogData: JsonValue | null;
	options?: UiProjectionOptions;
}

/**
 * 顶层可交互界面：Dialog 叠在窗口之上时优先返回 Dialog（当前 activeUi 是顶层）。
 * 两者都没有 → kind="none"（明确没有界面，不是"未知"）。
 */
export function projectUi(input: UiProjectionInput): UiSnapshot {
	const options = input.options ?? {};
	if (input.dialog != null) {
		const dialog = projectDialog(input.dialog, input.dialogData, input.dialog.dialogRef);
		return {
			kind: "dialog",
			screenRef: input.dialog.dialogRef,
			uiRevision: input.dialog.uiRevision,
			title: dialog.title,
			coverage: dialog.unknown.length === 0 ? "complete" : "partial",
			unknown: [...dialog.unknown],
			dialog,
		};
	}
	const screen = input.screen;
	if (screen == null) {
		return { kind: "none", screenRef: null, uiRevision: 0, title: null, coverage: "complete", unknown: [] };
	}
	const container = projectContainer(screen, { ...options, refPrefix: options.refPrefix ?? screen.screenRef });
	const unknown: string[] = [];
	if (!screen.synchronized) unknown.push("window slots have not been fully synchronized by the server");
	if (screen.layoutStatus !== "known") unknown.push("window layout is not verified for item transfer");
	if (!screen.cursorKnown) unknown.push("cursor state has not been reported");
	const title = parseComponent(screen.title, `${screen.screenRef}/title`);
	return {
		kind: "container",
		screenRef: screen.screenRef,
		uiRevision: screen.uiRevision,
		title,
		coverage: unknown.length === 0 ? "complete" : "partial",
		unknown,
		container,
	};
}

const BOSS_COLORS = ["pink", "blue", "red", "green", "yellow", "purple", "white"];
const BOSS_OVERLAYS = ["progress", "notched_6", "notched_10", "notched_12", "notched_20"];

export function projectHud(hud: HudState): HudSnapshot | null {
	const observed = hud.observedAt;
	const hasAnything =
		hud.objectives.size > 0 ||
		hud.scores.size > 0 ||
		hud.bossBars.size > 0 ||
		hud.title != null ||
		hud.subtitle != null ||
		hud.actionBar != null ||
		hud.tab != null;
	if (!hasAnything) return null;
	const objectiveName = hud.display?.objective ?? null;
	const objective = objectiveName == null ? null : (hud.objectives.get(objectiveName) ?? null);
	const lines =
		objectiveName == null
			? []
			: [...hud.scores.values()]
					.filter((entry) => entry.objective === objectiveName)
					.sort((a, b) => b.value - a.value || a.entry.localeCompare(b.entry))
					.map((entry) => ({
						entry: entry.entry,
						score: entry.value,
						display: parseComponent(entry.display, `hud:score:${entry.objective}:${entry.entry}`),
					}));
	const bossBars: HudBossBar[] = [...hud.bossBars.values()].map((bar) => ({
		id: bar.id,
		title: parseComponent(bar.title, `hud:boss:${bar.id}`) ?? {
			text: "",
			translate: null,
			style: { color: null, bold: null, italic: null, underlined: null, strikethrough: null, obfuscated: null },
			actions: [],
			children: [],
		},
		progress: bar.progress,
		color: bar.color == null ? null : (BOSS_COLORS[bar.color] ?? String(bar.color)),
		overlay: bar.overlay == null ? null : (BOSS_OVERLAYS[bar.overlay] ?? String(bar.overlay)),
		darkenSky: bar.darkenSky,
		createWorldFog: bar.createFog,
	}));
	return {
		scoreboard:
			objectiveName == null
				? null
				: {
						objective: objectiveName,
						display:
							hud.display?.position === 0
								? "list"
								: hud.display?.position === 1
									? "sidebar"
									: hud.display?.position === 2
										? "below_name"
										: null,
						title: parseComponent(objective?.title ?? null, `hud:objective:${objectiveName}`),
						lines,
					},
		bossBars,
		title: parseComponent(hud.title, "hud:title"),
		subtitle: parseComponent(hud.subtitle, "hud:subtitle"),
		actionBar: parseComponent(hud.actionBar, "hud:actionbar"),
		tab:
			hud.tab == null
				? null
				: {
						header: parseComponent(hud.tab.header, "hud:tab:header"),
						footer: parseComponent(hud.tab.footer, "hud:tab:footer"),
					},
		observedAt: observed,
	};
}
