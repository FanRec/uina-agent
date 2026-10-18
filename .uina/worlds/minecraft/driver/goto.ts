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

import type { DriverExecutionSink } from "../contracts/runtime.js";
import type { CallFailure, EffectReceipt, ExactRef, JsonValue, Ref, Vec3 } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import type { HostView } from "./body/session.js";
import type { DriverControlArbiter } from "./control-arbiter.js";
import type { MineflayerBot } from "./mineflayer/adapter.js";
import { fromMineflayerVec3 } from "./mineflayer/adapter.js";
import {
	clearGoal,
	configureMovements,
	gotoNear,
	loadPathfinderPlugin,
	pathfinderGoalActive,
	pathfinderMoving,
} from "./mineflayer/pathfinder.js";

export interface GotoDeps {
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
	/** 墙钟上限；到点未达按 TIMEOUT 结算，不推断成功。 */
	timeoutMs: number;
}

export interface GotoOutcome {
	receipt: EffectReceipt;
	/** 到达时的实际站位（采样自本地实体；完成判定按 GoalNear 邻域）。 */
	at: Vec3;
	/** 消耗的实际客户端物理步数。 */
	ticks: number;
}

const QUIESCE_DEADLINE_MS = 2000;

function nowIso(): string {
	return new Date().toISOString();
}

/** 事实 detail 只收纯 JSON 值。 */
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

type GotoState = "idle" | "running" | "settling" | "done";

export class GotoDirector {
	private readonly deps: GotoDeps;
	private state: GotoState = "idle";
	private recorderFaulted = false;

	constructor(deps: GotoDeps) {
		this.deps = deps;
	}

	async goto(request: GotoRequest, signal: AbortSignal): Promise<GotoOutcome> {
		if (this.recorderFaulted) {
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
			loadPathfinderPlugin(bot);
			configureMovements(bot, { sprint: request.sprint, digThrough: request.digThrough });

			// 守卫：Operation 失效后每物理步封印写源，直到结算退役（§9.3 隔离）
			const guard = (): void => {
				ticks++;
				if (this.state !== "running") return;
				if (signal.aborted || this.deps.host.state !== "ready") {
					this.seal(bot as MineflayerBot);
					if (pathfinderGoalActive(bot as MineflayerBot)) clearGoal(bot as MineflayerBot);
				}
			};
			bot.on("physicsTick", guard as never);

			this.recordFact(
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
				this.recordFact(
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
					}),
				);
				return { receipt: { effect: eff, dispatch: "sent", completion: "met", evidence: [] }, at, ticks };
			}
			throw this.mapOutcomeFailure(outcome, eff, ticks, bot, signal.aborted);
		} finally {
			await this.settle(bot, eff, op, signal.aborted ? "aborted" : "finished");
			this.state = "done";
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
			this.seal(bot); // 期限兜底：保持封印至本调用结束
		}
		this.recordFact(
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
}
