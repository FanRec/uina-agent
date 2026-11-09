/**
 * ui.act@1：对"已经打开的服务器界面"做一次受控写操作。
 *
 * 与 WindowSession 的分工（规格 §3.4）：
 * - 物品搬运是**事务**：CAS 槽位、预测结果、diverged/unknown 分类，属于 WindowSession；
 * - 菜单按钮是**单次派发**：只校验观察前态（screenRef + uiRevision + buttonDigest），
 *   派发一次真实协议包，然后把"界面是否转移"作为观察结果报告，不预测业务成功。
 *
 * 因此本模块不持有会话、不排队、不重试；身体资格只在派发瞬间核验。
 * 未知布局的窗口仍然可读（ui@1 只读），但这里拒绝按未验证区域点击。
 */

import type { RichTextAction, UiActInput, UiActOutcome, UiActReceipt } from "../../contracts/ui.js";
import type { CallFailure, JsonValue, Ref } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { parseDialog, projectContainer, projectUi } from "../ui/projection.js";
import type { ConnectionWindowState } from "../window/state.js";
import type { BodyOperationDeps } from "./operation.js";

/** 界面转移的观察窗口：菜单插件通常在 1 个 tick 内换屏，1.5 s 足够且不拖慢循环。 */
const ACT_MS = 1500;

export interface UiActDeps extends BodyOperationDeps {
	state: ConnectionWindowState;
	connection: Ref;
	incarnation: Ref;
}

interface ActPlan {
	/** 派发后应观察到的界面变化；none = 这个动作不改界面（聊天命令/自定义动作）。 */
	expect: "screen_change" | "screen_close" | "none";
	detail: Record<string, JsonValue>;
	dispatch(): void;
}

function stale(message: string) {
	return fail({ code: "UI_STALE", source: "capability", message, dispatch: "not_sent", recoverable: true });
}

function invalid(message: string) {
	return fail({ code: "INVALID_INPUT", source: "input", message, dispatch: "not_sent", recoverable: true });
}

function unsupported(message: string) {
	return fail({ code: "UNSUPPORTED_WINDOW", source: "capability", message, dispatch: "not_sent", recoverable: false });
}

function asRecord(raw: JsonValue | null): Record<string, JsonValue> {
	return raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JsonValue>) : {};
}

/** 只接受已声明输入键：拼错的值不会被静默丢弃，而是在派发前失败。 */
function validateValues(
	inputs: { key: string; type: string }[],
	values: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const declared = new Map(inputs.map((input) => [input.key, input.type]));
	const out: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(values)) {
		const type = declared.get(key);
		if (type == null) throw invalid(`dialog has no input named ${JSON.stringify(key)}`);
		if (type === "number_range" && typeof value !== "number")
			throw invalid(`dialog input ${key} is a number_range and needs a numeric value`);
		if (type === "boolean" && typeof value !== "boolean")
			throw invalid(`dialog input ${key} is a boolean and needs true/false`);
		if (type === "text" && typeof value !== "string") throw invalid(`dialog input ${key} is text and needs a string`);
		out[key] = value;
	}
	return out;
}

/** dynamic/run_command 的模板占位符是 $(key)；未提供的占位符原样保留（不编造参数）。 */
function expandTemplate(template: string, values: Record<string, JsonValue>): string {
	return template.replace(/\$\(([a-z0-9_]+)\)/gi, (whole, key: string) => {
		const value = values[key];
		return value == null ? whole : String(value);
	});
}

