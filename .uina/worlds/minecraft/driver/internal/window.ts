/**
 * WindowSession 实现：跨 open 返回与多次 click 的窗口会话。
 *
 * 设计依据 modules/driver.md §12 与 public-api.md §4：
 * - 窗口会话 Operation 跨越 openContainer 返回和多次点击；click 是短子操作，
 *   不因其完成而退役整个窗口。调用作用域/Body 结束、显式关闭或服务端关闭才失效。
 * - 同一窗口的实际修改操作串行执行；预测修改前与派发前都核验资格。
 * - revision 覆盖槽位、光标、类型、布局、属性与来源变化；完整快照比较，
 *   不能只数 updateSlot 或比较原地修改的对象引用。
 * - click 完成范围：点击已派发；本地预测不是服务端确认，completion=unknown。
 * - 普通 close 要求空光标且无未结束手势；作用域退出强制退役不受此阻止。
 */

import type { StackExpectation, WindowSession, WindowSnapshot } from "../../contracts/body.js";
import type { EffectReceipt, Fact, JsonValue, Ref } from "../../contracts/values.js";
import { CallFailureError } from "../../contracts/errors.js";
import {
	controlInvalid,
	cursorNotEmpty,
	invalidArgument,
	referenceStale,
	windowChanged,
	windowGestureActive,
} from "./failure.js";
import { WriteGate, type BodyPermit, type OperationRecord } from "./gate.js";
import type { ClientHost } from "./client-host.js";
import type { ClientBot, BotItemStack, BotWindowData } from "./bot-shape.js";
import { WINDOW_SCHEMA, utcNow } from "./facts.js";
import type { BodyDeps } from "./body.js";

export interface WindowSessionDeps {
	host: ClientHost;
	bot: ClientBot;
	gate: WriteGate;
	permit: BodyPermit;
	/** 窗口会话 Operation：跨多次 click。 */
	op: OperationRecord;
	windowRef: Ref;
	data: BotWindowData;
	deps: BodyDeps;
	onRetire: () => void;
}

function itemKey(i: BotItemStack | null | undefined): string {
	if (i === null || i === undefined) return "∅";
	return `${i.name}#${i.count}#${JSON.stringify(i.components ?? null)}`;
}

function snapshotKey(w: BotWindowData): string {
	return `${w.type}|${w.slotCount}|${w.slots.map((s) => itemKey(s)).join(",")}|cursor=${itemKey(w.cursor)}|props=${JSON.stringify(w.properties)}`;
}

function matchExpectation(item: BotItemStack | null, expected: StackExpectation): boolean {
	if (expected.item === null) {
		return expected.count === 0 && item === null;
	}
	if (item === null) return false;
	if (item.count !== expected.count) return false;
	const names = [expected.item.name, ...(expected.item.substitutions ?? [])];
	if (!names.includes(item.name)) return false;
	if (
		expected.item.components !== undefined &&
		JSON.stringify(expected.item.components) !== JSON.stringify(item.components)
	)
		return false;
	if (expected.item.minDurability !== undefined) {
		const durability = (item.components as { durability?: number } | null)?.durability;
		if (typeof durability !== "number" || durability < expected.item.minDurability) return false;
	}
	return true;
}

export class WindowSessionImpl implements WindowSession {
	readonly #d: WindowSessionDeps;
	readonly #protocolId: number;
	/** 本地窗口观察版本；不直接等同服务端 stateId。 */
	#revision = 0;
	#lastKey: string;
	#retired = false;
	#gestureActive = false;
	#clickChain: Promise<unknown> = Promise.resolve();
	#disposers: (() => void)[] = [];
	#effectCounter = 0;

	constructor(deps: WindowSessionDeps) {
		this.#d = deps;
		this.#protocolId = deps.data.id;
		this.#lastKey = snapshotKey(deps.data);
		this.#wire();
	}

	#wire(): void {
		const bot = this.#d.bot;
		this.#disposers.push(
			bot.on("setSlot", (windowId) => {
				if (windowId !== this.#protocolId) return;
				this.#refreshRevision();
			}),
			bot.on("windowClose", (windowId) => {
				if (windowId !== this.#protocolId) return;
				// 服务端关闭：退役会话并保留最终快照证据。
				void this.#retire("server closed", { closeProtocol: false });
			}),
		);
	}

