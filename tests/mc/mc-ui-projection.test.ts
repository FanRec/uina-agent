/**
 * UI 投影 / Dialog 解析 / 受控动作前态校验的单元测试。
 *
 * 夹具刻意用真服实测到的线上形态（typed NBT 组件、open_window 无槽数、window_items 先到），
 * 而不是"看起来合理"的 JSON：这些形状是本轮重构里最容易猜错的地方。
 */

import { describe, expect, test } from "vitest";
import type { ItemValue } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { runUiAct, type UiActDeps } from "../../.uina/worlds/minecraft/driver/body/ui-act.js";
import type {
	DriverProtocol,
	NativeWindow,
	ProtocolNotice,
} from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";
import { parseDialog, projectUi } from "../../.uina/worlds/minecraft/driver/ui/projection.js";
import { itemDisplay, parseComponent } from "../../.uina/worlds/minecraft/driver/ui/text.js";
import { ConnectionWindowState } from "../../.uina/worlds/minecraft/driver/window/state.js";

/** 真服实测：custom_name 在 1.21.11 是 {type:"compound", value:{color, text}}。 */
const typedName = (text: string, color: string): JsonValue =>
	({
		type: "compound",
		value: { color: { type: "string", value: color }, text: { type: "string", value: text } },
	}) as unknown as JsonValue;

const typedLore = (lines: string[]): JsonValue => lines.map((line) => typedName(line, "gray")) as unknown as JsonValue;

function itemWithDisplay(name: string, lore: string[]): ItemValue {
	return {
		name: "diamond",
		count: 1,
		stackSize: 64,
		durability: null,
		components: {
			added: [
				{ type: "custom_name", data: typedName(name, "gold") },
				{ type: "lore", data: typedLore(lore) },
			],
			removed: [],
		},
	} as unknown as ItemValue;
}

/** 线上通知的槽位是原始 JSON 形态（投影层用 toItem 归一化），测试按同一条路径喂。 */
const wireItem = (item: ItemValue): JsonValue => item as unknown as JsonValue;

function harness() {
	let push: (notice: ProtocolNotice) => void = () => {};
	const state = new ConnectionWindowState((listener) => {
		push = listener;
		return () => {};
	}, "ui1");
	return { state, send: (notice: ProtocolNotice) => push(notice) };
}

/** 原生窗口替身：只有状态机真正读的字段。 */
function nativeWindow(id: number, type: string, slotCount: number, inventoryStart: number): NativeWindow {
	return {
		id,
		type,
		slots: Array.from({ length: slotCount }, () => null),
		inventoryStart,
		inventoryEnd: slotCount,
	} as unknown as NativeWindow;
}

describe("1.21.11 text components", () => {
	test("typed NBT compound is unwrapped into text and style", () => {
		const parsed = parseComponent(typedName("Buy Diamond", "gold"), "ref");
		expect(parsed?.text).toBe("Buy Diamond");
		expect(parsed?.style.color).toBe("gold");
	});

	test("item display reads typed custom_name and lore instead of falling back to the item id", () => {
		const display = itemDisplay(itemWithDisplay("Buy Diamond", ["cost 3 emeralds", "variant 0"]), "slot11");
		expect(display?.name?.text).toBe("Buy Diamond");
		expect(display?.lore?.map((line) => line.text)).toEqual(["cost 3 emeralds", "variant 0"]);
	});

	test("legacy JSON-string components keep working (older plugin shape)", () => {
		const item = {
			name: "paper",
			count: 1,
			stackSize: 64,
			durability: null,
			components: {
				added: [
					{ type: "custom_name", data: '{"text":"Menu Button","color":"green"}' },
					{ type: "lore", data: ['{"text":"Click me","italic":false}'] },
				],
				removed: [],
			},
		} as unknown as ItemValue;
		const display = itemDisplay(item, "slot36");
		expect(display?.name?.text).toBe("Menu Button");
		expect(display?.lore?.[0]?.text).toBe("Click me");
	});

	test("a bare string is still treated as legacy section text", () => {
		expect(parseComponent("§ahello", "ref")?.text).toBe("hello");
	});
});

