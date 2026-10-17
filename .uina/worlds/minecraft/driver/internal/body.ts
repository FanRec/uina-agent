/**
 * BodySession / PlayerPort 实现：受控玩家的真实操作边界。
 *
 * 设计依据 public-api.md §4 与 modules/driver.md §6–7、§10：
 * - acquire FIFO：同一时刻最多一个有效资格；并发 acquire 排队，冲突申请明确拒绝。
 * - drive 的 ticks 是实际消费本次输入的客户端物理步：在首个消费步开始计数，
 *   第 ticks 步结束后、下一次模拟前撤销持续键/use（physicsTick 是模拟后事件）。
 * - 旧异步操作在每次 await 恢复后、实际写入前重新核验资格；迟到回调被拒绝。
 * - dig(preserve) 复用上游 ignore-look 路径，不暗中覆盖视角；dig(target) 才瞄准。
 * - useItem 一次激活；留下的原生使用状态归 Body 使用会话，endUse 独立结束。
 * - 回执只承诺低层完成范围：sent 只表示进入本地协议派发。
 */

import type {
	BlockTarget,
	BodySession,
	ControlInput,
	EntityRef,
	FeedbackStream,
	Hand,
	ItemSelector,
	SelfState,
	WindowSession,
} from "../../contracts/body.js";
import { CallFailureError } from "../../contracts/errors.js";
import type { EffectReceipt, Fact, JsonValue, Ref, Vec3 } from "../../contracts/values.js";
import type { WorldQuery } from "../../contracts/world.js";
import { BotFailure, type BotBlockPos, type BotItemSelector, type BotWindowData, type ClientBot } from "./bot-shape.js";
import type { ClientHost, PhysicsStep } from "./client-host.js";
import { KeyHold } from "./controls.js";
import {
	controlConflict,
	controlInvalid,
	fromBotFailure,
	invalidArgument,
	referenceStale,
	sourceUnavailable,
	targetNotMet,
} from "./failure.js";
import { FeedbackStreamImpl } from "./feedback.js";
import { type BodyPermit, type OperationRecord, WriteGate } from "./gate.js";
import { WindowSessionImpl } from "./window.js";

export interface BodyDeps {
	host: ClientHost;
	gate: WriteGate;
	clock: () => number;
	/** drive/apply 等待物理步的停滞超时（毫秒）。 */
	stallTimeoutMs: number;
	/** openContainer 等待 windowOpen 的超时（毫秒）。 */
	openTimeoutMs: number;
	/** 反馈帧输入有效期（毫秒）；帧 validUntil 与无更新撤销看门狗共用。 */
	feedbackValidityMs: number;
	/** 传感器实现：确切查询 ref → 快速纯采样。组合根注入。 */
	sensors: Map<string, (bot: ClientBot) => Fact<JsonValue>>;
}