	#current(): BotWindowData | null {
		if (this.#retired) return null;
		const w = this.#d.bot.currentWindow();
		if (!w || w.id !== this.#protocolId) return null;
		return w;
	}

	#refreshRevision(): void {
		const w = this.#current();
		if (!w) return;
		const key = snapshotKey(w);
		if (key !== this.#lastKey) {
			this.#lastKey = key;
			this.#revision += 1;
		}
	}

	#effectRef(op: OperationRecord): Ref {
		this.#effectCounter += 1;
		return `${op.ref}-e${this.#effectCounter}`;
	}

	#requireUsable(): void {
		if (this.#retired) throw referenceStale("窗口会话已退役；协议 ID 复用不能使旧窗口重新有效");
		const permit = this.#d.permit;
		if (permit.state !== "active") throw controlInvalid(`身体资格状态为 ${permit.state}`);
		const host = this.#d.host;
		if (permit.connectionRef !== host.identity.connection || permit.incarnationRef !== host.identity.incarnation) {
			throw referenceStale("窗口会话的连接/化身代次已更替");
		}
	}

	/** 不可变窗口快照（窗口被覆盖/移除前可捕获）。 */
	#snapshotValue(): WindowSnapshot {
		const w = this.#current()!;
		return {
			window: this.#d.windowRef,
			type: w.type,
			revision: this.#revision,
			layout: { slotCount: w.slotCount, regions: [] },
			properties: JSON.parse(JSON.stringify(w.properties)) as Record<string, JsonValue>,
			slots: w.slots.map((item, slot) => ({
				slot,
				item:
					item === null
						? null
						: ({ name: item.name, count: item.count, components: item.components ?? null } as JsonValue),
			})),
			cursor:
				w.cursor === null
					? null
					: ({ name: w.cursor.name, count: w.cursor.count, components: w.cursor.components ?? null } as JsonValue),
		};
	}

	async snapshot(): Promise<Fact<WindowSnapshot>> {
		this.#requireUsable();
		const w = this.#current();
		if (!w) throw referenceStale("当前窗口已不存在（服务端关闭或已被替换）");
		// 纯读：不触发主动协议操作。
		return {
			value: this.#snapshotValue(),
			observedAt: utcNow(),
			source: "mixed",
			coverage: "complete",
			unknown: [],
			evidence: [],
		};
	}

	async click(input: {
		slot: number;
		button: number;
		mode: number;
		expectedRevision: number;
		expectedSlots: { slot: number; stack: StackExpectation }[];
		expectedCursor: StackExpectation;
	}): Promise<EffectReceipt> {
		// 输入先校验：slot 非负、数量为非负整数；无效在派发前失败。
		if (!Number.isInteger(input.slot) || input.slot < 0) throw invalidArgument("slot 须为非负整数");
		if (!Number.isInteger(input.button) || !Number.isInteger(input.mode)) throw invalidArgument("button/mode 须为整数");
		if (!Number.isInteger(input.expectedRevision)) throw invalidArgument("expectedRevision 须为整数");
		for (const e of input.expectedSlots) {
			if (!Number.isInteger(e.slot) || e.slot < 0) throw invalidArgument("expectedSlots 的 slot 须为非负整数");
			if (!Number.isInteger(e.stack.count) || e.stack.count < 0)
				throw invalidArgument("StackExpectation.count 须为非负整数");
		}
		if (!Number.isInteger(input.expectedCursor.count) || input.expectedCursor.count < 0) {
			throw invalidArgument("expectedCursor.count 须为非负整数");
		}

		// 同一窗口的修改操作串行执行。
		const run = this.#clickChain.then(() => this.#clickOnce(input));
		this.#clickChain = run.catch(() => {});
		return run;
	}

	async #clickOnce(input: {
		slot: number;
		button: number;
		mode: number;
		expectedRevision: number;
		expectedSlots: { slot: number; stack: StackExpectation }[];
		expectedCursor: StackExpectation;
	}): Promise<EffectReceipt> {
		const permit = this.#d.permit;
		this.#requireUsable();
		const w = this.#current();
		if (!w) throw referenceStale("当前窗口已不存在");
		const op = this.#d.gate.createOperation("click", permit, `${this.#d.op.ref}-click-${Date.now() % 1e7}`);
		try {
			// 预期 revision：不符即窗口已变化（§12.3 步骤 3）。
			if (input.expectedRevision !== this.#revision) {
				throw windowChanged(`窗口 revision 不符：期望 ${input.expectedRevision}，当前 ${this.#revision}`);
			}
			// 预期槽位：至少覆盖直接操作槽位；不符返回 WINDOW_CHANGED，不自动换槽/重试。
			for (const e of input.expectedSlots) {
				if (e.slot >= w.slotCount) throw windowChanged(`槽位 ${e.slot} 超出窗口范围`);
				const current = w.slots[e.slot] ?? null;
				if (!matchExpectation(current, e.stack)) {
					throw windowChanged(
						`槽位 ${e.slot} 与预期不符：当前 ${itemKey(current)}，期望 ${e.stack.item === null ? "空" : `${e.stack.item.name}x${e.stack.count}`}`,
					);
				}
			}
			if (!matchExpectation(w.cursor, input.expectedCursor)) {
				throw windowChanged(`光标与预期不符：当前 ${itemKey(w.cursor)}`);
			}
			// 本地预测修改之前再次核验资格（inventory 的 acceptClick 预测先于发包）。
			this.#d.gate.checkWrite(op);
			try {
				await this.#d.bot.clickWindow(this.#protocolId, input.slot, input.button, input.mode);
			} catch (err) {
				// 派发本身失败：上游在发包前抛错（协议 mode 不支持等）。
				throw new CallFailureError({
					code: "CALL_UNAVAILABLE",
					message: `click 派发失败：${err instanceof Error ? err.message : String(err)}`,
					dispatch: "not_sent",
					effects: [this.#effectRef(op)],
				});
			}
			// 派发后：本地预测已发生（上游 acceptClick）。协议确认版本相关：
			// 当前槽位符合预期不必然证明交易完成，completion=unknown。
			this.#refreshRevision();
			this.#d.gate.closeOperation(op);
			return { effect: this.#effectRef(op), dispatch: "sent", completion: "unknown", evidence: [] };
		} catch (err) {
			this.#d.gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			throw invalidArgument("click 失败");
		}
	}

	/** 普通 close：空光标且无未结束手势；只关闭自己的窗口代次。 */
	async close(): Promise<void> {
		if (this.#retired) return; // 幂等。
		this.#requireUsable();
		const w = this.#current();
		if (!w) throw referenceStale("当前窗口已不存在");
		if (w.cursor !== null) throw cursorNotEmpty("光标持有物品；先通过显式操作处置，不隐式丢弃或搬移");
		if (this.#gestureActive) throw windowGestureActive("窗口存在未结束手势");
		await this.#retire("closed by owner", { closeProtocol: true });
	}

	/** 作用域退出/停机：强制退役，不受普通 close 前置条件阻止；保存可能的协议后果。 */
	async forceRetire(reason: string): Promise<void> {
		if (this.#retired) return;
		await this.#retire(`forced: ${reason}`, { closeProtocol: true });
	}

	async #retire(reason: string, opts: { closeProtocol: boolean }): Promise<void> {
		if (this.#retired) return;
		// 原始窗口事实在移除前捕获为不可变证据（§11.2 选定证据）；必须在置位退役标记前读取。
		const w = this.#current();
		if (w) {
			this.#d.host.facts.capture("window", WINDOW_SCHEMA, { ...this.#snapshotValue(), retireReason: reason });
		}
		this.#retired = true;
		for (const d of this.#disposers) d();
		this.#disposers = [];
		if (opts.closeProtocol) {
			try {
				this.#d.bot.closeWindow(this.#protocolId);
			} catch {
				// 上游关闭失败不阻断退役；后果在证据/未知中体现。
			}
		}
		this.#d.host.unregisterWindow(this.#protocolId);
		this.#d.gate.closeOperation(this.#d.op);
		this.#d.onRetire();
		this.#d.host.facts.commitWindowChanged();
	}
}
