/**
 * Body Session：资格门、持续控制与离散身体操作（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4、modules/driver.md §5–§7、§10、§13。
 * 状态机 active → revoking → quiesced → closed（§5.2）；revoking 不可逆；结束须新建资格。
 * 写入核验位置（I1 覆盖 §5.3 的 1/2/3/4）：操作入口、异步恢复后产生副作用前、
 * 控制状态修改前、修改插件目标前；窗口另在同步协议写入和按代次清理时核验。
 * feedback 尚未实现并显式失败。
 * 低层完成合同名（body.*@1）由 Driver 拥有；公开能力合同归 capabilities。
 * drive 的 Tick = 实际客户端物理模拟步（§7.2）：首个消费步开始计数，第 N 个
 * 消费步结束后、下一次模拟前撤销持续键/use（physicsTick 监听内同步撤销，
 * 上游 simulatePlayer 在 emit 前读取 controlState，构成模拟前窄接缝）。
 */

import type {
	AttackOutcome,
	BlockTarget,
	BodySession,
	ControlInput,
	EntityRef,
	EquipSlot,
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
import type { ClientWindowObservation } from "../../contracts/client-facts.js";
import type { DriverExecutionSink } from "../../contracts/runtime.js";
import type { CallFailure, EffectReceipt, Fact, Ref, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { ClientHostListener } from "../client-host.js";
import { EffectRecorder, fail } from "../execution.js";
import { toMineflayerVec3, type MineflayerBot } from "../mineflayer/adapter.js";
import { activateContainerBlock, activateContainerEntity } from "../mineflayer/window.js";
import { WindowSessionImpl } from "../window/session.js";

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
	/** Authoritative window observations; current value is cleared on retirement. */
	publishWindow?: (observation: ClientWindowObservation | null) => void;
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
/** 告示牌：上游 update_sign 路径每行 45 个 UTF-16 单元；编辑资格与提交确认各自 2 秒（§7.6.1）。 */
const SIGN_LINE_LIMIT = 45;
const SIGN_EDITOR_MS = 2000;
const SIGN_CONFIRM_MS = 2000;

/** EquipSlot → mineflayer 目的地（simple_inventory.js 的 destination 名）。 */
const DESTINATION: Record<EquipSlot, string> = {
	hand: "hand",
	offhand: "off-hand",
	head: "head",
	chest: "torso",
	legs: "legs",
	feet: "feet",
};

/** 校验装备结果的槽位：护甲 5..8、副手 45、主手随快捷栏选择。 */
const SLOT_OF: Record<EquipSlot, (bot: MineflayerBot) => number> = {
	hand: (bot) => 36 + bot.quickBarSlot,
	offhand: () => 45,
	head: () => 5,
	chest: () => 6,
	legs: () => 7,
	feet: () => 8,
};

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
	private ownedWindow: WindowSessionImpl | null = null;
	private openingWindow = false;
	private barrierProven = true;
	private readonly recorder: EffectRecorder;
	private detachHost: () => void;

	constructor(body: Ref, owner: ControlOwner, deps: BodySessionDeps) {
		this.body = body;
		this.owner = owner;
		this.deps = deps;
		this.recorder = new EffectRecorder(deps.sink);
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
		return this.recorder.isFaulted;
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
					this.recorder.record(eff, op, "body.dig@1", "cleanup", "sent", "not_met", {
						reason,
						detail: "digging cancelled during revocation",
					});
				} catch {
					this.recorder.record(eff, op, "body.dig@1", "cleanup", "unknown", "unknown", {
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
					this.recorder.record(eff, op, "body.endUse@1", "cleanup", "sent", "met", {
						reason,
						detail: "owned item use released during revocation; release side effects not confirmed",
					});
				} catch {
					this.recorder.record(eff, op, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
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
		if (this.recorder.isFaulted) {
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
		let bot: MineflayerBot | null = null;
		this.enterOp();
		try {
			bot = this.botForWrite();

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

			this.recorder.record(
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
			this.recorder.record(eff, op, "body.drive@1", "receipt", "sent", "met", {
				actualTicks: consumed,
				completionContract: "input applied for the requested client physics steps",
			});
			return {
				receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] },
				actualTicks: consumed,
				end,
			};
		} finally {
			// 任何退出路径都要撤销输入：停滞看门狗/中断/等待取消失败都不会走到成功路径，
			// 留下按住的键等于让客户端自己继续走（§7.2）；hold 蓄力同理必须释放（§7.5）。
			// once 留下的原生使用状态归使用会话，不在此释放。
			if (bot != null) {
				this.revokeKeys(bot);
				if (input.use != null && input.use.mode === "hold") {
					this.releaseUse(bot, input.use.hand, op, "drive exited");
				}
			}
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
			this.recorder.record(eff, cleanupOp, "body.endUse@1", "cleanup", "sent", "met", {
				reason,
				note: "held use released; release side effects (e.g. bow draw) not confirmed",
			});
		} catch {
			this.recorder.record(eff, cleanupOp, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
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
				let failure: unknown = null;
				try {
					await digging;
				} catch (err) {
					failure = err;
				}
				// 上游 dig 是 async：开始挖掘的包在内部 await 之后才写，拒绝可能发生在写包之前
				// 也可能之后（stopDigging/卸载），I1 不区分来源，如实记 unknown。
				this.recorder.record(
					eff,
					op,
					"body.dig@1",
					"dispatch",
					failure == null ? "sent" : "unknown",
					"unknown",
					plain({ target: target.block, aim, predictedMs: waitTime }),
				);
				if (failure != null) {
					if (this.state !== "active") {
						throw fail({
							code: "CONTROL_INVALID",
							source: "capability",
							message: `dig aborted: body qualification ${this.state}`,
							dispatch: "unknown",
							effects: [eff],
							recoverable: false,
						});
					}
					throw fail({
						code: "INTERRUPTED",
						source: "environment",
						message: `dig aborted: ${failure instanceof Error ? failure.message : String(failure)}`,
						dispatch: "unknown",
						effects: [eff],
						recoverable: true,
					});
				}
			} finally {
				this.signal.removeEventListener("abort", onAbort);
			}

			// 上游在 finishDigging 里把目标格本地置空后 resolve（digging.js），
			// 不等服务端 block update；本地预测完成与服务端确认在 I1 不可区分。
			this.recorder.record(eff, op, "body.dig@1", "receipt", "sent", "met", {
				completionContract:
					"target became air in the client world (local finish prediction or server update; origin not distinguished in I1)",
				confirmedBy: "client_block_update",
			});
			return { effect: eff, dispatch: "sent", completion: "met", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	async attack(target: EntityRef, options?: { evidenceMs?: number }): Promise<AttackOutcome> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const entity = this.resolveEntity(bot, target);
			const evidenceMs = Math.max(100, Math.min(options?.evidenceMs ?? 600, 5000));
			// 先登记证据监听再派发：受击包可能在 dispatch 之后极早到达。
			const hurt = this.awaitHurt(bot, target.networkId, evidenceMs);
			bot.attack(entity);
			const hit = await hurt;
			// 派发已发生：hit 只是证据，不改变 dispatch 事实。
			this.recorder.record(
				eff,
				op,
				"body.attack@1",
				"receipt",
				"sent",
				hit === true ? "met" : "unknown",
				plain({
					completionContract:
						hit === true
							? "target hurt/dead observed after the attack dispatch"
							: "attack dispatched; no hurt observation within the evidence window",
					target: target.networkId,
					hit,
					evidenceMs,
				}),
			);
			return {
				receipt: { effect: eff, dispatch: "sent", completion: hit === true ? "met" : "unknown", evidence: [] },
				hit,
			};
		} finally {
			this.exitOp();
		}
	}

	/**
	 * 受击证据窗口：entityHurt/entityDead 只按 networkId 归属，不把附近伤害当命中。
	 * 窗口内无观察 = false（看过但没有）；中止/断线 = null（没看完，不得宣称未命中）。
	 */
	private awaitHurt(bot: MineflayerBot, networkId: number, windowMs: number): Promise<boolean | null> {
		return new Promise<boolean | null>((resolve) => {
			let done = false;
			const onHurt = (entity: MFEntity | null) => {
				if (entity?.id === networkId) finish(true);
			};
			const onDead = (entity: MFEntity | null) => {
				if (entity?.id === networkId) finish(true);
			};
			const onAbort = () => finish(null);
			const onEnd = () => finish(null);
			const timer = setTimeout(() => finish(false), windowMs);
			const cleanup = () => {
				clearTimeout(timer);
				bot.removeListener("entityHurt", onHurt as never);
				bot.removeListener("entityDead", onDead as never);
				bot.removeListener("end", onEnd as never);
				this.signal.removeEventListener("abort", onAbort);
			};
			function finish(value: boolean | null) {
				if (done) return;
				done = true;
				cleanup();
				resolve(value);
			}
			bot.on("entityHurt", onHurt as never);
			bot.on("entityDead", onDead as never);
			bot.on("end", onEnd as never);
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
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
			this.recorder.record(eff, op, "body.useItem@1", "dispatch", "sent", "met", {
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
				this.recorder.record(eff, op, "body.endUse@1", "receipt", "not_sent", "met", {
					completionContract: "no owned item use to end",
					hadOwned,
				});
				return { effect: eff, dispatch: "not_sent", completion: "met", evidence: [] };
			}
			bot.deactivateItem();
			this.recorder.record(eff, op, "body.endUse@1", "receipt", "sent", "met", {
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
				this.recorder.record(eff, op, "body.interact@1", "dispatch", "sent", "met", {
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
			this.recorder.record(
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

	async equip(item: ItemSelector | null, slot: EquipSlot): Promise<EffectReceipt> {
		// components 匹配未实现：静默忽略会选出语义不同的物品，宁可在 mint 之前拒绝（零事实）
		if (item != null && item.components != null) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "item component matching is not implemented in the body I1 scope",
				hint: "select by name/substitutions/minDurability; component matching arrives with the inventory work package",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		// 腾空只对手有意义：护甲位不能"腾空"，也不允许把物品丢到地上。
		if (item == null && slot !== "hand" && slot !== "offhand") {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `cannot empty the ${slot} slot; only hand/offhand support item=null`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
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
				const heldSlot = slot === "hand" ? 36 + bot.quickBarSlot : 45;
				const held = bot.inventory.slots[heldSlot];
				if (held == null) {
					this.recorder.record(eff, op, "body.equip@1", "receipt", "not_sent", "met", {
						completionContract: "hand already empty",
						slot,
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
				this.recorder.record(eff, op, "body.equip@1", "receipt", "sent", confirmed ? "met" : "unknown", {
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
			await bot.equip(found.item, DESTINATION[slot] as Parameters<MineflayerBot["equip"]>[1]);
			this.recheck();
			const confirmSlot = SLOT_OF[slot](bot);
			const after = bot.inventory.slots[confirmSlot];
			const confirmed = after != null && after.name === found.item.name;
			this.recorder.record(eff, op, "body.equip@1", "receipt", "sent", confirmed ? "met" : "unknown", {
				completionContract: "target slot holds the requested item after controlled click sequence",
				item: found.name,
				slot,
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

	/**
	 * 丢出指定数量的同名物品（§7.5）：窗口外转移，destination -999。
	 *
	 * 可丢域只有主背包+快捷栏（9..44）——上游 `transfer` 的 sourceStart/sourceEnd 就是
	 * `window.inventoryStart..inventoryEnd`，护甲与副手里的同名物品根本搬不出去，所以
	 * 可用量必须按同一槽域算，否则会把上游的 "Can't find …" 漏成 INTERNAL。
	 *
	 * 完成只报 unknown：1.21.11 没有事务回执，且 clickWindow 先本地 acceptClick 再发包，
	 * 本地库存变化是乐观预测，不是服务端确认。是否真的落地由能力层用地面实体判定。
	 */
	async toss(item: string, count: number): Promise<EffectReceipt> {
		if (item.length === 0) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "item name must not be empty",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (!Number.isInteger(count) || count < 1) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `count must be a positive integer (got ${String(count)})`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if (bot.currentWindow != null) {
				throw fail({
					code: "WRONG_STATE",
					source: "world",
					message: "a container window is open; toss requires the player window in I1",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			const type = bot.registry.itemsByName[item]?.id;
			if (typeof type !== "number") {
				throw fail({
					code: "NOT_FOUND",
					source: "input",
					message: `unknown item ${item}`,
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			const available = this.countInPlayerWindow(bot, item);
			if (available < count) {
				throw fail({
					code: "MISSING_MATERIAL",
					source: "world",
					message: `only ${available} ${item} in the main inventory (asked ${count})`,
					hint: "armor and offhand slots cannot be tossed; move the item to the main inventory first",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			this.recorder.record(eff, op, "body.toss@1", "dispatch", "sent", "unknown", {
				completionContract: "window clicks for a drop are written; acknowledgement is not observable",
				item,
				count,
				slotRange: "9..44",
			});
			// 上游不接受 AbortSignal，也没有可取消的中间态；recheck() 是唯一的撤销边界。
			await bot.toss(type, null, count);
			this.recheck();
			this.recorder.record(eff, op, "body.toss@1", "receipt", "sent", "unknown", {
				completionContract: "item leaves the player window; ground presence is judged by the capability",
				item,
				count,
			});
			return { effect: eff, dispatch: "sent", completion: "unknown", evidence: [] };
		} finally {
			this.exitOp();
		}
	}

	/** 主背包+快捷栏（9..44）内的同名物品总数；toss 的可丢域。 */
	private countInPlayerWindow(bot: MineflayerBot, name: string): number {
		let total = 0;
		for (let i = 9; i <= 44; i++) {
			const slot = bot.inventory.slots[i];
			if (slot != null && slot.name === name) total += slot.count;
		}
		return total;
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
			this.recorder.record(
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

	async writeSign(target: BlockTarget, input: { side: "front" | "back"; lines: SignText }): Promise<EffectReceipt> {
		if (!isIntVec(target.block)) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "writeSign target must be integer block coordinates",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		for (const line of input.lines) {
			if (line.length > SIGN_LINE_LIMIT) {
				throw fail({
					code: "INVALID_INPUT",
					source: "input",
					message: `sign line exceeds ${SIGN_LINE_LIMIT} UTF-16 units: ${line.length}`,
					hint: "split the text yourself; the driver does not truncate or wrap",
					dispatch: "not_sent",
					recoverable: true,
				});
			}
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
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			if (!block.name.includes("sign")) {
				throw fail({
					code: "NOT_FOUND",
					source: "world",
					message: `${block.name} is not a sign`,
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			const properties = block.getProperties() as Record<string, string | number | boolean>;
			if (String(properties.is_waxed) === "true") {
				throw fail({
					code: "WRONG_STATE",
					source: "world",
					message: "sign is waxed; it cannot be edited",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}
			if (bot.heldItem != null) {
				throw fail({
					code: "WRONG_STATE",
					source: "capability",
					message: "main hand must be empty before opening the sign editor",
					hint: "use equip(null, hand) first; the driver does not drop items",
					dispatch: "not_sent",
					effects: [eff],
					recoverable: true,
				});
			}

			const face = this.facingVector(bot, target.block);
			const wantFront = input.side === "front";
			const editor = this.awaitSignEditor(bot, target.block, SIGN_EDITOR_MS);
			await bot.activateBlock(block, toMineflayerVec3(face));
			this.recheck();
			const opened = await editor;
			if (opened == null) {
				this.recorder.record(eff, op, "body.writeSign@1", "dispatch", "sent", "unknown", {
					completionContract: "sign editor did not open within the evidence window; no update_sign was sent",
					target: plain(target.block),
					side: input.side,
				});
				throw fail({
					code: "TIMEOUT",
					source: "world",
					message: "sign editor did not open within 2000 ms",
					hint: "stand closer to the requested face and retry",
					dispatch: "sent",
					effects: [eff],
					recoverable: true,
				});
			}
			if (opened.front !== wantFront) {
				this.recorder.record(eff, op, "body.writeSign@1", "dispatch", "sent", "not_met", {
					completionContract: "server opened the opposite face; update_sign was not sent",
					target: plain(target.block),
					side: input.side,
					openedFront: opened.front,
				});
				throw fail({
					code: "WRONG_STATE",
					source: "world",
					message: `server opened the ${opened.front ? "front" : "back"} face, requested ${input.side}`,
					hint: "stand on the side you want to edit",
					dispatch: "sent",
					effects: [eff],
					recoverable: true,
				});
			}

			bot.updateSign(block, input.lines.join("\n"), !wantFront);
			this.recheck();
			// 牌面文本读不回来（本栈无 block-entity 解码）：同位置更新到达即视为写入确认，
			// 不做文本比对，也不把本地预测当回执（§7.6.1）。
			const confirmed = await this.awaitBlockEntity(bot, target.block, SIGN_CONFIRM_MS);
			this.recorder.record(
				eff,
				op,
				"body.writeSign@1",
				"receipt",
				"sent",
				confirmed ? "met" : "unknown",
				plain({
					completionContract: confirmed
						? "server sent a block-entity update for the edited sign"
						: "update_sign dispatched; no block-entity update observed within 2000 ms",
					target: plain(target.block),
					side: input.side,
					lines: input.lines,
					confirmed,
				}),
			);
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

	/** 从方块中心到玩家眼睛的主导轴向：即玩家所在的那一面。 */
	private facingVector(bot: MineflayerBot, block: Vec3): Vec3 {
		const eyeY = (bot.entity?.position.y ?? 0) + 1.62;
		const dx = (bot.entity?.position.x ?? 0) - (block.x + 0.5);
		const dy = eyeY - (block.y + 0.5);
		const dz = (bot.entity?.position.z ?? 0) - (block.z + 0.5);
		const ax = Math.abs(dx);
		const ay = Math.abs(dy);
		const az = Math.abs(dz);
		if (ax >= ay && ax >= az) return { x: Math.sign(dx) || 1, y: 0, z: 0 };
		if (ay >= az) return { x: 0, y: Math.sign(dy) || 1, z: 0 };
		return { x: 0, y: 0, z: Math.sign(dz) || 1 };
	}

	/** 等待与目标位置匹配的 open_sign_entity；中止/断线/超时都结算为 null。 */
	private awaitSignEditor(bot: MineflayerBot, target: Vec3, windowMs: number): Promise<{ front: boolean } | null> {
		return new Promise<{ front: boolean } | null>((resolve) => {
			let done = false;
			const matches = (loc: { x: number; y: number; z: number } | null | undefined) =>
				loc != null && loc.x === target.x && loc.y === target.y && loc.z === target.z;
			const onOpen = (packet: { location?: { x: number; y: number; z: number }; isFrontText?: boolean }) => {
				if (!matches(packet?.location)) return;
				finish({ front: packet.isFrontText === true });
			};
			const onAbort = () => finish(null);
			const onEnd = () => finish(null);
			const timer = setTimeout(() => finish(null), windowMs);
			const cleanup = () => {
				clearTimeout(timer);
				bot._client.removeListener("open_sign_entity", onOpen as never);
				bot.removeListener("end", onEnd as never);
				this.signal.removeEventListener("abort", onAbort);
			};
			function finish(value: { front: boolean } | null) {
				if (done) return;
				done = true;
				cleanup();
				resolve(value);
			}
			bot._client.on("open_sign_entity", onOpen as never);
			bot.on("end", onEnd as never);
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 等待同位置 blockEntityData（服务端实际回送牌面更新）。 */
	private awaitBlockEntity(bot: MineflayerBot, target: Vec3, windowMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let done = false;
			const onEntity = (block: { position?: { x: number; y: number; z: number } } | null) => {
				const pos = block?.position;
				if (pos == null || pos.x !== target.x || pos.y !== target.y || pos.z !== target.z) return;
				finish(true);
			};
			const onAbort = () => finish(false);
			const onEnd = () => finish(false);
			const timer = setTimeout(() => finish(false), windowMs);
			const cleanup = () => {
				clearTimeout(timer);
				bot.removeListener("blockEntityData", onEntity as never);
				bot.removeListener("end", onEnd as never);
				this.signal.removeEventListener("abort", onAbort);
			};
			function finish(value: boolean) {
				if (done) return;
				done = true;
				cleanup();
				resolve(value);
			}
			bot.on("blockEntityData", onEntity as never);
			bot.on("end", onEnd as never);
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** physicsTick precedes updatePosition in the installed plugin; awaiting resumes after that stack. */
	private awaitContainerPhysicsBoundary(bot: MineflayerBot): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				bot.removeListener("physicsTick", onTick);
				bot.removeListener("end", onEnd);
				this.signal.removeEventListener("abort", onAbort);
			};
			const finish = (error?: CallFailure) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error === undefined) resolve();
				else reject(error);
			};
			const onTick = () => finish();
			const onAbort = () =>
				finish(
					fail({
						code: "INTERRUPTED",
						source: "environment",
						message: "container opening cancelled before the physics boundary",
						dispatch: "not_sent",
						recoverable: false,
					}),
				);
			const onEnd = () =>
				finish(
					fail({
						code: "DISCONNECTED",
						source: "environment",
						message: "client disconnected before container activation",
						dispatch: "not_sent",
						recoverable: false,
					}),
				);
			const timer = setTimeout(
				() =>
					finish(
						fail({
							code: "TIMEOUT",
							source: "environment",
							message: "client physics loop stalled before container activation",
							dispatch: "not_sent",
							recoverable: true,
						}),
					),
				DRIVE_STALL_MS,
			);
			bot.on("physicsTick", onTick);
			bot.on("end", onEnd);
			this.signal.addEventListener("abort", onAbort, { once: true });
			if (this.signal.aborted) onAbort();
		});
	}

	async openContainer(_target: BlockTarget | EntityRef): Promise<WindowSession> {
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if (this.openingWindow || this.ownedWindow !== null || bot.currentWindow !== null) {
				throw fail({
					code: "CONTROL_CONFLICT",
					source: "capability",
					message: "a window is already open or opening",
					dispatch: "not_sent",
					recoverable: false,
				});
			}
			if (!bot.supportFeature("stateIdUsed")) {
				throw fail({
					code: "UNSUPPORTED_PROTOCOL",
					source: "environment",
					message: "container confirmation requires modern stateId window synchronization",
					dispatch: "not_sent",
					recoverable: false,
				});
			}
			this.openingWindow = true;
			const target = structuredClone(_target);
			let point: Vec3;
			if ("networkId" in target) {
				const entity = this.resolveEntity(bot, target);
				if (target.appearance !== `ap:${entity.id}`) {
					throw fail({
						code: "REFERENCE_STALE",
						source: "input",
						message: "entity appearance does not match the tracked entity",
						dispatch: "not_sent",
						recoverable: false,
					});
				}
				point = { x: entity.position.x, y: entity.position.y + 1, z: entity.position.z };
			} else {
				if (!isIntVec(target.block) || target.place.dimension !== bot.game.dimension) {
					throw fail({
						code: "REFERENCE_STALE",
						source: "input",
						message: "container target coordinates or dimension are invalid",
						dispatch: "not_sent",
						recoverable: false,
					});
				}
				const self = this.deps.sampleSelf()?.value;
				if (
					self != null &&
					(self.place.world !== target.place.world || self.place.worldRevision !== target.place.worldRevision)
				) {
					throw fail({
						code: "REFERENCE_STALE",
						source: "input",
						message: "container target belongs to a different world revision",
						dispatch: "not_sent",
						recoverable: false,
					});
				}
				const block = bot.blockAt(toMineflayerVec3(target.block));
				if (block === null) {
					throw fail({
						code: "NOT_FOUND",
						source: "world",
						message: "container block is not loaded",
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				if (
					!/^(chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|(?:[a-z_]+_)?shulker_box)$/.test(
						block.name,
					)
				) {
					throw fail({
						code: "UNSUPPORTED_WINDOW",
						source: "capability",
						message: "target is not a supported plain container; dedicated workstation layouts are unsupported",
						dispatch: "not_sent",
						recoverable: false,
					});
				}
				point = { x: target.block.x + 0.5, y: target.block.y + 0.5, z: target.block.z + 0.5 };
			}
			// force=true performs only a synchronous native look update; no pending look task can activate later.
			await bot.lookAt(toMineflayerVec3(point), true);
			this.recheck();
			if (!("networkId" in target)) {
				await this.awaitContainerPhysicsBoundary(bot);
				this.recheck();
			}
			if (bot !== this.deps.bot() || bot.currentWindow !== null) {
				throw fail({
					code: "CONTROL_CONFLICT",
					source: "capability",
					message: "client or window changed while opening container",
					dispatch: "not_sent",
					recoverable: false,
				});
			}
			const window = new WindowSessionImpl({
				bot,
				signal: this.signal,
				operation: this.deps.mintOp(),
				target,
				connection: this.identity.connection,
				incarnation: this.identity.incarnation,
				recorder: this.recorder,
				mintOp: this.deps.mintOp,
				mintEff: this.deps.mintEff,
				guard: () => {
					this.recheck();
					if (this.ownedWindow !== window || this.deps.bot() !== bot)
						throw fail({
							code: "REFERENCE_STALE",
							source: "capability",
							message: "window Operation no longer owns this client",
							dispatch: "not_sent",
							recoverable: false,
						});
				},
				canCleanup: () => {
					const identity = this.deps.host.identity;
					return (
						this.deps.bot() === bot &&
						this.deps.host.state === "ready" &&
						identity?.connection === this.identity.connection &&
						identity.incarnation === this.identity.incarnation
					);
				},
				enterOp: () => this.enterOp(),
				exitOp: () => this.exitOp(),
				onRetired: (unresolvedOpening) => {
					if (unresolvedOpening) this.barrierProven = false;
					if (this.ownedWindow === window) this.ownedWindow = null;
				},
				publishWindow: this.deps.publishWindow,
			});
			this.ownedWindow = window;
			await window.open(() => {
				this.recheck();
				if ("networkId" in target) {
					this.resolveEntity(bot, target);
					activateContainerEntity(bot, target.networkId);
				} else activateContainerBlock(bot, target.block);
			});
			return window;
		} finally {
			this.openingWindow = false;
			this.exitOp();
		}
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
