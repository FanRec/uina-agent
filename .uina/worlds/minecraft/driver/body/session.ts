/**
 * Body Session：资格门、持续控制与离散身体操作（I1 子集）。
 *
 * 唯一定义来源：docs/proposals/mc/public-api.md §4、modules/driver.md §5–§7、§10、§13。
 * 状态机 active → revoking → quiesced → closed（§5.2）；revoking 不可逆；结束须新建资格。
 * 写入核验位置（I1 覆盖 §5.3 的 1/2/3/4）：操作入口、异步恢复后产生副作用前、
 * 控制状态修改前、修改插件目标前；窗口另在同步协议写入和按代次清理时核验。
 * feedback 复用真实物理步安装持续输入，并在流结束或资格撤销时清理。
 * 低层完成合同名（body.*@1）由 Driver 拥有；公开能力合同归 capabilities。
 * drive 的 Tick = 实际客户端物理模拟步（§7.2）：首个消费步开始计数，第 N 个
 * 消费步结束后、下一次模拟前撤销持续键/use（physicsTick 监听内同步撤销，
 * 上游 simulatePlayer 在 emit 前读取 controlState，构成模拟前窄接缝）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AttackOutcome,
	BlockTarget,
	BodyEventKind,
	BodyEventOptions,
	BodyEventOutcome,
	BodySession,
	ControlInput,
	ControlOwner,
	EntityRef,
	EquipSlot,
	EvidenceOutcome,
	FeedbackStream,
	Hand,
	ItemSelector,
	Key,
	PointTarget,
	SelfState,
	SignText,
	TossOutcome,
	WindowSession,
} from "../../contracts/body.js";
import { isClientAuthVehicle, VEHICLE_KINEMATICS } from "../../contracts/body.js";
import type { ClientWindowObservation } from "../../contracts/client-facts.js";
import type { ControlRetirement, DriverExecutionSink } from "../../contracts/runtime.js";
import type { CallFailure, EffectReceipt, Fact, JsonValue, Ref, Vec3 } from "../../contracts/values.js";
import { plain } from "../../contracts/values.js";
import type { WorldQuery } from "../../contracts/world.js";
import type { ClientHostListener } from "../client-host.js";
import { EffectRecorder, fail } from "../execution.js";
import { type MineflayerBot, toMineflayerVec3 } from "../mineflayer/adapter.js";
import { protocolFor } from "../mineflayer/protocol.js";
import { opensWindow } from "../window/layout.js";
import { WindowSessionImpl } from "../window/session.js";
import { FeedbackController } from "./feedback.js";
import { runEquip, runToss } from "./inventory.js";
import { runMining } from "./mining.js";
import type { BodyOperationDeps } from "./operation.js";
import { runSign } from "./sign.js";

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
	prepareFeedback?: import("../../contracts/body.js").PrepareFeedback;
	assertActionAllowed: () => void;
	requireRetirement?: (notice: ControlRetirement) => void;
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
/** 载具分支（批 18）：mineflayer mount 后 physicsTick 停发，载具拍用固定 50ms 节拍。 */
const VEHICLE_TICK_MS = 50;
/** 载具转向速率（弧度/拍）：开环递推的航向修正，探针实测被服务端接受。 */
const BOAT_TURN_RATE = 0.04;
function isIntVec(v: Vec3): boolean {
	return Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z);
}

export class BodySessionImpl implements BodySession {
	readonly body: Ref;
	readonly owner: ControlOwner;
	private readonly scopes = new AsyncLocalStorage<
		{ signal: AbortSignal; owner: ControlOwner; guard(): void; recorder: EffectRecorder } | undefined
	>();
	get signal(): AbortSignal {
		return this.scopes.getStore()?.signal ?? this.abortController.signal;
	}
	runScoped<T>(scope: { signal: AbortSignal; owner: ControlOwner; guard(): void }, work: () => Promise<T>): Promise<T> {
		const signal = AbortSignal.any([scope.signal, this.abortController.signal]);
		const recorder = new EffectRecorder({ record: (fact) => this.deps.sink.record({ ...fact, owner: scope.owner }) });
		return this.scopes.run({ ...scope, signal, recorder }, work);
	}

	private state: BodySessionState = "active";
	private closePromise: Promise<void> | null = null;
	private readonly identity: { connection: Ref; incarnation: Ref };
	private readonly deps: BodySessionDeps;
	private readonly abortController = new AbortController();
	/** 使用状态归属：hand → 占用它的 Operation（一次激活/hold 建档，endUse/hold 结束释放）。 */
	private readonly ownedUse = new Map<Hand, { operation: Ref; owner: ControlOwner; recorder: EffectRecorder }>();
	private pendingOps = 0;
	private ownedWindow: WindowSessionImpl | null = null;
	private openingWindow = false;
	private feedbackStream: FeedbackController | null = null;
	private viewOperations = 0;
	private barrierProven = true;
	private readonly rootRecorder: EffectRecorder;
	private get recorder(): EffectRecorder {
		return this.scopes.getStore()?.recorder ?? this.rootRecorder;
	}
	private boundCheck(): () => void {
		const scope = this.scopes.getStore();
		return () => this.scopes.run(scope, () => this.recheck());
	}
	private detachHost: () => void;

