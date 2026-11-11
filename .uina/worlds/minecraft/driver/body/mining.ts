/** Owned digging: client timing schedules writes; only decoded server block updates confirm them. */
import type { BlockTarget } from "../../contracts/body.js";
import type { CallFailure, EffectReceipt } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { toMineflayerVec3 } from "../mineflayer/adapter.js";
import type { ProtocolNotice } from "../mineflayer/protocol.js";
import { aimAtControlled, BLOCK_REACH, checkBlockHit, eyeOf, worldViewOf } from "./aim.js";
import type { BodyOperationDeps } from "./operation.js";

const CONFIRM_MS = 5000;

export async function runMining(
	deps: BodyOperationDeps,
	target: BlockTarget,
	options?: { aim?: "target" | "preserve" },
): Promise<EffectReceipt> {
	deps.guard();
	const operation = deps.mintOp();
	const effect = deps.mintEff();
	return new Promise((resolve, reject) => {
		let done = false;
		let dispatch: EffectReceipt["dispatch"] = "not_sent";
		let finishSent = false;
		// §4.1：真实命中面（闸门给出），start/finish/cancel 三包共用同一面。
		let aimFace = 1;
		let digTimer: ReturnType<typeof setTimeout> | null = null;
		let confirmTimer: ReturnType<typeof setTimeout> | null = null;
		// §4.3：startDig 到挖掘结束按 Mineflayer 原生约 350ms 节拍连续挥手；
		// 服务端终态、取消、断线、控制退役都立即清理周期任务。
		let swingTimer: ReturnType<typeof setInterval> | null = null;
		let detach: () => void = () => {};
		const cleanup = () => {
			if (digTimer !== null) clearTimeout(digTimer);
			if (confirmTimer !== null) clearTimeout(confirmTimer);
			if (swingTimer !== null) clearInterval(swingTimer);
			swingTimer = null;
			detach();
			deps.signal.removeEventListener("abort", onAbort);
		};
		const settle = (completion: EffectReceipt["completion"], error?: CallFailure) => {
			if (done) return;
			done = true;
			cleanup();
			if (dispatch !== "not_sent")
				deps.recorder.record(effect, operation, "body.dig@1", "receipt", dispatch, completion, {
					completionContract: "only a matching server block update confirms the target state",
					finished: finishSent,
					target: { x: target.block.x, y: target.block.y, z: target.block.z },
					// 世界身份（§3.5.4）：核验器据此拒绝跨维度/异世界的同坐标空气冒充确认。
					dimension: deps.bot.game?.dimension ?? null,
				});
			if (error !== undefined) reject(error);
			else resolve({ effect, dispatch, completion, evidence: [] });
		};
		const stop = (code: string, message: string, allowCleanup: boolean) => {
			if (done) return;
			if (dispatch !== "not_sent" && !finishSent && allowCleanup && deps.canCleanup()) {
				try {
					deps.protocol.cancelDig(target.block, aimFace);
					deps.recorder.record(effect, operation, "body.dig@1", "cleanup", "sent", "unknown", { reason: code });
				} catch {
					deps.recorder.record(effect, operation, "body.dig@1", "cleanup", "unknown", "unknown", { reason: code });
				}
			}
			settle(
				"unknown",
				fail({
					code,
					source: "environment",
					message,
					dispatch,
					effects: dispatch !== "not_sent" ? [effect] : [],
					recoverable: false,
				}),
			);
		};
		const onAbort = () => stop("INTERRUPTED", "digging interrupted; owned timers and writes retired", true);
		const onNotice = (notice: ProtocolNotice) => {
			if (done) return;
			if (notice.kind === "end") {
				stop("DISCONNECTED", "connection ended during digging", false);
				return;
			}
			if (
				notice.kind !== "block" ||
				dispatch === "not_sent" ||
				notice.position.x !== target.block.x ||
				notice.position.y !== target.block.y ||
				notice.position.z !== target.block.z
			)
				return;
			// A synchronous adapter callback cannot settle before its dispatch fact is recorded.
			queueMicrotask(() => {
				if (done) return;
				try {
					deps.guard();
				} catch {
					onAbort();
					return;
				}
				if (notice.air) settle("met");
				else if (finishSent) settle("not_met");
			});
		};
		detach = deps.protocol.subscribe(onNotice);
		deps.signal.addEventListener("abort", onAbort, { once: true });
		if (deps.signal.aborted) {
			onAbort();
			return;
		}
		const sendFinish = () => {
			if (done) return;
			try {
				deps.guard();
				finishSent = true;
				deps.protocol.finishDig(target.block, aimFace);
				if (!done) confirmTimer = setTimeout(() => settle("unknown"), CONFIRM_MS);
			} catch (error) {
				stop((error as CallFailure).code ?? "INTERNAL", error instanceof Error ? error.message : String(error), true);
			}
		};
		void (async () => {
			try {
				if ((options?.aim ?? "target") === "target") {
					await deps.bot.lookAt(
						toMineflayerVec3({ x: target.block.x + 0.5, y: target.block.y + 0.5, z: target.block.z + 0.5 }),
						true,
					);
				}
				if (done) return;
				deps.guard();
				const block = deps.bot.blockAt(toMineflayerVec3(target.block));
				if (block == null)
					throw fail({
						code: "NOT_FOUND",
						source: "world",
						message: "dig target is not loaded",
						dispatch: "not_sent",
						recoverable: true,
					});
				const waitMs = deps.bot.digTime(block);
				if (!Number.isFinite(waitMs) || waitMs < 0)
					throw fail({
						code: "MISSING_TOOL",
						source: "world",
						message: "the current tool cannot finish digging this block",
						dispatch: "not_sent",
						recoverable: true,
					});
				deps.guard();
				// 写前意图（§5.12）：破坏方块不可撤销。原来的 dispatch=unknown 只是内存标记，
				// 崩溃后连"可能已经开始挖"都没有持久证据。
				// §4.1 派发闸门：以操作当刻真实眼位/方块形状/射线/射程判可达性。
				// 隔墙、超程、目标未加载在写前意图之前失败，不产生任何效果记录。
				const gate = await checkBlockHit(worldViewOf(deps.bot), eyeOf(deps.bot.entity), target.block, {
					reach: BLOCK_REACH,
				});
				if (!gate.ok) {
					throw fail({
						code: gate.code === "NOT_FOUND" ? "NOT_FOUND" : "UNREACHABLE",
						source: "world",
						message: gate.message,
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				aimFace = gate.hit.faceNumber;
				// §4.2 受控转头到位（视角互斥域内、每 Tick 限速），再复核一次射线：
				// 瞄准期间目标可能被挖掉/回填，眼位也可能随姿态变化。
				await aimAtControlled(deps.bot, gate.hit.point, { signal: deps.signal });
				deps.guard();
				const recheck = await checkBlockHit(worldViewOf(deps.bot), eyeOf(deps.bot.entity), target.block, {
					reach: BLOCK_REACH,
				});
				if (!recheck.ok) {
					throw fail({
						code: recheck.code === "NOT_FOUND" ? "NOT_FOUND" : "UNREACHABLE",
						source: "world",
						message: `target changed while aiming: ${recheck.message}`,
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				aimFace = recheck.hit.faceNumber;
				await deps.recorder.beforeWrite(effect, operation, "body.dig@1", {
					target: { x: target.block.x, y: target.block.y, z: target.block.z },
					predictedMs: waitMs,
					dimension: deps.bot.game?.dimension ?? null,
				});
				deps.guard();
				// 意图等盘期间目标可能已经被挖掉或换掉：不往不存在的方块上发 startDig。
				if (deps.bot.blockAt(toMineflayerVec3(target.block)) == null) {
					deps.recorder.closeIntent(effect, operation, "body.dig@1", "NOT_FOUND");
					throw fail({
						code: "NOT_FOUND",
						source: "world",
						message: "dig target disappeared between the intent and the dispatch",
						dispatch: "not_sent",
						recoverable: true,
					});
				}
				dispatch = "unknown";
				// §4.1：挖掘面来自真实命中判定（不再是固定顶面）。
				deps.protocol.startDig(target.block, aimFace);
				dispatch = "sent";
				deps.recorder.record(effect, operation, "body.dig@1", "dispatch", "sent", "unknown", {
					predictedMs: waitMs,
					aim: options?.aim ?? "target",
					target: { x: target.block.x, y: target.block.y, z: target.block.z },
				});
				if (done) return;
				deps.guard();
				deps.bot.swingArm("right");
				if (!deps.signal.aborted && deps.canCleanup()) {
					swingTimer = setInterval(() => {
						try {
							deps.bot.swingArm("right");
						} catch {
							// 客户端消亡时的挥手失败不改变挖掘结算；下个周期由 cleanup 收尾。
						}
					}, 350);
				}
				digTimer = setTimeout(sendFinish, waitMs);
			} catch (error) {
				if (done) return;
				const failure = error as CallFailure;
				if (dispatch === "unknown" && failure.name === "CallFailure" && failure.dispatch === "not_sent")
					dispatch = "not_sent";
				if (dispatch === "unknown")
					deps.recorder.record(effect, operation, "body.dig@1", "dispatch", "unknown", "unknown");
				if (dispatch !== "not_sent")
					stop(failure.code ?? "INTERNAL", error instanceof Error ? error.message : String(error), true);
				else
					settle(
						"unknown",
						failure.name === "CallFailure"
							? failure
							: fail({
									code: "INTERNAL",
									source: "environment",
									message: error instanceof Error ? error.message : String(error),
									dispatch: "not_sent",
									recoverable: false,
								}),
					);
			}
		})();
	});
}
