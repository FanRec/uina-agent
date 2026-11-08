/**
 * 真服验收：通用服务器交互（ui@1 / ui.act@1 / hud@1）+ 普通容器回归。
 *
 * 前置：
 *   1. dev-env Paper 已运行（`pwsh .uina/worlds/minecraft/dev-env/start-server.ps1`）；
 *   2. uina-example-plugin 已安装（`node .uina/worlds/minecraft/dev-env/uina-plugin/build.mjs`）。
 * 运行：`pnpm dev:mc:ui`
 *
 * 这个场景刻意**不硬编码槽位号**：所有按钮都从 ui@1 的投影里按显示名找出来，
 * 再用它自己的 screenRef / uiRevision / buttonDigest 去点——这才是"未知结构菜单"的真实路径。
 * 每个断言都要有客户端读数与服务端日志两侧证据，缺一侧即失败。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientEventPayload } from "../contracts/client-facts.js";
import type { HudSnapshot, RichText, UiSlotValue, UiSnapshot } from "../contracts/ui.js";
import type { JsonValue, Ref } from "../contracts/values.js";
import { closeHarness, type DevHarness, openHarness, sleep } from "./harness.js";

/**
 * 每次运行用干净的运行库：事件历史与 storage_id 都绑在数据根上，
 * 复用旧根会让"这条聊天只出现一次"之类的断言跨运行失真。
 */
const DATA_ROOT = mkdtempSync(join(tmpdir(), "uina-ui-"));

function log(message: string): void {
	console.log(`[mc-ui] ${message}`);
}

