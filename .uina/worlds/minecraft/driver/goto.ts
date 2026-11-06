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
import type { RoutePlanResult } from "../contracts/world.js";
import type { HostView } from "./body/session.js";
import type { DriverControlArbiter } from "./control-arbiter.js";
import { EffectRecorder, fail } from "./execution.js";
import type { MineflayerBot } from "./mineflayer/adapter.js";
import { fromMineflayerVec3 } from "./mineflayer/adapter.js";
import {
	clearGoal,
	configureMovements,
	gotoNear,
	loadPathfinderPlugin,
	pathfinderGoalActive,
	pathfinderMoving,
	planPath,
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

/**
 * 无进展判据（G21 收尾）：上游执行器卡住时既不 reject 也不停路径，只在每 3.5s
 * 静默重规划一次（`resetPath('stuck')` 不 emit `path_stop`），调用方只能等到墙钟。
 * 这里按"实际位移"而不是"到目标的直线距离"判——绕行会合法地不缩短距离。
 */
const STALL_SAMPLE_MS = 500;
const STALL_WINDOW_MS = 3000;
const STALL_MIN_DISPLACEMENT = 0.25;
/** 同一个方块连续挖满这么久还没换目标，就不再当作"正在挖掘"的豁免。 */
const DIG_STALL_MS = 12000;
/**
 * 上膛后 goal 被上游清空的宽限：resetPath('stuck') 会连 goal 一起清且不 emit
 * path_stop（批19 G21 的静默卡死形态、批22 山地实测复现）——上膛后 goal 消失超过
 * 这个宽限仍无重规划新 goal、promise 也未结算，按 Stalled 收束，不再烧满墙钟。
 * 宽限覆盖合法的瞬时重规划（goal 短暂消失后立刻重设）。
 */
const GOAL_DROP_GRACE_MS = 2500;
/**
 * 零位移总兜底：无论 goal/isMoving 如何闪烁（重规划循环会把上膛与 goal 宽限双双
 * 重置——批22 山地实测第三形态），只要非挖掘状态下连续这么久位移 <0.25 格就按
 * Stalled 收束。它不依赖任何上游状态，是看门狗的最终防线。
 */
const ZERO_MOVE_STALL_MS = 10000;

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
				// 到达精度权威归 Uina，不删此复核。上游 lib/goto.js 的空路径假成功已
				// 补丁修复（noPath/timeout 空路径现按错误名拒绝），但 goal_reached 还有
				// isEnd(p.floored().offset(0,1,0)) 分支：站在半砖/楼梯上时 floored 比目标
				// 低 2 格也会被判到达——GoalNear 的 +1 容忍与 nodeGap 口径不等价（已知
				// 语义差）。nodeGap 更严，符合 goto@1 的站位合同；若真服出现误拒再裁决放宽。
				// 同时保留对上游回归的防线。
				const gap = Math.hypot(at.x - request.at.x, at.y - request.at.y, at.z - request.at.z);
				if (nodeGap(at, request.at) > request.tolerance) {
					throw fail({
						code: "UNREACHABLE",
						source: "world",
						message: `pathfinder stopped ${gap.toFixed(2)} blocks from the goal without a route`,
						hint: "retry with a nearer target or digThrough",
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
	 * 竞速等待：到达 / 上游拒绝 / 墙钟超时 / 无进展 / 信号中断。
	 * 上游 promise 经 settle-once 包装收集，避免未处理拒绝与多路清理竞态。
	 */
	private awaitOutcome(
		bot: MineflayerBot,
		request: GotoRequest,
		signal: AbortSignal,
	): Promise<"reached" | "timeout" | "aborted" | Error> {
		return new Promise((resolve) => {
			let done = false;
			const samples: { at: number; pos: Vec3 | null }[] = [];
			const finish = (value: "reached" | "timeout" | "aborted" | Error): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				clearInterval(watchdog);
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const timer = setTimeout(() => finish("timeout"), request.timeoutMs);
			const onAbort = (): void => finish("aborted");
			signal.addEventListener("abort", onAbort, { once: true });
			// 起算条件：至少见过一次非空路径。规划期的静止是合法的（A* 可能思考数秒），
			// 而卡死时上游每次重规划都会重新给出路径，isMoving 只在重规划的那一瞬为假——
			// 所以"上膛"之后改用 goal 活性判定，不再被重规划窗口打断。
			let armed = false;
			let goalInactiveSince = 0;
			let digTarget: unknown = null;
			let digSince = 0;
			let lastMoveAt = Date.now();
			let lastTickPos: Vec3 | null = null;
			const watchdog = setInterval(() => {
				const now = Date.now();
				const pos = fromMineflayerVec3(bot.entity.position);
				samples.push({ at: now, pos });
				while (samples.length > 0 && now - samples[0]!.at > STALL_WINDOW_MS) samples.shift();
				if (lastTickPos != null && pos != null) {
					const tickMoved = Math.hypot(pos.x - lastTickPos.x, pos.y - lastTickPos.y, pos.z - lastTickPos.z);
					if (tickMoved >= STALL_MIN_DISPLACEMENT) lastMoveAt = now;
				}
				lastTickPos = pos;
				if (!armed) {
					// 规划期的静止合法（A* 可能思考数秒）；见到非空路径即上膛。
					// 始终无路径的静默空转（goal 在而 A* 不产出）由下方零位移兜底收束。
					if (pathfinderMoving(bot)) armed = true;
					else return;
				}
				const digBlock = bot.targetDigBlock;
				if (digBlock !== digTarget) {
					digTarget = digBlock;
					digSince = now;
				}
				// 挖掘本身会让身体停住：换目标算进展，同一个方块挖满 DIG_STALL_MS 仍算卡死。
				const digging = digBlock != null && now - digSince < DIG_STALL_MS;
				if (digging) {
					lastMoveAt = now;
					samples.length = 0;
					goalInactiveSince = 0;
					return;
				}
				// 零位移总兜底：与 goal/isMoving 状态无关（闪烁免疫），挖掘已在上方豁免。
				if (now - lastMoveAt > ZERO_MOVE_STALL_MS) {
					finish(
						Object.assign(new Error("no displacement for 10s regardless of pathfinder state"), {
							name: "Stalled",
						}),
					);
					return;
				}
				if (!pathfinderGoalActive(bot)) {
					// 上膛后 goal 消失 = 上游清了路径与 goal 却未结算 promise（resetPath 形态）。
					// 宽限内的重规划（goal 立刻重设）不打断；超宽限按 Stalled 收束。
					if (goalInactiveSince === 0) goalInactiveSince = now;
					else if (now - goalInactiveSince > GOAL_DROP_GRACE_MS) {
						samples.length = 0;
						finish(Object.assign(new Error("navigation stopped without settling"), { name: "Stalled" }));
						return;
					}
					samples.length = 0;
					return;
				}
				goalInactiveSince = 0;
				const oldest = samples[0];
				if (oldest == null || now - oldest.at < STALL_WINDOW_MS) return;
				if (oldest.pos == null || pos == null) return;
				const moved = Math.hypot(pos.x - oldest.pos.x, pos.y - oldest.pos.y, pos.z - oldest.pos.z);
				if (moved >= STALL_MIN_DISPLACEMENT) return;
				finish(Object.assign(new Error("navigation made no progress"), { name: "Stalled" }));
			}, STALL_SAMPLE_MS);
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
		if (name === "Stalled") {
			return fail({
				code: "UNREACHABLE",
				source: "world",
				message: "navigation made no progress for 3s; the route is blocked or a step cannot be climbed",
				hint: "inspect the obstacle at the reported position, or allow digThrough / pick a nearer target",
				dispatch: "sent",
				progress,
				effects: [eff],
				recoverable: true,
			});
		}
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

	// ---- route.plan@1：只读试算（capabilities.md §3 route.plan、§2.11） ----

	/** 试算串行链：plan 是短操作，并发调用顺延而不是拒绝；不占 arbiter 控制槽。 */
	private planQueue: Promise<unknown> = Promise.resolve();

	/**
	 * 只读试算：GoalNear + movements 配置与 goto 共用（§2.11 计划与执行复用目标语义）；
	 * 局部 Movements 不触碰活动导航的共享配置，never setGoal、无写入、无效果记录。
	 * 输入是 World 校验后的 route.plan@1 参数；Pos 解析在驱动侧镜像 capability §2.2
	 * 语义（显式维度参与核验，rel 相对当前站位）。
	 */
	async plan(input: {
		at: unknown;
		tolerance?: number;
		digThrough?: boolean;
		placeToReach?: boolean;
		sprint?: boolean;
	}): Promise<RoutePlanResult> {
		this.deps.assertActionAllowed();
		const run = this.planQueue.then(() => this.planOnce(input));
		this.planQueue = run.catch(() => undefined);
		return run;
	}

	private async planOnce(input: {
		at: unknown;
		tolerance?: number;
		digThrough?: boolean;
		placeToReach?: boolean;
		sprint?: boolean;
	}): Promise<RoutePlanResult> {
		const bot = this.botForWrite();
		const current = fromMineflayerVec3(bot.entity.position);
		if (current == null) {
			throw fail({
				code: "DISCONNECTED",
				source: "environment",
				message: "client entity position is unavailable",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const raw = input.at as { x: number; y: number; z: number } | { position: Vec3; dimension: string } | { rel: Vec3 };
		let at: Vec3;
		let dimension: string = bot.game.dimension;
		if ("rel" in raw) {
			at = { x: current.x + raw.rel.x, y: current.y + raw.rel.y, z: current.z + raw.rel.z };
		} else if ("position" in raw) {
			at = raw.position;
			dimension = raw.dimension;
		} else {
			at = raw;
		}
		if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: "route.plan target must be finite coordinates",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		if (dimension !== bot.game.dimension) {
			throw fail({
				code: "WRONG_STATE",
				source: "world",
				message: `target is in dimension ${dimension}, current dimension is ${bot.game.dimension}`,
				hint: "route.plan stays inside the current dimension; transit@1 will handle portals",
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const tolerance = input.tolerance ?? 2;
		if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > 8) {
			throw fail({
				code: "INVALID_INPUT",
				source: "input",
				message: `tolerance must be an integer in [1,8], got ${tolerance}`,
				dispatch: "not_sent",
				recoverable: true,
			});
		}
		const planned = await planPath(bot, at, tolerance, {
			sprint: input.sprint ?? true,
			digThrough: input.digThrough ?? false,
			placeToReach: input.placeToReach ?? true,
		});
		const distance = Math.round(Math.hypot(at.x - current.x, at.y - current.y, at.z - current.z) * 100) / 100;
		const ok = planned.status === "success";
		const blockers =
			ok || planned.steps.length === 0
				? ok
					? []
					: [
							{
								at: { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) },
								reason: "pathfinder found no route to the goal",
							},
						]
				: [
						{
							at: {
								x: planned.steps[planned.steps.length - 1]!.x,
								y: planned.steps[planned.steps.length - 1]!.y,
								z: planned.steps[planned.steps.length - 1]!.z,
							},
							reason: "pathfinding stopped short of the goal within its think budget",
						},
					];
		return {
			ok,
			distance,
			steps: planned.steps.map((step) => ({ at: { x: step.x, y: step.y, z: step.z }, action: step.action })),
			needs: planned.needs,
			blockers,
			estTimeSec: ok ? Math.round(planned.cost * 10) / 10 : null,
		};
	}
}