/** 点击动作 → 真实出站编码；client-local 动作（复制/开网页/翻页）没有服务端写入，如实拒绝。 */
function dispatchTextAction(deps: UiActDeps, state: ConnectionWindowState, action: RichTextAction): ActPlan {
	switch (action.kind) {
		case "run_command": {
			if (action.value == null) throw unsupported("run_command action carries no command");
			const command = action.value;
			return {
				expect: "none",
				detail: { action: "run_command", command },
				dispatch: () => deps.protocol.chatCommand(command),
			};
		}
		case "custom": {
			if (action.value == null) throw unsupported("custom action carries no id");
			const id = action.value;
			const payload = action.payload;
			return {
				expect: "none",
				detail: { action: "custom", id },
				dispatch: () => deps.protocol.customClickAction(id, payload),
			};
		}
		case "show_dialog": {
			// 内联 Dialog 是客户端本地显示，不发包；注册表引用没有内联数据时不猜。
			const payload = action.payload;
			if (payload == null || typeof payload !== "object")
				throw unsupported("show_dialog references a registry dialog that this client cannot resolve locally");
			return {
				expect: "screen_change",
				detail: { action: "show_dialog", local: true },
				dispatch: () => {
					state.openLocalDialog(payload);
				},
			};
		}
		default:
			throw unsupported(`click action ${action.kind} is client-local and has no serverbound encoding`);
	}
}

function planClickSlot(
	deps: UiActDeps,
	state: ConnectionWindowState,
	input: Extract<UiActInput, { kind: "click_slot" }>,
): ActPlan {
	const screen = state.screen();
	if (screen == null) throw stale("no container screen is open on this connection");
	if (input.screenRef !== screen.screenRef)
		throw stale(`screen changed since the observation: ${input.screenRef} is no longer the open screen`);
	if (input.uiRevision !== screen.uiRevision)
		throw stale(`ui revision ${input.uiRevision} is stale; the current screen is at ${screen.uiRevision}`);
	const view = projectContainer(screen, { includeEmptySlots: true });
	const slot = view.slots.find((entry) => entry.index === input.slot);
	if (slot == null) throw invalid(`slot ${input.slot} is outside this window (${view.layout.slotCount} slots)`);
	if (slot.buttonDigest == null)
		throw invalid(
			`slot ${input.slot} is empty and has no button digest; use the window item transaction to move items`,
		);
	if (slot.buttonDigest !== input.buttonDigest)
		throw stale(`slot ${input.slot} content changed since the observation; re-read ui@1 before clicking`);
	if (screen.native == null)
		throw unsupported(
			`window type ${screen.type ?? String(screen.windowType)} is not materialized by this client; slot clicks have no encoding`,
		);
	const native = screen.native;
	const button = input.button === "left" ? 0 : 1;
	return {
		expect: "screen_change",
		detail: { slot: input.slot, button: input.button, digest: input.buttonDigest },
		dispatch: () => deps.protocol.click(native, input.slot, button),
	};
}

function planSubmitDialog(
	deps: UiActDeps,
	state: ConnectionWindowState,
	input: Extract<UiActInput, { kind: "submit_dialog" }>,
): ActPlan {
	const dialog = state.dialog();
	if (dialog == null) throw stale("no dialog is open on this connection");
	if (input.screenRef !== dialog.dialogRef)
		throw stale(`dialog changed since the observation: ${input.screenRef} is no longer the open dialog`);
	if (input.uiRevision !== dialog.uiRevision)
		throw stale(`ui revision ${input.uiRevision} is stale; the current dialog is at ${dialog.uiRevision}`);
	const projection = projectUi({ screen: null, dialog, dialogData: state.dialogData() });
	const view = projection.dialog;
	if (view == null) throw unsupported("dialog payload could not be projected");
	const button = view.buttons.find((entry) => entry.ref === input.buttonRef);
	if (button == null) throw stale(`dialog button ${input.buttonRef} is not part of the current dialog`);
	const values = validateValues(view.inputs, input.values);
	// 结构化动作（static/dynamic_*）比投影里的简化动作更权威：先按它编码，投影只做展示。
	const parsed = parseDialog(state.dialogData(), dialog.dialogRef);
	const structured = parsed.buttons.find((entry) => entry.ref === input.buttonRef)?.action;
	if (structured == null) throw unsupported(`dialog button ${input.buttonRef} has no resolvable action`);
	if (structured.kind === "dynamic_command") {
		const template = structured.template;
		if (template == null) throw unsupported("dynamic/run_command button carries no template");
		const command = expandTemplate(template, values);
		return {
			expect: "none",
			detail: { action: "dynamic_command", command },
			dispatch: () => deps.protocol.chatCommand(command),
		};
	}
	if (structured.kind === "dynamic_custom") {
		const id = structured.id;
		if (id == null) throw unsupported("dynamic/custom button carries no id");
		const payload = { ...asRecord(structured.additions), ...values };
		const floatKeys = view.inputs.filter((entry) => entry.type === "number_range").map((entry) => entry.key);
		return {
			expect: "none",
			detail: { action: "dynamic_custom", id, keys: Object.keys(payload) },
			dispatch: () => deps.protocol.customClickAction(id, payload, floatKeys),
		};
	}
	if (structured.click == null) throw unsupported(`dialog button ${input.buttonRef} has no click action`);
	return dispatchTextAction(deps, state, structured.click);
}

