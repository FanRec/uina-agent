/**
 * 受控导航：pathfinder 完整受控独占 Operation（I1）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/driver.md §5.4、§9.3、§10、§13；plan §6。
 * goto 与 Body 资格互斥（DriverControlArbiter 单槽）：独占期 acquire 与新 goto
 * 均报 CONTROL_CONFLICT。低层完成合同 body.goto@1：GoalNear 邻域判定到达
 * （goal_reached）；站立/距离核验与 tolerance 默认值归能力层。
 * 写源封印（§9.3）：取消经 clearGoal（上游 resetPath 同步清键/停挖/释放锁）+
 * physicsTick 守卫持续封印直到插件静止（stateGoal 为空后 monitorMovement
 * 不再写键位）；stop()/setGoal(null) 不作为屏障唯一证据。fullStop 的
 * 零速/回中修正属本 Operation，不入服务端纠偏。
 * 结果如实：到达=met；未到达按上游错误名与当时状态映射；派发后取消/断线
 * 不推断成功，结算 quiescence 有界，超期如实记 unknown。
 */

import type { ControlRetirement, DriverExecutionSink } from "../contracts/runtime.js";
import type { CallFailure, EffectReceipt, JsonValue, Ref, Vec3 } from "../contracts/values.js";
import { plain } from "../contracts/values.js";
import type { HostView } from "./body/session.js";
import type { DriverControlArbiter } from "./control-arbiter.js";
import type { MineflayerBot } from "./mineflayer/adapter.js";
import { fromMineflayerVec3 } from "./mineflayer/adapter.js";
import { EffectRecorder, fail } from "./execution.js";
import {
	clearGoal,
	configureMovements,
	gotoNear,
	loadPathfinderPlugin,
	pathfinderGoalActive,
	pathfinderMoving,
} from "./mineflayer/pathfinder.js";

export interface GotoDeps {
	assertActionAllowed: () => void;
	requireRetirement?: (notice: ControlRetirement) => void;
	host: HostView;
	bot: () => MineflayerBot | null;
	sink: DriverExecutionSink;
	arbiter: DriverControlArbiter;
	/** Driver 级唯一发号：op:/eff: 空间跨操作单调。 */
	mintOp: () => Ref;
	mintEff: () => Ref;
}

export interface GotoRequest {
	at: Vec3;
	/** GoalNear 邻域半径（格）；能力层默认 2（1..8），Driver 只收已校验值。 */
	tolerance: number;
	sprint: boolean;
	digThrough: boolean;
	/** 允许垫方块到达（pathfinder allow1by1towers）；不保证有材料。 */
	placeToReach: boolean;
	/** 墙钟上限；到点未达按 TIMEOUT 结算，不推断成功。 */
	timeoutMs: number;
}

export interface GotoOutcome {
	receipt: EffectReceipt;
	/** 到达时的实际站位（采样自本地实体；完成判定按 GoalNear 邻域）。 */
	at: Vec3;
	/** 消耗的实际客户端物理步数。 */
	ticks: number;
	/** 本次导航中实际完成的挖掘次数（upstream diggingCompleted 计数）。 */
	dug: number;
	/** 本次导航中放置的方块数：当前栈无法归属放置来源，如实 null。 */
	placed: null;
}

const QUIESCE_DEADLINE_MS = 2000;

/** GoalNear 的判定口径：节点（整数格）之间的 3D 距离。 */
function nodeGap(a: Vec3, b: Vec3): number {
	return Math.hypot(
		Math.floor(a.x) - Math.floor(b.x),
		Math.floor(a.y) - Math.floor(b.y),
		Math.floor(a.z) - Math.floor(b.z),
	);
}

type GotoState = "idle" | "running" | "settling" | "done";

export class GotoDirector {
	private readonly deps: GotoDeps;
	private state: GotoState = "idle";
	private readonly recorder: EffectRecorder;

	constructor(deps: GotoDeps) {
		this.deps = deps;
		this.recorder = new EffectRecorder(deps.sink);
	}

