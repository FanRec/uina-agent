/** Window Operation: authoritative server snapshots, guarded synchronous dispatch, exact listener retirement. */
import type {
	BlockTarget,
	EntityRef,
	MerchantOfferValue,
	StackExpectation,
	WindowClickReceipt,
	WindowSession,
	WindowSnapshot,
} from "../../contracts/body.js";
import type { ClientWindowObservation } from "../../contracts/client-facts.js";
import { jsonEqual, matchesItem } from "../../contracts/items.js";
import type { EffectReceipt, Fact, JsonValue, Ref } from "../../contracts/values.js";
import { EffectRecorder, fail, nowIso } from "../execution.js";
import type { MineflayerBot } from "../mineflayer/adapter.js";
import { type DriverProtocol, type NativeWindow, type ProtocolNotice, protocolFor } from "../mineflayer/protocol.js";
import { windowLayout } from "./layout.js";

const RESPONSE_MS = 5000;
type ClickInput = Parameters<WindowSession["click"]>[0];
export interface WindowSessionDeps {
	bot: MineflayerBot;
	signal: AbortSignal;
	operation: Ref;
	connection: Ref;
	incarnation: Ref;
	target?: BlockTarget | EntityRef;
	player?: boolean;
	recorder: EffectRecorder;
	mintOp(): Ref;
	mintEff(): Ref;
	/** Includes Body, connection, incarnation and this Window Operation ownership. */
	guard(): void;
	/** Cleanup is allowed during Body revocation, only on the original connection/incarnation. */
	canCleanup(): boolean;
	enterOp(): void;
	exitOp(): void;
	onRetired(unresolvedOpening: boolean): void;
	publishWindow?(value: ClientWindowObservation | null): void;
}

function failure(code: string, message: string) {
	return fail({ code, source: "capability", message, dispatch: "not_sent", recoverable: false });
}

function layout(window: NativeWindow): WindowSnapshot["layout"] {
	const result = windowLayout(String(window.type), window.slots.length, window.inventoryStart, window.inventoryEnd);
	if ("reason" in result) throw failure("UNSUPPORTED_WINDOW", result.reason);
	return result.layout;
}

function matches(value: JsonValue | null, expected: StackExpectation): boolean {
	if (expected.item === null) return value === null && expected.count === 0;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		value.count === expected.count &&
		matchesItem(expected.item, value as unknown as import("../../contracts/body.js").ItemValue)
	);
}

function validExpectation(expected: StackExpectation): boolean {
	return Number.isInteger(expected.count) && expected.count >= 0 && (expected.item !== null || expected.count === 0);
}

type Stack = { [key: string]: JsonValue };
function stack(value: JsonValue | null): Stack | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function withCount(value: Stack, count: number): JsonValue | null {
	return count === 0 ? null : { ...value, count };
}

/** Pure expected mode-0 result, used only to compare a server response; never installed in Mineflayer. */
function expectedClick(
	slotValue: JsonValue | null,
	cursorValue: JsonValue | null,
	button: number,
): { slot: JsonValue | null; cursor: JsonValue | null } | null {
	const slot = stack(slotValue);
	const cursor = stack(cursorValue);
	if (cursor === null) {
		if (slot === null) return { slot: null, cursor: null };
		const taken = button === 0 ? Number(slot.count) : Math.ceil(Number(slot.count) / 2);
		return { slot: withCount(slot, Number(slot.count) - taken), cursor: withCount(slot, taken) };
	}
	if (slot === null) {
		const placed = button === 0 ? Number(cursor.count) : 1;
		return { slot: withCount(cursor, placed), cursor: withCount(cursor, Number(cursor.count) - placed) };
	}
	if (slot.name === cursor.name) {
		if (slot.components === null || cursor.components === null) return null;
		if (jsonEqual(slot.components, cursor.components) && slot.durability === cursor.durability) {
			if (typeof slot.stackSize !== "number") return null;
			const placed = Math.min(button === 0 ? Number(cursor.count) : 1, slot.stackSize - Number(slot.count));
			return {
				slot: withCount(slot, Number(slot.count) + placed),
				cursor: withCount(cursor, Number(cursor.count) - placed),
			};
		}
	}
	return { slot: cursorValue, cursor: slotValue };
}