/** 原生使用状态归属接口：Body 会话实现；feedback 流按 op 核验、登记与释放。 */
export interface UseControl {
	/** 冲突检查：活动中的其他操作持有原生使用状态时拒绝。 */
	requireAvailable(op: OperationRecord): void;
	/** 登记归属。 */
	claim(op: OperationRecord): void;
	/** 归属匹配时释放（deactivateItem + 清空）；不匹配为 no-op。 */
	release(op: OperationRecord): void;
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function validateBlockTarget(target: BlockTarget): BotBlockPos {
	if (!target || typeof target !== "object") throw invalidArgument("目标缺失");
	const b = target.block;
	if (
		!isFiniteNumber(b.x) ||
		!isFiniteNumber(b.y) ||
		!isFiniteNumber(b.z) ||
		!Number.isInteger(b.x) ||
		!Number.isInteger(b.y) ||
		!Number.isInteger(b.z)
	) {
		throw invalidArgument("block 各分量须为整数");
	}
	return { x: b.x, y: b.y, z: b.z };
}

function validateEntityRef(host: ClientHost, target: EntityRef): void {
	if (target.connection !== host.identity.connection) {
		throw referenceStale("实体引用的连接代次已更替");
	}
	if (target.incarnation !== host.identity.incarnation) {
		throw referenceStale("实体引用的化身代次已更替");
	}
	if (host.appearanceOf(target.networkId) !== target.appearance) {
		throw referenceStale("实体出现代次已更替，旧引用不能指向新实体");
	}
}

/** 轴向单位法向校验：face 必须是 ±x/±y/±z 单位向量。 */
function validateFace(face: Vec3): void {
	const axes: Vec3[] = [
		{ x: 1, y: 0, z: 0 },
		{ x: -1, y: 0, z: 0 },
		{ x: 0, y: 1, z: 0 },
		{ x: 0, y: -1, z: 0 },
		{ x: 0, y: 0, z: 1 },
		{ x: 0, y: 0, z: -1 },
	];
	if (!axes.some((a) => a.x === face.x && a.y === face.y && a.z === face.z)) {
		throw invalidArgument("face 须为轴向单位法向");
	}
}

/** cursor 须在方块内 [0,1] 且位于指定面上。 */
function validateCursor(cursor: Vec3, face: Vec3 | undefined): void {
	for (const v of [cursor.x, cursor.y, cursor.z]) {
		if (!isFiniteNumber(v) || v < 0 || v > 1) throw invalidArgument("cursor 分量须在 [0,1] 内");
	}
	if (face) {
		if (face.x === 1 && cursor.x !== 1) throw invalidArgument("cursor 不在指定面 +x 上");
		if (face.x === -1 && cursor.x !== 0) throw invalidArgument("cursor 不在指定面 -x 上");
		if (face.y === 1 && cursor.y !== 1) throw invalidArgument("cursor 不在指定面 +y 上");
		if (face.y === -1 && cursor.y !== 0) throw invalidArgument("cursor 不在指定面 -y 上");
		if (face.z === 1 && cursor.z !== 1) throw invalidArgument("cursor 不在指定面 +z 上");
		if (face.z === -1 && cursor.z !== 0) throw invalidArgument("cursor 不在指定面 -z 上");
	}
}

function matchItemSelector(
	item:
		| { name: string; count: number; components: JsonValue | null; remainingDurability: number | null }
		| null
		| undefined,
	selector: BotItemSelector,
): boolean {
	if (!item) return false;
	const names = [selector.name, ...(selector.substitutions ?? [])];
	if (!names.includes(item.name)) return false;
	if (selector.components !== undefined && JSON.stringify(selector.components) !== JSON.stringify(item.components))
		return false;
	// 耐久只认接缝的 remainingDurability（上游 maxDurability - durabilityUsed）；
	// 不再从 components 里猜字段名——1.20.5+ 的组件是 [{type,data}]，猜不中。
	if (selector.minDurability !== undefined) {
		if (item.remainingDurability === null || item.remainingDurability < selector.minDurability) return false;
	}
	return true;
}

/** 等待 count 个物理步；返回取消函数。停滞由墙钟检测，不无限等待。 */
function waitForPhysicsSteps(
	host: ClientHost,
	stallTimeoutMs: number,
	count: number,
	onStep: (step: PhysicsStep, consumed: number) => void,
): {
	promise: Promise<PhysicsStep>;
	cancel: () => void;
	cancelWith: (err: Error) => void;
	consumedSoFar: () => number;
} {
	let unsubscribe: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let settled = false;
	let consumedTotal = 0;
	let rejectExternal: ((err: Error) => void) | null = null;
	const promise = new Promise<PhysicsStep>((resolve, reject) => {
		rejectExternal = reject;
		let consumed = 0;
		unsubscribe = host.onPhysicsStep((step) => {
			consumed += 1;
			consumedTotal = consumed;
			try {
				onStep(step, consumed);
			} catch (err) {
				settled = true;
				cleanup();
				reject(err);
				return;
			}
			if (consumed >= count && !settled) {
				settled = true;
				cleanup();
				resolve(step);
			}
		});
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new CallFailureError({
					code: "SOURCE_UNAVAILABLE",
					message: `等待物理步停滞超过 ${stallTimeoutMs}ms（模拟未推进）`,
					dispatch: "sent",
					recoverable: true,
					progress: {
						summary: "drive 因物理步停滞中断",
						measures: [{ name: "actualTicks", value: consumedTotal, unit: "steps", evidence: [] }],
					},
				}),
			);
		}, stallTimeoutMs);
	});
	function cleanup() {
		unsubscribe?.();
		unsubscribe = null;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}
	return {
		promise,
		cancel: cleanup,
		cancelWith(err: Error) {
			if (settled) return;
			settled = true;
			cleanup();
			rejectExternal?.(err);
		},
		consumedSoFar: () => consumedTotal,
	};
}

