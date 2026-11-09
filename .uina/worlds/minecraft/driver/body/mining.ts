/** Owned digging: client timing schedules writes; only decoded server block updates confirm them. */
import type { BlockTarget } from "../../contracts/body.js";
import type { CallFailure, EffectReceipt } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { toMineflayerVec3 } from "../mineflayer/adapter.js";
import type { ProtocolNotice } from "../mineflayer/protocol.js";
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
	const face = 1;
	return new Promise((resolve, reject) => {
		let done = false;
		let dispatch: EffectReceipt["dispatch"] = "not_sent";
		let finishSent = false;
		let digTimer: ReturnType<typeof setTimeout> | null = null;
		let confirmTimer: ReturnType<typeof setTimeout> | null = null;
		let detach: () => void = () => {};
		const cleanup = () => {
			if (digTimer !== null) clearTimeout(digTimer);
			if (confirmTimer !== null) clearTimeout(confirmTimer);
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
				});
			if (error !== undefined) reject(error);
			else resolve({ effect, dispatch, completion, evidence: [] });
		};
		const stop = (code: string, message: string, allowCleanup: boolean) => {
			if (done) return;
			if (dispatch !== "not_sent" && !finishSent && allowCleanup && deps.canCleanup()) {
				try {
					deps.protocol.cancelDig(target.block, face);
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
				deps.protocol.finishDig(target.block, face);
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
				await deps.recorder.beforeWrite(effect, operation, "body.dig@1", {
					target: { x: target.block.x, y: target.block.y, z: target.block.z },
					predictedMs: waitMs,
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
				deps.protocol.startDig(target.block, face);
				dispatch = "sent";
				deps.recorder.record(effect, operation, "body.dig@1", "dispatch", "sent", "unknown", {
					predictedMs: waitMs,
					aim: options?.aim ?? "target",
					target: { x: target.block.x, y: target.block.y, z: target.block.z },
				});
				if (done) return;
				deps.guard();
				deps.bot.swingArm("right");
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
