/**
 * Window Operation：物品事务与受控同步派发。
 *
 * 内容真值不在本类：槽位/光标/标题/布局都由 `driver/window/state.ts` 的连接级唯一状态提供，
 * 这里只保留**这次操作**的所有权（CAS、busy/uncertain、Effect 记录、监听器退役）。
 * 因此同一次打开同时被物品事务、ui@1 投影与 HUD 观察读取时，三处看到的必须是同一份数据。
 */
import type {
	BlockTarget,
	EntityRef,
	MerchantOfferValue,
	StackExpectation,
	WindowClickOutcome,
	WindowClickReceipt,
	WindowSession,
	WindowSnapshot,
} from "../../contracts/body.js";
import type { ClientWindowObservation } from "../../contracts/client-facts.js";
import { jsonEqual, matchesItem } from "../../contracts/items.js";
import type { EffectReceipt, Fact, JsonValue, Ref } from "../../contracts/values.js";
import { EffectRecorder, fail, nowIso } from "../execution.js";
import type { MineflayerBot } from "../mineflayer/adapter.js";
import { type DriverProtocol, type NativeWindow, protocolFor } from "../mineflayer/protocol.js";
import type { WindowLayout } from "./layout.js";
import { type ConnectionUiNotice, ConnectionWindowState, windowStateFor } from "./state.js";

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

/** 一次操作视角下的窗口内容；由共享连接状态（或玩家库存快照）即时读出，不落第二份缓存。 */
interface SessionView {
	type: string;
	revision: number;
	layout: WindowLayout;
	properties: Record<string, JsonValue>;
	slots: (JsonValue | null)[];
	cursor: JsonValue | null;
	observedAt: string;
	fullSequence: number;
	serverStateId: number | null;
}

