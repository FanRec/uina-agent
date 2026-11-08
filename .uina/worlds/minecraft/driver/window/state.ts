/**
 * 连接级唯一窗口/界面状态（ConnectionWindowState）。
 *
 * 唯一真值：服务器当前报告的窗口、Dialog、HUD 与配置阶段交互。
 * 消费方：
 * - driver/window/session.ts 的物品事务从这里读槽位/光标（不再自己维护第二份镜像）；
 * - driver/ui/projection.ts 投影成 ui@1 的 UiSnapshot；
 * - driver/facts 的 ui/hud 采样与有界事件。
 *
 * 生命周期与 Connection 一致：protocol 实例（每个 bot 一个）创建它，end 时清空。
 * 窗口身份不以网络 windowId 为真值（服务端会复用）：screenRef 在原始 open_window
 * 时创建，window_items 只按当前屏幕的 windowId 归并；旧屏幕的迟到包一律丢弃。
 */

import type { RichTextAction } from "../../contracts/ui.js";
import type { JsonValue } from "../../contracts/values.js";
import type { NativeWindow, ProtocolNotice } from "../mineflayer/protocol.js";
import { type WindowLayout, windowLayout } from "./layout.js";

export interface ScreenState {
	/** 当前连接 + 本次打开唯一；不是网络 windowId。 */
	screenRef: string;
	windowId: number;
	/** 协议 inventoryType id（原始 open_window）；native 到达后另有类型名。 */
	windowType: number | null;
	/** 窗口类型名（mineflayer native window.type），未到达时为 null。 */
	type: string | null;
	/** 标题文本组件（原始 NBT 已解成纯 JSON）；没有标题时为 null。 */
	title: JsonValue | null;
	native: NativeWindow | null;
	layout: WindowLayout | null;
	layoutStatus: "known" | "partial" | "unknown";
	slotCount: number;
	inventoryStart: number | null;
	inventoryEnd: number | null;
	slots: (JsonValue | null)[];
	cursor: JsonValue | null;
	/** 光标是否已被服务端报告过（false 时 cursor=null 只是"没收到"）。 */
	cursorKnown: boolean;
	properties: Record<string, number>;
	serverStateId: number | null;
	/** 内容（槽位/光标/类型/布局）修订：物品 CAS 的前置条件。 */
	contentRevision: number;
	/** 界面可见语义修订：标题/槽位/光标/Dialog 变化；按钮点击的过期判据。 */
	uiRevision: number;
	/** 收到的权威 full 包数量；用于把回执归因到某次点击。 */
	fullSequence: number;
	/** 已收到至少一次完整槽位同步。 */
	synchronized: boolean;
	openedAt: string;
	observedAt: string;
}

export interface DialogState {
	dialogRef: string;
	phase: "play" | "config" | "local";
	/** 内联 Dialog NBT（纯 JSON）；注册表引用时为 null。 */
	data: JsonValue | null;
	/** 注册表引用序号；内联时为 null。 */
	registryId: number | null;
	uiRevision: number;
	openedAt: string;
}

export interface ConfigInteraction {
	kind: "code_of_conduct";
	ref: string;
	/** 服务器给出的原文；是否接受由用户/授权策略决定，不自动同意。 */
	contents: string;
	observedAt: string;
}

export interface ScoreboardObjective {
	name: string;
	title: JsonValue | null;
}

export interface ScoreEntry {
	entry: string;
	objective: string;
	value: number;
	display: JsonValue | null;
}

export interface BossBarState {
	id: string;
	title: JsonValue | null;
	progress: number;
	color: number | null;
	overlay: number | null;
	darkenSky: boolean | null;
	createFog: boolean | null;
}

export interface HudState {
	objectives: Map<string, ScoreboardObjective>;
	display: { position: number; objective: string } | null;
	scores: Map<string, ScoreEntry>;
	bossBars: Map<string, BossBarState>;
	title: JsonValue | null;
	subtitle: JsonValue | null;
	actionBar: JsonValue | null;
	tab: { header: JsonValue | null; footer: JsonValue | null } | null;
	observedAt: string;
}

export type ConnectionUiNotice =
	| { kind: "screen"; action: "opened" | "closed" | "updated"; screen: ScreenState | null }
	| { kind: "dialog"; action: "opened" | "closed" | "updated"; dialog: DialogState | null }
	| { kind: "config"; interaction: ConfigInteraction | null }
	| { kind: "hud" };