export class WindowSessionImpl implements WindowSession {
	private readonly wire: DriverProtocol;
	private native: NativeWindow | null = null;
	private value: WindowSnapshot | null = null;
	private observedAt = nowIso();
	private openSent = false;
	private retired = false;
	private busy = false;
	private uncertain = false;
	private fullSequence = 0;
	private readonly wake = new Set<() => void>();
	private readonly earlyFull = new Map<number, Extract<ProtocolNotice, { kind: "full" }>>();
	private readonly detach: (() => void)[] = [];
	/** 本窗口收到的商人报价；换窗/关闭即作废，不跨窗口复用。 */
	private offerList: MerchantOfferValue[] | null = null;

	constructor(private readonly deps: WindowSessionDeps) {
		this.wire = protocolFor(deps.bot);
		this.wire.assertSupported();
		if (deps.player) {
			const initial = this.wire.playerSnapshot();
			if (initial === null) throw failure("WRONG_STATE", "authoritative player inventory has not arrived");
			this.native = deps.bot.inventory;
			this.value = { ...initial, window: `window:${deps.operation}` };
		}
		this.detach.push(
			this.wire.subscribe((notice) => {
				switch (notice.kind) {
					case "window_open":
						this.onOpen(notice.window);
						break;
					case "window_close":
						this.onClose(notice.window);
						break;
					case "end":
						this.onEnd();
						break;
					case "replacement":
						this.onReplacement();
						break;
					case "full":
						this.onFull(notice);
						break;
					case "slot":
						this.onSlot(notice);
						break;
					case "cursor":
						this.onCursor(notice);
						break;
					case "player_slot":
						this.onPlayerInventory(notice);
						break;
					case "property":
						this.onProperty(notice);
						break;
					case "trades":
						this.onTrades(notice);
						break;
				}
			}),
		);
		deps.signal.addEventListener("abort", this.onAbort, { once: true });
		this.detach.push(() => deps.signal.removeEventListener("abort", this.onAbort));
	}

	private live(): boolean {
		if (this.retired) return false;
		try {
			this.deps.guard();
		} catch (error) {
			// A delegated parent's window remains an observation source. Its public
			// check() still rejects writes while suspended; identity replacement retires it below.
			if ((error as { code?: string }).code !== "BODY_SUSPENDED") {
				this.retire(false);
				return false;
			}
		}
		if (
			this.native != null &&
			(this.deps.player ? this.deps.bot.currentWindow !== null : this.deps.bot.currentWindow !== this.native)
		) {
			this.retire(false);
			return false;
		}
		return true;
	}

	private check(): void {
		this.deps.guard();
		if (!this.live()) throw failure("REFERENCE_STALE", "window Operation is retired or replaced");
	}

	private readonly onOpen = (window: NativeWindow): void => {
		if (this.deps.player || !this.live()) return;
		if (this.native !== null) {
			if (window !== this.native) this.retire(false);
			return;
		}
		this.native = window;
		this.offerList = null;
		const early = this.earlyFull.get(window.id);
		this.earlyFull.clear();
		if (early !== undefined) this.onFull(early);
		this.notify();
	};
	private readonly onReplacement = (): void => {
		if (this.native != null) this.live();
	};
	private readonly onClose = (window: NativeWindow | null): void => {
		if (window === this.native) this.retire(false);
	};
	private readonly onEnd = (): void => this.retire(false);
	private readonly onAbort = (): void => this.retire(true);

	private readonly onFull = (packet: Extract<ProtocolNotice, { kind: "full" }>): void => {
		if (!this.live()) return;
		const native = this.native;
		if (native === null) {
			this.earlyFull.set(packet.windowId, packet);
			return;
		}
		if (packet.windowId !== native.id) return;
		try {
			const next: WindowSnapshot = {
				window: `window:${this.deps.operation}`,
				type: String(native.type),
				revision: this.value?.revision ?? 0,
				layout: this.deps.player ? (this.value as WindowSnapshot).layout : layout(native),
				properties: this.value?.properties ?? {},
				slots: packet.items.map((item, slot) => ({ slot, item })),
				cursor: packet.cursor,
			};
			if (next.slots.length !== next.layout.slotCount) return;
			this.fullSequence++;
			this.update(next);
		} catch (error) {
			this.openError = error;
			this.retire(true);
		}
	};