export class BodySessionImpl implements BodySession {
	readonly #deps: BodyDeps;
	readonly #permit: BodyPermit;
	readonly #gate: WriteGate;
	readonly #bot: ClientBot;
	readonly #windows = new Set<WindowSessionImpl>();
	readonly #streams = new Set<FeedbackStreamImpl>();
	/** 当前连续控制根：最多一个，未经协调的第二个报 CONTROL_CONFLICT。 */
	#continuousRoot: OperationRecord | null = null;
	/** Body 使用会话归属：useItem/hold 留下的原生使用状态归此 op 所有（唯一权威）。 */
	#useOwner: OperationRecord | null = null;
	#opCounter = 0;
	#closed = false;
	#effectCounter = 0;

	constructor(
		deps: BodyDeps,
		permit: BodyPermit,
		gate: WriteGate,
		bot: ClientBot,
		private readonly onClosed?: () => void,
	) {
		this.#deps = deps;
		this.#permit = permit;
		this.#gate = gate;
		this.#bot = bot;
	}

	get bodyRef(): Ref {
		return this.#permit.ref;
	}

	#newOp(kind: Parameters<WriteGate["createOperation"]>[0]): OperationRecord {
		// 会话内单调计数保证 ref 唯一：ops.size 会因 close 复用而撞号。
		this.#opCounter += 1;
		// gate 是操作记录唯一集合；会话按 permit 枚举（operationsOf）撤销。
		return this.#gate.createOperation(kind, this.#permit, `${this.#permit.ref}-${kind}-${this.#opCounter}`);
	}

	// ---- 原生使用状态归属（唯一权威；drive/useItem/feedback 经此核验）----

	#requireUseAvailable(op: OperationRecord): void {
		if (this.#useOwner && this.#useOwner.state === "active" && this.#useOwner !== op) {
			throw controlConflict("原生使用状态被其他操作持有；切换或结束须由协调者显式处理");
		}
	}

	#claimUse(op: OperationRecord): void {
		this.#useOwner = op;
	}

	#releaseUse(op: OperationRecord): void {
		if (this.#useOwner === op) {
			this.#bot.deactivateItem();
			this.#useOwner = null;
		}
	}

	#effectRef(op: OperationRecord): Ref {
		this.#effectCounter += 1;
		return `${op.ref}-e${this.#effectCounter}`;
	}

	#receipt(
		op: OperationRecord,
		dispatch: "not_sent" | "sent" | "unknown",
		completion: "met" | "not_met" | "unknown",
		evidence: Ref[] = [],
	): EffectReceipt {
		return { effect: this.#effectRef(op), dispatch, completion, evidence };
	}

	/** 连续根准入：两个无协调关系的持续控制器不能并行（§6.3）。 */
	#claimContinuous(op: OperationRecord): void {
		if (this.#continuousRoot && this.#continuousRoot.state === "active" && this.#continuousRoot !== op) {
			throw controlConflict("已有活动连续控制根（drive/feedback）；无协调关系的第二个持续控制器被拒绝");
		}
		this.#continuousRoot = op;
	}

	#releaseContinuous(op: OperationRecord): void {
		if (this.#continuousRoot === op) this.#continuousRoot = null;
	}

	#requireUsable(): void {
		if (this.#closed) throw controlInvalid("Body 会话已关闭");
		const host = this.#deps.host;
		if (host.state !== "ready") {
			throw sourceUnavailable(`连接状态为 ${host.state}，不能执行身体操作`);
		}
		if (this.#permit.state !== "active") {
			throw controlInvalid(`身体资格状态为 ${this.#permit.state}`);
		}
		if (
			this.#permit.connectionRef !== host.identity.connection ||
			this.#permit.incarnationRef !== host.identity.incarnation
		) {
			throw referenceStale("身体资格的连接/化身代次已更替");
		}
	}

	#requireHeldItem(hand: Hand, op: OperationRecord): void {
		const inv = this.#bot.inventorySlots();
		const slotIndex = hand === "off" ? 45 : inv.selectedSlot;
		const item = inv.slots[slotIndex] ?? null;
		if (!item) {
			throw new CallFailureError({
				code: "TARGET_NOT_MET",
				message: `${hand === "off" ? "副手" : "主手"}为空，use_item 不会派发（上游空手激活是静默 no-op）`,
				dispatch: "not_sent",
				effects: [this.#effectRef(op)],
			});
		}
	}

	// ---- drive ----

	async drive(
		input: ControlInput,
		ticks: number,
	): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }> {
		const bot = this.#bot;
		const host = this.#deps.host;
		if (!Number.isInteger(ticks) || ticks < 1) throw invalidArgument("drive 的 ticks 须为正整数");
		this.#requireUsable();

		const op = this.#newOp("drive");
		try {
			this.#claimContinuous(op);
		} catch (err) {
			this.#gate.closeOperation(op);
			throw err;
		}
		// 已消费步数跨安装/等待阶段追踪：取消与停滞错误必须携带 actualTicks（错误合同）。
		let consumedSoFar = 0;
		let cancelWait: ((err: Error) => void) | null = null;
		const keyHold = new KeyHold(bot);
		let disposed = false;
		op.onRevoke = () => {
			revokeOwned();
			cancelWait?.(
				new CallFailureError({
					code: "CONTROL_INVALID",
					message: "drive 在等待物理步期间被撤销",
					dispatch: "sent",
					effects: [op.ref],
					progress: {
						summary: "drive 被撤销",
						measures: [{ name: "actualTicks", value: consumedSoFar, unit: "steps", evidence: [] }],
					},
				}),
			);
		};

		const revokeOwned = () => {
			if (disposed) return;
			disposed = true;
			keyHold.releaseAll(); // 只撤销本根按住的键，不碰其他根/新主人。
			// 只撤销本次 drive 拥有的使用资源（归属匹配才释放）。
			this.#releaseUse(op);
			// 自然完成：直接结算操作记录；不触发 onRevoke（那是外部撤销通道）。
			this.#gate.closeOperation(op);
			this.#releaseContinuous(op);
		};

		try {
			// 安装：视角 → 键 → use → attack。look 是异步的；恢复后重新核验再继续写入。
			if (input.look) {
				if (!isFiniteNumber(input.look.yaw) || !isFiniteNumber(input.look.pitch)) {
					throw invalidArgument("look.yaw/pitch 须为有限数值（弧度）");
				}
				await bot.look(input.look.yaw, input.look.pitch, true);
				this.#gate.checkWrite(op); // 异步恢复后、继续写入前重查。
			}
			keyHold.applyInput(input);
			if (input.use) {
				this.#requireUseAvailable(op);
				if (input.use.mode === "hold") {
					if (!bot.usingHeldItem()) {
						this.#requireHeldItem(input.use.hand, op);
						bot.activateItem(input.use.hand === "off");
					}
					this.#claimUse(op);
				} else {
					// once：同一次有效提交最多执行一次，不建立自动重复激活。
					this.#requireHeldItem(input.use.hand, op);
					bot.activateItem(input.use.hand === "off");
				}
			}
			if (input.attack) {
				validateEntityRef(host, input.attack);
				bot.attack(input.attack.networkId);
			}
			this.#gate.checkWrite(op);

			// 计数：physicsTick 是本次模拟后事件；安装发生在下一模拟之前，
			// 因此下一个 physicsTick 即第一个消费步。第 ticks 步的处理器内撤销，
			// 保证在下次模拟前生效（不依赖额外定时器或包计数）。
			const wait = waitForPhysicsSteps(host, this.#deps.stallTimeoutMs, ticks, (_step, consumed) => {
				consumedSoFar = consumed;
				if (consumed >= ticks) revokeOwned();
			});
			cancelWait = (err) => wait.cancelWith(err);
			try {
				await wait.promise;
			} finally {
				op.onRevoke = undefined;
			}
			const captured = host.facts.sample((v) => v.self());
			const inner = captured.value;
			if (inner === null || inner.value === null) throw sourceUnavailable("drive 结束采样不可用");
			const endFact: Fact<SelfState> = { ...inner, value: inner.value };
			const receipt: EffectReceipt = {
				effect: this.#effectRef(op),
				dispatch: "sent",
				completion: "met",
				evidence: [],
			};
			return { receipt, actualTicks: ticks, end: endFact };
		} catch (err) {
			revokeOwned();
			// 取消/失效/停滞：保留已有步数与效果引用，不把短执行包装成完整成功。
			if (err instanceof CallFailureError) throw err;
			throw new CallFailureError({
				code: "CONTROL_INVALID",
				message: `drive 被中断：${err instanceof Error ? err.message : String(err)}`,
				dispatch: "sent",
				effects: [op.ref],
				recoverable: false,
			});
		}
	}

	// ---- dig ----

	async dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt> {
		const bot = this.#bot;
		const facts = this.#deps.host.facts;
		const pos = validateBlockTarget(target);
		const aim = options?.aim ?? "target";
		this.#requireUsable();
		const op = this.#newOp("dig");
		op.onRevoke = () => {
			// 撤销立即取消在途上游挖掘，不等迟到回调。
			try {
				bot.stopDigging();
			} catch {
				// 无活动挖掘时为 no-op。
			}
		};

		// 兼容准入：dig(target) 要调整视角，与活动连续根的视角输出真实冲突；
		// dig(preserve) 复用上游 ignore-look 路径，保留现有视角（§6.3 兼容表）。
		if (aim === "target" && this.#continuousRoot && this.#continuousRoot.state === "active") {
			this.#gate.closeOperation(op);
			throw controlConflict("dig(target) 需要调整视角，与活动连续控制冲突；同协调者的组合须使用 aim=preserve");
		}

		try {
			const block = bot.blockAt(pos);
			if (!block) {
				throw sourceUnavailable("目标方块未加载；不能把未知格当作可挖目标", [op.ref]);
			}
			if (aim === "target") {
				const s = bot.self();
				const cx = pos.x + 0.5;
				const cy = pos.y + 0.5;
				const cz = pos.z + 0.5;
				const dx = cx - s.position.x;
				const dy = cy - (s.position.y + 1.62);
				const dz = cz - s.position.z;
				// mineflayer 视角约定：yaw = atan2(-dx, dz)，pitch = -atan2(dy, 水平距)。
				const yaw = Math.atan2(-dx, dz);
				const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
				await bot.look(yaw, pitch, true);
				this.#gate.checkWrite(op); // 异步恢复后、派发前重查（§17.3 迟到写入拒绝）。
			}
			// forceLook=true 仅 target 模式；preserve 走上游 ignore-look 路径（digging.js dig(block, 'ignore')），
			// 不得暗中覆盖视角。
			// 预测登记必须先于派发：上游 dig 完成会立刻同步 emit blockUpdate，
			// 若等 await 回来再登记，第一条通知早被当成 server 提交掉了（§11.6）。
			facts.markBlockPredicted(pos);
			await bot.dig(pos, { forceLook: aim === "target" });
			this.#gate.checkWrite(op);
			// 本地预测捕获：上游 dig 完成会把目标格预测为空气（_updateBlockState(position, 0)）；
			// 这是预测事实，不是服务端确认。
			const after = bot.blockAt(pos);
			const digEvidence = this.#deps.host.facts.capture(
				"dig",
				"driver.dig@1",
				{
					op: op.ref,
					target: { x: pos.x, y: pos.y, z: pos.z },
					aim,
					localPredicted: after === null ? null : { name: after.name, properties: after.properties },
				} as JsonValue,
				"prediction",
			);
			// 预测标记已在本操作派发前登记；这里只推进变化通知。
			facts.commitBlockChanged();
			this.#gate.closeOperation(op);
			// 回执携带已取得的证据（§13）：预测证据 ref 随低层完成回执交付结算方。
			return this.#receipt(op, "sent", "met", [digEvidence.ref]);
		} catch (err) {
			// 清理只处理本操作的资源：取消上游挖掘状态，并撤掉本次登记的预测标记。
			try {
				bot.stopDigging();
			} catch {
				// 上游无活动挖掘时 stopDigging 是 no-op。
			}
			facts.unmarkBlockPredicted(pos);
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			if (err instanceof BotFailure) throw fromBotFailure(err, [op.ref]);
			throw new CallFailureError({
				code: "CALL_UNAVAILABLE",
				message: `dig 派发失败：${err instanceof Error ? err.message : String(err)}`,
				dispatch: "not_sent",
				effects: [op.ref],
			});
		}
	}

	// ---- attack ----

	async attack(target: EntityRef): Promise<EffectReceipt> {
		this.#requireUsable();
		const op = this.#newOp("attack");
		try {
			// attack 不暗中瞄准或清键；一次攻击尝试派发即低层完成（不承诺命中）。
			validateEntityRef(this.#deps.host, target);
			this.#gate.checkWrite(op);
			this.#bot.attack(target.networkId);
			this.#gate.closeOperation(op);
			return this.#receipt(op, "sent", "met");
		} catch (err) {
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			throw invalidArgument("attack 目标无效");
		}
	}

	// ---- useItem / endUse ----

	async useItem(hand: Hand): Promise<EffectReceipt> {
		this.#requireUsable();
		const op = this.#newOp("use");
		try {
			this.#requireUseAvailable(op);
			this.#requireHeldItem(hand, op);
			this.#gate.checkWrite(op);
			this.#bot.activateItem(hand === "off");
			// 激活短操作返回不结束可能留下的使用状态：归 Body 使用会话。
			if (this.#bot.usingHeldItem()) {
				this.#claimUse(op);
			}
			this.#gate.closeOperation(op);
			return this.#receipt(op, "sent", "met");
		} catch (err) {
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			throw invalidArgument("useItem 失败");
		}
	}

	async endUse(): Promise<EffectReceipt> {
		this.#requireUsable();
		const op = this.#newOp("endUse");
		try {
			this.#gate.checkWrite(op);
			if (this.#bot.usingHeldItem() && this.#useOwner) {
				// 结束可能释放蓄力效果（如放箭）——这是派发效果，不是零副作用清理。
				this.#releaseUse(this.#useOwner);
				return this.#receipt(op, "sent", "met");
			}
			// 幂等：所属使用状态已结束，不重复发 release。
			return this.#receipt(op, "not_sent", "met");
		} finally {
			this.#gate.closeOperation(op);
		}
	}

	// ---- interact ----

	async interact(input: {
		target: BlockTarget | EntityRef;
		hand: Hand;
		face?: Vec3;
		cursor?: Vec3;
	}): Promise<EffectReceipt> {
		this.#requireUsable();
		const op = this.#newOp("interact");
		try {
			this.#gate.checkWrite(op);
			if ("networkId" in input.target) {
				validateEntityRef(this.#deps.host, input.target);
				// 上游先转头再写包，await 完成才代表协议派发真的发生；失败即 not_sent。
				await this.#bot.activateEntity(input.target.networkId);
				this.#gate.checkWrite(op); // 异步恢复后、结算前核验资格。
				this.#gate.closeOperation(op);
				return this.#receipt(op, "sent", "met");
			}
			const pos = validateBlockTarget(input.target);
			if (input.face) validateFace(input.face);
			if (input.cursor) validateCursor(input.cursor, input.face);
			if (!this.#bot.blockAt(pos)) {
				throw sourceUnavailable("目标方块未加载", [op.ref]);
			}
			await this.#bot.activateBlock(pos, input.face ?? null, input.cursor ?? null);
			this.#gate.checkWrite(op);
			this.#gate.closeOperation(op);
			return this.#receipt(op, "sent", "met");
		} catch (err) {
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			// 适配层分类（方块未加载、实体已移除、上游 lookAt 失败）优先于兜底，
			// 否则"目标不在视野/已消失"会被误报成参数错误。
			if (err instanceof BotFailure) throw fromBotFailure(err, [op.ref]);
			throw invalidArgument("interact 输入无效");
		}
	}

	// ---- equip ----

	async equip(item: ItemSelector, hand: Hand): Promise<EffectReceipt> {
		this.#requireUsable();
		const op = this.#newOp("equip");
		try {
			const inv = this.#bot.inventorySlots();
			const found = inv.slots.findIndex((s) => matchItemSelector(s, item as BotItemSelector));
			if (found === -1) {
				throw targetNotMet("背包中未找到匹配物品", {
					summary: "equip 物品选择失败",
					measures: [{ name: "examinedSlots", value: inv.slots.length, unit: "slots", evidence: [] }],
				});
			}
			this.#gate.checkWrite(op);
			await this.#bot.equip(
				{
					name: item.name,
					components: item.components,
					minDurability: item.minDurability,
					substitutions: item.substitutions,
				},
				hand,
			);
			this.#gate.checkWrite(op); // 异步恢复后核验。
			this.#gate.closeOperation(op);
			return this.#receipt(op, "sent", "met");
		} catch (err) {
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			// 适配层的失败分类（unavailable/stale/invalid）优先于统一兜底。
			if (err instanceof BotFailure) throw fromBotFailure(err, [op.ref]);
			throw new CallFailureError({
				code: "CALL_UNAVAILABLE",
				message: `equip 派发失败：${err instanceof Error ? err.message : String(err)}`,
				dispatch: "not_sent",
				effects: [op.ref],
			});
		}
	}

	// ---- openContainer ----

	async openContainer(target: BlockTarget | EntityRef): Promise<WindowSession> {
		const host = this.#deps.host;
		this.#requireUsable();
		const op = this.#newOp("window");
		try {
			// 同一客户端只允许一个在途打开（§12.2）。
			if (host.openingInProgress) throw controlConflict("已有在途窗口打开");
			const isEntity = "networkId" in target;
			if (isEntity) {
				validateEntityRef(host, target as EntityRef);
			} else {
				const pos = validateBlockTarget(target as BlockTarget);
				if (!this.#bot.blockAt(pos)) throw sourceUnavailable("目标方块未加载", [op.ref]);
			}
			host.openingInProgress = true;
			try {
				this.#gate.checkWrite(op);
				// 打开意图先登记（同步 emit 不能被错过），再激活：等待 windowOpen，
				// 超时按"已派发、结果未知"处理，不自动重试。
				let rejectOpen: ((e: Error) => void) | null = null;
				op.onRevoke = () => {
					rejectOpen?.(controlInvalid("openContainer 等待窗口期间被撤销"));
				};
				// 激活失败时撤销等待（监听 + 定时器），否则会白等满 openTimeoutMs。
				let cancelWait = (): void => {};
				const windowOpenPromise = new Promise<BotWindowData>((resolve, reject) => {
					rejectOpen = reject;
					const off = this.#bot.on("windowOpen", (w) => {
						cleanup();
						resolve(w);
					});
					const timer = setTimeout(() => {
						cleanup();
						reject(
							new CallFailureError({
								code: "EFFECT_UNCERTAIN",
								message: "openContainer 激活已派发但窗口未在期限内打开；效果未知，不自动重试",
								dispatch: "sent",
								effects: [op.ref],
							}),
						);
					}, this.#deps.openTimeoutMs);
					const cleanup = () => {
						off();
						clearTimeout(timer);
					};
					cancelWait = cleanup;
				});
				// 先等协议派发完成：lookAt 失败时包没发出去，必须立即失败而不是报 EFFECT_UNCERTAIN。
				try {
					if (isEntity) await this.#bot.activateEntity((target as EntityRef).networkId);
					else await this.#bot.activateBlock(validateBlockTarget(target as BlockTarget), null, null);
				} catch (err) {
					cancelWait();
					throw err;
				}
				const windowData: BotWindowData = await windowOpenPromise;

				this.#gate.checkWrite(op); // 归因核验后再绑定。
				const windowRef = host.registerWindow(windowData.id);
				const session = new WindowSessionImpl({
					host,
					bot: this.#bot,
					gate: this.#gate,
					permit: this.#permit,
					op,
					windowRef,
					data: windowData,
					deps: this.#deps,
					onRetire: () => this.#windows.delete(session),
				});
				this.#windows.add(session);
				return session;
			} finally {
				host.openingInProgress = false;
			}
		} catch (err) {
			this.#gate.closeOperation(op);
			if (err instanceof CallFailureError) throw err;
			if (err instanceof BotFailure) throw fromBotFailure(err, [op.ref]);
			throw new CallFailureError({
				code: "CALL_UNAVAILABLE",
				message: `openContainer 失败：${err instanceof Error ? err.message : String(err)}`,
				dispatch: "not_sent",
				effects: [op.ref],
			});
		}
	}

	// ---- feedback ----

	async feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream> {
		this.#requireUsable();
		// 传感校验：本地键 → 确切查询；未登记的传感在建流前失败，不静默漏键。
		for (const [key, query] of Object.entries(sensors)) {
			if (!this.#deps.sensors.has(query.ref)) {
				throw new CallFailureError({
					code: "SENSOR_UNAVAILABLE",
					message: `传感 ${key}（${query.ref}）未登记；不静默漏键`,
				});
			}
		}
		const selfCheck = this.#deps.host.facts.sample((v) => v.self());
		if (!selfCheck.value) {
			throw new CallFailureError({
				code: "SENSOR_UNAVAILABLE",
				message: "self 尚不能形成真实 SelfState；不创建反馈流、不虚构位置/生命值",
			});
		}
		const op = this.#newOp("feedback");
		try {
			this.#claimContinuous(op);
		} catch (err) {
			this.#gate.closeOperation(op);
			throw err;
		}
		// 使用状态归属经本会话核验：会话是唯一权威。
		const useControl: UseControl = {
			requireAvailable: (o) => this.#requireUseAvailable(o),
			claim: (o) => this.#claimUse(o),
			release: (o) => this.#releaseUse(o),
		};
		const stream = new FeedbackStreamImpl({
			host: this.#deps.host,
			gate: this.#gate,
			permit: this.#permit,
			op,
			bot: this.#bot,
			deps: this.#deps,
			useControl,
			sensorFns: new Map(Object.entries(sensors).map(([k, q]) => [k, this.#deps.sensors.get(q.ref)!])),
			onEnd: () => {
				this.#releaseContinuous(op);
				this.#streams.delete(stream);
			},
		});
		this.#streams.add(stream);
		return stream;
	}

	// ---- 生命周期 ----

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// 先撤销本会话全部活动操作（gate 按 permit 枚举，唯一操作集合）：
		// drive 计步取消、dig 停止、openContainer 等待中止。
		for (const op of this.#gate.operationsOf(this.#permit)) {
			this.#gate.revokeOperation(op);
		}
		// 作用域退出：强制退役窗口（不受普通 close 前置条件阻止），撤销连续输入。
		for (const w of [...this.#windows]) {
			await w.forceRetire("body closed").catch(() => {});
		}
		for (const s of [...this.#streams]) {
			await s.close().catch(() => {});
		}
		// Body 使用会话强制清理并保存后果（释放蓄力可能产生真实效果）。
		if (this.#bot.usingHeldItem() && this.#useOwner) {
			this.#bot.deactivateItem();
			this.#deps.host.facts.capture(
				"use",
				"driver.use@1",
				{ kind: "forced-release", body: this.#permit.ref },
				"prediction",
			);
			this.#useOwner = null;
		}
		this.#gate.quiesce(this.#permit);
		// 屏障完成：资格与操作记录结算。
		this.#gate.close(this.#permit);
		this.onClosed?.();
	}
}