function planActivateText(
	deps: UiActDeps,
	state: ConnectionWindowState,
	input: Extract<UiActInput, { kind: "activate_text" }>,
): ActPlan {
	const action = state.textAction(input.eventRef, input.actionRef);
	if (action == null)
		throw stale(
			`text action ${input.actionRef} is not registered for ${input.eventRef}; re-read the message or interface that produced it`,
		);
	return dispatchTextAction(deps, state, action);
}

function planClose(
	deps: UiActDeps,
	state: ConnectionWindowState,
	input: Extract<UiActInput, { kind: "close" }>,
): ActPlan {
	const screen = state.screen();
	if (screen == null) {
		// 对话框的"关闭"是纯客户端行为：1.21.11 没有 serverbound 的关对话框包，
		// 服务端也无从得知。这里如实拒绝，而不是假装发了一个包。
		if (state.dialog() != null)
			throw unsupported(
				"dialog dismissal is client-local in 1.21.11: there is no serverbound close packet, so the server would never learn about it. Use one of the dialog's own buttons, or open another interface",
			);
		throw stale("no container screen is open on this connection");
	}
	if (input.screenRef !== screen.screenRef)
		throw stale(`screen changed since the observation: ${input.screenRef} is no longer the open screen`);
	if (input.uiRevision !== screen.uiRevision)
		throw stale(`ui revision ${input.uiRevision} is stale; the current screen is at ${screen.uiRevision}`);
	if (screen.native == null) throw unsupported("this window is not materialized by the client; it cannot be closed");
	const native = screen.native;
	return {
		expect: "screen_close",
		detail: { window: screen.screenRef },
		dispatch: () => deps.protocol.close(native),
	};
}

function plan(deps: UiActDeps, state: ConnectionWindowState, input: UiActInput): ActPlan {
	switch (input.kind) {
		case "click_slot":
			return planClickSlot(deps, state, input);
		case "submit_dialog":
			return planSubmitDialog(deps, state, input);
		case "activate_text":
			return planActivateText(deps, state, input);
		case "close":
			return planClose(deps, state, input);
		case "book_page":
			throw unsupported(
				"written-book page turns are client-local in 1.21.11: the protocol has no serverbound page packet",
			);
		default:
			throw invalid(`unknown ui.act kind ${String((input as { kind?: unknown }).kind)}`);
	}
}

interface ScreenMark {
	ref: string | null;
	revision: number;
}

function markOf(state: ConnectionWindowState): ScreenMark {
	return {
		ref: state.dialog()?.dialogRef ?? state.screen()?.screenRef ?? null,
		revision: state.uiRevision(),
	};
}

/**
 * 等待界面转移。只认"可归因于这次派发"的变化：
 * screenRef 变了（换屏/开新屏/关闭）或同一 screenRef 的 uiRevision 推进。
 */