describe("dialog projection", () => {
	// 夹具用真服 dump 的原样形态（`pnpm dev:mc:ui` 前的探针输出）：
	// - body 是 Either<List<DialogBody>, DialogBody>，单个 body 时线上是裸 compound；
	// - static 动作不是 `minecraft:static`，而是内联 ClickEvent（字段是 type）。
	// dialogData() 存的是已解包的纯 JSON，所以 typed NBT 只出现在物品组件那一路。
	const dialog: JsonValue = {
		type: "minecraft:multi_action",
		title: "Uina Dialog",
		body: { type: "minecraft:plain_message", width: 300, contents: "Pick an action." },
		inputs: [{ type: "minecraft:text", key: "note", label: "Note", max_length: 64 }],
		actions: [
			{
				label: { text: "Submit" },
				action: { type: "minecraft:dynamic/run_command", template: "uina_dialog_submit $(note)" },
			},
			{
				label: { text: "Custom" },
				action: { type: "minecraft:dynamic/custom", id: "uina:dialog_submit" },
			},
			{
				label: { text: "Close" },
				action: { type: "minecraft:run_command", command: "/uina_say dialog-close" },
			},
		],
		can_close_with_escape: true,
	} as unknown as JsonValue;

	test("the three real button encodings stay distinguishable", () => {
		const parsed = parseDialog(dialog, "dialog:ui1:local:1");
		expect(parsed.buttons).toHaveLength(3);
		expect(parsed.buttons[0].action.kind).toBe("dynamic_command");
		expect(parsed.buttons[0].action.template).toBe("uina_dialog_submit $(note)");
		expect(parsed.buttons[1].action.kind).toBe("dynamic_custom");
		expect(parsed.buttons[1].action.id).toBe("uina:dialog_submit");
		expect(parsed.buttons[2].action.kind).toBe("static");
		expect(parsed.buttons[2].action.click?.kind).toBe("run_command");
		expect(parsed.buttons[2].action.click?.value).toBe("/uina_say dialog-close");
		expect(parsed.inputs.map((input) => [input.key, input.type])).toEqual([["note", "text"]]);
	});

	test("a single body compound is not dropped, and neither is a body list", () => {
		expect(parseDialog(dialog, "d1").body.map((line) => line.text)).toEqual(["Pick an action."]);
		const listed = {
			type: "minecraft:multi_action",
			body: [
				{ type: "minecraft:plain_message", contents: "first" },
				{ type: "minecraft:plain_message", contents: "second" },
			],
			actions: [],
		} as unknown as JsonValue;
		expect(parseDialog(listed, "d2").body.map((line) => line.text)).toEqual(["first", "second"]);
	});

	test("the projection exposes a view action per button and keeps unknown buttons honest", () => {
		const projection = projectUi({ screen: null, dialog: null, dialogData: null });
		expect(projection.kind).toBe("none");
		const { state, send } = harness();
		send({ kind: "dialog", phase: "play", data: dialog, registryId: null });
		const view = projectUi({ screen: null, dialog: state.dialog(), dialogData: state.dialogData() });
		expect(view.kind).toBe("dialog");
		expect(view.dialog?.phase).toBe("play");
		expect(view.dialog?.buttons.map((button) => button.action?.kind)).toEqual(["run_command", "custom", "run_command"]);
		expect(view.dialog?.dismissible).toBe(true);
	});
});