function failure(code: string, message: string) {
	return fail({ code, source: "capability", message, dispatch: "not_sent", recoverable: false });
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
	/** 连接级唯一窗口状态；本类只读它，绝不复制槽位。 */
	private readonly state: ConnectionWindowState;
	private readonly detach: (() => void)[] = [];
	/**
	 * 本操作**认领的那个** native 窗口对象。
	 * 网络 windowId 会被服务端复用：同 id 的新窗口必须让旧句柄失效，
	 * 所以身份比对用对象引用，而不是 `screen.native`（共享状态永远指向最新对象）。
	 */
	private opened: NativeWindow | null = null;
	private openSent = false;
	private retired = false;
	private busy = false;
	private uncertain = false;
	/** 是否真的拿到过服务端窗口（决定 open 失败后屏障是否成立）。 */
	private adopted = false;
	/** 上次对外发布窗口证据时的内容修订，避免同一内容重复发布。 */
	private publishedRevision = -1;
	private readonly wake = new Set<() => void>();
	/** 本窗口收到的商人报价；换窗/关闭即作废，不跨窗口复用。 */
	private offerList: MerchantOfferValue[] | null = null;
	/** 玩家自带窗口（window 0）没有 ConnectionWindowState 屏幕，响应归因用本地计数。 */
	private playerFullSequence = 0;
	private playerStateId: number | null = null;
	private playerObservedAt = nowIso();

	constructor(private readonly deps: WindowSessionDeps) {
		this.wire = protocolFor(deps.bot);
		this.wire.assertSupported();
		this.state = windowStateFor(this.wire);
		if (deps.player) {
			if (this.wire.playerSnapshot() === null)
				throw failure("WRONG_STATE", "authoritative player inventory has not arrived");
			this.opened = deps.bot.inventory;
			// 玩家窗口不是服务器打开的界面，不进 ConnectionWindowState；这里只需要响应计数。
			this.detach.push(
				this.wire.subscribe((notice) => {
					if (this.retired) return;
					if (notice.kind === "full" && notice.windowId === 0) {
						this.playerFullSequence++;
						if (notice.stateId !== null) this.playerStateId = notice.stateId;
						this.playerObservedAt = nowIso();
						this.notify();
					} else if (notice.kind === "slot" || notice.kind === "cursor" || notice.kind === "player_slot") {
						this.playerObservedAt = nowIso();
						this.notify();
					}
				}),
			);
		} else {
			this.detach.push(this.state.subscribe(this.onScreen));
			// 商人报价是窗口私有的交易载荷，不属于界面状态；只保留这一条窄订阅。
			this.detach.push(
				this.wire.subscribe((notice) => {
					if (notice.kind === "trades") this.onTrades(notice);
				}),
			);
		}
		deps.signal.addEventListener("abort", this.onAbort, { once: true });
		this.detach.push(() => deps.signal.removeEventListener("abort", this.onAbort));
	}

	/** 当前服务端窗口身份；玩家窗口恒为 bot.inventory。 */
	private nativeWindow(): NativeWindow | null {
		return this.deps.player ? this.deps.bot.inventory : this.opened;
	}

	/**
	 * 本操作可见的窗口内容。
	 * 未同步/无已知布局时返回 null：物品操作需要可验证的区域，未知布局只能由 ui@1 只读查看。
	 */
	private view(): SessionView | null {
		if (this.deps.player) {
			const snapshot = this.wire.playerSnapshot();
			if (snapshot == null) return null;
			return {
				type: snapshot.type,
				revision: snapshot.revision,
				layout: snapshot.layout,
				properties: snapshot.properties,
				slots: snapshot.slots.map((entry) => entry.item),
				cursor: snapshot.cursor,
				observedAt: this.playerObservedAt,
				fullSequence: this.playerFullSequence,
				serverStateId: this.playerStateId,
			};
		}
		const screen = this.state.screen();
		if (screen == null || !screen.synchronized || screen.layout == null) return null;
		return {
			type: screen.type ?? `window-type:${screen.windowType ?? "unknown"}`,
			revision: screen.contentRevision,
			layout: screen.layout,
			properties: screen.properties,
			slots: screen.slots,
			cursor: screen.cursor,
			observedAt: screen.observedAt,
			fullSequence: screen.fullSequence,
			serverStateId: screen.serverStateId,
		};
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
		const native = this.nativeWindow();
		if (native != null) {
			if (this.deps.player ? this.deps.bot.currentWindow !== null : this.deps.bot.currentWindow !== native) {
				this.retire(false);
				return false;
			}
		} else if (!this.deps.player && this.deps.bot.currentWindow !== null) {
			// 服务端窗口已经换人：旧操作不能再读写新窗口。
			this.retire(false);
			return false;
		}
		return true;
	}

	private check(): void {
		this.deps.guard();
		if (!this.live()) throw failure("REFERENCE_STALE", "window Operation is retired or replaced");
	}

	private readonly onScreen = (notice: ConnectionUiNotice): void => {
		if (notice.kind !== "screen") return;
		if (notice.action === "closed") {
			this.retire(false);
			return;
		}
		const screen = notice.screen;
		if (screen == null) return;
		if (screen.native != null) {
			this.adopted = true;
			// 只认领一次：后续同 id 的新对象由 live() 判为替换。
			if (this.opened == null) this.opened = screen.native;
		}
		// 布局无法验证：物品事务没有可信区域，打开阶段立即失败，不等到 5 秒超时。
		// 但必须等到原生窗口就位再判：普通箱子的 window_items 会先于 mineflayer 的 windowOpen
		// 到达，那一刻 synchronized 已是 true 而 native 还是 null，那是中间态，不是结论（真服实测）。
		if (
			screen.synchronized &&
			screen.native != null &&
			screen.layout == null &&
			this.openSent &&
			this.openError === null
		) {
			this.openError = failure(
				"UNSUPPORTED_WINDOW",
				`window ${screen.type ?? String(screen.windowType)} exposes ${screen.slotCount} slots without a verified slot layout`,
			);
			this.retire(true);
			return;
		}
		if (screen.contentRevision !== this.publishedRevision) {
			this.publishedRevision = screen.contentRevision;
			const view = this.view();
			if (view != null && this.deps.target) {
				this.deps.publishWindow?.(structuredClone({ target: this.deps.target, snapshot: this.snapshotOf(view) }));
			}
		}
		this.notify();
	};

	/** trade_list 只属于它报的那个窗口；先到后到都按 id 对齐，不跨窗口保留。 */
	private onTrades = (
		packet: Extract<import("../mineflayer/protocol.js").ProtocolNotice, { kind: "trades" }>,
	): void => {
		if (this.retired) return;
		const screen = this.state.screen();
		const windowId = this.deps.player ? 0 : (screen?.windowId ?? null);
		if (windowId === null || packet.windowId !== windowId) return;
		this.offerList = packet.offers.map((offer) => ({ ...offer }));
		this.notify();
	};

	private readonly onAbort = (): void => this.retire(true);

	private snapshotOf(view: SessionView): WindowSnapshot {
		return {
			window: `window:${this.deps.operation}`,
			type: view.type,
			revision: view.revision,
			layout: view.layout,
			properties: { ...view.properties },
			slots: view.slots.map((item, slot) => ({ slot, item })),
			cursor: view.cursor,
		};
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
		// 身份以 screenRef 为准：激活前就存在的旧屏幕不能被当成本次打开。
		const before = this.state.screen()?.screenRef ?? null;
		try {
			this.check();
			this.openSent = true;
			activate();
			sent = true;
			this.deps.recorder.record(effect, operation, "body.openContainer@1", "dispatch", "sent", "unknown");
			const ready = await this.waitFor(() => {
				const screen = this.state.screen();
				return screen != null && screen.screenRef !== before && screen.synchronized;
			});
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
			const view = this.view();
			if (view == null) throw this.openError ?? failure("UNSUPPORTED_WINDOW", "window has no verifiable slot layout");
			this.deps.recorder.record(effect, operation, "body.openContainer@1", "receipt", "sent", "met", {
				window: `window:${operation}`,
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
		const view = this.view();
		if (view == null) throw failure("WRONG_STATE", "window content has not arrived");
		const value = this.snapshotOf(view);
		const unknown: string[] = [];
		for (const entry of [...value.slots, { slot: -1, item: value.cursor }]) {
			if (
				entry.item !== null &&
				typeof entry.item === "object" &&
				!Array.isArray(entry.item) &&
				entry.item.components === null
			)
				unknown.push(`slot ${entry.slot}: components unavailable`);
		}
		return {
			value: structuredClone(value),
			observedAt: view.observedAt,
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
		const view = this.view();
		const native = this.nativeWindow();
		if (view == null || native === null) throw failure("WRONG_STATE", "window is not ready");
		if (input.expectedRevision !== view.revision) throw failure("CONFLICT", "window revision changed before dispatch");
		if (
			!Number.isInteger(input.slot) ||
			(input.slot < 0 && !(this.deps.player && input.slot === -999)) ||
			input.slot >= view.layout.slotCount ||
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
			!matches(view.cursor, input.expectedCursor) ||
			input.expectedSlots.some(
				(entry) =>
					!Number.isInteger(entry.slot) ||
					entry.slot < 0 ||
					entry.slot >= view.layout.slotCount ||
					!matches(view.slots[entry.slot] ?? null, entry.stack),
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
									: withCount(stack(view.cursor) as Stack, Number(stack(view.cursor)?.count) - 1),
						}
					: expectedClick(view.slots[input.slot] ?? null, view.cursor, input.button);
			const before = view.fullSequence;
			const stateAtDispatch = view.serverStateId;
			const slotBefore = view.slots[input.slot] ?? null;
			const cursorBefore = view.cursor;
			const startedAt = Date.now();
			writing = true;
			this.wire.click(native, input.slot, input.button);
			sent = true;
			this.deps.recorder.record(effect, operation, "body.window.click@1", "dispatch", "sent", "unknown", {
				window: `window:${this.deps.operation}`,
				slot: input.slot,
				button: input.button,
				stateId: stateAtDispatch,
			});
			/**
			 * 真服探针（Paper 1.21.11）：强制 stateId 的 click 每次都收到权威 full 回包，
			 * 而且 window_items 带单调递增 stateId。因此"收到 full"本身就是响应，
			 * 不再要求槽位内容必须变化——内容没变是**明确拒绝**，不是 unknown。
			 * 有 stateId 时用它做因果归因，迟到的初始 full（stateId 不增）不会误结算本次点击。
			 */
			const responded = await this.waitFor(() => {
				const current = this.view();
				if (current == null || current.fullSequence <= before) return false;
				// 只有 stateId 明确倒退（迟到包）才排除；相等/更大都接受，避免把
				// "服务端复用同一状态代次但内容已变"误判成无响应。
				if (stateAtDispatch !== null && current.serverStateId !== null && current.serverStateId < stateAtDispatch)
					return false;
				// 真服 SHELTER 证据：工作台窗口会先回一个"仅同步"的 full（stateId 推进但内容不变），
				// 真正的点击结果随后才到。只凭 full 到达就结算会把同步包误判成拒绝；
				// 因此仍要求 clicked slot / cursor 发生变化，才进入结果分类。
				return !jsonEqual(
					{ slot: current.slots[input.slot] ?? null, cursor: current.cursor },
					{ slot: slotBefore, cursor: cursorBefore },
				);
			});
			const current = this.view();
			const diagnostics = (outcome: WindowClickOutcome): NonNullable<WindowClickReceipt["diagnostics"]> => {
				const slotAfter = current?.slots[input.slot] ?? null;
				const cursorAfter = current?.cursor ?? null;
				return {
					stateBefore: stateAtDispatch,
					stateAfter: current?.serverStateId ?? null,
					slot: input.slot,
					button: input.button,
					elapsedMs: Date.now() - startedAt,
					slotChanged: !jsonEqual(slotAfter, slotBefore),
					cursorChanged: !jsonEqual(cursorAfter, cursorBefore),
					recovery:
						outcome === "unknown"
							? "no authoritative full was attributable to this click; close this window, reopen a controlled session, re-read server state before any further inventory write"
							: outcome === "diverged"
								? "server state diverged from the predicted result; cursor may be held, close and reopen before computing remaining work"
								: "server confirmed the exact clicked slot and cursor result; no recovery needed",
				};
			};
			if (!responded || !this.live()) return this.unknown(effect, operation, diagnostics("unknown"));
			this.check();
			const settled = this.view();
			if (settled == null) return this.unknown(effect, operation, diagnostics("unknown"));
			const actual = { slot: settled.slots[input.slot] ?? null, cursor: settled.cursor };
			const matched = expected !== null && jsonEqual(actual, expected);
			if (matched) {
				this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", "sent", "met", {
					window: `window:${this.deps.operation}`,
					completionContract: "forced-stateId business click returned the exact mode-0 clicked slot and cursor result",
					stateId: settled.serverStateId,
				});
				return {
					effect,
					dispatch: "sent",
					completion: "met",
					evidence: [],
					confirmed: this.snapshotOf(settled),
					needsSnapshot: false,
					outcome: "confirmed",
					diagnostics: diagnostics("confirmed"),
				};
			}
			// 状态确实变了，但与客户端预测不符：不做成功推断，也不抹掉已派发事实。
			// 注意：内容完全没变的 full 不能证明拒绝——真服上它可能只是同步包，
			// 所以那种情况继续等（超时后按 unknown 结算），不在这里猜。
			this.uncertain = true;
			this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", "sent", "unknown", {
				window: `window:${this.deps.operation}`,
				completionContract: "authoritative state diverged from the predicted click result",
				stateId: settled.serverStateId,
			});
			return {
				effect,
				dispatch: "sent",
				completion: "unknown",
				evidence: [],
				needsSnapshot: true,
				outcome: "diverged",
				diagnostics: diagnostics("diverged"),
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

	private unknown(effect: Ref, operation: Ref, diagnostics?: WindowClickReceipt["diagnostics"]): WindowClickReceipt {
		this.uncertain = true;
		this.deps.recorder.record(effect, operation, "body.window.click@1", "receipt", "sent", "unknown", {
			completionContract: "click dispatched but authoritative synchronization did not complete; no automatic retry",
		});
		return {
			effect,
			dispatch: "sent",
			completion: "unknown",
			evidence: [],
			needsSnapshot: true,
			outcome: "unknown",
			...(diagnostics ? { diagnostics } : {}),
		};
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
		const native = this.nativeWindow();
		const view = this.view();
		if (native === null || view == null) throw failure("WRONG_STATE", "window is not ready");
		const type = view.type;
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
		const view = this.view();
		if (view == null) throw failure("WRONG_STATE", "window content has not arrived");
		return {
			value: this.offerList === null ? null : structuredClone(this.offerList),
			observedAt: view.observedAt,
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
		this.offerList = null;
		this.notify();
		const native = this.nativeWindow();
		if (
			closeNative &&
			native !== null &&
			(this.deps.player ? this.deps.bot.currentWindow === null : this.deps.bot.currentWindow === native) &&
			this.deps.canCleanup()
		) {
			const effect = this.deps.mintEff();
			// 判定必须在派发**之前**取快照：关闭包本身会让服务端把光标物品塞回背包并发
			// cursor/slot 更新，派发后再读就把"关闭导致的正常变化"当成了"关不干净"。
			// 真服实证（task shelter）：一次成功的 craft 因这条 cleanup 记成 unknown，
			// 整个 Run 被结算成 unknown，尽管房子已经建成、服务端判决全绿。
			const before = this.view();
			const cursor = before?.cursor ?? null;
			const cursorKnown = before !== null && !this.uncertain && !this.busy;
			try {
				this.wire.close(native);
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
		this.deps.onRetired(this.openSent && !this.adopted);
	}

	async close(options?: { force?: boolean }): Promise<void> {
		if (this.retired) return;
		if (options?.force !== true) {
			this.check();
			const view = this.view();
			if (view === null || view.cursor !== null || this.uncertain || this.busy) {
				throw failure(
					"CURSOR_NOT_EMPTY",
					"ordinary window close requires a confirmed empty cursor; forced cleanup may have unknown return/drop consequences",
				);
			}
		}
		this.retire(true);
	}
}