	async goto(request: GotoRequest, signal: AbortSignal): Promise<GotoOutcome> {
		this.deps.assertActionAllowed();
		if (this.recorder.isFaulted) {
			throw fail({
				code: "INTERNAL",
				source: "capability",
				message: "effect recorder faulted; new side effects are sealed",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (this.state !== "idle" && this.state !== "done") {
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "another controlled navigation operation is active on this driver",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		if (signal.aborted) {
			throw fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "goto aborted before dispatch",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		this.validateRequest(request);
		if (!this.deps.arbiter.tryClaimGoto()) {
			throw fail({
				code: "CONTROL_CONFLICT",
				source: "capability",
				message: "a body qualification is held; close it before a controlled navigation",
				dispatch: "not_sent",
				recoverable: false,
			});
		}

		const op = this.deps.mintOp();
		const eff = this.deps.mintEff();
		this.state = "running";
		let bot: MineflayerBot | null = null;
		let ticks = 0;
		let dug = 0;
		// 守卫：Operation 失效后每物理步封印写源，直到结算退役（§9.3 隔离）；
		// 定义在 try 外以便 finally 注销（迟到信号不得透过旧守卫影响后续 Operation）。
		const onDug = (): void => {
			dug++;
		};
		const guard = (): void => {
			ticks++;
			if (this.state !== "running") return;
			let ownerAllowed = true;
			try {
				this.deps.assertActionAllowed();
			} catch {
				ownerAllowed = false;
			}
			if (!ownerAllowed || signal.aborted || this.deps.host.state !== "ready") {
				this.seal(bot as MineflayerBot);
				if (pathfinderGoalActive(bot as MineflayerBot)) clearGoal(bot as MineflayerBot);
			}
		};
		try {
			bot = this.botForWrite();
			if (this.deps.host.identity == null) {
				throw fail({
					code: "WRONG_STATE",
					source: "environment",
					message: "client has no connection identity yet",
					dispatch: "not_sent",
					recoverable: true,
				});
			}
			const current = fromMineflayerVec3(bot.entity.position);
			if (current != null && nodeGap(current, request.at) <= request.tolerance) {
				// 目标已成立时上游不会发 goal_reached：它照常 setGoal 然后一直"移动"，
				// tolerance=1 且恰好隔一格是最常见的挂死形态。这里直接结算，不派发路径。
				this.recorder.record(
					eff,
					op,
					"body.goto@1",
					"receipt",
					"not_sent",
					"met",
					plain({
						completionContract: "already within the GoalNear radius; no path was dispatched",
						at: current,
						ticks: 0,
					}),
				);
				return {
					receipt: { effect: eff, dispatch: "not_sent", completion: "met", evidence: [] },
					at: current,
					ticks: 0,
					dug: 0,
					placed: null,
				};
			}
			loadPathfinderPlugin(bot);
			configureMovements(bot, {
				sprint: request.sprint,
				digThrough: request.digThrough,
				placeToReach: request.placeToReach,
			});
			bot.on("diggingCompleted", onDug as never);

			bot.on("physicsTick", guard as never);

			this.recorder.record(
				eff,
				op,
				"body.goto@1",
				"dispatch",
				"sent",
				"unknown",
				plain({
					at: request.at,
					tolerance: request.tolerance,
					sprint: request.sprint,
					digThrough: request.digThrough,
					timeoutMs: request.timeoutMs,
				}),
			);

			const outcome = await this.awaitOutcome(bot, request, signal);

			if (outcome === "reached") {
				if (this.deps.host.state !== "ready" || this.deps.host.identity == null) {
					throw fail({
						code: "DISCONNECTED",
						source: "environment",
						message: "connection ended during navigation",
						dispatch: "sent",
						effects: [eff],
						recoverable: false,
					});
				}
				const at = fromMineflayerVec3(bot.entity.position) ?? request.at;
				// 上游 goto 在"空路径"时也会 resolve（lib/goto.js 的 noPathListener 先判
				// path.length===0 再判 status，noPath 的空路径被当成正常结束）。
				// 完成必须是 GoalNear 真实成立：这里按实际站位复核，不把 resolve 当到达。
				const gap = Math.hypot(at.x - request.at.x, at.y - request.at.y, at.z - request.at.z);
				if (nodeGap(at, request.at) > request.tolerance) {
					throw fail({
						code: "UNREACHABLE",
						source: "world",
						message: `pathfinder stopped ${gap.toFixed(2)} blocks from the goal without a route`,
						hint: "the upstream goto resolves on an empty path; retry with a nearer target or digThrough",
						dispatch: "sent",
						progress: plain({ ticks, at, target: request.at, gap }) as never,
						effects: [eff],
						recoverable: true,
					});
				}
				this.recorder.record(
					eff,
					op,
					"body.goto@1",
					"receipt",
					"sent",
					"met",
					plain({
						completionContract:
							"goal_reached: GoalNear proximity satisfied (standing check belongs to the capability layer)",
						at,
						ticks,
						dug,
					}),
				);
				return {
					receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] },
					at,
					ticks,
					dug,
					placed: null,
				};
			}
			throw this.mapOutcomeFailure(outcome, eff, ticks, bot, signal.aborted);
		} finally {
			await this.settle(bot, eff, op, signal.aborted ? "aborted" : "finished");
			this.state = "done";
			// 守卫随 Operation 注销：调用结束后本 Operation 的 signal 已 abort，
			// 陈旧守卫会在后续导航运行期误触发封印并 clearGoal（上游表现为 GoalChanged）。
			if (bot != null) {
				bot.removeListener("physicsTick", guard as never);
				bot.removeListener("diggingCompleted", onDug as never);
			}
		}
	}

	private validateRequest(request: GotoRequest): void {
		const at = request.at;
		if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "goto target must be finite coordinates",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (!Number.isInteger(request.tolerance) || request.tolerance < 1 || request.tolerance > 8) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `tolerance must be an integer in [1,8], got ${request.tolerance}`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "timeoutMs must be a positive finite number",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
	}

	/**
	 * 竞速等待：到达 / 上游拒绝 / 墙钟超时 / 信号中断。
	 * 上游 promise 经 settle-once 包装收集，避免未处理拒绝与多路清理竞态。
	 */
	private awaitOutcome(
		bot: MineflayerBot,
		request: GotoRequest,
		signal: AbortSignal,
	): Promise<"reached" | "timeout" | "aborted" | Error> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (value: "reached" | "timeout" | "aborted" | Error): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const timer = setTimeout(() => finish("timeout"), request.timeoutMs);
			const onAbort = (): void => finish("aborted");
			signal.addEventListener("abort", onAbort, { once: true });
			gotoNear(bot, request.at, request.tolerance).then(
				() => finish("reached"),
				(err: Error) => finish(err),
			);
		});
	}