const MAX_REGISTRY_ENTRIES = 512;
/** 文本动作登记的保留窗口：只服务于"刚看到的那条消息/那个界面"，不做历史。 */
const MAX_TEXT_ACTION_EVENTS = 128;

/** 每个连接（DriverProtocol 实例）一份；bot 重建即新连接，旧状态随 WeakMap 释放。 */
const states = new WeakMap<object, ConnectionWindowState>();
let namespaceSerial = 0;

export function windowStateFor(protocol: {
	subscribe(listener: (notice: ProtocolNotice) => void): () => void;
}): ConnectionWindowState {
	let state = states.get(protocol);
	if (state == null) {
		namespaceSerial += 1;
		state = new ConnectionWindowState((listener) => protocol.subscribe(listener), `ui${namespaceSerial}`);
		states.set(protocol, state);
	}
	return state;
}

function nowIso(): string {
	return new Date().toISOString();
}

function emptyHud(): HudState {
	return {
		objectives: new Map(),
		display: null,
		scores: new Map(),
		bossBars: new Map(),
		title: null,
		subtitle: null,
		actionBar: null,
		tab: null,
		observedAt: nowIso(),
	};
}

/** 布局判定：已知表严格匹配；普通容器要求业务槽+36 玩家槽；其余只读为 unknown。 */
function resolveLayout(native: NativeWindow | null): {
	layout: WindowLayout | null;
	status: "known" | "partial" | "unknown";
	slotCount: number;
} {
	if (native == null) return { layout: null, status: "unknown", slotCount: 0 };
	const slotCount = native.slots.length;
	const result = windowLayout(String(native.type), slotCount, native.inventoryStart, native.inventoryEnd);
	if (!("reason" in result)) return { layout: result.layout, status: "known", slotCount };
	// 有业务槽 + 36 玩家槽的形状仍然可以按"只读部分布局"查看（区域未知）。
	const playerShaped =
		native.inventoryStart > 0 && native.inventoryEnd === slotCount && slotCount - native.inventoryStart === 36;
	return { layout: null, status: playerShaped ? "partial" : "unknown", slotCount };
}

export class ConnectionWindowState {
	private screenState: ScreenState | null = null;
	private dialogState: DialogState | null = null;
	private configState: ConfigInteraction | null = null;
	private hudState: HudState = emptyHud();
	private readonly listeners = new Set<(notice: ConnectionUiNotice) => void>();
	private readonly dialogRegistry = new Map<number, JsonValue>();
	/**
	 * 已观察到的文本动作（聊天富文本 / Dialog 正文）：eventRef → actions。
	 * ui.act 的 activate_text 只按这里登记过的 ref 执行，模型不能自己拼动作；
	 * 有界 FIFO，超出即淘汰最旧的事件（旧观察本来就会因 UI_STALE 失效）。
	 */
	private readonly textActions = new Map<string, { actions: RichTextAction[]; at: number }>();
	private readonly textActionOrder: string[] = [];
	private screenSerial = 0;
	private dialogSerial = 0;
	private readonly detach: (() => void)[];

	constructor(
		private readonly subscribeProtocol: (listener: (notice: ProtocolNotice) => void) => () => void,
		private readonly namespace: string,
	) {
		this.detach = [this.subscribeProtocol((notice) => this.onNotice(notice))];
	}

	screen(): ScreenState | null {
		return this.screenState;
	}

	dialog(): DialogState | null {
		return this.dialogState;
	}

	/** 当前 Dialog 的实际内容：内联 NBT 或按注册表序号解析；两者都没有时为 null。 */
	dialogData(): JsonValue | null {
		const dialog = this.dialogState;
		if (dialog == null) return null;
		if (dialog.data != null) return dialog.data;
		if (dialog.registryId != null) return this.registryDialog(dialog.registryId);
		return null;
	}

	config(): ConfigInteraction | null {
		return this.configState;
	}

	hud(): HudState {
		return this.hudState;
	}

	/** 当前界面（窗口优先，其次 Dialog）的 uiRevision；都没有时为 0。 */
	uiRevision(): number {
		return this.dialogState?.uiRevision ?? this.screenState?.uiRevision ?? 0;
	}