function awaitTransition(
	state: ConnectionWindowState,
	before: ScreenMark,
	expect: ActPlan["expect"],
	timeoutMs: number,
): Promise<{ changed: boolean; timedOut: boolean }> {
	if (expect === "none") return Promise.resolve({ changed: false, timedOut: false });
	return new Promise((resolve) => {
		let done = false;
		const finish = (changed: boolean, timedOut: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			detach();
			resolve({ changed, timedOut });
		};
		const check = () => {
			const now = markOf(state);
			if (now.ref !== before.ref) finish(true, false);
			else if (now.revision > before.revision) finish(true, false);
		};
		const timer = setTimeout(() => finish(false, true), timeoutMs);
		const detach = state.subscribe(() => check());
		check();
	});
}

export async function runUiAct(deps: UiActDeps, input: UiActInput): Promise<UiActReceipt> {
	deps.guard();
	const state = deps.state;
	const startedAt = Date.now();
	const before = markOf(state);
	const operation = deps.mintOp();
	const effect = deps.mintEff();
	const planResult = plan(deps, state, input);
	let dispatch: UiActReceipt["dispatch"] = "not_sent";
	let outcome: UiActOutcome = "unsupported";
	let detail = "";

	const record = (
		phase: "dispatch" | "receipt",
		value: UiActReceipt["dispatch"],
		completion: "met" | "not_met" | "unknown",
		extra: Record<string, JsonValue>,
	) => {
		deps.recorder.record(effect, operation, "body.uiAct@1", phase, value, completion, {
			kind: input.kind,
			...extra,
		});
	};

	try {
		// 写前意图（§5.12）：菜单里的购买/选择会扣货币或扣物，不可安全重放；
		// 原来只有"发包之后"那条事实，崩溃时无法区分"点了没发出去"和"发出去了"。
		await deps.recorder.beforeWrite(effect, operation, "body.uiAct@1", { kind: input.kind });
		deps.guard();
		dispatch = "unknown";
		planResult.dispatch();
		dispatch = "sent";
		record("dispatch", "sent", "unknown", planResult.detail);
	} catch (error) {
		const failure = error as CallFailure;
		if (failure?.name === "CallFailure" && failure.dispatch === "not_sent") dispatch = "not_sent";
		if (dispatch !== "not_sent") record("dispatch", "unknown", "unknown", { kind: input.kind });
		if (failure?.name === "CallFailure") throw failure;
		throw fail({
			code: "INTERNAL",
			source: "environment",
			message: error instanceof Error ? error.message : String(error),
			dispatch,
			effects: dispatch === "not_sent" ? [] : [effect],
			recoverable: false,
		});
	}

	const settled = await awaitTransition(state, before, planResult.expect, ACT_MS);
	const after = markOf(state);
	const afterView = projectUi({
		screen: state.screen(),
		dialog: state.dialog(),
		dialogData: state.dialogData(),
	});

	if (after.ref !== before.ref) {
		outcome = after.ref == null ? "screen_closed" : "screen_opened";
		detail =
			after.ref == null
				? "the server closed the observed interface after this write"
				: `the server replaced the interface after this write (${before.ref ?? "none"} → ${after.ref})`;
	} else if (after.revision > before.revision) {
		outcome = "updated";
		detail = "the observed interface changed after this write";
	} else if (settled.timedOut) {
		outcome = "sent";
		detail =
			"the write entered the connection boundary but no attributable interface change was observed within 1500 ms; this is a legitimate outcome for command-only buttons";
	} else {
		outcome = "sent";
		detail = "the write entered the connection boundary; no interface change is expected from this action kind";
	}

	record("receipt", dispatch, "met", {
		outcome,
		screenRef: before.ref,
		uiRevisionBefore: before.revision,
		uiRevisionAfter: after.revision,
		completionContract:
			"the write entered the protocol send boundary; the resulting interface is a separate observation, not a business success claim",
	});

	return {
		effect,
		dispatch,
		completion: "met",
		outcome,
		screen: afterView,
		diagnostics: {
			screenRef: before.ref ?? "none",
			uiRevisionBefore: before.revision,
			uiRevisionAfter: after.revision,
			elapsedMs: Date.now() - startedAt,
			detail,
		},
		evidence: [],
	};
}