	private mapOutcomeFailure(
		outcome: "timeout" | "aborted" | Error,
		eff: Ref,
		ticks: number,
		bot: MineflayerBot,
		aborted: boolean,
	): CallFailure {
		if (this.deps.host.state !== "ready") {
			return fail({
				code: "DISCONNECTED",
				source: "environment",
				message: `connection is ${this.deps.host.state}; navigation did not complete`,
				dispatch: "sent",
				effects: [eff],
				recoverable: false,
			});
		}
		const at = fromMineflayerVec3(bot.entity.position);
		const progress = plain({ ticks, at: at ?? null }) as { summary?: string } & Record<string, JsonValue>;
		if (outcome === "aborted" || (aborted && outcome instanceof Error && outcome.name === "PathStopped")) {
			return fail({
				code: "INTERRUPTED",
				source: "environment",
				message: "goto was interrupted before reaching the goal",
				dispatch: "sent",
				progress,
				effects: [eff],
				recoverable: true,
			});
		}
		if (outcome === "timeout") {
			return fail({
				code: "TIMEOUT",
				source: "world",
				message: "goto exceeded its wall-clock budget before reaching the goal",
				hint: "retry with a larger timeoutMs or a nearer target",
				dispatch: "sent",
				progress,
				effects: [eff],
				recoverable: true,
			});
		}
		const name = outcome instanceof Error ? outcome.name : "Unknown";
		if (name === "NoPath" || name === "Timeout") {
			return fail({
				code: "UNREACHABLE",
				source: "world",
				message:
					name === "NoPath"
						? "pathfinder found no path to the goal"
						: "pathfinder could not plan a path within its think budget",
				hint: "check blockers along the way or pick a nearer reachable target",
				dispatch: "sent",
				progress,
				effects: [eff],
				recoverable: true,
			});
		}
		if (name === "PathStopped") {
			return fail({
				code: "CONTROL_INVALID",
				source: "capability",
				message: "navigation was stopped by another control transition before reaching the goal",
				dispatch: "sent",
				progress,
				effects: [eff],
				recoverable: true,
			});
		}
		return fail({
			code: "INTERNAL",
			source: "capability",
			message: `navigation ended unexpectedly: ${name} ${outcome instanceof Error ? outcome.message : String(outcome)}`,
			dispatch: "sent",
			progress,
			effects: [eff],
			recoverable: false,
		});
	}

