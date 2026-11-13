import type { ExtensionAPI } from "../../src/extensions/runner.js";

/**
 * Memory 派生实验 capability（tests fixture，非生产代码）。
 *
 * 派生测试证明：一个真实的"持久记忆"能力完全经公开 pi 接缝实现——
 * observation Source（每次请求的只读快照，同一事实只出现一次）+ appendEntry/
 * auxiliary（capability 私有 durable state），零触碰内核内部状态。
 * 本文件的 import 即测试侧审定的白名单。
 */

export const MEMORY_ENTRY_TYPE = "uina.memory.facts";

function readFacts(pi: ExtensionAPI): string[] {
	const facts: string[] = [];
	for (const record of pi.auxiliary()) {
		if (record.kind !== "custom_entry" || record.customType !== MEMORY_ENTRY_TYPE) continue;
		const data = record.data as { fact?: string } | undefined;
		if (data?.fact) facts.push(data.fact);
	}
	return facts;
}

export default function activateMemory(pi: ExtensionAPI): void {
	pi.registerCommand({
		name: "remember",
		description: "记住一条事实（Memory 派生实验）",
		hasArgs: true,
		argumentHint: "<fact>",
		handler: async (arg) => {
			await pi.appendEntry({ customType: MEMORY_ENTRY_TYPE, data: { fact: String(arg) } });
		},
	});

	pi.provideContext({
		id: "memory",
		kind: "observation",
		read: () => {
			const facts = readFacts(pi);
			if (facts.length === 0) return null;
			return {
				text: `[已知记忆]\n- ${facts.join("\n- ")}`,
				source: { type: "memory.facts", origin: "internal" },
			};
		},
	});
}