	private readonly onSlot = (packet: Extract<ProtocolNotice, { kind: "slot" }>): void => {
		if (!this.live() || this.value === null || this.native === null) return;
		if (packet.windowId === -1 && packet.slot === -1) {
			this.update({ ...this.value, cursor: packet.item });
			return;
		}
		if (packet.windowId !== this.native.id || packet.slot < 0 || packet.slot >= this.value.layout.slotCount) return;
		this.update({
			...this.value,
			slots: this.value.slots.map((entry) =>
				entry.slot === packet.slot ? { slot: entry.slot, item: packet.item } : entry,
			),
		});
	};
	private readonly onCursor = (packet: Extract<ProtocolNotice, { kind: "cursor" }>): void => {
		if (!this.live() || this.value === null || this.native === null) return;
		this.update({ ...this.value, cursor: packet.item });
	};
	private readonly onPlayerInventory = (packet: Extract<ProtocolNotice, { kind: "player_slot" }>): void => {
		if (!this.live() || this.value === null || this.native === null) return;
		const slot = this.deps.player
			? packet.slot
			: packet.slot >= 9 && packet.slot <= 44
				? this.native.inventoryStart + packet.slot - 9
				: -1;
		if (slot < 0) return;
		this.update({
			...this.value,
			slots: this.value.slots.map((entry) => (entry.slot === slot ? { slot, item: packet.item } : entry)),
		});
	};
	private readonly onProperty = (packet: { windowId: number; property: number; value: number }): void => {
		if (!this.live() || this.value === null || this.native?.id !== packet.windowId) return;
		this.update({ ...this.value, properties: { ...this.value.properties, [packet.property]: packet.value } });
	};
	/** trade_list 只属于它报的那个窗口；先到后到都按 id 对齐，不跨窗口保留。 */
	private readonly onTrades = (packet: Extract<ProtocolNotice, { kind: "trades" }>): void => {
		if (this.retired || this.native?.id !== packet.windowId) return;
		this.offerList = packet.offers.map((offer) => ({ ...offer }));
		this.notify();
	};

	private update(next: WindowSnapshot): void {
		const previous = this.value;
		if (previous != null && jsonEqual(previous, next)) {
			this.notify();
			return;
		}
		// revision 是点击的 CAS 前置条件，只约束内容（槽位与光标）。炉子进度每秒变化多次，
		// 若也推进 revision，燃烧期间每次点击都会在派发前撞 CONFLICT。
		const contentChanged =
			previous == null ||
			previous.type !== next.type ||
			!jsonEqual(previous.layout, next.layout) ||
			!jsonEqual(previous.slots, next.slots) ||
			!jsonEqual(previous.cursor, next.cursor);
		this.value =
			previous == null ? next : { ...next, revision: contentChanged ? previous.revision + 1 : previous.revision };
		this.observedAt = nowIso();
		// 证据只记内容变化：进度包不构成新的窗口观察事实。
		if (contentChanged && this.deps.target) {
			this.deps.publishWindow?.(structuredClone({ target: this.deps.target, snapshot: this.value }));
		}
		this.notify();
	}
	private notify(): void {
		for (const callback of [...this.wake]) callback();
	}
	private waitFor(predicate: () => boolean): Promise<boolean> {
		if (predicate()) return Promise.resolve(true);
		if (this.retired) return Promise.resolve(false);
		return new Promise((resolve) => {
			let done = false;
			const finish = (value: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.wake.delete(check);
				resolve(value);
			};
			const check = () => {
				if (this.retired) finish(false);
				else if (predicate()) finish(true);
			};
			const timer = setTimeout(() => finish(false), RESPONSE_MS);
			this.wake.add(check);
			check();
		});
	}