describe("connection-level screen state", () => {
	test("open_window arrives without a slot count, and window_items may beat the native window", () => {
		const { state, send } = harness();
		send({ kind: "open_window", windowId: 2, windowType: 2, title: null, horse: false, slotCount: null });
		const opened = state.screen();
		expect(opened?.slotCount).toBe(0);
		expect(opened?.layoutStatus).toBe("unknown");

		// 真服顺序：window_items 先到（synchronized=true，但还没有原生窗口对象）
		send({
			kind: "full",
			windowId: 2,
			items: [wireItem(itemWithDisplay("Buy Diamond", ["cost 3"]))],
			cursor: null,
			stateId: 1,
		});
		const synced = state.screen();
		expect(synced?.synchronized).toBe(true);
		expect(synced?.layout).toBeNull();
		expect(synced?.slotCount).toBe(1);

		// 原生窗口就位后布局才可验证，screenRef 不变（同一块屏）
		const refBefore = synced?.screenRef;
		send({ kind: "window_open", window: nativeWindow(2, "minecraft:generic_9x3", 63, 27) });
		const settled = state.screen();
		expect(settled?.screenRef).toBe(refBefore);
		expect(settled?.layoutStatus).toBe("known");
		expect(settled?.slotCount).toBe(63);
	});

	test("a reopened menu is a new screen identity, not the same one with new contents", () => {
		const { state, send } = harness();
		send({ kind: "open_window", windowId: 1, windowType: 2, title: null, horse: false, slotCount: null });
		send({ kind: "window_open", window: nativeWindow(1, "minecraft:generic_9x3", 63, 27) });
		const first = state.screen()?.screenRef;
		send({ kind: "open_window", windowId: 2, windowType: 2, title: null, horse: false, slotCount: null });
		expect(state.screen()?.screenRef).not.toBe(first);
	});

	test("a local dialog replaces the container screen and vice versa", () => {
		const { state, send } = harness();
		send({ kind: "open_window", windowId: 1, windowType: 2, title: null, horse: false, slotCount: null });
		send({ kind: "window_open", window: nativeWindow(1, "minecraft:generic_9x3", 63, 27) });
		expect(state.screen()).not.toBeNull();

		state.openLocalDialog({ type: "minecraft:multi_action" });
		expect(state.screen()).toBeNull();
		expect(state.dialog()?.phase).toBe("local");

		send({ kind: "open_window", windowId: 3, windowType: 2, title: null, horse: false, slotCount: null });
		expect(state.dialog()).toBeNull();
		expect(state.screen()?.windowId).toBe(3);
	});
});