function fail(message: string): never {
	throw new Error(`UI FAIL: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) fail(message);
}

/** 显示文本取纯文本，只用于"人读得懂"的定位，不参与业务判断。 */
function textOf(rich: RichText | null): string | null {
	return rich == null ? null : rich.text;
}

function loreOf(slot: UiSlotValue): string {
	return (slot.display?.lore ?? []).map((line) => line.text).join(" | ");
}

function slotByLabel(ui: UiSnapshot, label: string): UiSlotValue {
	const slots = ui.container?.slots ?? [];
	const hit = slots.find((slot) => textOf(slot.display?.name ?? null) === label);
	if (hit == null)
		fail(
			`menu has no slot labelled ${JSON.stringify(label)}; visible slots: ${slots
				.map((slot) => `${slot.index}:${textOf(slot.display?.name ?? null) ?? "?"}`)
				.join(", ")}`,
		);
	return hit;
}

interface EventRecord {
	ref: Ref;
	receivedAt: string;
	payload: ClientEventPayload;
}

/** inventory@1 的公开输出：只列非空槽，另有 counts/usedSlots/freeSlots 汇总。 */
interface InventoryValue {
	slots: { slot: number; name: string; count: number }[];
	counts: Record<string, number>;
	usedSlots: number;
	freeSlots: number;
}

/** ui.act@1 的公开输出（capabilities/actions/ui.ts 摊平后交给调用方的形状）。 */
interface ActResult {
	outcome: "screen_opened" | "screen_closed" | "updated" | "sent" | "unknown" | "unsupported";
	screenRef: string;
	uiRevision: number;
	uiKind: "none" | "container" | "dialog" | "book";
	detail: string;
	elapsedMs: number;
}

async function main(): Promise<void> {
	const h: DevHarness = await openHarness("ui", { dataRoot: DATA_ROOT });
	const { world: mcWorld, runtime: rt, ns, worldOwner, activation } = h;
	const origin = { worldOwner, activation };
	let seq = 0;
	const requestId = (tag: string): Ref => `req:${ns}:${tag}:${++seq}` as Ref;

	const readUi = async (): Promise<UiSnapshot> => {
		const observation = await mcWorld.read<UiSnapshot>({ ref: "ui@1", input: {} });
		assert(observation.value != null, "ui@1 returned no value");
		return observation.value;
	};
	const readHud = async (): Promise<HudSnapshot | null> => {
		const observation = await mcWorld.read<HudSnapshot | null>({ ref: "hud@1", input: {} });
		return observation.value ?? null;
	};
	const readChat = async (): Promise<EventRecord[]> => {
		const observation = await mcWorld.read<{ events: EventRecord[] }>({
			ref: "events@1",
			input: { kinds: ["chat"], limit: 40 },
		});
		return (observation.value?.events ?? []).filter((event) => event.payload.kind === "chat");
	};
	const chatTexts = async (): Promise<string[]> => {
		const events = await readChat();
		return events.map((event) => (event.payload.kind === "chat" ? event.payload.text : ""));
	};
	const inventoryItems = async (): Promise<{ slot: number; name: string; count: number }[]> => {
		const observation = await mcWorld.read<InventoryValue>({ ref: "inventory@1", input: {} });
		return observation.value?.slots ?? [];
	};
	const countOf = async (name: string): Promise<number> =>
		(await inventoryItems()).filter((slot) => slot.name === name).reduce((sum, slot) => sum + slot.count, 0);

	type CallOutcome = { ok: true; value: JsonValue | undefined } | { ok: false; code: string; message: string };
	const call = async (tag: string, selector: string, input: JsonValue): Promise<CallOutcome> => {
		const acceptance = await rt.submit(origin, {
			requestId: requestId(tag),
			entry: { kind: "call", selector, input },
			schedule: { kind: "enqueue" },
		});
		if (acceptance.kind !== "accepted") fail(`submit ${selector} (${tag}) not accepted: ${JSON.stringify(acceptance)}`);
		const reply = await rt.wait(acceptance.snapshot.run, { timeoutMs: 30_000 });
		if (reply.kind !== "result" || reply.snapshot.phase !== "finished")
			fail(`run ${selector} (${tag}) did not finish: ${reply.kind}`);
		const full = await rt.readRecord(reply.snapshot.record);
		if (full.kind !== "inline") fail(`run ${selector} (${tag}) produced no inline record`);
		const record = full.record.value as { value?: JsonValue; code?: string; message?: string };
		// 有值就是成功：outcome=unknown 只说明这次调用留下了未定性副作用（例如方块交互），
		// 不代表调用本身没做完。失败面只在"没有值且有错误码"时成立。
		if (record.value !== undefined) return { ok: true, value: record.value };
		return {
			ok: false,
			code: record.code ?? reply.snapshot.error?.code ?? reply.snapshot.outcome,
			message:
				record.message ??
				reply.snapshot.error?.message ??
				`outcome=${reply.snapshot.outcome} record=${JSON.stringify(record).slice(0, 2500)}`,
		};
	};
	/**
	 * 每次写之后都要求连接仍然 ready：协议编码错误会让服务端直接踢人，
	 * 而 mineflayer 的写是"投递即返回"，不查这一步就会把"发不出去"读成 sent。
	 */
	const assertConnected = (tag: string): void => {
		if (h.host.state !== "ready")
			fail(`connection is ${h.host.state} after ${tag}; the write never reached a live server`);
	};
	const act = async (tag: string, input: JsonValue): Promise<ActResult> => {
		const outcome = await call(tag, "ui.act@1", input);
		assert(outcome.ok, `ui.act@1 (${tag}) failed: ${outcome.ok ? "" : `${outcome.code}: ${outcome.message}`}`);
		assertConnected(tag);
		return outcome.value as unknown as ActResult;
	};
	/** 期望失败的动作：返回真实错误码，证明"没派发"而不是"派发了但没效果"。 */
	const actFailure = async (tag: string, input: JsonValue): Promise<string> => {
		const outcome = await call(tag, "ui.act@1", input);
		assert(!outcome.ok, `ui.act@1 (${tag}) was expected to fail before dispatch but succeeded`);
		assertConnected(tag);
		return outcome.code;
	};
	const say = async (text: string): Promise<void> => {
		const outcome = await call(`chat:${text.slice(0, 16)}`, "chat@1", { text });
		assert(outcome.ok, `chat ${text} failed: ${outcome.ok ? "" : `${outcome.code}: ${outcome.message}`}`);
		assertConnected(`chat ${text}`);
		await sleep(800);
	};

	// ---- 0. 基线：没有界面、没有 HUD ----
	const baseline = await readUi();
	log(`baseline ui: kind=${baseline.kind} screenRef=${String(baseline.screenRef)} rev=${baseline.uiRevision}`);
	assert(baseline.kind === "none", `expected no interface at baseline, got ${baseline.kind}`);
	assert(baseline.screenRef == null, "baseline screenRef must be null");
	const baselineHud = await readHud();
	log(
		`baseline hud: ${baselineHud == null ? "null (nothing observed yet)" : `objective=${String(baselineHud.scoreboard?.objective)}`}`,
	);

	// ---- 1. 打开菜单，只靠 ui@1 读懂结构 ----
	await say("/give UinaDev emerald 16");
	await say("/uina_menu");
	const menu = await readUi();
	log(
		`menu: kind=${menu.kind} type=${menu.container?.windowType} layout=${menu.container?.layout.status}/${menu.container?.layout.slotCount} visibleSlots=${menu.container?.slots.length} rev=${menu.uiRevision} screenRef=${String(menu.screenRef)}`,
	);
	assert(menu.kind === "container", `expected a container menu, got ${menu.kind}`);
	assert(menu.container != null, "container projection missing");
	assert(menu.container.layout.status === "known", `layout must be known, got ${menu.container.layout.status}`);
	const containerRegion = menu.container.layout.regions?.find((region) => region.name === "container");
	const playerRegion = menu.container.layout.regions?.find((region) => region.name === "player");
	assert(
		containerRegion?.slots.length === 27,
		`a 9x3 menu has 27 container slots, got ${containerRegion?.slots.length ?? "no container region"}`,
	);
	assert(
		playerRegion?.slots.length === 36,
		`the player region has 36 slots, got ${playerRegion?.slots.length ?? "no player region"}`,
	);
	assert(menu.screenRef != null, "menu must carry a screenRef");
	for (const slot of menu.container.slots) {
		log(
			`  slot ${slot.index} (${slot.region}) "${textOf(slot.display?.name ?? null) ?? "<no name>"}" :: ${loreOf(slot) || "<no lore>"} digest=${String(slot.buttonDigest).slice(0, 10)}`,
		);
	}
	const buy = slotByLabel(menu, "Buy Diamond");
	assert(buy.buttonDigest != null, "buy button must have a digest");
	const priceBefore = loreOf(buy);
	// 价格只从菜单自己写的 Lore 读：这不是"相信服务器"，而是"按服务器开出的条件核对扣款"。
	const advertisedPrice = Number(/cost (\d+) emeralds/.exec(priceBefore)?.[1] ?? Number.NaN);
	assert(Number.isFinite(advertisedPrice), `the buy button must advertise a price in its lore, got "${priceBefore}"`);
	log(`resolved by display name: buy=${buy.index} price="${priceBefore}" (${advertisedPrice} emeralds)`);

	// ---- 2. 点一次菜单按钮：内容真的变了（新屏 + 新价 + HUD + 库存 + 服务器确认） ----
	const emeraldBefore = await countOf("emerald");
	const diamondBefore = await countOf("diamond");
	log(
		`inventory before buy: emerald=${emeraldBefore} diamond=${diamondBefore} items=${JSON.stringify(await inventoryItems())}`,
	);

	const buyReceipt = await act("buy", {
		kind: "click_slot",
		screenRef: menu.screenRef,
		uiRevision: menu.uiRevision,
		slot: buy.index,
		button: "left",
		buttonDigest: buy.buttonDigest,
	});
	log(`buy outcome=${buyReceipt.outcome} elapsed=${buyReceipt.elapsedMs}ms :: ${buyReceipt.detail}`);
	assert(buyReceipt.outcome === "screen_opened", `buying must replace the menu screen, got ${buyReceipt.outcome}`);

	const afterBuy = await readUi();
	assert(afterBuy.screenRef != menu.screenRef, "the reopened menu must have a new screenRef");
	const buy2 = slotByLabel(afterBuy, "Buy Diamond");
	assert(buy2.buttonDigest !== buy.buttonDigest, "the price changed, so the button digest must change");
	log(`after buy: screenRef ${menu.screenRef} → ${afterBuy.screenRef}; price "${priceBefore}" → "${loreOf(buy2)}"`);

	const emeraldAfter = await countOf("emerald");
	const diamondAfter = await countOf("diamond");
	log(`inventory after buy: emerald=${emeraldAfter} diamond=${diamondAfter}`);
	assert(diamondAfter === diamondBefore + 1, "the server must have granted exactly one diamond");
	assert(
		emeraldAfter === emeraldBefore - advertisedPrice,
		`the server must have charged the ${advertisedPrice} emeralds the menu advertised (${emeraldBefore} → ${emeraldAfter})`,
	);

	const hud = await readHud();
	assert(hud != null, "hud@1 must report the scoreboard the plugin installed");
	log(
		`hud: objective=${String(hud.scoreboard?.objective)} display=${String(hud.scoreboard?.display)} lines=${(
			hud.scoreboard?.lines ?? []
		)
			.map((line) => `${line.entry}=${line.score}`)
			.join(
				",",
			)} bossBars=${hud.bossBars.length} title=${String(textOf(hud.title))} actionBar=${String(textOf(hud.actionBar))}`,
	);
	assert(hud.scoreboard?.display === "sidebar", `expected a sidebar objective, got ${String(hud.scoreboard?.display)}`);
	const buyChats = (await chatTexts()).filter((text) => text.includes("bought a diamond"));
	log(`chat evidence: ${buyChats.join(" / ")}`);
	assert(buyChats.length === 1, `the server must confirm the purchase exactly once, got ${buyChats.length}`);
	// 服务端购买计数是进程级的：从它自己的聊天回执取 N，再要求侧边栏读到同一个 N。
	// 这是两个独立服务端输出之间的交叉核对，不是"客户端猜一个期望值"。
	const serverTotal = Number(/bought a diamond \((\d+) total\)/.exec(buyChats[0])?.[1] ?? Number.NaN);
	assert(Number.isFinite(serverTotal), `the purchase notice must report a total, got "${buyChats[0]}"`);
	const diamondsLine = hud.scoreboard.lines.find((line) => line.entry === "diamonds");
	assert(diamondsLine != null, "sidebar must expose the diamonds line");
	assert(
		diamondsLine.score === serverTotal,
		`the sidebar must agree with the server's own total (chat says ${serverTotal}, sidebar says ${diamondsLine.score})`,
	);

	// ---- 3. 陈旧前态必须被拒：旧 screenRef/digest 不再可用 ----
	const staleCode = await actFailure("stale", {
		kind: "click_slot",
		screenRef: menu.screenRef,
		uiRevision: menu.uiRevision,
		slot: buy.index,
		button: "left",
		buttonDigest: buy.buttonDigest,
	});
	log(`stale click rejected with ${staleCode}`);
	assert(staleCode === "UI_STALE", `a stale screenRef must fail with UI_STALE, got ${staleCode}`);

	// ---- 4. 只发聊天、不改界面的按钮：outcome 必须是 sent，不是"成功" ----
	const silentButton = slotByLabel(afterBuy, "Silent Notice");
	const silentReceipt = await act("silent", {
		kind: "click_slot",
		screenRef: afterBuy.screenRef,
		uiRevision: afterBuy.uiRevision,
		slot: silentButton.index,
		button: "left",
		buttonDigest: silentButton.buttonDigest,
	});
	log(`silent outcome=${silentReceipt.outcome} :: ${silentReceipt.detail}`);
	assert(silentReceipt.outcome === "sent", `a chat-only button must report sent, got ${silentReceipt.outcome}`);
	const stillOpen = await readUi();
	assert(stillOpen.screenRef === afterBuy.screenRef, "a chat-only button must not change the screen identity");
	assert(
		(await chatTexts()).some((text) => text.includes("silent notice")),
		"the chat-only button must produce its server message",
	);

	// ---- 5. 关闭按钮：outcome=screen_closed，ui@1 回到 none ----
	const closeButton = slotByLabel(stillOpen, "Close");
	const closeReceipt = await act("close-button", {
		kind: "click_slot",
		screenRef: stillOpen.screenRef,
		uiRevision: stillOpen.uiRevision,
		slot: closeButton.index,
		button: "left",
		buttonDigest: closeButton.buttonDigest,
	});
	log(`close-button outcome=${closeReceipt.outcome}`);
	assert(closeReceipt.outcome === "screen_closed", `closing must report screen_closed, got ${closeReceipt.outcome}`);
	const closed = await readUi();
	assert(closed.kind === "none" && closed.screenRef == null, "ui@1 must report no interface after closing");

	// ---- 6. 聊天富文本：三种 click_event 都要解析出来，且只能执行已观察到的动作 ----
	await say("/uina_chat_actions");
	const actionEvent = [...(await readChat())]
		.reverse()
		.find((event) => event.payload.kind === "chat" && (event.payload.rich?.actions.length ?? 0) >= 3);
	assert(actionEvent != null, "the chat action line must carry at least three click actions");
	const rich = actionEvent.payload.kind === "chat" ? actionEvent.payload.rich : null;
	assert(rich != null, "chat action line must carry rich text");
	const kinds = rich.actions.map((action) => action.kind);
	log(`chat actions on ${actionEvent.ref}: ${kinds.join(", ")}`);
	assert(kinds.includes("run_command"), "run_command click action must be parsed");
	assert(kinds.includes("custom"), "custom click action must be parsed");
	assert(kinds.includes("show_dialog"), "show_dialog click action must be parsed");

	const runAction = rich.actions.find((action) => action.kind === "run_command");
	assert(runAction != null, "run_command action missing");
	const runReceipt = await act("text-run", {
		kind: "activate_text",
		eventRef: actionEvent.ref,
		actionRef: runAction.ref,
	});
	log(`activate run_command (${String(runAction.value)}) outcome=${runReceipt.outcome}`);
	assert(runReceipt.outcome === "sent", `a chat command must report sent, got ${runReceipt.outcome}`);
	await sleep(600);
	assert(
		(await chatTexts()).some((text) => text.includes("clicked-run")),
		"the run_command action must have executed on the server",
	);

	const customAction = rich.actions.find((action) => action.kind === "custom");
	assert(customAction != null, "custom action missing");
	const customReceipt = await act("text-custom", {
		kind: "activate_text",
		eventRef: actionEvent.ref,
		actionRef: customAction.ref,
	});
	log(`activate custom (${String(customAction.value)}) outcome=${customReceipt.outcome}`);
	assert(customReceipt.outcome === "sent", `a custom click action must report sent, got ${customReceipt.outcome}`);

	// 未登记的动作引用必须被拒（不能凭 ref 猜动作）。
	const ghostCode = await actFailure("text-ghost", {
		kind: "activate_text",
		eventRef: actionEvent.ref,
		actionRef: `${actionEvent.ref}/a99`,
	});
	log(`unknown text action rejected with ${ghostCode}`);
	assert(ghostCode === "UI_STALE", `an unobserved text action must fail with UI_STALE, got ${ghostCode}`);

	// ---- 7. show_dialog：本地 Dialog 投影出输入与按钮，命令模板按输入展开 ----
	const dialogAction = rich.actions.find((action) => action.kind === "show_dialog");
	assert(dialogAction != null, "show_dialog action missing");
	const dialogReceipt = await act("text-dialog", {
		kind: "activate_text",
		eventRef: actionEvent.ref,
		actionRef: dialogAction.ref,
	});
	log(`activate show_dialog outcome=${dialogReceipt.outcome}`);
	const dialogUi = await readUi();
	assert(dialogUi.kind === "dialog", `show_dialog must open a dialog view, got ${dialogUi.kind}`);
	assert(dialogUi.dialog != null, "dialog projection missing");
	log(
		`dialog: phase=${dialogUi.dialog.phase} type=${dialogUi.dialog.type} rev=${dialogUi.uiRevision} inputs=${dialogUi.dialog.inputs
			.map((input) => `${input.key}:${input.type}`)
			.join(
				",",
			)} buttons=${dialogUi.dialog.buttons.map((button) => `${textOf(button.label) ?? "?"}→${button.action?.kind ?? "none"}`).join(",")}`,
	);
	assert(
		dialogUi.dialog.inputs.some((input) => input.key === "note" && input.type === "text"),
		"dialog must expose the note text input",
	);
	assert(
		dialogUi.dialog.buttons.length === 3,
		`dialog must expose three buttons, got ${dialogUi.dialog.buttons.length}`,
	);

	// 按显示名定位按钮，不靠顺序：Submit 是命令模板，Close 是内联 ClickEvent。
	const submitButton = dialogUi.dialog.buttons.find((button) => textOf(button.label) === "Submit");
	assert(
		submitButton != null && submitButton.action?.kind === "run_command",
		"the Submit button must resolve to its command template",
	);
	// static 按钮在 1.21.11 是内联 ClickEvent（`{type:"minecraft:run_command"}`），
	// 不是 `minecraft:static`：解析错的话这里会是 none，真服曾经就是这样悄悄丢了动作。
	const staticButton = dialogUi.dialog.buttons.find(
		(button) => button.action?.kind === "run_command" && button.action.value?.startsWith("/uina_say"),
	);
	assert(staticButton != null, "the dialog's static button must resolve to its run_command click event");
	assert(dialogUi.dialog.body.length > 0, "the dialog body must be projected (a single body compound is not a list)");
	const submitReceipt = await act("dialog-submit", {
		kind: "submit_dialog",
		screenRef: dialogUi.screenRef,
		uiRevision: dialogUi.uiRevision,
		buttonRef: submitButton.ref,
		values: { note: "hello-uina" },
	});
	log(`dialog submit outcome=${submitReceipt.outcome} :: ${submitReceipt.detail}`);
	await sleep(700);
	assert(
		(await chatTexts()).some((text) => text.includes("dialog submit: hello-uina")),
		"the dialog command template must have expanded the note input on the server",
	);

	// 未声明的输入键必须在派发前失败。
	const stillDialog = await readUi();
	if (stillDialog.kind === "dialog") {
		const badKeyCode = await actFailure("dialog-bad-key", {
			kind: "submit_dialog",
			screenRef: stillDialog.screenRef,
			uiRevision: stillDialog.uiRevision,
			buttonRef: submitButton.ref,
			values: { note: "x", bogus: "y" },
		});
		log(`undeclared dialog input rejected with ${badKeyCode}`);
		assert(
			badKeyCode === "INVALID_INPUT",
			`an undeclared dialog input must fail with INVALID_INPUT, got ${badKeyCode}`,
		);
		// 对话框的关闭在 1.21.11 是纯客户端行为：没有 serverbound 包，必须如实拒绝，
		// 而不是假装发了一个服务端能收到的东西。
		const closeDialogCode = await actFailure("dialog-close", {
			kind: "close",
			screenRef: stillDialog.screenRef,
			uiRevision: stillDialog.uiRevision,
		});
		log(`closing a dialog is refused with ${closeDialogCode}`);
		assert(
			closeDialogCode === "UNSUPPORTED_WINDOW",
			`closing a dialog must be refused as UNSUPPORTED_WINDOW, got ${closeDialogCode}`,
		);
	} else {
		log("dialog already closed by the server after submit (no local close needed)");
	}

	// ---- 8. HUD 单独验证：scoreboard / bossbar / title / action bar / tab ----
	await say("/uina_hud");
	const hud2 = await readHud();
	assert(hud2 != null, "hud@1 must report elements after /uina_hud");
	log(
		`hud after /uina_hud: sidebar=${String(hud2.scoreboard?.objective)} bossBars=${hud2.bossBars
			.map((bar) => `${String(textOf(bar.title))}@${bar.progress}`)
			.join(",")} title=${String(textOf(hud2.title))} subtitle=${String(textOf(hud2.subtitle))} actionBar=${String(
			textOf(hud2.actionBar),
		)} tab=${String(textOf(hud2.tab?.header ?? null))}/${String(textOf(hud2.tab?.footer ?? null))}`,
	);
	assert(hud2.bossBars.length >= 1, "hud@1 must observe the boss bar");
	assert(textOf(hud2.title) === "Uina Title", `hud@1 must observe the title, got ${String(textOf(hud2.title))}`);
	assert(
		textOf(hud2.actionBar) === "action bar line",
		`hud@1 must observe the action bar, got ${String(textOf(hud2.actionBar))}`,
	);
	assert(textOf(hud2.tab?.header ?? null) === "Uina Header", "hud@1 must observe the tab header");

	// ---- 9. 普通容器回归：菜单之外的原版箱子仍走 container@1 / transfer@1 ----
	const self = await mcWorld.read<{ place: { position: { x: number; y: number; z: number } } }>({
		ref: "self@1",
		input: {},
	});
	const base = self.value?.place.position ?? { x: 0, y: 64, z: 0 };
	const chestAt = { x: Math.floor(base.x) + 2, y: Math.floor(base.y), z: Math.floor(base.z) };
	// 真服实测：1.21.11 的 /item replace block 用 container.0 不生效，带 Items 的 setblock 才落得进去。
	await say(
		`/setblock ${chestAt.x} ${chestAt.y} ${chestAt.z} minecraft:chest{Items:[{slot:0b,id:"minecraft:diamond",count:5}]}`,
	);

	const opened = await call("open-chest", "container@1", { at: chestAt });
	assert(opened.ok, `container@1 must open an ordinary chest: ${opened.ok ? "" : `${opened.code}: ${opened.message}`}`);
	const chestValue = opened.value as { type?: string; freeSlots?: number; slots?: { name: string; count: number }[] };
	log(
		`container@1 → type=${String(chestValue.type)} freeSlots=${String(chestValue.freeSlots)} slots=${JSON.stringify(chestValue.slots)}`,
	);
	assert(chestValue.type === "minecraft:generic_9x3", `a single chest is generic_9x3, got ${String(chestValue.type)}`);
	assert(
		(chestValue.slots ?? []).some((slot) => slot.name === "diamond" && slot.count === 5),
		"container@1 must read the five diamonds the server put in the chest",
	);

	const diamondBeforeTake = await countOf("diamond");
	const taken = await call("take-diamonds", "transfer@1", { from: chestAt, item: "diamond", count: 2 });
	assert(
		taken.ok,
		`transfer@1 must move items out of an ordinary chest: ${taken.ok ? "" : `${taken.code}: ${taken.message}`}`,
	);
	log(`transfer@1 → ${JSON.stringify(taken.value)}`);
	const diamondAfterTake = await countOf("diamond");
	log(`diamonds: ${diamondBeforeTake} → ${diamondAfterTake}`);
	assert(
		diamondAfterTake === diamondBeforeTake + 2,
		"transfer@1 must have moved exactly two diamonds into the inventory",
	);

	const afterChest = await readUi();
	assert(afterChest.kind === "none", `ui@1 must report no interface after container@1 closes: got ${afterChest.kind}`);

	log("PASS: menu / dialog / chat actions / HUD / ordinary container all behaved as specified");
	await closeHarness(h);
	try {
		rmSync(DATA_ROOT, { recursive: true, force: true });
	} catch {
		log(`warn: could not remove ${DATA_ROOT}; it is a throwaway runtime store`);
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	},
);