	constructor(body: Ref, owner: ControlOwner, deps: BodySessionDeps) {
		this.body = body;
		this.owner = owner;
		this.deps = deps;
		this.rootRecorder = new EffectRecorder({ record: (fact) => deps.sink.record({ ...fact, owner: this.owner }) });
		const identity = deps.host.identity;
		if (identity == null) {
			throw new Error("body session requires a ready connection identity");
		}
		this.identity = identity;
		this.detachHost = deps.host.on((notice) => {
			if (notice.kind === "disconnected") {
				this.revoke("connection_lost");
				return;
			}
			if (notice.kind === "incarnation_changed" || notice.kind === "incarnation_invalidated") {
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

	close(): Promise<void> {
		if (this.closePromise != null) return this.closePromise;
		this.revoke("session_close");
		this.closePromise = this.finishClose();
		return this.closePromise;
	}
	private async finishClose(): Promise<void> {
		await this.awaitPendingSettled(2000);
		if (this.pendingOps > 0) {
			this.barrierProven = false; // §10.5：无法证明旧写入失效，不允许新主人复用该客户端
		}
		this.state = "quiesced";
		this.state = "closed";
		this.detachHost();
		this.detachHost = () => {};
		if (!this.barrierProven)
			this.deps.requireRetirement?.({
				source: "driver",
				subject: this.body,
				code: "CONTROL_ISOLATION_FAILED",
				detail: "Body close could not prove that all old writes retired",
			});
		this.deps.onClosed(this.barrierProven);
	}

	/** 撤销资格：立即拒绝旧写入并清理持续输入（§10.2 前段，同步完成）。 */
	private revoke(reason: string): void {
		if (this.state !== "active") return;
		this.state = "revoking";
		this.abortController.abort();
		void this.feedbackStream?.close();
		const bot = this.deps.bot();
		if (bot != null) {
			try {
				bot.clearControlStates();
			} catch {
				// 撤销不因上游异常失败；连接已亡时控制态随连接消亡
			}
			this.neutralizeVehicle(bot);
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
				const recorder = [...this.ownedUse.values()].at(-1)!.recorder;
				const eff = this.deps.mintEff();
				const op = this.deps.mintOp();
				try {
					protocolFor(bot).endUse();
					recorder.record(eff, op, "body.endUse@1", "cleanup", "sent", "met", {
						reason,
						detail: "owned item use released during revocation; release side effects not confirmed",
					});
				} catch {
					recorder.record(eff, op, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
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
		const scope = this.scopes.getStore();
		if (scope) {
			try {
				scope.guard();
			} catch (e) {
				return e as CallFailure;
			}
		}
		try {
			this.deps.assertActionAllowed();
		} catch (err) {
			this.revoke("owner_gate_closed");
			return fail({
				code: "OWNER_GATE_CLOSED",
				source: "environment",
				message: String(err),
				dispatch: "not_sent",
				recoverable: false,
			});
		}
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
		protocolFor(bot).assertSupported();
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

	/** Local compatibility check; movement-only feedback keeps running. */
	private beginView(): () => void {
		this.recheck();
		if (this.feedbackStream?.hasViewInput()) this.viewConflict();
		this.viewOperations++;
		return () => {
			this.viewOperations--;
		};
	}
	private viewConflict(): never {
		throw fail({
			code: "CONTROL_CONFLICT",
			source: "capability",
			message: "another operation controls view",
			dispatch: "not_sent",
			recoverable: true,
		});
	}

	// ---- 记录 ----

	async drive(
		input: ControlInput,
		ticks: number,
	): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState> }> {
		if (this.feedbackStream)
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "feedback owns continuous input",
				dispatch: "not_sent",
				recoverable: true,
			});
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

			// 载具分支（批 18）必须先于视角处理：骑乘态 physicsTick 停发（mineflayer
			// mount 后停模拟），bot.lookAt 等物理 tick 收敛会永久挂死（真服 60s 挂死实证）。
			// 船走客户端权威 vehicle_move 运动学，马/猪/驼等服务端权威走 look + player_input；
			// 视角在 driveVehicle 内按角度直算、发原始包。
			if (bot.vehicle != null) {
				if (input.use != null || input.attack != null) {
					throw fail({
						code: "INVALID_INPUT",
						source: "input",
						message: "vehicle drive covers movement keys only; use/attack are not available while mounted",
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				return await this.driveVehicle(bot, input, ticks, eff, op);
			}

			// 视角：先于键位安装；lookAt/look 各派发一次。
			if (input.lookAt != null) {
				const point = this.lookPointFor(bot, input.lookAt);
				await bot.lookAt(toMineflayerVec3(point), false);
				this.recheck();
			} else if (input.look != null) {
				await bot.look(input.look.yaw, input.look.pitch, false);
				this.recheck();
			}

			// 键位：省略项按 false 安装（public-api §4）
			this.installControl(bot, input, op);

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
			// 载具输入一并中和：骑乘态键位走 player_input，与 controlState 无关（批 18）。
			if (bot != null) {
				this.revokeKeys(bot);
				this.neutralizeVehicle(bot);
				if (input.use != null && input.use.mode === "hold") {
					this.releaseUse(bot, input.use.hand, op, "drive exited");
				}
			}
			this.exitOp();
		}
	}

	/**
	 * 载具驾驶（批 18）：固定 50ms 节拍逐拍派发，任何退出路径先中和输入。
	 * 船（客户端权威）：运动学递推位置 + 每拍 vehicle_move；服务端权威实体：
	 * 每拍 look（服务端从骑手视角取转向）+ player_input 键位。
	 */
	private async driveVehicle(
		bot: MineflayerBot,
		input: ControlInput,
		ticks: number,
		eff: Ref,
		op: Ref,
	): Promise<{ receipt: EffectReceipt; actualTicks: number; end: Fact<SelfState>; vehicleAt: Vec3 }> {
		const vehicle = bot.vehicle;
		const vehicleName = vehicle?.name ?? "";
		const clientAuth = isClientAuthVehicle(vehicleName);
		const wantsMovement =
			input.keys.forward === true || input.keys.back === true || input.keys.left === true || input.keys.right === true;
		if (!clientAuth && wantsMovement) {
			// 矿车是轨道驱动：驾驶请求如实失败（capability 层先挡，这里是协议窄口的第二道）；
			// 但 sneak-only 放行——它是下马原语，矿车也靠它下车（批 18 真服实证）。
			throw fail({
				code: "WRONG_STATE",
				source: "input",
				message: `${vehicleName} follows rails and takes no drive input`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		// 运动学以载具实体位置为起点（骑乘态客户端视图冻结：self 与被骑载具都不回同步）。
		// 速率取 contracts 唯一真源：船 0.22/拍，马/猪等 0.15/拍（探针实测被服务端接受）。
		const isBoat = vehicleName.includes("boat") || vehicleName.includes("raft");
		const rates = isBoat ? VEHICLE_KINEMATICS.boat : VEHICLE_KINEMATICS.default;
		const kinematics = {
			x: vehicle?.position.x ?? bot.entity.position.x,
			y: vehicle?.position.y ?? bot.entity.position.y,
			z: vehicle?.position.z ?? bot.entity.position.z,
			yaw: bot.entity.yaw,
			pitch: bot.entity.pitch,
			speed: 0,
			forwardRate: rates.forward,
			reverseRate: rates.reverse,
		};
		// 视角：按角度直算进运动学（mineflayer lookAt 等物理 tick 收敛，骑乘态会永久挂死）。
		if (input.lookAt != null) {
			const point = this.lookPointFor(bot, input.lookAt);
			const eye = { x: kinematics.x, y: kinematics.y + 1.2, z: kinematics.z };
			const dx = point.x - eye.x;
			const dy = point.y - eye.y;
			const dz = point.z - eye.z;
			kinematics.yaw = Math.atan2(-dx, dz);
			kinematics.pitch = Math.atan2(-dy, Math.hypot(dx, dz));
		} else if (input.look != null) {
			kinematics.yaw = input.look.yaw;
			kinematics.pitch = input.look.pitch;
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
				lookAt: input.lookAt == null ? null : ({ ...input.lookAt } as unknown as JsonValue),
				vehicle: { name: vehicleName, clientAuth },
				kind: "vehicle",
			}),
		);
		const consumed = await this.consumeVehicleTicks(bot, input, kinematics, ticks, eff);
		// 骑乘态无服务端回声（self 与被骑载具的客户端视图都冻结）：申报终点是唯一的
		// 驾驶结论载体，随 receipt 交给调用方；服务端真值复核是验收场景的职责。
		const vehicleAt: Vec3 = { x: kinematics.x, y: kinematics.y, z: kinematics.z };
		const sampled = this.deps.sampleSelf();
		if (sampled == null || sampled.value == null) {
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "self sampling unavailable after vehicle drive; inputs were applied",
				dispatch: "sent",
				progress: { actualTicks: consumed, vehicle: vehicleName },
				effects: [eff],
				recoverable: false,
			});
		}
		const end: Fact<SelfState> = { ...sampled, value: sampled.value };
		this.recorder.record(eff, op, "body.drive@1", "receipt", "sent", "met", {
			actualTicks: consumed,
			vehicle: vehicleName,
			vehicleAt: plain(vehicleAt),
			completionContract:
				"vehicle inputs applied for the requested 50ms ticks; the declared endpoint is the open-loop proposal, not a server-confirmed position",
		});
		return {
			receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] },
			actualTicks: consumed,
			end,
			vehicleAt,
		};
	}

	/** 载具拍消费：固定节拍；中止/断线如实 INTERRUPTED（actualTicks 保留）。 */
	private consumeVehicleTicks(
		bot: MineflayerBot,
		input: ControlInput,
		kinematics: {
			x: number;
			y: number;
			z: number;
			yaw: number;
			pitch: number;
			speed: number;
			forwardRate: number;
			reverseRate: number;
		},
		ticks: number,
		eff: Ref,
	): Promise<number> {
		const signal = this.signal;
		const keys = input.keys;
		const protocol = protocolFor(bot);
		return new Promise<number>((resolve, reject) => {
			let consumed = 0;
			let settled = false;
			const cleanup = (): void => {
				clearInterval(timer);
				signal.removeEventListener("abort", onAbort);
			};
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};
			const onAbort = (): void => {
				settle(() =>
					reject(
						fail({
							code: "INTERRUPTED",
							source: "environment",
							message: "vehicle drive interrupted; inputs neutralized",
							dispatch: "sent",
							progress: { actualTicks: consumed },
							effects: [eff],
							recoverable: true,
						}),
					),
				);
			};
			const timer = setInterval(() => {
				consumed++;
				// 回调内任何异常都必须 settle：setInterval 里抛错会让本 promise 永不结束，
				// 身体槽被占死（真服 60s 挂死 + CONTROL_ISOLATION_FAILED 连锁的教训）。
				try {
					// 1.21.2+ 载具移动全面客户端权威（真服探针实测）：马对 player_input 的
					// forward 无响应；vehicle_move 生效但服务端带自己的物理拉扯，且**同一拍
					// 里发 player_input 会以输入位压制位移**（forward:false + 位置变更 = 拒收）。
					// 因此移动拍只发 vehicle_move（服务端回传位姿做闭环起点，沿 yaw 推进）；
					// 非移动拍（sneak 下马 / jump）只发 player_input，不掺 vehicle_move。
					const movement = keys.forward === true || keys.back === true || keys.left === true || keys.right === true;
					if (movement) {
						if (keys.left === true) kinematics.yaw += BOAT_TURN_RATE;
						if (keys.right === true) kinematics.yaw -= BOAT_TURN_RATE;
						kinematics.speed =
							keys.forward === true ? kinematics.forwardRate : keys.back === true ? -kinematics.reverseRate : 0;
						// 开环递推（探针验证）：申报点必须持续前移，马才会追踪；
						// 不能用服务端回读位置做闭环起点——被拒后回读不动，申报点冻结在原地，死锁。
						kinematics.x += -Math.sin(kinematics.yaw) * kinematics.speed;
						kinematics.z += Math.cos(kinematics.yaw) * kinematics.speed;
						protocol.vehicleMove({ x: kinematics.x, y: kinematics.y, z: kinematics.z }, kinematics.yaw);
					} else {
						protocol.vehicleInput({
							forward: false,
							backward: false,
							left: false,
							right: false,
							jump: keys.jump === true,
							shift: keys.sneak === true,
							sprint: keys.sprint === true,
						});
					}
					if (consumed >= ticks) settle(() => resolve(consumed));
				} catch (err) {
					settle(() =>
						reject(
							fail({
								code: "INTERNAL",
								source: "environment",
								message: `vehicle input write failed: ${String(err)}`,
								dispatch: "sent",
								progress: { actualTicks: consumed, vehicle: bot.vehicle?.name ?? "" },
								effects: [eff],
								recoverable: true,
							}),
						),
					);
				}
			}, VEHICLE_TICK_MS);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 载具输入中和：退出路径统一调用（防止"下车后还在按 W"与马持续前行）。 */
	private neutralizeVehicle(bot: MineflayerBot): void {
		// 非骑乘不发：player_input 是载具键位通道（1.21.2+），步行撤销发它纯属多余。
		if (bot.vehicle == null) return;
		try {
			protocolFor(bot).vehicleInput({});
		} catch {
			// 客户端消亡时输入随连接消亡
		}
	}

	/**
	 * 物理步消费：首个 physicsTick 即第 1 个消费步（上游 simulatePlayer 先读
	 * controlState 再 emit）；第 ticks 个消费步的监听回调内同步结算，
	 * 保证撤销发生在下一次 simulatePlayer 之前（模拟前窄接缝）。
	 * 失败一律抛错并携带实际步数；短执行不包装为完整成功。
	 */
	private consumeTicks(bot: MineflayerBot, ticks: number, eff: Ref): Promise<number> {
		const signal = this.signal;
		return new Promise<number>((resolve, reject) => {
			let consumed = 0;
			let lastTickAt = Date.now();
			let settled = false;
			const cleanup = () => {
				bot.removeListener("physicsTick", onTick as never);
				clearInterval(watchdog);
				signal.removeEventListener("abort", onAbort);
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
			signal.addEventListener("abort", onAbort, { once: true });
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

	private validateControl(bot: MineflayerBot, input: ControlInput): void {
		this.recheck();
		if (
			!input ||
			!input.keys ||
			Object.entries(input.keys).some(
				([key, value]) => !DRIVE_KEYS.includes(key as Key) || typeof value !== "boolean",
			) ||
			(input.look && (![input.look.yaw, input.look.pitch].every(Number.isFinite) || input.lookAt)) ||
			(input.use && (!["main", "off"].includes(input.use.hand) || !["hold", "once"].includes(input.use.mode)))
		)
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "invalid ControlInput",
				dispatch: "not_sent",
				recoverable: true,
			});
		if ((input.look || input.lookAt) && this.viewOperations > 0) this.viewConflict();
		if (input.use && !this.handHasItem(bot, input.use.hand))
			throw fail({
				code: "WRONG_STATE",
				source: "input",
				message: "selected hand has no item",
				dispatch: "not_sent",
				recoverable: true,
			});
		if (input.attack) this.resolveEntity(bot, input.attack);
		if (input.lookAt) this.lookPointFor(bot, input.lookAt);
	}
	private installControl(bot: MineflayerBot, input: ControlInput, op: Ref): void {
		this.validateControl(bot, input);
		for (const key of DRIVE_KEYS) bot.setControlState(key, input.keys[key] === true);
		for (const [hand, use] of this.ownedUse)
			if (use.operation === op && input.use?.hand !== hand)
				this.releaseUse(bot, hand, op, "control input released use");
		if (input.use) {
			const hand = input.use.hand;
			if (input.use.mode === "once" || this.ownedUse.get(hand)?.operation !== op) {
				protocolFor(bot).useItem(hand === "off" ? 1 : 0);
				this.ownedUse.set(hand, {
					operation: op,
					owner: this.scopes.getStore()?.owner ?? this.owner,
					recorder: this.recorder,
				});
			}
		}
		if (input.attack) bot.attack(this.resolveEntity(bot, input.attack));
	}

	private releaseUse(bot: MineflayerBot, hand: Hand, op: Ref, reason: string): void {
		const use = this.ownedUse.get(hand);
		if (use?.operation !== op) return; // 不清理无委托关系的其他操作资源
		this.ownedUse.delete(hand);
		if (!bot.usingHeldItem) return;
		const eff = this.deps.mintEff();
		const cleanupOp = this.deps.mintOp();
		try {
			protocolFor(bot).endUse();
			use.recorder.record(eff, cleanupOp, "body.endUse@1", "cleanup", "sent", "met", {
				reason,
				note: "held use released; release side effects (e.g. bow draw) not confirmed",
			});
		} catch {
			use.recorder.record(eff, cleanupOp, "body.endUse@1", "cleanup", "unknown", "unknown", { reason });
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

	private checkBlockTarget(target: BlockTarget, bot: MineflayerBot): void {
		this.recheck();
		const self = this.deps.sampleSelf()?.value;
		if (
			!isIntVec(target.block) ||
			target.place.dimension !== bot.game.dimension ||
			(self != null &&
				(self.place.world !== target.place.world || self.place.worldRevision !== target.place.worldRevision))
		)
			throw fail({
				code: "REFERENCE_STALE",
				source: "input",
				message: "block target does not belong to the current integer grid/world/dimension",
				dispatch: "not_sent",
				recoverable: false,
			});
	}

	async dig(target: BlockTarget, options?: { aim?: "target" | "preserve" }): Promise<EffectReceipt> {
		const releaseView = options?.aim === "preserve" ? () => {} : this.beginView();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			this.checkBlockTarget(target, bot);
			return await runMining(this.operationDeps(bot), target, options);
		} finally {
			releaseView();
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
			const evidence = this.awaitHurtEvidence(bot, target.networkId, evidenceMs);
			bot.attack(entity);
			const { hit, dead } = await evidence;
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
				dead,
			};
		} finally {
			this.exitOp();
		}
	}

	/** 证据窗口：不派发动作，只等待该实体的受击/死亡观察（批 12 fight 的远程与击杀确认）。 */
	async awaitEvidence(target: EntityRef, options?: { evidenceMs?: number }): Promise<EvidenceOutcome> {
		this.enterOp();
		try {
			const bot = this.botForWrite();
			this.resolveEntity(bot, target);
			const evidenceMs = Math.max(100, Math.min(options?.evidenceMs ?? 600, 5000));
			return await this.awaitHurtEvidence(bot, target.networkId, evidenceMs);
		} finally {
			this.exitOp();
		}
	}

	/**
	 * 受击证据窗口：entityHurt/entityDead 只按 networkId 归属，不把附近伤害当命中。
	 * hit=true 见受击或死亡；dead=true 只由死亡观察置位。窗口自然走完仍无观察 = false
	 * （看过但没有）；中止/断线 = null（没看完，不得宣称未命中或已击杀），
	 * 但窗口内已见到的证据照实保留（中止前已受击 → hit=true）。
	 */
	private awaitHurtEvidence(bot: MineflayerBot, networkId: number, windowMs: number): Promise<EvidenceOutcome> {
		const signal = this.signal;
		return new Promise<EvidenceOutcome>((resolve) => {
			let done = false;
			let hit: boolean | null = null;
			let dead: boolean | null = null;
			const onHurt = (entity: MFEntity | null) => {
				if (entity?.id === networkId) hit = true;
			};
			const onDead = (entity: MFEntity | null) => {
				if (entity?.id === networkId) {
					hit = true;
					dead = true;
					finish();
				}
			};
			const onAbort = () => finish();
			const onEnd = () => finish();
			const timer = setTimeout(() => {
				// 窗口走完：没有观察就是明确的 false，不是 null（null 只属于未走完）。
				hit ??= false;
				dead ??= false;
				finish();
			}, windowMs);
			const cleanup = () => {
				clearTimeout(timer);
				bot.removeListener("entityHurt", onHurt as never);
				bot.removeListener("entityDead", onDead as never);
				bot.removeListener("end", onEnd as never);
				signal.removeEventListener("abort", onAbort);
			};
			function finish() {
				if (done) return;
				done = true;
				cleanup();
				resolve({ hit, dead });
			}
			bot.on("entityHurt", onHurt as never);
			bot.on("entityDead", onDead as never);
			bot.on("end", onEnd as never);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * 身体事件证据窗口（批 18）：三态纪律与 awaitHurtEvidence 相同——
	 * true=窗口内观察到；false=窗口走完没有；null=中止/断线（没看完）。
	 * mount/dismount 只认 set_passengers/attach_entity 协议事实，
	 * mineflayer 的 mount/dismount 事件在"空 passengers 下马"与拴绳链接上不完整。
	 */
	async awaitBodyEvent(kind: BodyEventKind, options?: BodyEventOptions): Promise<BodyEventOutcome> {
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const evidenceMs = Math.max(100, Math.min(options?.evidenceMs ?? 3000, 600000));
			return await this.awaitBodyEventWindow(bot, kind, options ?? {}, evidenceMs);
		} finally {
			this.exitOp();
		}
	}

	/** 目标是否被本玩家拴住（批 18）：attach_entity 的本连接事实缓存，见 contracts 注释。 */
	async leashedBySelf(target: EntityRef): Promise<boolean> {
		this.enterOp();
		try {
			const bot = this.botForWrite();
			const entity = this.resolveEntity(bot, target);
			const selfId = bot.entity?.id;
			return selfId != null && protocolFor(bot).linkHolder(entity.id) === selfId;
		} finally {
			this.exitOp();
		}
	}

	private awaitBodyEventWindow(
		bot: MineflayerBot,
		kind: BodyEventKind,
		options: BodyEventOptions,
		windowMs: number,
	): Promise<BodyEventOutcome> {
		const signal = this.signal;
		const selfId = bot.entity?.id;
		return new Promise<BodyEventOutcome>((resolve) => {
			let done = false;
			const finish = (outcome: BodyEventOutcome): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				unsubscribeNotice();
				bot.removeListener("sleep", onBotEvent as never);
				bot.removeListener("wake", onBotEvent as never);
				bot.removeListener("dismount", onBotEvent as never);
				bot.removeListener("end", onEnd as never);
				signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			const onBotEvent = (): void => finish({ observed: true, vehicleId: null });
			const onEnd = (): void => finish({ observed: null });
			const onAbort = (): void => finish({ observed: null });
			// 窗口走完 = 明确的 false（没有观察到），null 只属于未走完。
			const timer = setTimeout(() => finish({ observed: false, vehicleId: null }), windowMs);
			const unsubscribeNotice = protocolFor(bot).subscribe((notice) => {
				if (kind === "mount") {
					if (notice.kind === "passengers" && notice.passengers.includes(selfId))
						finish({ observed: true, vehicleId: notice.vehicleId });
					else if (notice.kind === "link" && notice.entityId === selfId && notice.vehicleId > 0)
						finish({ observed: true, vehicleId: notice.vehicleId });
					return;
				}
				if (kind === "dismount") {
					if (notice.kind === "passengers" && !notice.passengers.includes(selfId))
						finish({ observed: true, vehicleId: null });
					else if (notice.kind === "link" && notice.entityId === selfId && notice.vehicleId <= 0)
						finish({ observed: true, vehicleId: notice.vehicleId });
					return;
				}
				if (kind === "link") {
					if (notice.kind !== "link") return;
					if (options.passengerId != null && notice.entityId !== options.passengerId) return;
					if (options.detached === true && notice.vehicleId > 0) return;
					if (options.detached !== true && notice.vehicleId <= 0) return;
					finish({ observed: true, vehicleId: notice.vehicleId });
					return;
				}
				if (kind === "bobber" && notice.kind === "bobber") finish({ observed: true, vehicleId: notice.id });
				if (kind === "bite" && notice.kind === "bite") finish({ observed: true, vehicleId: null });
			});
			if (kind === "sleep") bot.on("sleep", onBotEvent as never);
			if (kind === "wake") bot.on("wake", onBotEvent as never);
			if (kind === "dismount") bot.on("dismount", onBotEvent as never);
			bot.on("end", onEnd as never);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 结束睡眠（批 18）：entity_action stop_sleeping；唤醒与否由调用方的 wake 证据决定。 */
	async endSleep(): Promise<EffectReceipt> {
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			protocolFor(bot).wakeUp();
			this.recorder.record(eff, op, "body.endSleep@1", "dispatch", "sent", "unknown", {
				completionContract: "stop_sleeping dispatched; the wake observation belongs to the caller",
			});
			return { effect: eff, dispatch: "sent", completion: "unknown", evidence: [] };
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
			protocolFor(bot).useItem(hand === "off" ? 1 : 0);
			this.ownedUse.set(hand, {
				operation: op,
				owner: this.scopes.getStore()?.owner ?? this.owner,
				recorder: this.recorder,
			});
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
			const scopeOwner = this.scopes.getStore()?.owner;
			const owned = [...this.ownedUse].filter(
				([, use]) => scopeOwner === undefined || JSON.stringify(use.owner) === JSON.stringify(scopeOwner),
			);
			const hadOwned = owned.length > 0;
			for (const [hand] of owned) this.ownedUse.delete(hand);
			if (!hadOwned || !bot.usingHeldItem) {
				// 已结束状态幂等，不重复发 release
				this.recorder.record(eff, op, "body.endUse@1", "receipt", "not_sent", "met", {
					completionContract: "no owned item use to end",
					hadOwned,
				});
				return { effect: eff, dispatch: "not_sent", completion: "met", evidence: [] };
			}
			protocolFor(bot).endUse();
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
		const releaseView = "networkId" in input.target ? () => {} : this.beginView();
		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if ("networkId" in input.target) {
				const entity = this.resolveEntity(bot, input.target);
				protocolFor(bot).activateEntity(entity.id, input.hand === "off" ? 1 : 0);
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
			await bot.lookAt(
				toMineflayerVec3({ x: target.block.x + 0.5, y: target.block.y + 0.5, z: target.block.z + 0.5 }),
				true,
			);
			this.recheck();
			const f = direction ?? { x: 0, y: 1, z: 0 };
			const face = f.y > 0 ? 1 : f.y < 0 ? 0 : f.z > 0 ? 3 : f.z < 0 ? 2 : f.x > 0 ? 5 : 4;
			protocolFor(bot).activateBlock(target.block, face, input.hand === "off" ? 1 : 0, cursorPos);
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
			releaseView();
			this.exitOp();
		}
	}

	private operationDeps(bot: MineflayerBot): BodyOperationDeps {
		return {
			bot,
			protocol: protocolFor(bot),
			signal: this.signal,
			guard: this.boundCheck(),
			canCleanup: () =>
				this.deps.bot() === bot &&
				this.deps.host.state === "ready" &&
				this.deps.host.identity?.connection === this.identity.connection &&
				this.deps.host.identity?.incarnation === this.identity.incarnation,
			recorder: this.recorder,
			mintOp: this.deps.mintOp,
			mintEff: this.deps.mintEff,
		};
	}

	private async withInventoryScope<T>(
		work: (deps: BodyOperationDeps & { window: WindowSession; selectedSlot: number }) => Promise<T>,
	): Promise<T> {
		this.enterOp();
		try {
			const bot = this.botForWrite();
			if (this.ownedWindow !== null || this.openingWindow || bot.currentWindow !== null)
				throw fail({
					code: "CONTROL_CONFLICT",
					source: "capability",
					message: "another inventory/window operation owns this body",
					dispatch: "not_sent",
					recoverable: false,
				});
			const deps = this.operationDeps(bot);
			const check = this.boundCheck();
			const window = new WindowSessionImpl({
				...deps,
				player: true,
				operation: this.deps.mintOp(),
				connection: this.identity.connection,
				incarnation: this.identity.incarnation,
				guard: () => {
					check();
					if (this.ownedWindow !== window)
						throw fail({
							code: "REFERENCE_STALE",
							source: "capability",
							message: "inventory operation retired",
							dispatch: "not_sent",
							recoverable: false,
						});
				},
				enterOp: () => this.enterOp(),
				exitOp: () => this.exitOp(),
				onRetired: () => {
					if (this.ownedWindow === window) this.ownedWindow = null;
				},
			});
			this.ownedWindow = window;
			try {
				return await work({ ...deps, window, selectedSlot: bot.quickBarSlot });
			} finally {
				await window.close({ force: true });
			}
		} finally {
			this.exitOp();
		}
	}

	async equip(item: ItemSelector | null, slot: EquipSlot): Promise<EffectReceipt> {
		return this.withInventoryScope((deps) => runEquip(deps, item, slot));
	}

	async toss(item: ItemSelector, count: number): Promise<TossOutcome> {
		return this.withInventoryScope((deps) => runToss(deps, item, count));
	}

	/** 玩家自带窗口的作用域（2×2 合成用）：与 equip/toss 走同一条所有权与撤销屏障。 */
	async withInventory<T>(work: (window: WindowSession) => Promise<T>): Promise<T> {
		return this.withInventoryScope((deps) => work(deps.window));
	}

	async lookAt(target: PointTarget | EntityRef): Promise<EffectReceipt> {
		const releaseView = this.beginView();
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
			releaseView();
			this.exitOp();
		}
	}

	async writeSign(target: BlockTarget, input: { side: "front" | "back"; lines: SignText }): Promise<EffectReceipt> {
		const releaseView = this.beginView();
		this.enterOp();
		try {
			const bot = this.botForWrite();
			this.checkBlockTarget(target, bot);
			return await runSign(this.operationDeps(bot), target, input);
		} finally {
			releaseView();
			this.exitOp();
		}
	}

	/** physicsTick precedes updatePosition in the installed plugin; awaiting resumes after that stack. */
	private awaitContainerPhysicsBoundary(bot: MineflayerBot): Promise<void> {
		const signal = this.signal;
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				bot.removeListener("physicsTick", onTick);
				bot.removeListener("end", onEnd);
				signal.removeEventListener("abort", onAbort);
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
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	async openContainer(_target: BlockTarget | EntityRef): Promise<WindowSession> {
		const releaseView = this.beginView();
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
				if (!opensWindow(block.name)) {
					throw fail({
						code: "UNSUPPORTED_WINDOW",
						source: "capability",
						message: `${block.name} does not open a supported window`,
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
			const check = this.boundCheck();
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
					check();
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
					protocolFor(bot).activateEntity(target.networkId);
				} else protocolFor(bot).activateBlock(target.block);
			});
			return window;
		} finally {
			this.openingWindow = false;
			releaseView();
			this.exitOp();
		}
	}

	async feedback(sensors: Record<string, WorldQuery>): Promise<FeedbackStream> {
		const bot = this.botForWrite();
		if (this.feedbackStream || this.pendingOps > 0 || this.ownedWindow)
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "another continuous control/window is active",
				dispatch: "not_sent",
				recoverable: true,
			});
		if (!this.deps.prepareFeedback)
			throw fail({
				code: "SENSOR_UNAVAILABLE",
				source: "environment",
				message: "feedback sampler is not installed",
				dispatch: "not_sent",
				recoverable: true,
			});
		const sample = this.deps.prepareFeedback(sensors);
		sample();
		const op = this.deps.mintOp();
		const scope = this.scopes.getStore();
		const scoped = <T>(work: () => T): T => this.scopes.run(scope, work);
		const recorder = this.recorder;
		let effect = this.deps.mintEff();
		const raw = new FeedbackController({
			body: this.body,
			operation: op,
			identity: this.identity,
			bot,
			signal: this.signal,
			guard: this.boundCheck(),
			sample,
			validate: (input) => scoped(() => this.validateControl(bot, input)),
			install: (input) =>
				scoped(() => {
					this.installControl(bot, input, op);
					if (input.lookAt) {
						const point = this.lookPointFor(bot, input.lookAt);
						const pos = bot.entity.position;
						const dx = point.x - pos.x,
							dy = point.y - (pos.y + 1.62),
							dz = point.z - pos.z;
						void bot.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true);
					} else if (input.look) void bot.look(input.look.yaw, input.look.pitch, true);
				}),
			clear: () =>
				scoped(() => {
					this.revokeKeys(bot);
					for (const hand of ["main", "off"] as const) this.releaseUse(bot, hand, op, "feedback released");
				}),
			closed: () => {
				if (this.feedbackStream === raw) this.feedbackStream = null;
			},
			record: (kind, detail, dispatch = "sent") => {
				if ((kind === "dispatch" && dispatch === "unknown") || kind === "cleanup") effect = this.deps.mintEff();
				recorder.record(effect, op, "body.feedback@1", kind, dispatch, kind === "dispatch" ? "unknown" : "met", detail);
				return { effect, dispatch, completion: kind === "dispatch" ? "unknown" : "met", evidence: [] };
			},
		});
		this.feedbackStream = raw;
		return raw;
	}
}
