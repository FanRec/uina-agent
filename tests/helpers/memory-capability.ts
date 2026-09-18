import type { ExtensionAPI } from "../../src/extensions/runner.js";

/**
 * Memory 派生实验 capability（tests fixture，非生产代码）。
 *
 * 派生测试证明：一个真实的"持久记忆"能力完全经公开 pi 接缝实现——
 * prepare（systemPrompt 注入）+ transformContext（上下文注入）+ appendEntry/
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

	pi.onHook("turn.prepare", (input) => {
		const facts = readFacts(pi);
		if (facts.length === 0) return undefined;
		return { systemPrompt: `${input.systemPrompt}\n\n[已知记忆]\n- ${facts.join("\n- ")}` };
	});

	pi.onHook("turn.transformContext", (messages) => {
		const facts = readFacts(pi);
		if (facts.length === 0) return undefined;
		return { messages: [...messages, { role: "user", content: `[记忆上下文] ${facts.join("；")}` }] };
	});
}
