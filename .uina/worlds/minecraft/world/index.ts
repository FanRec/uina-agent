/**
 * World 模块公共入口（实现归 World 开发 AI；本文件签名是模块接缝）。
 *
 * 职责（docs/proposals/mc/modules/world.md）：Driver 证据接收与 ACK、当前查询切面、
 * Watch 失效水位、SQLite 历史/领域修订、保留闭包。
 *
 * 边界：只依赖 Driver 的 ClientFactsPort、自己的存储与注入的查询定义；
 * 不导入 Navigation/Combat 等玩法算法，不触碰 Bot/Chunk。
 */

import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { WorldPort } from "../contracts/world.js";

export interface WorldDeps {
	readonly facts: ClientFactsPort;
	/** World 数据目录（由接入层从 worldDataDir 注入）。 */
	readonly dataDir: string;
}

export interface WorldHandle extends WorldPort {
	/** world.status@1：current/history/binding 分别表达，不以单一 ready 掩盖降级。 */
	status(): Promise<import("../contracts/world.js").WorldAvailabilityValue>;
	close(): Promise<void>;
}

export function createWorld(_deps: WorldDeps): WorldHandle {
	throw new Error("未实现：World 切片待 World 开发 AI 交付（保持本签名）");
}
