/**
 * World 模块公共入口（实现归 World 开发 AI；本文件签名是模块接缝）。
 *
 * 职责（World 重构终态）：Driver 证据接收与 durable ACK、当前查询切面、
 * 提交屏障化的历史读取、Watch 失效水位、SQLite Worker 历史/领域修订、保留闭包。
 *
 * 边界：只依赖 Driver 的 ClientFactsPort、自己的存储与注入的查询定义；
 * 不导入 Navigation/Combat 等玩法算法，不触碰 Bot/Chunk。
 */

import type { ClientFactsPort } from "../contracts/client-facts.js";
import type { WorldEvidencePort, WorldPort } from "../contracts/world.js";
import { SqliteWorkerStore, UnavailableWorldStore, type WorldStore } from "./internal/store.js";
import { WorldImpl } from "./internal/world-impl.js";

export interface WorldDeps {
	readonly facts: ClientFactsPort;
	/** World 数据目录（由接入层从 worldDataDir 注入）。 */
	readonly dataDir: string;
}

export interface WorldHandle extends WorldPort {
	/** world.status@1：current/history/binding 分别表达，不以单一 ready 掩盖降级。 */
	status(): Promise<import("../contracts/world.js").WorldAvailabilityValue>;
	close(): Promise<void>;
	/** 证据保留端口：仅注入 Runtime、Assets 等持久记录所有者，不给 Program。 */
	readonly evidence: WorldEvidencePort;
	/** 历史侧结算完成（就绪或明确不可用）。当前事实能力不等它；需要确定历史可用时等待。 */
	readonly historySettled: Promise<void>;
}

/**
 * 句柄交付不等 SQLite（§13.1）：当前事实能力在当前基线建立后立即可用，
 * 历史存储独立进入 opening → ready/unavailable（status 如实报告）。
 * 打开失败不是异常：façade 显式 unavailable，历史操作据此拒绝，不假装空历史。
 */
export async function createWorld(
	deps: WorldDeps,
	options?: { store?: WorldStore; receiver?: string },
): Promise<WorldHandle> {
	let store: WorldStore;
	if (options?.store) {
		store = options.store;
	} else {
		try {
			// 构造即启动打开握手；不 await——当前读取不被 SQLite 阻塞。
			store = new SqliteWorkerStore(deps.dataDir);
		} catch (error) {
			store = new UnavailableWorldStore(`SQLite Worker 启动失败：${String(error)}`);
		}
	}
	const impl = new WorldImpl({
		facts: deps.facts,
		dataDir: deps.dataDir,
		store,
		receiver: options?.receiver,
	});
	await impl.ready;
	return impl;
}

export type { WorldStore } from "./internal/store.js";
