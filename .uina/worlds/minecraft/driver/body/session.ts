/**
 * Body Session：资格门、持续控制与离散身体操作（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4、modules/driver.md §5–§7、§10、§13。
 * 状态机 active → revoking → quiesced → closed（§5.2）；revoking 不可逆；结束须新建资格。
 * 写入核验位置（I1 覆盖 §5.3 的 1/2/3/4）：操作入口、异步恢复后产生副作用前、
 * 控制状态修改前、修改插件目标前；位置 5/6（协议业务包、共享状态清理）随窗口
 * 与告示牌路径接入时补全。未实现操作（writeSign/openContainer/feedback）显式失败。
 * 低层完成合同名（body.*@1）由 Driver 拥有；公开能力合同归 capabilities。
 * drive 的 Tick = 实际客户端物理模拟步（§7.2）：首个消费步开始计数，第 N 个
 * 消费步结束后、下一次模拟前撤销持续键/use（physicsTick 监听内同步撤销，
 * 上游 simulatePlayer 在 emit 前读取 controlState，构成模拟前窄接缝）。
 */

import type {
	BlockTarget,
	BodySession,
	ControlInput,
	EntityRef,
	FeedbackStream,
	Hand,
	ItemSelector,
	Key,
	ControlOwner,
	PointTarget,
	SelfState,
	SignText,
	WindowSession,
} from "../../contracts/body.js";
import type { WorldQuery } from "../../contracts/world.js";
import type { DriverExecutionSink } from "../../contracts/runtime.js";
import type { CallFailure, EffectReceipt, ExactRef, Fact, JsonValue, Ref, Vec3 } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";
import type { ClientHostListener } from "../client-host.js";
import { toMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";

/** mineflayer 实体类型别名（index.d.ts 不直接导出 Entity）。 */
type MFEntity = NonNullable<MineflayerBot["entities"][string]>;

export type BodySessionState = "active" | "revoking" | "quiesced" | "closed";

/** 测试窄接缝：session 只依赖此视图；ClientHost 结构满足。 */
export interface HostView {
	readonly state: "connecting" | "syncing" | "ready" | "disconnected" | "faulted";
	readonly identity: { connection: Ref; incarnation: Ref } | null;
	on(listener: (notice: ClientHostListener) => void): () => void;
}

export interface BodySessionDeps {
	host: HostView;
	/** DriverExecutionSink（public-api §7.1）；返回 null 时锁存 recorder fault 并封闭新副作用。 */
	sink: DriverExecutionSink;
	/** 组合根注入的自采样（复用同一事实源纯查询）；不可用时返回 null。 */
	sampleSelf: () => Fact<SelfState | null> | null;
	bot: () => MineflayerBot | null;
	/** Driver 级唯一发号：op:/eff: 空间跨会话单调，保证 EffectRecord 引用不碰撞。 */
	mintOp: () => Ref;
	mintEff: () => Ref;
	/** 会话 closed 后回调（PlayerPort 由此清当前资格并核查屏障是否成立）。 */
	onClosed: (barrierProven: boolean) => void;
}

const DRIVE_KEYS: Key[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];
/** drive 停滞看门狗：物理循环暂停不得导致无限等待（§7.2），墙钟只作停滞检测。 */
const DRIVE_STALL_MS = 2000;
/** dig start 包观察期限：超时按 unknown 记派发，不推断成功。 */
const DIG_DISPATCH_OBSERVE_MS = 500;

function nowIso(): string {
	return new Date().toISOString();
}

/** 事实 detail 只收纯 JSON 值；合同类型（Vec3/EntityRef 等）经序列化落库。 */
function plain(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function fail(data: {
	code: string;
	source: CallFailure["source"];
	message: string;
	hint?: string;
	dispatch: CallFailure["dispatch"];
	progress?: { summary?: string } & Record<string, JsonValue>;
	effects?: Ref[];
	recoverable: boolean;
}): CallFailure {
	return callFailure({
		code: data.code,
		source: data.source,
		message: data.message,
		hint: data.hint,
		dispatch: data.dispatch,
		progress: data.progress,
		effects: data.effects ?? [],
		recoverable: data.recoverable,
	});
}

function isIntVec(v: Vec3): boolean {
	return Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z);
}

export class BodySessionImpl implements BodySession {
	readonly body: Ref;
	readonly owner: ControlOwner;
	readonly signal: AbortSignal;

	private state: BodySessionState = "active";
	private readonly identity: { connection: Ref; incarnation: Ref };
	private readonly deps: BodySessionDeps;
	private readonly abortController = new AbortController();
	/** 使用状态归属：hand → 占用它的 Operation（一次激活/hold 建档，endUse/hold 结束释放）。 */
	private readonly ownedUse = new Map<Hand, Ref>();
	private pendingOps = 0;
	private barrierProven = true;
	private recorderFaulted = false;
	private detachHost: () => void;

	constructor(body: Ref, owner: ControlOwner, deps: BodySessionDeps) {
		this.body = body;
		this.owner = owner;
		this.deps = deps;
		const identity = deps.host.identity;
		if (identity == null) {
			throw new Error("body session requires a ready connection identity");
		}
		this.identity = identity;
		this.signal = this.abortController.signal;
		this.detachHost = deps.host.on((notice) => {
			if (notice.kind === "disconnected") {
				this.revoke("connection_lost");
				return;
			}
			if (notice.kind === "incarnation_changed") {
				this.revoke("incarnation_changed");
			}
		});
		if (this.signal.aborted) this.revoke("acquire_cancelled");
	}

	/** 当前状态（PlayerPort 屏障核查用）。 */
	get sessionState(): BodySessionState {
		return this.state;
	}

	/** recorder fault 是否已锁存（PlayerPort 传播封闭用）。 */
	get isRecorderFaulted(): boolean {
		return this.recorderFaulted;
	}

	// ---- 生命周期 ----

	async close(): Promise<void> {
		if (this.state === "closed") return;
		this.revoke("session_close");
		await this.awaitPendingSettled(2000);
		if (this.pendingOps > 0) {
			this.barrierProven = false; // §10.5：无法证明旧写入失效，不允许新主人复用该客户端
		}
		this.state = "quiesced";
		this.state = "closed";
		this.detachHost();
		this.detachHost = () => {};
		this.deps.onClosed(this.barrierProven);
	}

	/** 撤销资格：立即拒绝旧写入并清理持续输入（§10.2 前段，同步完成）。 */
	private revoke(reason: string): void {
		if (this.state !== "active") return;
		this.state = "revoking";
		this.abortController.abort();
		const bot = this.deps.bot();
		if (bot != null) {
			try {
				bot.clearControlStates();
			} catch {
				// 撤销不因上游异常失败；连接已亡时控制态随连接消亡
			}
			if (bot.targetDigBlock != null) {
				const eff = this.deps.mintEff();
				const op = this.deps.mintOp();
				try {
					bot.stopDigging();
					this.recordFact(eff, op, "body.dig@1", "cleanup", "sent", "not_met", {
						reason,
						detail: "digging cancelled during revocation",
					});
				} catch {
					this.recordFact(eff, op, "body.dig@1", "cleanup", "unknown", "unknown", {
						reason,
						detail: "dig cancel dispatch failed during revocation",
					});
				}
			}
			if (bot.usingHeldItem && this.ownedUse.size > 0) {
				const eff = this.deps.mintEff();
				const op = this.deps.mintOp();
				try {
					bot.deactivateItem();
					this.recordFact(eff, op, "body.endUse@1", "cleanup", "sent", "met", {
						reason,
						detail: "owned item use released during revocation; release side effects not confirmed",
					});
				} catch {
					this.recordFact(eff, op, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
				}
			}
		}
		this.ownedUse.clear();
	}

	private awaitPendingSettled(deadlineMs: number): Promise<void> {
		if (this.pendingOps === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (this.pendingOps === 0 || Date.now() - started >= deadlineMs) {
					clearInterval(poll);
					resolve();
				}
			}, 10);
		});
	}

	// ---- 写入核验（§5.3） ----

	private writeDenial(): CallFailure | null {
		if (this.recorderFaulted) {
			return fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect recorder faulted; new side effects are sealed",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.state !== "active") {
			return fail({
				code: "CONTROL_INVALID",
				source: "capability",
				message: `body qualification is ${this.state}; acquire a new qualification`,
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.deps.host.state !== "ready") {
			return fail({
				code: "DISCONNECTED",
				source: "environment",
				message: `client is ${this.deps.host.state}, not ready`,
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		const id = this.deps.host.identity;
		if (id == null || id.connection !== this.identity.connection || id.incarnation !== this.identity.incarnation) {
			return fail({
				code: "REFERENCE_STALE",
				source: "capability",
				message: "connection/incarnation changed since qualification grant",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.signal.aborted) {
			return fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "body qualification is being revoked",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return null;
	}

	/** 异步恢复后重新核验；任何 await 之后、产生副作用之前必须调用。 */
	private recheck(): void {
		const denial = this.writeDenial();
		if (denial != null) throw denial;
		const bot = this.deps.bot();
		if (bot == null) {
			throw fail({
				code: "CONTROL_INVALID",
				source: "capability",
				message: "client is gone",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return;
	}

	private botForWrite(): MineflayerBot {
		this.recheck();
		// recheck 已保证 bot 非空
		return this.deps.bot() as MineflayerBot;
	}

	private enterOp(): void {
		this.pendingOps++;
	}

	private exitOp(): void {
		this.pendingOps--;
	}

	// ---- 记录 ----

	private recordFact(
		effect: Ref,
		operation: Ref,
		contract: ExactRef,
		kind: "dispatch" | "receipt" | "cleanup",
		dispatch: "not_sent" | "sent" | "unknown",
		completion: "met" | "not_met" | "unknown",
		detail?: JsonValue,
	): void {
		const ticket = this.deps.sink.record({
			effect,
			operation,
			contract,
			observedAt: nowIso(),
			kind,
			dispatch,
			completion,
			evidence: [],
			detail,
		});
		if (ticket == null) this.recorderFaulted = true;
	}

	async drive(
		input: ControlInput,
		ticks: number,
	): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }> {
		if (!Number.isInteger(ticks) || ticks <= 0) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `ticks must be a positive integer, got ${ticks}`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (input.look != null && input.lookAt != null) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "look and lookAt are mutually exclusive",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();

			// 视角：先于键位安装；lookAt/look 各派发一次
			if (input.lookAt != null) {
				const point = this.lookPointFor(bot, input.lookAt);
				await bot.lookAt(toMineflayerVec3(point), false);
				this.recheck();
			} else if (input.look != null) {
				await bot.look(input.look.yaw, input.look.pitch, false);
				this.recheck();
			}

			// 键位：省略项按 false 安装（public-api §4）
			for (const key of DRIVE_KEYS) {
				bot.setControlState(key, input.keys[key] === true);
			}

			// use：hold/once 都在状态进入时激活一次，不逐 Tick 重复
			if (input.use != null) {
				const hand = input.use.hand;
				if (!this.handHasItem(bot, hand)) {
					this.revokeKeys(bot);
					throw fail({
						code: "WRONG_STATE",
						source: "input",
						message: `hand ${hand} has no item to use`,
						hint: "equip the item first (equip), or drop the use field",
						dispatch: "not_sent",
						effects: [eff],
						recoverable: true,
					});
				}
				bot.activateItem(hand === "off");
				this.ownedUse.set(hand, op);
			}

			// attack：只在本次输入安装时派发一次，不随 ticks 重复
			if (input.attack != null) {
				const entity = this.resolveEntity(bot, input.attack);
				bot.attack(entity);
			}

			this.recordFact(
				eff,
				op,
				"body.drive@1",
				"dispatch",
				"sent",
				"unknown",
				plain({
					keys: { ...input.keys },
					look: input.look ?? null,
					lookAt: input.lookAt ?? null,
					use: input.use ?? null,
					attack: input.attack ?? null,
				}),
			);

			const consumed = await this.consumeTicks(bot, ticks, eff);

			// 第 N 个消费步结束后、下一次模拟前撤销持续键（physicsTick 回调内同步完成）
			this.revokeKeys(bot);
			if (input.use != null && input.use.mode === "hold") {
				this.releaseUse(bot, input.use.hand, op, "drive hold ended");
			}
			// once 留下的原生使用状态归使用会话（§7.5），不在 drive 返回时释放

			const sampled = this.deps.sampleSelf();
			if (sampled == null || sampled.value == null) {
				throw fail({
					code: "INTERNAL",
					source: "capability",
					message: "self sampling unavailable after drive; inputs were applied",
					dispatch: "sent",
					progress: { actualTicks: consumed },
					effects: [eff],
					recoverable: false,
				});
			}
			// 已核验 value 非 null：按 BodyOps.drive 契约固化 Fact<SelfState>
			const end: Fact<SelfState> = { ...sampled, value: sampled.value };
			this.recordFact(eff, op, "body.drive@1", "receipt", "sent", "met", {
				actualTicks: consumed,
				completionContract: "input applied for the requested client physics steps",
			});
			return {
				receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] },
				actualTicks: consumed,
				end,
			};
		} finally {
			this.exitOp();
		}
	}

	/**
	 * 物理步消费：首个 physicsTick 即第 1 个消费步（上游 simulatePlayer 先读
	 * controlState 再 emit）；第 ticks 个消费步的监听回调内同步结算，
	 * 保证撤销发生在下一次 simulatePlayer 之前（模拟前窄接缝）。
	 * 失败一律抛错并携带实际步数；短执行不包装为完整成功。
	 */
	private consumeTicks(bot: MineflayerBot, ticks: number, eff: Ref): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			let consumed = 0;
			let lastTickAt = Date.now();
			let settled = false;
			const cleanup = () => {
				bot.removeListener("physicsTick", onTick as never);
				clearInterval(watchdog);
				this.signal.removeEventListener("abort", onAbort);
			};
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};
			const onTick = () => {
				consumed++;
				lastTickAt = Date.now();
				if (consumed >= ticks) {
					settle(() => resolve(consumed));
				}
			};
			const watchdog = setInterval(() => {
				if (Date.now() - lastTickAt > DRIVE_STALL_MS) {
					settle(() =>
						reject(
							fail({
								code: "TIMEOUT",
								source: "environment",
								message: "client physics loop stalled during drive",
								hint: "chunks may be unloaded or the client is frozen; sample self/block to inspect",
								dispatch: "sent",
								progress: { actualTicks: consumed },
								effects: [eff],
								recoverable: true,
							}),
						),
					);
				}
			}, 250);
			const onAbort = () => {
				settle(() =>
					reject(
						fail({
							code: "INTERRUPTED",
							source: "environment",
							message: "drive interrupted; continuous inputs revoked",
							dispatch: "sent",
							progress: { actualTicks: consumed },
							effects: [eff],
							recoverable: true,
						}),
					),
				);
			};
			this.signal.addEventListener("abort", onAbort, { once: true });
			bot.on("physicsTick", onTick as never);
		});
	}

	private revokeKeys(bot: MineflayerBot): void {
		for (const key of DRIVE_KEYS) {
			try {
				bot.setControlState(key, false);
			} catch {
				// 客户端消亡时键位随连接消亡
			}
		}
	}

	private releaseUse(bot: MineflayerBot, hand: Hand, op: Ref, reason: string): void {
		if (this.ownedUse.get(hand) !== op) return; // 不清理无委托关系的其他操作资源
		this.ownedUse.delete(hand);
		if (!bot.usingHeldItem) return;
		const eff = this.deps.mintEff();
		const cleanupOp = this.deps.mintOp();
		try {
			bot.deactivateItem();
			this.recordFact(eff, cleanupOp, "body.endUse@1", "cleanup", "sent", "met", {
				reason,
				note: "held use released; release side effects (e.g. bow draw) not confirmed",
			});
		} catch {
			this.recordFact(eff, cleanupOp, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
		}
	}

	private handHasItem(bot: MineflayerBot, hand: Hand): boolean {
		if (hand === "off") return bot.inventory.slots[45] != null;
		return bot.heldItem != null;
	}

	/** lookAt 目标解析：实体瞄头部（position + height 缺省 1.62），点/地位经维度核验。 */
	private lookPointFor(bot: MineflayerBot, target: PointTarget | EntityRef): Vec3 {
		if ("networkId" in target) {
			const entity = this.resolveEntity(bot, target);
			const height = typeof entity.height === "number" ? entity.height : 1.62;
			return { x: entity.position.x, y: entity.position.y + height, z: entity.position.z };
		}
		return this.resolveLookPoint(bot, target);
	}

	private resolveLookPoint(bot: MineflayerBot, target: PointTarget): Vec3 {
		if ("x" in target) return target;
		const position = target.position;
		const dimension = target.dimension;
		const current = bot.game.dimension ?? null;
		if (dimension !== current) {
			throw fail({
				code: "REFERENCE_STALE",
				source: "input",
				message: `target dimension ${dimension} does not match current ${current ?? "unknown"}`,
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return position;
	}

	private resolveEntity(bot: MineflayerBot, ref: EntityRef): MFEntity {
		if (ref.connection !== this.identity.connection || ref.incarnation !== this.identity.incarnation) {
			throw fail({
				code: "REFERENCE_STALE",
				source: "input",
				message: "entity ref predates current connection/incarnation",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		const entity = bot.entities[ref.networkId];
		if (entity == null) {
			throw fail({
				code: "REFERENCE_STALE",
				source: "input",
				message: `entity ${ref.networkId} is not tracked`,
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return entity;
	}

	async dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt> {
		const aim = options?.aim ?? "target";
		if (!isIntVec(target.block)) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "dig target must be integer block coordinates",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const block = bot.blockAt(toMineflayerVec3(target.block));
			if (block == null) {
				throw fail({
					code: "NOT_FOUND",
					source: "world",
					message: `block ${target.block.x} ${target.block.y} ${target.block.z} is not loaded on the client`,
					hint: "sample block/entities first or move closer",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			const waitTime = bot.digTime(block);
			if (!Number.isFinite(waitTime)) {
				throw fail({
					code: "MISSING_TOOL",
					source: "world",
					message: `digging ${block.name} with the current held item would never finish`,
					hint: "equip a proper tool first (equip)",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}

			const onAbort = () => {
				if (bot.targetDigBlock != null) {
					try {
						bot.stopDigging();
					} catch {
						// 取消派发失败按 unknown 结算
					}
				}
			};
			this.signal.addEventListener("abort", onAbort, { once: true });

			try {
				// aim=target → 上游即时转向；preserve → ignore-look 路径，不触碰视角（§7.3）
				const digging = bot.dig(block, aim === "target" ? true : "ignore");
				const dispatchState = await this.observeDigDispatch(bot, target);
				this.recordFact(
					eff,
					op,
					"body.dig@1",
					"dispatch",
					dispatchState,
					"unknown",
					plain({ target: target.block, aim, predictedMs: waitTime }),
				);
				try {
					await digging;
				} catch (err) {
					if (this.state !== "active") {
						throw fail({
							code: "CONTROL_INVALID",
							source: "capability",
							message: `dig aborted: body qualification ${this.state}`,
							dispatch: "sent",
							effects: [eff],
							recoverable: false,
						});
					}
					throw fail({
						code: "INTERRUPTED",
						source: "environment",
						message: `dig aborted: ${err instanceof Error ? err.message : String(err)}`,
						dispatch: "sent",
						effects: [eff],
						recoverable: true,
					});
				}
			} finally {
				this.signal.removeEventListener("abort", onAbort);
			}

			// 上游 dig 仅在服务端 block_update 变空气时 resolve（digging.js onBlockUpdate）；
			// 本地预测完成不算服务端确认（§7.3）。
			this.recordFact(eff, op, "body.dig@1", "receipt", "sent", "met", {
				completionContract: "server block update confirmed target became air",
				confirmedBy: "server_block_update",
			});
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	/** 观察 dig start 包是否已派发（targetDigBlock 置位是上游写包后的可靠后效）。 */
	private async observeDigDispatch(bot: MineflayerBot, target: BlockTarget): Promise<"sent" | "unknown"> {
		const started = Date.now();
		while (Date.now() - started <= DIG_DISPATCH_OBSERVE_MS) {
			const t = bot.targetDigBlock?.position;
			if (t != null && t.x === target.block.x && t.y === target.block.y && t.z === target.block.z) {
				return "sent";
			}
			await new Promise((r) => setTimeout(r, 50));
			this.recheck();
		}
		return "unknown";
	}

	async attack(target: EntityRef): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const entity = this.resolveEntity(bot, target);
			bot.attack(entity);
			this.recordFact(eff, op, "body.attack@1", "dispatch", "sent", "met", {
				completionContract: "one attack attempt dispatched",
				target: target.networkId,
			});
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async useItem(hand: Hand): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if (!this.handHasItem(bot, hand)) {
				throw fail({
					code: "WRONG_STATE",
					source: "input",
					message: `hand ${hand} has no item to use`,
					hint: "equip the item first (equip)",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			bot.activateItem(hand === "off");
			this.ownedUse.set(hand, op);
			this.recordFact(eff, op, "body.useItem@1", "dispatch", "sent", "met", {
				completionContract: "one protocol activation dispatched",
				hand,
				nativeUseState: bot.usingHeldItem,
			});
			// 原生使用状态归当前 Body 的使用会话；endUse 或退役清理释放
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async endUse(): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const hadOwned = this.ownedUse.size > 0;
			this.ownedUse.clear();
			if (!bot.usingHeldItem) {
				// 已结束状态幂等，不重复发 release
				this.recordFact(eff, op, "body.endUse@1", "receipt", "not_sent", "met", {
					completionContract: "no owned item use to end",
					hadOwned,
				});
				return { effect: eff, dispatch: "not_sent", completion: "met", evidence: [] };
			}
			bot.deactivateItem();
			this.recordFact(eff, op, "body.endUse@1", "receipt", "sent", "met", {
				completionContract: "owned item use ended; release side effects not confirmed",
				hadOwned,
			});
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async interact(input: {
		target: BlockTarget | EntityRef;
		hand: Hand;
		face?: Vec3;
		cursor?: Vec3;
	}): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if ("networkId" in input.target) {
				const entity = this.resolveEntity(bot, input.target);
				bot.activateEntity(entity);
				this.recordFact(eff, op, "body.interact@1", "dispatch", "sent", "met", {
					completionContract: "entity interaction dispatched",
					entity: input.target.networkId,
				});
				return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
			}
			const target = input.target;
			if (!isIntVec(target.block)) {
				throw fail({
					code: "INVALID_INPUT",
					source: "input",
					message: "interact block target must be integer coordinates",
					dispatch: "not_sent",
					recoverable: true,
				});
			}
			// face/cursor 仅对方块有效：face 为轴向单位法向，cursor 为 [0,1] 命中点且位于指定面
			let direction: Vec3 | undefined;
			let cursorPos: Vec3 | undefined;
			if (input.face != null) {
				const f = input.face;
				const axisCount = [f.x, f.y, f.z].filter((c) => c !== 0).length;
				if (
					axisCount !== 1 ||
					(f.x !== 0 && f.x !== 1 && f.x !== -1) ||
					(f.y !== 0 && f.y !== 1 && f.y !== -1) ||
					(f.z !== 0 && f.z !== 1 && f.z !== -1)
				) {
					throw fail({
						code: "INVALID_INPUT",
						source: "input",
						message: "face must be an axial unit normal (one component ±1, others 0)",
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				if (input.cursor != null) {
					const c = input.cursor;
					const inRange = (v: number) => v >= 0 && v <= 1;
					if (!inRange(c.x) || !inRange(c.y) || !inRange(c.z)) {
						throw fail({
							code: "INVALID_INPUT",
							source: "input",
							message: "cursor components must be within [0,1]",
							dispatch: "not_sent",
							recoverable: true,
						});
					}
					const onFace =
						(f.x !== 0 && c.x === (f.x > 0 ? 1 : 0)) ||
						(f.y !== 0 && c.y === (f.y > 0 ? 1 : 0)) ||
						(f.z !== 0 && c.z === (f.z > 0 ? 1 : 0));
					if (!onFace) {
						throw fail({
							code: "INVALID_INPUT",
							source: "input",
							message: "cursor must lie on the specified face",
							dispatch: "not_sent",
							recoverable: true,
						});
					}
					cursorPos = c;
				}
				direction = f;
			}
			const block = bot.blockAt(toMineflayerVec3(target.block));
			if (block == null) {
				throw fail({
					code: "NOT_FOUND",
					source: "world",
					message: `block ${target.block.x} ${target.block.y} ${target.block.z} is not loaded on the client`,
					hint: "sample block first or move closer",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			await bot.activateBlock(
				block,
				direction == null ? undefined : toMineflayerVec3(direction),
				cursorPos == null ? undefined : toMineflayerVec3(cursorPos),
			);
			this.recheck();
			this.recordFact(
				eff,
				op,
				"body.interact@1",
				"dispatch",
				"sent",
				"met",
				plain({
					completionContract: "block interaction dispatched; placement/opening verified by observation",
					block: target.block,
					face: input.face ?? null,
				}),
			);
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async equip(item: ItemSelector | null, hand: Hand): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if (bot.currentWindow != null) {
				throw fail({
					code: "WRONG_STATE",
					source: "world",
					message: "a container window is open; equip requires the player window in I1",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			if (item == null) {
				// 腾空该手：安全移动到空位，不得隐式丢弃（§7.6.1）
				const heldSlot = hand === "main" ? 36 + bot.quickBarSlot : 45;
				const held = bot.inventory.slots[heldSlot];
				if (held == null) {
					this.recordFact(eff, op, "body.equip@1", "receipt", "not_sent", "met", {
						completionContract: "hand already empty",
						hand,
					});
					return { effect: eff, dispatch: "not_sent", completion: "met", evidence: [] };
				}
				const empty = this.findEmptySlot(bot, heldSlot);
				if (empty == null) {
					throw fail({
						code: "INVENTORY_FULL",
						source: "world",
						message: `no free slot in main+hotbar to move the held item (slot ${heldSlot})`,
						hint: "free inventory space first",
						dispatch: "not_sent",
						effects: [eff],
						recoverable: true,
					});
				}
				await bot.moveSlotItem(heldSlot, empty);
				this.recheck();
				const confirmed = bot.inventory.slots[heldSlot] == null;
				this.recordFact(eff, op, "body.equip@1", "receipt", "sent", confirmed ? "met" : "unknown", {
					completionContract: "held slot emptied by controlled slot move",
					from: heldSlot,
					to: empty,
					confirmed,
				});
				return {
					effect: eff,
					dispatch: "sent",
					completion: confirmed ? "met" : "unknown",
					evidence: [],
				};
			}
			const found = this.findItem(bot, item);
			if (found == null) {
				throw fail({
					code: "MISSING_MATERIAL",
					source: "world",
					message: `no inventory item matches ${item.name}${item.substitutions ? ` (or ${item.substitutions.join(", ")})` : ""}`,
					hint: `inventory holds: ${this.inventoryNames(bot).join(", ") || "nothing"}`,
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			await bot.equip(found.item, hand === "main" ? "hand" : "off-hand");
			this.recheck();
			const heldSlot = hand === "main" ? 36 + bot.quickBarSlot : 45;
			const after = bot.inventory.slots[heldSlot];
			const confirmed = after != null && after.name === found.item.name;
			this.recordFact(eff, op, "body.equip@1", "receipt", "sent", confirmed ? "met" : "unknown", {
				completionContract: "hand slot holds the requested item after controlled click sequence",
				item: found.name,
				hand,
				confirmed,
			});
			return {
				effect: eff,
				dispatch: "sent",
				completion: confirmed ? "met" : "unknown",
				evidence: [],
			};
		} finally {
			this.exitOp();
		}
	}

	/** 主背包+快捷栏（9..44）内排除 exclude 的第一个空位；不碰护甲/合成/副手格。 */
	private findEmptySlot(bot: MineflayerBot, exclude: number): number | null {
		const slots = bot.inventory.slots;
		for (let i = 9; i <= 44; i++) {
			if (i === exclude) continue;
			if (slots[i] == null) return i;
		}
		return null;
	}

	private findItem(
		bot: MineflayerBot,
		selector: ItemSelector,
	): { name: string; item: NonNullable<MineflayerBot["inventory"]["slots"][number]> } | null {
		const names = [selector.name, ...(selector.substitutions ?? [])];
		const slots = bot.inventory.slots;
		for (let i = 0; i < slots.length; i++) {
			const item = slots[i];
			if (item == null) continue;
			if (!names.includes(item.name)) continue;
			if (selector.minDurability != null) {
				const max = (item as unknown as { maxDurability?: number }).maxDurability;
				const used = (item as unknown as { durabilityUsed?: number }).durabilityUsed;
				if (typeof max === "number" && typeof used === "number" && max - used < selector.minDurability) {
					continue;
				}
			}
			return { name: item.name, item };
		}
		return null;
	}

	private inventoryNames(bot: MineflayerBot): string[] {
		const names: string[] = [];
		for (const item of bot.inventory.slots) {
			if (item != null) names.push(item.name);
		}
		return names;
	}

	async lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const point = this.lookPointFor(bot, target);
			await bot.lookAt(toMineflayerVec3(point), false);
			this.recheck();
			this.recordFact(
				eff,
				op,
				"body.lookAt@1",
				"dispatch",
				"sent",
				"met",
				plain({
					completionContract: "view applied locally and sent with position stream",
					target: "networkId" in target ? { entity: target.networkId } : point,
				}),
			);
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async writeSign(_target: BlockTarget, _input: { side: "front" | "back"; lines: SignText }): Promise<EffectReceipt> {
		throw fail({
			code: "INTERNAL",
			source: "capability",
			message: "writeSign is not implemented in driver I1 scope",
			hint: "sign editing arrives with the window/sign work package",
			dispatch: "not_sent",
			recoverable: false,
		});
	}

	async openContainer(_target: BlockTarget | EntityRef): Promise<WindowSession> {
		throw fail({
			code: "INTERNAL",
			source: "capability",
			message: "openContainer is not implemented in driver I1 scope",
			hint: "window sessions arrive with the window work package",
			dispatch: "not_sent",
			recoverable: false,
		});
	}

	async feedback(_sensors: Record<string, WorldQuery>): Promise<FeedbackStream> {
		throw fail({
			code: "INTERNAL",
			source: "capability",
			message: "feedback is not implemented in driver I1 scope",
			hint: "feedback streams arrive with K-group work packages",
			dispatch: "not_sent",
			recoverable: false,
		});
	}
}