describe("ui.act pre-state validation", () => {
	function deps(state: ConnectionWindowState, dispatched: string[]): UiActDeps {
		const protocol = {
			click: (_window: NativeWindow, slot: number, button: number) => dispatched.push(`click:${slot}:${button}`),
			chatCommand: (command: string) => dispatched.push(`chat:${command}`),
			customClickAction: (id: string) => dispatched.push(`custom:${id}`),
			close: () => dispatched.push("close"),
		} as unknown as DriverProtocol;
		return {
			bot: {} as UiActDeps["bot"],
			protocol,
			signal: new AbortController().signal,
			guard: () => {},
			canCleanup: () => true,
			// beforeWrite 是写前意图门（G34）；这里验的是前态校验，放行即可。
			recorder: { record: () => {}, beforeWrite: async () => {} } as unknown as UiActDeps["recorder"],
			mintOp: () => "op:1" as UiActDeps["connection"],
			mintEff: () => "eff:1" as UiActDeps["connection"],
			state,
			connection: "conn:1" as UiActDeps["connection"],
			incarnation: "inc:1" as UiActDeps["connection"],
		};
	}

	async function menuState() {
		const { state, send } = harness();
		send({ kind: "open_window", windowId: 1, windowType: 2, title: null, horse: false, slotCount: null });
		send({
			kind: "full",
			windowId: 1,
			items: [wireItem(itemWithDisplay("Buy Diamond", ["cost 3"]))],
			cursor: null,
			stateId: 1,
		});
		send({ kind: "window_open", window: nativeWindow(1, "minecraft:generic_9x3", 63, 27) });
		return state;
	}

	test("a stale screenRef fails before any packet is written", async () => {
		const state = await menuState();
		const dispatched: string[] = [];
		const screen = state.screen();
		expect(screen).not.toBeNull();
		const view = projectUi({ screen, dialog: null, dialogData: null });
		const slot = view.container?.slots.find((entry) => entry.index === 0);
		await expect(
			runUiAct(deps(state, dispatched), {
				kind: "click_slot",
				screenRef: "screen:ui1:99",
				uiRevision: screen?.uiRevision ?? 0,
				slot: 0,
				button: "left",
				buttonDigest: slot?.buttonDigest ?? "x",
			}),
		).rejects.toMatchObject({ code: "UI_STALE", dispatch: "not_sent" });
		expect(dispatched).toEqual([]);
	});

	test("a changed button digest fails before dispatch (content changed under the observation)", async () => {
		const state = await menuState();
		const dispatched: string[] = [];
		const screen = state.screen();
		await expect(
			runUiAct(deps(state, dispatched), {
				kind: "click_slot",
				screenRef: screen?.screenRef ?? "x",
				uiRevision: screen?.uiRevision ?? 0,
				slot: 0,
				button: "left",
				buttonDigest: "deadbeef",
			}),
		).rejects.toMatchObject({ code: "UI_STALE" });
		expect(dispatched).toEqual([]);
	});

	test("an empty slot has no digest and cannot be clicked as a button", async () => {
		const state = await menuState();
		const dispatched: string[] = [];
		const screen = state.screen();
		await expect(
			runUiAct(deps(state, dispatched), {
				kind: "click_slot",
				screenRef: screen?.screenRef ?? "x",
				uiRevision: screen?.uiRevision ?? 0,
				slot: 1,
				button: "left",
				buttonDigest: "deadbeef",
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(dispatched).toEqual([]);
	});

	test("a valid click writes exactly one packet and reports the observed transition", async () => {
		const state = await menuState();
		const dispatched: string[] = [];
		const screen = state.screen();
		const view = projectUi({ screen, dialog: null, dialogData: null });
		const slot = view.container?.slots.find((entry) => entry.index === 0);
		expect(slot?.buttonDigest).not.toBeNull();
		const receipt = await runUiAct(deps(state, dispatched), {
			kind: "click_slot",
			screenRef: screen?.screenRef ?? "x",
			uiRevision: screen?.uiRevision ?? 0,
			slot: 0,
			button: "left",
			buttonDigest: slot?.buttonDigest ?? "x",
		});
		expect(dispatched).toEqual(["click:0:0"]);
		// 没有界面变化 → sent，而不是"购买成功"
		expect(receipt.outcome).toBe("sent");
		expect(receipt.dispatch).toBe("sent");
	});

	test("text actions only run when the observation registered them", async () => {
		const { state } = harness();
		const dispatched: string[] = [];
		await expect(
			runUiAct(deps(state, dispatched), { kind: "activate_text", eventRef: "ev:1", actionRef: "ev:1/a0" }),
		).rejects.toMatchObject({ code: "UI_STALE" });
		expect(dispatched).toEqual([]);

		state.registerTextActions("ev:1", [{ ref: "ev:1/a0", kind: "run_command", value: "/uina_say hi", payload: null }]);
		const receipt = await runUiAct(deps(state, dispatched), {
			kind: "activate_text",
			eventRef: "ev:1",
			actionRef: "ev:1/a0",
		});
		expect(dispatched).toEqual(["chat:/uina_say hi"]);
		expect(receipt.outcome).toBe("sent");
	});

	test("a dialog cannot be closed by a packet, and the refusal happens before dispatch", async () => {
		const { state } = harness();
		const dispatched: string[] = [];
		const dialog = state.openLocalDialog({ type: "minecraft:multi_action" });
		await expect(
			runUiAct(deps(state, dispatched), { kind: "close", screenRef: dialog.dialogRef, uiRevision: dialog.uiRevision }),
		).rejects.toMatchObject({ code: "UNSUPPORTED_WINDOW", dispatch: "not_sent" });
		expect(dispatched).toEqual([]);
	});
});
