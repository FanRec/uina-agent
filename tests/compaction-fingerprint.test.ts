/**
 * 摘要复用指纹与边界不变式的单元级验证：
 * 1. prefixFingerprint 必须对"被摘要内容"严格敏感，相同内容哈希恒等，篡改即失配；
 * 2. checkpointValid 保证仅当 canonical 覆盖点仍在主线且前缀指纹完全一致时才有效；
 * 3. semanticUnits 保证工具调用事务原子性，findTrimBoundary 保障保留尾部永远不以 tool 角色开头。
 */
import { describe, expect, test } from "./harness/index.js";
import {
	checkpointValid,
	findTrimBoundary,
	fingerprintPrefix,
	semanticUnits,
	type CompactionCheckpoint,
} from "../src/extensions/compaction/index.js";
import type { HydratedSessionEntry } from "../src/session/types.js";

function createEntry(id: string, seq: number, text: string): HydratedSessionEntry {
	return {
		id,
		parentId: seq === 0 ? null : `entry-${seq - 1}`,
		seq,
		timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
		kind: "input",
		input: {
			id,
			order: seq,
			mode: "followUp",
			text,
		},
	};
}

describe("compaction canonical boundary & fingerprint", () => {
	test("prefixFingerprint 对被覆盖内容敏感，对后续条目变更不敏感", () => {
		const entry1 = createEntry("e1", 0, "用户提问 1");
		const entry2 = createEntry("e2", 1, "用户提问 2");
		const entry3 = createEntry("e3", 2, "用户提问 3");

		const history = [entry1, entry2, entry3];

		const fp1 = fingerprintPrefix(history, "e2");
		expect(fp1).toBeDefined();

		// 1. 相同历史条目，指纹完全一致
		const fp2 = fingerprintPrefix([entry1, entry2, entry3], "e2");
		expect(fp2).toBe(fp1);

		// 2. 覆盖范围内的条目发生变更（篡改文本），指纹必然失配
		const alteredEntry2 = createEntry("e2", 1, "被篡改的内容");
		const fpAltered = fingerprintPrefix([entry1, alteredEntry2, entry3], "e2");
		expect(fpAltered).not.toBe(fp1);

		// 3. 覆盖范围之后的条目追加或变更，指纹保持恒等（正交性）
		const entry4 = createEntry("e4", 3, "后续新消息");
		const fpExtended = fingerprintPrefix([...history, entry4], "e2");
		expect(fpExtended).toBe(fp1);
	});

	test("checkpointValid 严格校验 canonical 主线存在性与指纹一致性", () => {
		const entry1 = createEntry("e1", 0, "第一轮");
		const entry2 = createEntry("e2", 1, "第二轮");
		const entry3 = createEntry("e3", 2, "第三轮");

		const history = [entry1, entry2, entry3];
		const fp = fingerprintPrefix(history, "e2")!;

		const checkpoint: CompactionCheckpoint = {
			version: 1,
			summary: "前两轮历史摘要",
			coveredThroughEntryId: "e2",
			tailStartsAtEntryId: "e3",
			prefixFingerprint: fp,
			source: "automatic",
		};

		// 校验成功
		expect(checkpointValid(checkpoint, history)).toBe(true);

		// 回溯丢弃：如果主线由于 rewind 丢失了 e2，checkpoint 立即失效
		expect(checkpointValid(checkpoint, [entry1])).toBe(false);

		// 指纹篡改：如果主线内容被修改导致指纹失配，checkpoint 立即失效
		const tamperedHistory = [createEntry("e1", 0, "不同内容"), entry2, entry3];
		expect(checkpointValid(checkpoint, tamperedHistory)).toBe(false);
	});

	test("semanticUnits 将 tool_calls 与 tool_results 绑定为不可分割的原子单元", () => {
		const messages = [
			{ role: "user", content: "发起任务" },
			{ role: "assistant", content: "", tool_calls: [{ name: "t1", args: {} }] },
			{ role: "tool", content: "结果1", tool_call_id: "call-1" },
			{ role: "assistant", content: "", tool_calls: [{ name: "t2", args: {} }] },
			{ role: "tool", content: "结果2", tool_call_id: "call-2" },
			{ role: "assistant", content: "最终回答" },
		];

		const units = semanticUnits(messages);
		expect(units.length).toBe(4);

		// Unit 0: user
		expect(units[0]).toMatchObject({ start: 0, end: 1 });
		// Unit 1: assistant(tool_calls) + tool_result
		expect(units[1]).toMatchObject({ start: 1, end: 3 });
		// Unit 2: assistant(tool_calls) + tool_result
		expect(units[2]).toMatchObject({ start: 3, end: 5 });
		// Unit 3: plain assistant
		expect(units[3]).toMatchObject({ start: 5, end: 6 });
	});

	test("findTrimBoundary 选出的保留尾部非系统消息第一条绝不可为孤立 tool 消息", () => {
		const messages = [
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "超长用户请求 ".repeat(200) },
			{ role: "assistant", content: "", tool_calls: [{ name: "t1", args: {} }] },
			{ role: "tool", content: "大结果 ".repeat(500), tool_call_id: "call-1" },
			{ role: "assistant", content: "", tool_calls: [{ name: "t2", args: {} }] },
			{ role: "tool", content: "后续结果", tool_call_id: "call-2" },
		];

		// 给一个只能容纳最后一步的预算
		const keepFrom = findTrimBoundary(messages, 200);
		expect(keepFrom).not.toBeNull();
		// 保留头绝不能是 tool 角色
		expect(messages[keepFrom!]!.role).not.toBe("tool");
		expect(messages[keepFrom!]!.role).toBe("assistant");
	});
});
