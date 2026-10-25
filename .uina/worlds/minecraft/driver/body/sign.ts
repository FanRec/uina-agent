/** Sign editor and write phases belong to one Body operation; native async activation is never used. */
import type { BlockTarget, SignText } from "../../contracts/body.js";
import type { CallFailure, EffectReceipt } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { toMineflayerVec3 } from "../mineflayer/adapter.js";
import type { ProtocolNotice } from "../mineflayer/protocol.js";
import type { BodyOperationDeps } from "./operation.js";

const EDITOR_MS = 2000;
const CONFIRM_MS = 2000;

export async function runSign(
	deps: BodyOperationDeps,
	target: BlockTarget,
	input: { side: "front" | "back"; lines: SignText },
): Promise<EffectReceipt> {
	deps.guard();
	if (input.lines.some((line) => line.length > 45))
		throw fail({
			code: "INVALID_INPUT",
			source: "input",
			message: "sign lines must not exceed 45 UTF-16 units",
			dispatch: "not_sent",
			recoverable: true,
		});
	const block = deps.bot.blockAt(toMineflayerVec3(target.block));
	if (block == null || !block.name.includes("sign"))
		throw fail({
			code: "NOT_FOUND",
			source: "world",
			message: "target is not a loaded sign",
			dispatch: "not_sent",
			recoverable: true,
		});
	if (String(block.getProperties().is_waxed) === "true")
		throw fail({
			code: "WRONG_STATE",
			source: "world",
			message: "sign is waxed",
			dispatch: "not_sent",
			recoverable: true,
		});
	if (deps.bot.heldItem != null)
		throw fail({
			code: "WRONG_STATE",
			source: "capability",
			message: "main hand must be empty before opening the sign editor",
			dispatch: "not_sent",
			recoverable: true,
		});
	const operation = deps.mintOp();
	const effect = deps.mintEff();
	return new Promise((resolve, reject) => {
		let done = false;
		let dispatch: EffectReceipt["dispatch"] = "not_sent";
		let phase: "look" | "editor" | "submitting" | "confirmation" = "look";
		let timer: ReturnType<typeof setTimeout> | null = null;
		let detach: () => void = () => {};
		const settle = (completion: EffectReceipt["completion"], error?: CallFailure) => {
			if (done) return;
			done = true;
			if (timer !== null) clearTimeout(timer);
			detach();
			deps.signal.removeEventListener("abort", onAbort);
			if (dispatch !== "not_sent")
				deps.recorder.record(effect, operation, "body.writeSign@1", "receipt", dispatch, completion, {
					completionContract:
						"editor admission followed by a matching server block-entity update after sign submission",
					phase,
				});
			if (error !== undefined) reject(error);
			else resolve({ effect, dispatch, completion, evidence: [] });
		};
		const rejectWith = (code: string, message: string, completion: EffectReceipt["completion"] = "unknown") =>
			settle(
				completion,
				fail({
					code,
					source: "environment",
					message,
					dispatch,
					effects: dispatch !== "not_sent" ? [effect] : [],
					recoverable: false,
				}),
			);
		const onAbort = () => rejectWith("INTERRUPTED", "sign operation interrupted before any further writes");
		const submit = () => {
			if (done) return;
			try {
				deps.guard();
				phase = "confirmation";
				timer = setTimeout(() => settle("unknown"), CONFIRM_MS);
				deps.protocol.writeSign(target.block, input.side === "front", input.lines);
				deps.recorder.record(effect, operation, "body.writeSign@1", "dispatch", "sent", "unknown", {
					phase: "submitted",
					side: input.side,
				});
			} catch (error) {
				rejectWith((error as CallFailure).code ?? "INTERNAL", error instanceof Error ? error.message : String(error));
			}
		};
		const onNotice = (notice: ProtocolNotice) => {
			if (done) return;
			if (notice.kind === "end") {
				rejectWith("DISCONNECTED", "connection ended during sign editing");
				return;
			}
			if (
				(notice.kind !== "sign_editor" && notice.kind !== "sign_update") ||
				notice.position.x !== target.block.x ||
				notice.position.y !== target.block.y ||
				notice.position.z !== target.block.z
			)
				return;
			if (notice.kind === "sign_editor" && phase === "editor") {
				if (timer !== null) clearTimeout(timer);
				if (notice.front !== (input.side === "front")) {
					rejectWith("WRONG_STATE", "server opened the opposite sign face; no text was submitted", "not_met");
					return;
				}
				phase = "submitting";
				queueMicrotask(submit);
			} else if (notice.kind === "sign_update" && phase === "confirmation") {
				queueMicrotask(() => {
					if (done) return;
					try {
						deps.guard();
						settle("met");
					} catch {
						onAbort();
					}
				});
			}
		};
		detach = deps.protocol.subscribe(onNotice);
		deps.signal.addEventListener("abort", onAbort, { once: true });
		if (deps.signal.aborted) {
			onAbort();
			return;
		}
		void (async () => {
			try {
				await deps.bot.lookAt(
					toMineflayerVec3({ x: target.block.x + 0.5, y: target.block.y + 0.5, z: target.block.z + 0.5 }),
					true,
				);
				if (done) return;
				deps.guard();
				const self = deps.bot.entity.position;
				const dx = self.x - target.block.x - 0.5;
				const dy = self.y + 1.62 - target.block.y - 0.5;
				const dz = self.z - target.block.z - 0.5;
				let face: number;
				if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) face = dx > 0 ? 5 : 4;
				else if (Math.abs(dy) >= Math.abs(dz)) face = dy > 0 ? 1 : 0;
				else face = dz > 0 ? 3 : 2;
				phase = "editor";
				timer = setTimeout(() => rejectWith("TIMEOUT", "sign editor did not open within 2000 ms"), EDITOR_MS);
				dispatch = "unknown";
				deps.protocol.activateBlock(target.block, face);
				dispatch = "sent";
				deps.recorder.record(effect, operation, "body.writeSign@1", "dispatch", "sent", "unknown", {
					phase: "editor_requested",
					side: input.side,
				});
			} catch (error) {
				if (done) return;
				const failure = error as CallFailure;
				if (dispatch === "unknown" && failure.name === "CallFailure" && failure.dispatch === "not_sent")
					dispatch = "not_sent";
				if (dispatch === "unknown")
					deps.recorder.record(effect, operation, "body.writeSign@1", "dispatch", "unknown", "unknown");
				if (dispatch === "not_sent" && failure.name === "CallFailure") settle("unknown", failure);
				else rejectWith(failure.code ?? "INTERNAL", error instanceof Error ? error.message : String(error));
			}
		})();
	});
}
