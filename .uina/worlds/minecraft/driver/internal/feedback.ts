/**
 * FeedbackStream 实现：高频反馈帧与受控输入应用。
 *
 * 设计依据 public-api.md §4 与 modules/driver.md §8：
 * - 帧观察第 N 步的已完成结果；apply 的输出在后续 M>N 步模拟前安装、由该步消费，
 *   正常返回 appliedStep，不只确认接收入队（不补播、不追溯 N）。
 * - 每流一个顺序在算帧 + 一个 latest-only 待交付槽；next 交付后旧帧不可提交；
 *   同一帧最多消费一次，重复/乱序在任何副作用前失败。
 * - 准入和实际安装边界都核验资格与 validUntil；过期撤销持续输入并记录故障。
 * - 控制流退出时撤销其持续输入；不依赖消费者 finally。
 */

import type {
	ControlInput,
	FeedbackFrame,
	FeedbackFrameRef,
	FeedbackStream,
	Key,
	SelfState,
} from "../../contracts/body.js";
import { CallFailureError } from "../../contracts/errors.js";
import type { EffectReceipt, Fact, JsonValue } from "../../contracts/values.js";
import type { BodyDeps, UseControl } from "./body.js";
import type { ClientBot } from "./bot-shape.js";
import type { ClientHost, PhysicsStep } from "./client-host.js";
import { CONTROL_KEYS, KeyHold } from "./controls.js";
import { controlConflict, controlInvalid, invalidArgument, referenceStale } from "./failure.js";
import { type BodyPermit, type OperationRecord, WriteGate } from "./gate.js";

export interface FeedbackStreamDeps {
	host: ClientHost;
	gate: WriteGate;
	permit: BodyPermit;
	op: OperationRecord;
	bot: ClientBot;
	deps: BodyDeps;
	/** 原生使用状态归属经 Body 会话核验（会话是唯一权威）。 */
	useControl: UseControl;
	sensorFns: Map<string, (bot: ClientBot) => Fact<JsonValue>>;
	onEnd: () => void;
}

interface Waiter {
	after: number;
	resolve: (frame: FeedbackFrame) => void;
	reject: (err: Error) => void;
	onAbort: () => void;
	/** 交付/取消/关流后移除 signal listener；next 是每帧热路径，残留即泄漏。 */
	cleanup: () => void;
}

export class FeedbackStreamImpl implements FeedbackStream {
	readonly #d: FeedbackStreamDeps;
	readonly #streamRef: string;
	#frameSeq = 0;
	/** latest-only 待交付槽：新采样只替换，不使在算帧失效。 */
	#latest: FeedbackFrame | null = null;
	/** 已交付、可 apply 的当前帧；交付新帧后前一帧不可提交。 */
	#delivered: FeedbackFrame | null = null;
	#waiter: Waiter | null = null;
	#closed = false;
	readonly #keyHold: KeyHold;
	#validityTimer: ReturnType<typeof setTimeout> | null = null;
	#unsubscribeStep: (() => void) | null = null;
	#effectCounter = 0;

	constructor(deps: FeedbackStreamDeps) {
		this.#d = deps;
		this.#streamRef = `${deps.permit.ref}-fbstream`;
		this.#keyHold = new KeyHold(deps.bot);
		this.#unsubscribeStep = deps.host.onPhysicsStep((step) => this.#onStep(step));
	}

	get streamRef(): string {
		return this.#streamRef;
	}