	/** 失效封印：清键、停挖、清目标（幂等；guard 每 tick 重入）。 */
	private seal(bot: MineflayerBot): void {
		try {
			bot.clearControlStates();
		} catch {
			// 客户端消亡时键位随连接消亡
		}
		if (bot.targetDigBlock != null) {
			try {
				bot.stopDigging();
			} catch {
				// 取消派发失败按 unknown 结算
			}
		}
	}

	/**
	 * 结算：清目标 → 等插件静止（有界）→ 退役 → release 槽位。
	 * 静止判据（§9.3 屏障证据）：无目标、路径空、无在挖方块、键位全 false。
	 */
	private async settle(bot: MineflayerBot | null, eff: Ref, op: Ref, reason: string): Promise<void> {
		if (bot != null && pathfinderGoalActive(bot)) clearGoal(bot);
		const quiesced = await this.awaitQuiesced(bot);
		if (bot != null && !quiesced) {
			this.deps.requireRetirement?.({
				source: "driver",
				subject: eff,
				code: "CONTROL_ISOLATION_FAILED",
				detail: "navigation quiescence deadline exceeded",
			});
			this.seal(bot); // 期限兜底：保持封印至本调用结束
		}
		this.recorder.record(
			eff,
			op,
			"body.goto@1",
			"cleanup",
			bot == null ? "unknown" : "sent",
			bot == null || !quiesced ? "unknown" : "met",
			{
				reason,
				quiesced,
				note: quiesced
					? "navigation write sources sealed (no goal, no path, no digging, keys released)"
					: "quiescence deadline exceeded; residual writes cannot be excluded",
			},
		);
		this.deps.arbiter.releaseGoto();
	}

	private awaitQuiesced(bot: MineflayerBot | null): Promise<boolean> {
		if (bot == null) return Promise.resolve(false);
		const started = Date.now();
		return new Promise((resolve) => {
			const poll = setInterval(() => {
				const keysReleased = !Object.values(bot.controlState).some(Boolean);
				const busy = pathfinderGoalActive(bot) || pathfinderMoving(bot) || bot.targetDigBlock != null || !keysReleased;
				if (!busy || Date.now() - started >= QUIESCE_DEADLINE_MS) {
					clearInterval(poll);
					resolve(!busy);
				}
			}, 10);
		});
	}

	private botForWrite(): MineflayerBot {
		this.deps.assertActionAllowed();
		if (this.deps.host.state !== "ready") {
			throw fail({
				code: "DISCONNECTED",
				source: "environment",
				message: `client is ${this.deps.host.state}, not ready`,
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		const bot = this.deps.bot();
		if (bot == null) {
			throw fail({
				code: "DISCONNECTED",
				source: "environment",
				message: "client is gone",
				dispatch: "not_sent",
				recoverable: false,
			});
		}
		return bot;
	}
}