	private openError: unknown = null;
	async open(activate: () => void): Promise<void> {
		const operation = this.deps.operation;
		const effect = this.deps.mintEff();
		let sent = false;
		try {
			this.check();
			this.openSent = true;
			activate();
			sent = true;
			this.deps.recorder.record(effect, operation, "body.openContainer@1", "dispatch", "sent", "unknown");
			const ready = await this.waitFor(() => this.value !== null);
			if (!ready) {
				throw (
					this.openError ??
					fail({
						code: this.retired ? "CONTROL_INVALID" : "TIMEOUT",
						source: "environment",
						message: "container did not provide a supported authoritative window within 5000 ms",
						dispatch: "sent",
						effects: [effect],
						recoverable: false,
					})
				);
			}
			this.check();
			this.deps.recorder.record(effect, operation, "body.openContainer@1", "receipt", "sent", "met", {
				window: this.value?.window ?? null,
				completionContract: "server window and complete slot/cursor contents received",
			});
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "CallFailure" &&
				(error as import("../../contracts/values.js").CallFailure).dispatch === "not_sent"
			) {
				this.openSent = false;
				this.retire(false);
				throw error;
			}
			this.deps.recorder.record(
				effect,
				operation,
				"body.openContainer@1",
				"receipt",
				sent ? "sent" : "unknown",
				"unknown",
			);
			this.retire(true);
			throw error;
		}
	}

	async snapshot(): Promise<Fact<WindowSnapshot>> {
		this.check();
		if (this.uncertain)
			throw failure(
				"WINDOW_UNCERTAIN",
				"window must be closed after an unconfirmed click; do not retry the business click",
			);
		if (this.value === null) throw failure("WRONG_STATE", "window content has not arrived");
		const unknown: string[] = [];
		for (const entry of [...this.value.slots, { slot: -1, item: this.value.cursor }]) {
			if (
				entry.item !== null &&
				typeof entry.item === "object" &&
				!Array.isArray(entry.item) &&
				entry.item.components === null
			)
				unknown.push(`slot ${entry.slot}: components unavailable`);
		}
		return {
			value: structuredClone(this.value),
			observedAt: this.observedAt,
			connection: this.deps.connection,
			incarnation: this.deps.incarnation,
			source: "server",
			coverage: unknown.length === 0 ? "complete" : "partial",
			unknown,
			evidence: [],
		};
	}

	async click(input: ClickInput): Promise<WindowClickReceipt> {
		this.check();
		if (this.busy) throw failure("CONTROL_CONFLICT", "another click is pending on this window");
		if (this.uncertain)
			throw failure(
				"WINDOW_UNCERTAIN",
				"previous click is unconfirmed; close the window before further business clicks",
			);
		const value = this.value;
		const native = this.native;
		if (value === null || native === null) throw failure("WRONG_STATE", "window is not ready");
		if (input.expectedRevision !== value.revision) throw failure("CONFLICT", "window revision changed before dispatch");
		if (
			!Number.isInteger(input.slot) ||
			(input.slot < 0 && !(this.deps.player && input.slot === -999)) ||
			input.slot >= value.layout.slotCount ||
			input.mode !== 0 ||
			![0, 1].includes(input.button)
		)
			throw failure("INVALID_INPUT", "only in-window mode 0 left/right clicks are supported");
		if (
			(input.slot !== -999 && !input.expectedSlots.some((entry) => entry.slot === input.slot)) ||
			!validExpectation(input.expectedCursor) ||
			input.expectedSlots.some((entry) => !validExpectation(entry.stack))
		) {
			throw failure(
				"INVALID_INPUT",
				"expectedSlots must cover the clicked slot; stack counts must be nonnegative integers and null stacks must have count zero",
			);
		}
		if (
			!matches(value.cursor, input.expectedCursor) ||
			input.expectedSlots.some(
				(entry) =>
					!Number.isInteger(entry.slot) ||
					entry.slot < 0 ||
					entry.slot >= value.layout.slotCount ||
					!matches(value.slots[entry.slot].item, entry.stack),
			)
		)
			throw failure("CONFLICT", "window revision or stack expectation changed before dispatch");
		this.busy = true;
		this.deps.enterOp();
		const operation = this.deps.mintOp();
		const effect = this.deps.mintEff();
		let sent = false;
		let writing = false;
		try {
			this.check();
			const expected =
				input.slot === -999
					? {
							slot: null,
							cursor:
								input.button === 0
									? null
									: withCount(stack(value.cursor) as Stack, Number(stack(value.cursor)?.count) - 1),
						}
					: expectedClick(value.slots[input.slot]?.item ?? null, value.cursor, input.button);
			const before = this.fullSequence;
			writing = true;
			this.wire.click(native, input.slot, input.button);
			sent = true;
			this.deps.recorder.record(effect, operation, "body.window.click@1", "dispatch", "sent", "unknown", {
				window: value.window,
				slot: input.slot,
				button: input.button,
			});
			// A delayed initial full must not settle a dispatched click while its real response is pending.
			// Unchanged-only packets cannot prove rejection and therefore time out as unknown.
			const confirmed = await this.waitFor(
				() =>
					this.fullSequence > before &&
					this.value !== null &&
					!jsonEqual(
						{ slot: this.value.slots[input.slot]?.item ?? null, cursor: this.value.cursor },
						{ slot: value.slots[input.slot]?.item ?? null, cursor: value.cursor },
					),
			);
			if (!confirmed || !this.live() || this.value === null) return this.unknown(effect, operation);
			this.check();
			const actual = { slot: this.value.slots[input.slot]?.item ?? null, cursor: this.value.cursor };
			if (expected === null || !jsonEqual(actual, expected)) return this.unknown(effect, operation);
			const completion = "met";
			this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", "sent", completion, {
				window: value.window,
				completionContract: "forced-stateId business click returned the exact mode-0 clicked slot and cursor result",
			});
			return {
				effect,
				dispatch: "sent",
				completion,
				evidence: [],
				confirmed: structuredClone(this.value),
				needsSnapshot: false,
			};
		} catch (error) {
			if (sent) return this.unknown(effect, operation);
			const failure = error as import("../../contracts/values.js").CallFailure;
			const dispatch =
				failure?.name === "CallFailure" && failure.dispatch === "not_sent"
					? "not_sent"
					: writing
						? "unknown"
						: "not_sent";
			if (dispatch !== "not_sent") {
				this.uncertain = true;
				this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", dispatch, "unknown");
			}
			if (failure?.name === "CallFailure") throw failure;
			throw fail({
				code: "INTERNAL",
				source: "environment",
				message: error instanceof Error ? error.message : String(error),
				dispatch,
				effects: dispatch === "not_sent" ? [] : [effect],
				recoverable: false,
			});
		} finally {
			this.busy = false;
			this.deps.exitOp();
		}
	}

	private unknown(effect: Ref, operation: Ref): WindowClickReceipt {
		this.uncertain = true;
		this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", "sent", "unknown", {
			completionContract: "click dispatched but authoritative synchronization did not complete; no automatic retry",
		});
		return { effect, dispatch: "sent", completion: "unknown", evidence: [], needsSnapshot: true };
	}

	/**
	 * 工作站专用提交（批 15）：只写包，不改 revision、不做槽位预测、不置 uncertain。
	 * 完成合同与 chat 同口径——"包已进入当前连接的协议发送边界"，
	 * 由此产生的窗口状态是另一次观察，由能力层按证据判定。
	 */
	private commit(
		contract: `${string}@${string}`,
		expect: string[],
		detail: Record<string, JsonValue>,
		write: (native: NativeWindow) => void,
	): EffectReceipt {
		this.check();
		const native = this.native;
		if (native === null || this.value === null) throw failure("WRONG_STATE", "window is not ready");
		const type = String(native.type);
		if (!expect.includes(type))
			throw failure("WRONG_STATE", `${contract} needs ${expect.join(" or ")}, this window is ${type}`);
		const operation = this.deps.operation;
		const effect = this.deps.mintEff();
		try {
			write(native);
		} catch (error) {
			this.deps.recorder.record(effect, operation, contract, "dispatch", "not_sent", "unknown", detail);
			if ((error as { name?: string }).name === "CallFailure") throw error;
			throw fail({
				code: "INTERNAL",
				source: "environment",
				message: error instanceof Error ? error.message : String(error),
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		this.deps.recorder.record(effect, operation, contract, "dispatch", "sent", "unknown", detail);
		this.deps.recorder.record(effect, operation, contract, "receipt", "sent", "met", {
			completionContract:
				"selection packet written into the protocol send boundary; the resulting window state is a separate observation",
		});
		return { effect, dispatch: "sent", completion: "met", evidence: [] };
	}

	async selectEnchant(offer: 1 | 2 | 3): Promise<EffectReceipt> {
		if (![1, 2, 3].includes(offer)) throw failure("INVALID_INPUT", "enchantment offer must be 1, 2 or 3");
		return this.commit("body.window.selectEnchant@1", ["minecraft:enchantment"], { offer }, (native) =>
			this.wire.selectEnchant(native, offer),
		);
	}

	async renameItem(name: string): Promise<EffectReceipt> {
		return this.commit("body.window.renameItem@1", ["minecraft:anvil"], { name }, () => this.wire.renameItem(name));
	}

	async selectTrade(index: number): Promise<EffectReceipt> {
		if (!Number.isInteger(index) || index < 0)
			throw failure("INVALID_INPUT", "trade index must be a nonnegative integer");
		return this.commit("body.window.selectTrade@1", ["minecraft:merchant"], { index }, () =>
			this.wire.selectTrade(index),
		);
	}

	async offers(): Promise<Fact<MerchantOfferValue[] | null>> {
		this.check();
		if (this.value === null) throw failure("WRONG_STATE", "window content has not arrived");
		return {
			value: this.offerList === null ? null : structuredClone(this.offerList),
			observedAt: this.observedAt,
			connection: this.deps.connection,
			incarnation: this.deps.incarnation,
			source: "server",
			coverage: this.offerList === null ? "partial" : "complete",
			unknown: this.offerList === null ? ["no trade_list received for this window"] : [],
			evidence: [],
		};
	}

	/** Synchronous retirement: no old callback can publish, click or close a replacement window. */
	retire(closeNative: boolean): void {
		if (this.retired) return;
		this.retired = true;
		for (const detach of this.detach.splice(0)) detach();
		this.earlyFull.clear();
		this.offerList = null;
		this.notify();
		const native = this.native;
		if (
			closeNative &&
			native !== null &&
			(this.deps.player ? this.deps.bot.currentWindow === null : this.deps.bot.currentWindow === native) &&
			this.deps.canCleanup()
		) {
			const effect = this.deps.mintEff();
			try {
				this.wire.close(native);
				const cursor = this.value?.cursor ?? null;
				const cursorKnown = this.value !== null && !this.uncertain && !this.busy;
				this.deps.recorder.record(
					effect,
					this.deps.operation,
					"body.window.close@1",
					"cleanup",
					"sent",
					cursorKnown && cursor === null ? "met" : "unknown",
					{
						cursor,
						completionContract:
							cursorKnown && cursor === null
								? "native window close synchronously dispatched with an empty cursor"
								: "window closed; server cursor return/drop consequences are not confirmed",
					},
				);
			} catch {
				this.deps.recorder.record(effect, this.deps.operation, "body.window.close@1", "cleanup", "unknown", "unknown");
			}
		}
		if (this.deps.target) this.deps.publishWindow?.(null);
		this.deps.onRetired(this.openSent && native === null);
	}

	async close(options?: { force?: boolean }): Promise<void> {
		if (this.retired) return;
		if (options?.force !== true) {
			this.check();
			if (this.value === null || this.value.cursor !== null || this.uncertain || this.busy) {
				throw failure(
					"CURSOR_NOT_EMPTY",
					"ordinary window close requires a confirmed empty cursor; forced cleanup may have unknown return/drop consequences",
				);
			}
		}
		this.retire(true);
	}
}