	#effectRef(): string {
		this.#effectCounter += 1;
		return `${this.#d.op.ref}-e${this.#effectCounter}`;
	}

	#onStep(step: PhysicsStep): void {
		if (this.#closed) return;
		const facts = this.#d.host.facts;
		let composite: { self: Fact<SelfState | null>; sensors: Record<string, Fact<JsonValue>> };
		try {
			const capture = facts.sample((view) => {
				const self = view.self();
				const sensors: Record<string, Fact<JsonValue>> = {};
				for (const [key, fn] of this.#d.sensorFns) {
					sensors[key] = fn(this.#d.bot);
				}
				return { self, sensors };
			});
			composite = capture.value;
		} catch {
			return; // self 不可用时不发帧；有效期机制会撤销持续输入。
		}
		if (composite.self.value === null) return;
		this.#frameSeq += 1;
		const sampledAt = this.#d.deps.clock();
		const frame: FeedbackFrame = {
			stream: this.#streamRef,
			sequence: this.#frameSeq,
			body: this.#d.permit.ref,
			operation: this.#d.op.ref,
			step: { connection: step.connection, incarnation: step.incarnation, sequence: step.sequence },
			sampledAt,
			validUntil: sampledAt + this.#d.deps.feedbackValidityMs,
			connection: step.connection,
			incarnation: step.incarnation,
			self: composite.self as unknown as FeedbackFrame["self"],
			sensors: composite.sensors as FeedbackFrame["sensors"],
		};
		this.#latest = frame;
		const waiter = this.#waiter;
		if (waiter && frame.sequence > waiter.after) {
			this.#waiter = null;
			// 交付即清槽：next 交付新帧后旧帧不可提交。
			this.#latest = null;
			this.#delivered = frame;
			waiter.resolve(frame);
		}
		// waiter 存在但 frame.sequence <= waiter.after：帧留在槽内，等超过 after 的帧交付。
	}

	#revokeHeld(): void {
		this.#keyHold.releaseAll(); // 只撤销本流按住的键。
		// 使用资源经会话归属释放（不匹配为 no-op）。
		this.#d.useControl.release(this.#d.op);
		if (this.#validityTimer !== null) {
			clearTimeout(this.#validityTimer);
			this.#validityTimer = null;
		}
	}

	async next(after: number | null, signal: AbortSignal): Promise<FeedbackFrame> {
		if (this.#closed) throw controlInvalid("反馈流已关闭");
		// 已中止的 signal 不会再触发 abort 事件：必须显式检查，否则永久挂起。
		if (signal.aborted) {
			throw new CallFailureError({ code: "CONTROL_INVALID", message: "feedback.next 等待被取消", recoverable: true });
		}
		if (this.#waiter) throw controlConflict("上一帧仍在算（next 未返回）；每流只有一个顺序在算帧");
		// latest-only 槽有新帧且序号超前：直接交付。
		if (this.#latest && this.#latest.sequence > (after ?? 0)) {
			const frame = this.#latest;
			this.#latest = null;
			this.#delivered = frame;
			return frame;
		}
		return new Promise<FeedbackFrame>((resolve, reject) => {
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			const onAbort = () => {
				cleanup();
				if (this.#waiter?.onAbort === onAbort) this.#waiter = null;
				reject(
					new CallFailureError({
						code: "CONTROL_INVALID",
						message: "feedback.next 等待被取消",
						recoverable: true,
					}),
				);
			};
			const settleWithFrame = (frame: FeedbackFrame) => {
				cleanup();
				resolve(frame);
			};
			signal.addEventListener("abort", onAbort);
			this.#waiter = { after: after ?? 0, resolve: settleWithFrame, reject, onAbort, cleanup };
		});
	}

	async apply(
		frameRef: FeedbackFrameRef,
		input: ControlInput,
	): Promise<{ receipt: EffectReceipt; appliedStep: PhysicsStep }> {
		const bot = this.#d.bot;
		const host = this.#d.host;
		const permit = this.#d.permit;
		if (this.#closed) throw controlInvalid("反馈流已关闭");

		// 单次消费：准入通过即占掉当前帧，重复/乱序在任何副作用前失败。
		const delivered = this.#delivered;
		if (!delivered || delivered.sequence !== frameRef.sequence || frameRef.stream !== this.#streamRef) {
			throw controlConflict("帧未交付、已消费或乱序；同一帧最多消费一次");
		}
		// 准入边界核验资格与有效期。
		if (this.#d.deps.clock() > delivered.validUntil) {
			this.#delivered = null;
			this.#revokeHeld();
			throw controlInvalid("反馈帧已过期；撤销所属持续输入");
		}
		if (permit.state !== "active") throw controlInvalid(`身体资格状态为 ${permit.state}`);
		if (permit.connectionRef !== host.identity.connection || permit.incarnationRef !== host.identity.incarnation) {
			throw referenceStale("反馈流的连接/化身代次已更替");
		}
		this.#d.gate.checkWrite(this.#d.op);

		// 输入形状校验在消费之前：坏输入不该浪费这一帧的消费名额。
		for (const [k, on] of Object.entries(input.keys ?? {})) {
			const key = k as Key;
			if (!CONTROL_KEYS.includes(key)) throw invalidArgument(`未知控制键: ${k}`);
			void on;
		}
		if (input.look && (!Number.isFinite(input.look.yaw) || !Number.isFinite(input.look.pitch))) {
			throw invalidArgument("look.yaw/pitch 须为有限数值（弧度）");
		}
		this.#delivered = null;

		// 实际安装边界（下一模拟前）：键同步安装；look 由适配层即时生效。
		this.#keyHold.applyFrame(input);
		if (input.look) void bot.look(input.look.yaw, input.look.pitch, true);
		if (input.use) {
			// 使用归属经会话核验：活动中的其他操作持有时拒绝（与 useItem/drive 同一权威）。
			this.#d.useControl.requireAvailable(this.#d.op);
			if (input.use.mode === "hold") {
				if (!bot.usingHeldItem()) {
					const inv = bot.inventorySlots();
					const item = inv.slots[input.use.hand === "off" ? 45 : inv.selectedSlot] ?? null;
					if (!item) {
						this.#revokeHeld();
						throw new CallFailureError({
							code: "TARGET_NOT_MET",
							message: "反馈帧 use 激活时手持为空",
							dispatch: "not_sent",
						});
					}
					bot.activateItem(input.use.hand === "off");
				}
				this.#d.useControl.claim(this.#d.op);
			} else {
				bot.activateItem(input.use.hand === "off");
			}
		} else {
			// 省略 use：释放本流拥有的使用资源（归属不匹配为 no-op）。
			this.#d.useControl.release(this.#d.op);
		}
		if (input.attack) {
			bot.attack(input.attack.networkId); // 每帧最多一次；随帧提交不重放。
		}

		// 等待消费步：下一 physicsTick 即安装输入被消费的 M 步。
		return new Promise((resolve, reject) => {
			const off = host.onPhysicsStep((step) => {
				cleanup();
				const receipt: EffectReceipt = { effect: this.#effectRef(), dispatch: "sent", completion: "met", evidence: [] };
				// 安装边界已过、该步已消费：重置有效期看门狗。
				this.#armValidityWatch();
				resolve({ receipt, appliedStep: step });
			});
			const timer = setTimeout(() => {
				cleanup();
				this.#revokeHeld();
				reject(
					new CallFailureError({
						code: "SOURCE_UNAVAILABLE",
						message: "apply 安装后物理步停滞；输出未应用，不补播",
						dispatch: "sent",
						recoverable: true,
					}),
				);
			}, this.#d.deps.stallTimeoutMs);
			function cleanup() {
				off();
				clearTimeout(timer);
			}
		});
	}

	/** 有效期内未产生下一次更新时撤销持续输入（§8.3 规则 6）。 */
	#armValidityWatch(): void {
		if (this.#validityTimer !== null) clearTimeout(this.#validityTimer);
		if (!this.#keyHold.holdsAny) return;
		this.#validityTimer = setTimeout(
			() => {
				// 有效期窗口内没有新的 apply：撤销持续输入并记录故障事实。
				if (this.#keyHold.holdsAny) {
					this.#revokeHeld();
					this.#d.host.facts.capture(
						"feedback",
						"driver.feedback@1",
						{ kind: "validity-expiry-revoked", stream: this.#streamRef },
						"prediction",
					);
				}
			},
			Math.max(1, this.#d.deps.feedbackValidityMs),
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#revokeHeld();
		this.#unsubscribeStep?.();
		this.#unsubscribeStep = null;
		const waiter = this.#waiter;
		this.#waiter = null;
		waiter?.cleanup(); // 关流不走 signal abort，直接移除 listener。
		waiter?.reject(controlInvalid("反馈流已关闭；旧输出不补播"));
		this.#delivered = null;
		this.#latest = null;
		this.#d.gate.closeOperation(this.#d.op);
		this.#d.onEnd();
	}
}
