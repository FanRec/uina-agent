import type { SessionHeader, SessionNodeInfo, SessionRecord } from "../../../src/session/types.js";
import type { UinaTestHarness } from "../host/harness.js";

/**
 * 领域不变量（Core Invariants）守卫：
 * 验证无论经历何种并发扰动、中断或异常，系统的物理事实永远满足基本代数法则。
 */

/**
 * 1. DAG 有向无环因果树不变量：
 * 会话记录中的所有 records 必须构成一棵合法的因果树，不能出现回环，
 * 且所有回溯/分支必须溯源至先前的有效节点。
 */
export function assertDAGInvariants(records: readonly (SessionRecord | SessionHeader | SessionNodeInfo)[]): void {
	const seenIds = new Set<string>();
	let lastSeq = -1;

	for (let i = 0; i < records.length; i++) {
		const rec = records[i];

		// 忽略 header 等无 seq 的元数据记录
		if ("kind" in rec && rec.kind === "header") {
			if ("id" in rec && typeof rec.id === "string") seenIds.add(rec.id);
			continue;
		}
		if (typeof rec.seq !== "number") continue;

		// 序列号严格递增
		if (rec.seq <= lastSeq) {
			throw new Error(`DAG 破坏：记录 seq 非严格递增。当前 seq=${rec.seq}, 上一 seq=${lastSeq}`);
		}
		lastSeq = rec.seq;

		// 记录 ID 唯一
		if ("id" in rec && typeof rec.id === "string") {
			if (seenIds.has(rec.id)) {
				throw new Error(`DAG 破坏：发现重复的记录 ID '${rec.id}'`);
			}
			seenIds.add(rec.id);
		}

		// 回溯节点合法性 (SessionRewindRecord)
		if ("targetId" in rec && typeof rec.targetId === "string") {
			if (!seenIds.has(rec.targetId)) {
				throw new Error(`DAG 破坏：回溯目标 targetId '${rec.targetId}' 不在历史记录中`);
			}
		}

		// 节点父引用合法性 (SessionNodeInfo)
		if ("parentId" in rec && typeof rec.parentId === "string") {
			if (!seenIds.has(rec.parentId)) {
				throw new Error(`DAG 破坏：节点 parentId '${rec.parentId}' 不在已知历史节点中`);
			}
		}
	}
}

/**
 * 2. 资源收敛不变量：
 * 当测试结束或任务 idle 时，系统内部的 Promise 链和活跃排队状态必须收敛。
 */
export function assertNoResourceLeaks(harness: UinaTestHarness): void {
	if (harness.isBusy()) {
		throw new Error("资源泄漏守卫：系统在检查时依然处于 busy 状态");
	}
	const queue = harness.queue;
	if (queue.length > 0) {
		throw new Error(`资源泄漏守卫：排队队列未收敛，残留 ${queue.length} 条未处理消息`);
	}
}