	subscribe(listener: (notice: ConnectionUiNotice) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 注册表 Dialog 条目（配置阶段 registry_data 的 dialog 注册表，按序号索引）。 */
	registryDialog(id: number): JsonValue | null {
		return this.dialogRegistry.get(id) ?? null;
	}

	/**
	 * 登记一次观察到的文本动作集合（聊天富文本 / Dialog 正文）。
	 * eventRef 是这次观察的引用；activate_text 只执行登记过的动作，不接受自造参数。
	 */
	registerTextActions(eventRef: string, actions: readonly RichTextAction[]): void {
		if (actions.length === 0) return;
		// 同一 eventRef 重复登记（重读同一条消息）只刷新内容，不重复占队位：
		// 否则淘汰会先删掉刚登记的这一条。
		if (!this.textActions.has(eventRef)) this.textActionOrder.push(eventRef);
		this.textActions.set(eventRef, { actions: [...actions], at: Date.now() });
		while (this.textActionOrder.length > MAX_TEXT_ACTION_EVENTS) {
			const oldest = this.textActionOrder.shift();
			if (oldest != null) this.textActions.delete(oldest);
		}
	}

	textAction(eventRef: string, actionRef: string): RichTextAction | null {
		return this.textActions.get(eventRef)?.actions.find((action) => action.ref === actionRef) ?? null;
	}

	/**
	 * 客户端本地 Dialog（聊天 show_dialog 点击动作）：只影响本地显示，
	 * 不冒充服务器主动发送；按钮提交仍走真实动作编码。
	 */
	openLocalDialog(data: JsonValue | null): DialogState {
		// 客户端一次只显示一个界面：对话框取代当前容器屏，旧窗口不再可读可点。
		const baseRevision = Math.max(this.dialogState?.uiRevision ?? 0, this.screenState?.uiRevision ?? 0);
		if (this.screenState != null) {
			this.screenState = null;
			this.emit({ kind: "screen", action: "closed", screen: null });
		}
		const dialog: DialogState = {
			dialogRef: this.nextDialogRef("local"),
			phase: "local",
			data,
			registryId: null,
			uiRevision: baseRevision + 1,
			openedAt: nowIso(),
		};
		this.dialogState = dialog;
		this.emit({ kind: "dialog", action: "opened", dialog });
		return dialog;
	}

	clearLocalDialog(): void {
		if (this.dialogState?.phase !== "local") return;
		this.dialogState = null;
		this.emit({ kind: "dialog", action: "closed", dialog: null });
	}

	close(): void {
		for (const detach of this.detach.splice(0)) detach();
		this.listeners.clear();
		this.screenState = null;
		this.dialogState = null;
		this.configState = null;
		this.dialogRegistry.clear();
		this.textActions.clear();
		this.textActionOrder.length = 0;
	}

	private nextScreenRef(): string {
		this.screenSerial += 1;
		return `screen:${this.namespace}:${this.screenSerial}`;
	}

	private nextDialogRef(phase: "play" | "config" | "local"): string {
		this.dialogSerial += 1;
		return `dialog:${this.namespace}:${phase}:${this.dialogSerial}`;
	}

	private emit(notice: ConnectionUiNotice): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(notice);
			} catch {
				// 观察者异常不能打断协议处理。
			}
		}
	}

	private onNotice(notice: ProtocolNotice): void {
		switch (notice.kind) {
			case "open_window":
				this.onOpenWindow(notice);
				return;
			case "window_open":
				this.onNativeWindow(notice.window);
				return;
			case "full":
				this.onFull(notice);
				return;
			case "slot":
				this.onSlot(notice);
				return;
			case "cursor":
				this.onCursor(notice.item);
				return;
			case "player_slot":
				// 玩家背包区变化会改变窗口玩家区的可见内容（native window 由上游同步）。
				this.onPlayerSlot(notice.slot, notice.item);
				return;
			case "property":
				this.onProperty(notice);
				return;
			case "window_close":
				this.onWindowClose(notice.window);
				return;
			case "end":
				this.onEnd();
				return;
			case "dialog":
				this.onDialog(notice);
				return;
			case "dialog_clear":
				this.onDialogClear(notice.phase);
				return;
			case "code_of_conduct":
				this.onCodeOfConduct(notice.contents);
				return;
			case "registry_data":
				this.onRegistry(notice);
				return;
			case "objective":
			case "score":
			case "score_reset":
			case "score_display":
			case "boss_bar":
			case "title_text":
			case "titles_clear":
			case "tab_header":
				this.onHud(notice);
				return;
			default:
				return;
		}
	}

	/**
	 * 原始 open_window：**不一定**是第一条到达的包。
	 * mineflayer 的 open_window 处理器先于本模块注册，会同步发 windowOpen，
	 * 因此常态是 native 先建档、这里补标题与协议窗口类型（同一 windowId 只补不重建）。
	 */
	private onOpenWindow(notice: Extract<ProtocolNotice, { kind: "open_window" }>): void {
		const existing = this.screenState;
		if (existing != null && existing.windowId === notice.windowId && existing.windowType === null) {
			existing.windowType = notice.windowType;
			if (notice.title != null) existing.title = notice.title;
			if (notice.horse) existing.type = "minecraft:horse";
			if (notice.slotCount != null && existing.slotCount === 0) existing.slotCount = notice.slotCount;
			existing.observedAt = nowIso();
			existing.uiRevision += 1;
			this.emit({ kind: "screen", action: "updated", screen: existing });
			return;
		}
		if (existing != null && existing.windowId === notice.windowId) {
			// 已补齐过类型：重复的 open_window 不产生新的界面身份。
			if (notice.title != null && existing.title == null) {
				existing.title = notice.title;
				existing.uiRevision += 1;
				this.emit({ kind: "screen", action: "updated", screen: existing });
			}
			return;
		}
		this.replaceScreen({
			windowId: notice.windowId,
			windowType: notice.windowType,
			type: notice.horse ? "minecraft:horse" : null,
			title: notice.title,
			native: null,
			slotCount: notice.slotCount ?? 0,
		});
	}

	/** native 窗口身份：mineflayer 建好窗口就发；没有 open_window 也能独立建档（标题稍后补）。 */
	private onNativeWindow(window: NativeWindow): void {
		const current = this.screenState;
		if (current == null || current.windowId !== window.id) {
			this.replaceScreen({
				windowId: window.id,
				windowType: null,
				type: String(window.type),
				title: null,
				native: window,
				slotCount: window.slots.length,
			});
			return;
		}
		const resolved = resolveLayout(window);
		current.native = window;
		current.type = String(window.type);
		current.layout = resolved.layout;
		current.layoutStatus = resolved.status;
		current.slotCount = resolved.slotCount;
		current.inventoryStart = window.inventoryStart ?? null;
		current.inventoryEnd = window.inventoryEnd ?? null;
		current.observedAt = nowIso();
		current.uiRevision += 1;
		this.emit({ kind: "screen", action: "updated", screen: current });
	}

	/** 新屏幕身份：旧屏幕先发 closed，再发 opened（订阅方按 screenRef 判代次）。 */
	private replaceScreen(seed: {
		windowId: number;
		windowType: number | null;
		type: string | null;
		title: JsonValue | null;
		native: NativeWindow | null;
		slotCount: number;
	}): void {
		const previous = this.screenState;
		// 修订号跨界面单调：被取代的可能是 Dialog（它的 revision 更高），不能从 0 重新开始，
		// 否则旧观察的 revision 会"看起来更新"。与 openLocalDialog 用同一口径。
		const baseRevision = Math.max(previous?.uiRevision ?? 0, this.dialogState?.uiRevision ?? 0);
		// 容器屏取代任何当前显示的对话框：两者不可能同时可见，状态里也只留一个。
		this.clearLocalDialog();
		if (previous != null) {
			this.screenState = null;
			this.emit({ kind: "screen", action: "closed", screen: null });
		}
		const resolved = seed.native == null ? null : resolveLayout(seed.native);
		const screen: ScreenState = {
			screenRef: this.nextScreenRef(),
			windowId: seed.windowId,
			windowType: seed.windowType,
			type: seed.type,
			title: seed.title,
			native: seed.native,
			layout: resolved?.layout ?? null,
			layoutStatus: resolved?.status ?? "unknown",
			slotCount: seed.slotCount,
			inventoryStart: seed.native?.inventoryStart ?? null,
			inventoryEnd: seed.native?.inventoryEnd ?? null,
			slots: [],
			cursor: null,
			cursorKnown: false,
			properties: {},
			serverStateId: null,
			contentRevision: 1,
			uiRevision: baseRevision + 1,
			fullSequence: 0,
			synchronized: false,
			openedAt: nowIso(),
			observedAt: nowIso(),
		};
		this.screenState = screen;
		this.emit({ kind: "screen", action: "opened", screen });
	}

	private onFull(notice: Extract<ProtocolNotice, { kind: "full" }>): void {
		const screen = this.screenState;
		if (screen == null || screen.windowId !== notice.windowId) return;
		const nextSlots = notice.items;
		// open_window 不带槽数、mineflayer 又没建窗口时（插件自定义窗口类型），
		// 以权威 full 的槽数为准，而不是永远停在 0 格。
		if (screen.slotCount === 0 && nextSlots.length > 0) screen.slotCount = nextSlots.length;
		const contentChanged =
			nextSlots.length !== screen.slots.length ||
			nextSlots.some((item, index) => JSON.stringify(item) !== JSON.stringify(screen.slots[index])) ||
			JSON.stringify(notice.cursor) !== JSON.stringify(screen.cursor);
		screen.slots = nextSlots;
		screen.cursor = notice.cursor;
		screen.cursorKnown = true;
		if (notice.stateId !== null) screen.serverStateId = notice.stateId;
		screen.fullSequence += 1;
		screen.synchronized = true;
		screen.observedAt = nowIso();
		if (contentChanged) {
			screen.contentRevision += 1;
			screen.uiRevision += 1;
		}
		this.emit({ kind: "screen", action: "updated", screen });
	}

	private onSlot(notice: Extract<ProtocolNotice, { kind: "slot" }>): void {
		const screen = this.screenState;
		if (screen == null) return;
		if (notice.windowId === -1 && notice.slot === -1) {
			this.onCursor(notice.item);
			return;
		}
		if (notice.windowId !== screen.windowId) return;
		if (notice.slot < 0 || notice.slot >= screen.slotCount) return;
		while (screen.slots.length < screen.slotCount) screen.slots.push(null);
		if (JSON.stringify(screen.slots[notice.slot]) === JSON.stringify(notice.item)) return;
		screen.slots[notice.slot] = notice.item;
		screen.contentRevision += 1;
		screen.uiRevision += 1;
		screen.observedAt = nowIso();
		this.emit({ kind: "screen", action: "updated", screen });
	}

	private onCursor(item: JsonValue | null): void {
		const screen = this.screenState;
		if (screen == null) return;
		if (JSON.stringify(screen.cursor) === JSON.stringify(item) && screen.cursorKnown) return;
		screen.cursor = item;
		screen.cursorKnown = true;
		screen.contentRevision += 1;
		screen.uiRevision += 1;
		screen.observedAt = nowIso();
		this.emit({ kind: "screen", action: "updated", screen });
	}

	private onPlayerSlot(slot: number, item: JsonValue | null): void {
		const screen = this.screenState;
		if (screen == null || screen.inventoryStart == null) return;
		// 协议 player_slot 的 9..44 对应窗口玩家区（与 WindowSession 的映射一致）。
		if (slot < 9 || slot > 44) return;
		const index = screen.inventoryStart + slot - 9;
		if (index < 0 || index >= screen.slotCount) return;
		if (JSON.stringify(screen.slots[index]) === JSON.stringify(item)) return;
		screen.slots[index] = item;
		screen.contentRevision += 1;
		screen.uiRevision += 1;
		screen.observedAt = nowIso();
		this.emit({ kind: "screen", action: "updated", screen });
	}

	private onProperty(notice: Extract<ProtocolNotice, { kind: "property" }>): void {
		const screen = this.screenState;
		if (screen == null || screen.windowId !== notice.windowId) return;
		// 进度条不推进 uiRevision：与物品 CAS 的 revision 同口径，避免高频刷新刷爆 UI 版本。
		screen.properties[String(notice.property)] = notice.value;
		screen.observedAt = nowIso();
		this.emit({ kind: "screen", action: "updated", screen });
	}

	private onWindowClose(window: NativeWindow | null): void {
		const screen = this.screenState;
		if (screen == null) return;
		if (window != null && window.id !== screen.windowId) return;
		this.screenState = null;
		this.emit({ kind: "screen", action: "closed", screen: null });
	}

	private onEnd(): void {
		const hadScreen = this.screenState != null;
		const hadDialog = this.dialogState != null;
		this.screenState = null;
		this.dialogState = null;
		this.configState = null;
		this.dialogRegistry.clear();
		this.textActions.clear();
		this.textActionOrder.length = 0;
		this.hudState = emptyHud();
		if (hadScreen) this.emit({ kind: "screen", action: "closed", screen: null });
		if (hadDialog) this.emit({ kind: "dialog", action: "closed", dialog: null });
	}

	private onDialog(notice: Extract<ProtocolNotice, { kind: "dialog" }>): void {
		const dialog: DialogState = {
			dialogRef: this.nextDialogRef(notice.phase),
			phase: notice.phase,
			data: notice.data,
			registryId: notice.registryId,
			uiRevision: (this.dialogState?.uiRevision ?? this.screenState?.uiRevision ?? 0) + 1,
			openedAt: nowIso(),
		};
		this.dialogState = dialog;
		this.emit({ kind: "dialog", action: "opened", dialog });
	}

	private onDialogClear(phase: "play" | "config"): void {
		if (this.dialogState == null || this.dialogState.phase !== phase) return;
		this.dialogState = null;
		this.emit({ kind: "dialog", action: "closed", dialog: null });
	}

	private onCodeOfConduct(contents: string): void {
		this.configState = {
			kind: "code_of_conduct",
			ref: `config:${this.namespace}:coc`,
			contents,
			observedAt: nowIso(),
		};
		this.emit({ kind: "config", interaction: this.configState });
	}

	private onRegistry(notice: Extract<ProtocolNotice, { kind: "registry_data" }>): void {
		if (notice.id !== "minecraft:dialog" && notice.id !== "dialog") return;
		this.dialogRegistry.clear();
		for (let index = 0; index < notice.entries.length && index < MAX_REGISTRY_ENTRIES; index++)
			this.dialogRegistry.set(index, { key: notice.entries[index].key, value: notice.entries[index].value });
	}

	private onHud(
		notice: Extract<
			ProtocolNotice,
			{
				kind:
					| "objective"
					| "score"
					| "score_reset"
					| "score_display"
					| "boss_bar"
					| "title_text"
					| "titles_clear"
					| "tab_header";
			}
		>,
	): void {
		const hud = this.hudState;
		switch (notice.kind) {
			case "objective":
				if (notice.action === 1) hud.objectives.delete(notice.name);
				else
					hud.objectives.set(notice.name, {
						name: notice.name,
						title: notice.display ?? hud.objectives.get(notice.name)?.title ?? null,
					});
				if (hud.display?.objective === notice.name && notice.action === 1) hud.display = null;
				break;
			case "score":
				hud.scores.set(`${notice.objective}\u0000${notice.entry}`, {
					entry: notice.entry,
					objective: notice.objective,
					value: notice.value,
					display: notice.display,
				});
				break;
			case "score_reset":
				if (notice.objective == null) {
					for (const [key, value] of hud.scores) if (value.entry === notice.entry) hud.scores.delete(key);
				} else hud.scores.delete(`${notice.objective}\u0000${notice.entry}`);
				break;
			case "score_display":
				// position 0=list 1=sidebar 2=below_name；name="" 表示清除。
				hud.display = notice.objective === "" ? null : { position: notice.position, objective: notice.objective };
				break;
			case "boss_bar":
				if (notice.action === 1) {
					hud.bossBars.delete(notice.id);
					break;
				}
				{
					const previous = hud.bossBars.get(notice.id);
					hud.bossBars.set(notice.id, {
						id: notice.id,
						title: notice.title ?? previous?.title ?? null,
						progress: notice.health ?? previous?.progress ?? 0,
						color: notice.color ?? previous?.color ?? null,
						overlay: notice.overlay ?? previous?.overlay ?? null,
						darkenSky: notice.darkenSky ?? previous?.darkenSky ?? null,
						createFog: notice.createFog ?? previous?.createFog ?? null,
					});
				}
				break;
			case "title_text":
				if (notice.target === "title") hud.title = notice.text;
				else if (notice.target === "subtitle") hud.subtitle = notice.text;
				else hud.actionBar = notice.text;
				break;
			case "titles_clear":
				if (notice.reset) {
					hud.title = null;
					hud.subtitle = null;
				} else {
					hud.title = null;
					hud.subtitle = null;
					hud.actionBar = null;
				}
				break;
			case "tab_header":
				hud.tab = { header: notice.header, footer: notice.footer };
				break;
			default:
				return;
		}
		hud.observedAt = nowIso();
		this.emit({ kind: "hud" });
	}
}
