/**
 * 步行输入（批 24 从 BodySession 分离）：键位安装/撤销与物理步消费。
 *
 * 职责边界：这里只拥有"步行态怎么走"——controlState 键位面、physicsTick 消费
 * 节奏与停滞看门狗。drive 的编排、use/attack 会话、资格与效果归属仍归
 * BodySession。DRIVE_STALL_MS 同时被 BodySession 的容器物理边界借用
 * （同一"客户端物理循环停滞"预算，单一真源）。
 */

import type { ControlInput, Key } from "../../contracts/body.js";
import type { Ref } from "../../contracts/values.js";
import { fail } from "../execution.js";
import { type MineflayerBot } from "../mineflayer/adapter.js";

export const DRIVE_KEYS: Key[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];
/** drive 停滞看门狗：物理循环暂停不得导致无限等待（§7.2），墙钟只作停滞检测。 */
export const DRIVE_STALL_MS = 2000;

/** 键位安装：省略项按 false 覆盖（public-api §4）。use/attack 由 BodySession 归属处理。 */
export function applyWalkingKeys(bot: MineflayerBot, keys: ControlInput["keys"]): void {
	for (const key of DRIVE_KEYS) bot.setControlState(key, keys[key] === true);
}

/** 键位撤销：任何退出路径调用；客户端消亡时键位随连接消亡。 */
export function revokeKeys(bot: MineflayerBot): void {
	for (const key of DRIVE_KEYS) {
		try {
			bot.setControlState(key, false);
		} catch {
			// 客户端消亡时键位随连接消亡
		}
	}
}

/**
 * 物理步消费：首个 physicsTick 即第 1 个消费步（上游 simulatePlayer 先读
 * controlState 再 emit）；第 ticks 个消费步的监听回调内同步结算，
 * 保证撤销发生在下一次 simulatePlayer 之前（模拟前窄接缝）。
 * 失败一律抛错并携带实际步数；短执行不包装为完整成功。
 */
export function consumeWalkingTicks(bot: MineflayerBot, ticks: number, eff: Ref, signal: AbortSignal): Promise<number> {
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
