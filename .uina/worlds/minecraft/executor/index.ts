/**
 * Executor / 运行管理（技术负责人独占；三个模块共同依赖的组合点）。
 *
 * 职责（docs/proposals/mc/public-api.md §7 + contracts.md §2/§3）：受理事务与去重、
 * run/segment/call 记录、身体调度（withBody FIFO 资格）、停止意图、能力目录装配、
 * 程序执行域桥接、五态结算与待递送项。
 *
 * 边界：唯一写运行/段/调用/效果/停止记录；不实现任何玩法算法；
 * 组合根注入 Driver/World/Assets 的具体实现。
 */

import type { AssetRepository } from "../contracts/assets.js";
import type { PlayerPort } from "../contracts/body.js";
import type { NativeCallable } from "../contracts/callables.js";
import type { ExecutorClient } from "../contracts/executor.js";
import type { WorldPort } from "../contracts/world.js";

export interface ExecutorDeps {
	readonly player: PlayerPort;
	readonly world: WorldPort;
	readonly assets: AssetRepository;
	/** 组合根收集并校验同 ref 唯一后的原生能力导出。 */
	readonly callables: readonly NativeCallable<unknown, unknown>[];
	/** Executor 持久数据目录。 */
	readonly dataDir: string;
}

export interface ExecutorHandle extends ExecutorClient {
	close(): Promise<void>;
}

export function createExecutor(_deps: ExecutorDeps): ExecutorHandle {
	throw new Error("未实现：Executor 归技术负责人（lead）实现；本签名即组合接缝");
}
