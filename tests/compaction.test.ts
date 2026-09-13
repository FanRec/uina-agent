import { describe, expect, it } from "vitest";
import {
	clearRetainedUsage,
	collectFileOperations,
	estimateMessageTokens,
	findCutPoint,
	findTurnStartIndex,
	formatFileOperations,
	prepareCompaction,
	serializeConversation,
	SUMMARIZATION_PROMPT,
	truncateForSummary,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../src/agent/compaction.js";
import type { AgentMessage, ChatMsg } from "../src/core/types.js";

const user = (content: string): ChatMsg => ({ role: "user", content });
const assistant = (content: string, toolCalls?: ChatMsg[]): ChatMsg => ({
	role: "assistant",
	content,
	...(toolCalls ? { tool_calls: toolCalls as never } : {}),
});
const tool = (content: string, callId = "c1"): ChatMsg => ({ role: "tool", tool_call_id: callId, content });
const call = (name: string, args: Record<string, unknown>) => ({ id: "c1", name, args });

// ---------------------------------------------------------------------------
// estimateMessageTokens：逐条消息的保守估算
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
	it("uses ceil(chars / 4) for plain content", () => {
		expect(estimateMessageTokens(user("abcd"))).toBe(1);
		expect(estimateMessageTokens(user("abcde"))).toBe(2);
	});

	it("counts assistant thinking and tool-call JSON", () => {
		const plain = estimateMessageTokens({ role: "assistant", content: "12345678" });
		const richer = estimateMessageTokens({
			role: "assistant",
			content: "12345678",
			thinking: "12345678",
			tool_calls: [call("read_file", { path: "a.ts" })] as never,
		});
		expect(richer).toBeGreaterThan(plain);
	});

	it("charges a fixed budget per image", () => {
		const without = estimateMessageTokens(user("hi"));
		const withImage = estimateMessageTokens({ role: "user", content: "hi", images: [{ data: "x" } as never] });
		expect(withImage - without).toBe(1200); // 4800 chars / 4
	});

	it("measures a compaction summary by its summary text, not its content envelope", () => {
		expect(estimateMessageTokens({ role: "compactionSummary", summary: "abcdefgh", content: "x" } as never)).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// findCutPoint：只在回合边界切开，绝不落在 tool 上
// ---------------------------------------------------------------------------

describe("findCutPoint", () => {
	it("returns a zero cut for an empty history", () => {
		expect(findCutPoint([], 100)).toEqual({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
	});

	it("returns a zero cut when no message is a legal cut point", () => {
		expect(findCutPoint([tool("a"), tool("b")], 100).firstKeptEntryIndex).toBe(0);
	});

	it("never places the cut on a tool result", () => {
		const history = [user("u1"), assistant("a1", [call("read_file", { path: "f" })] as never), tool("result"), user("u2"), assistant("a2")];
		const cut = findCutPoint(history, 1);
		expect(history[cut.firstKeptEntryIndex]?.role).not.toBe("tool");
	});

	it("keeps a recent tail once the budget is spent", () => {
		const history: ChatMsg[] = [];
		for (let i = 0; i < 20; i++) history.push(user(`message number ${i} padded out to some length`));
		const cut = findCutPoint(history, 20);
		expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(cut.firstKeptEntryIndex).toBeLessThan(history.length);
	});

	it("flags a split turn when the cut lands mid-turn", () => {
		// The budget stops inside the assistant/tool part of a turn, so the turn start is reported.
		const history = [user("first turn with plenty of text to exceed the budget"), assistant("a1"), tool("t1"), user("u2"), assistant("a2"), tool("t2")];
		const cut = findCutPoint(history, 140);
		if (cut.firstKeptEntryIndex > 0 && cut.firstKeptEntryIndex < history.length) {
			expect(cut.isSplitTurn).toBe(cut.turnStartIndex !== -1);
		}
	});

	describe("short-history fallback", () => {
		const short = [user("hi"), assistant("ok")];

		it("does not advance without the fallback flag (Pi parity)", () => {
			expect(findCutPoint(short, 100000, false).firstKeptEntryIndex).toBe(0);
		});

		it("advances past index 0 when the fallback flag is set", () => {
			const cut = findCutPoint(short, 100000, true);
			expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
			expect(cut.firstKeptEntryIndex).toBeLessThan(short.length);
		});

		it("keeps only the final stretch, matching the legacy keepFrom fallback", () => {
			const cases: ChatMsg[][] = [
				[user("u1"), assistant("a1")],
				[user("u1"), assistant("a1"), user("u2"), assistant("a2")],
				[user("u1"), assistant("a1"), user("u2"), assistant("a2"), tool("t2")],
			];
			for (const history of cases) {
				const cut = findCutPoint(history, 1_000_000, true);
				expect(history.length - cut.firstKeptEntryIndex).toBeLessThanOrEqual(2);
				expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
			}
		});
		it("still avoids cutting on a tool even with the fallback", () => {
			const history = [user("u"), assistant("a", [call("read_file", { path: "f" })] as never), tool("t")];
			const cut = findCutPoint(history, 100000, true);
			expect(history[cut.firstKeptEntryIndex]?.role).not.toBe("tool");
		});
	});
});

describe("findTurnStartIndex", () => {
	it("walks back to the nearest user or custom message", () => {
		const history = [user("u1"), assistant("a1"), tool("t1"), user("u2"), assistant("a2")];
		expect(findTurnStartIndex(history, 4, 0)).toBe(3);
		expect(findTurnStartIndex(history, 2, 0)).toBe(0);
	});

	it("returns -1 when the search window has no turn start", () => {
		expect(findTurnStartIndex([assistant("a"), tool("t")], 1, 0)).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// prepareCompaction：切片与拆分回合
// ---------------------------------------------------------------------------

describe("prepareCompaction", () => {
	it("splits summarized, prefix and retained segments", () => {
		const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
		const prep = prepareCompaction(history, { firstKeptEntryIndex: 4, turnStartIndex: 4, isSplitTurn: false }, 999);
		expect(prep.messagesToSummarize).toHaveLength(4);
		expect(prep.retainedTail).toHaveLength(2);
		expect(prep.turnPrefixMessages).toHaveLength(0);
		expect(prep.tokensBefore).toBe(999);
	});

	it("carves out a turn prefix when the cut splits a turn", () => {
		const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), tool("t2"), user("u3"), assistant("a3")];
		const prep = prepareCompaction(history, { firstKeptEntryIndex: 5, turnStartIndex: 2, isSplitTurn: true }, 1);
		// Everything before the split turn's start is the older history to summarize.
		expect(prep.messagesToSummarize).toHaveLength(2);
		expect(prep.turnPrefixMessages).toHaveLength(3); // u2, a2, t2
		expect(prep.retainedTail).toHaveLength(2);
	});

	it("carries a previous summary forward for iterative updates", () => {
		const history: ChatMsg[] = [{ role: "user", content: "[历史摘要] earlier decisions" }, user("u2"), assistant("a2")];
		const prep = prepareCompaction(history, { firstKeptEntryIndex: 2, turnStartIndex: -1, isSplitTurn: false }, 1);
		expect(prep.previousSummary).toBe("earlier decisions");
	});

	it("finds a structured previous summary", () => {
		const history: AgentMessage[] = [
			{ role: "compactionSummary", summary: "## 目标\nship it", content: "[历史摘要] x" },
			user("u2"),
		];
		const prep = prepareCompaction(history, { firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false }, 1);
		expect(prep.previousSummary).toContain("## 目标");
	});
});

// ---------------------------------------------------------------------------
// serializeConversation：给摘要模型的纯文本视图
// ---------------------------------------------------------------------------

describe("serializeConversation", () => {
	it("tags every role and skips system messages", () => {
		const text = serializeConversation([
			{ role: "system", content: "SYSTEM-PROMPT" },
			user("hello"),
			{ role: "assistant", content: "answer", thinking: "hmm" },
			tool("tool-output"),
		]);
		expect(text).not.toContain("SYSTEM-PROMPT");
		expect(text).toContain("[用户]: hello");
		expect(text).toContain("[助手思考]: hmm");
		expect(text).toContain("[助手]: answer");
		expect(text).toContain("[工具结果]: tool-output");
	});

	it("renders tool calls with named arguments", () => {
		const text = serializeConversation([assistant("", [call("read_file", { path: "a.ts" })] as never)]);
		expect(text).toContain("read_file(path=\"a.ts\")");
	});

	it("truncates oversized tool results", () => {
		const text = serializeConversation([tool("x".repeat(5000))]);
		expect(text).toContain("已截断");
		expect(text.length).toBeLessThan(5000);
	});
});

describe("truncateForSummary", () => {
	it("leaves short text untouched", () => {
		expect(truncateForSummary("short", 100)).toBe("short");
	});
	it("annotates how much was dropped", () => {
		const out = truncateForSummary("abcdefghij", 4);
		expect(out.startsWith("abcd")).toBe(true);
		expect(out).toContain("6");
	});
});

// ---------------------------------------------------------------------------
// collectFileOperations / formatFileOperations
// ---------------------------------------------------------------------------

describe("collectFileOperations", () => {
	it("separates reads from writes and drops files that were also written", () => {
		const history = [
			assistant("", [call("read_file", { path: "read.ts" })] as never),
			assistant("", [call("read_file", { path: "both.ts" })] as never),
			assistant("", [call("write_file", { path: "both.ts", content: "x" })] as never),
			assistant("", [call("write_file", { path: "new.ts", content: "y" })] as never),
		];
		const { readFiles, modifiedFiles } = collectFileOperations(history);
		expect(readFiles).toEqual(["read.ts"]);
		expect(modifiedFiles).toEqual(["both.ts", "new.ts"]);
	});

	it("deduplicates and sorts", () => {
		const history = [
			assistant("", [call("read_file", { path: "b.ts" })] as never),
			assistant("", [call("read_file", { path: "a.ts" })] as never),
			assistant("", [call("read_file", { path: "b.ts" })] as never),
		];
		expect(collectFileOperations(history).readFiles).toEqual(["a.ts", "b.ts"]);
	});

	it("ignores calls without a string path", () => {
		const history = [assistant("", [call("read_file", {}), call("read_file", { path: 42 })] as never)];
		expect(collectFileOperations(history).readFiles).toEqual([]);
	});
});

describe("formatFileOperations", () => {
	it("returns an empty string when nothing happened", () => {
		expect(formatFileOperations([], [])).toBe("");
	});
	it("emits read and modified sections", () => {
		const out = formatFileOperations(["a.ts"], ["b.ts"]);
		expect(out).toContain("<read-files>");
		expect(out).toContain("<modified-files>");
	});
});

// ---------------------------------------------------------------------------
// clearRetainedUsage：压缩后不得让旧 usage 污染估算
// ---------------------------------------------------------------------------

describe("clearRetainedUsage", () => {
	it("drops assistant usage without mutating the input", () => {
		const original: ChatMsg = { role: "assistant", content: "x", usage: { totalTokens: 100 } };
		const cleared = clearRetainedUsage([original]);
		expect((cleared[0] as { usage?: unknown }).usage).toBeUndefined();
		expect(original.usage).toBeDefined();
	});

	it("keeps non-assistant usage fields untouched", () => {
		const cleared = clearRetainedUsage([user("hi")]);
		expect(cleared[0]).toEqual(user("hi"));
	});
});

describe("summarisation prompts keep the length discipline", () => {
	// 这些提示词决定压缩后上下文有多满。回归点：早期版本的提示词只要求“保持简洁”，
	// 结果模型把 git 提交流水账和代码行号整段抄进摘要，产出 23k 字符的“摘要”，
	// 重新撑满了保留预算。长度纪律一旦被删掉，这个测试应当失败。
	for (const [name, prompt] of [
		["SUMMARIZATION_PROMPT", SUMMARIZATION_PROMPT],
		["UPDATE_SUMMARIZATION_PROMPT", UPDATE_SUMMARIZATION_PROMPT],
	] as const) {
		it(`${name} caps the summary length and bans the two known noise sources`, () => {
			expect(prompt).toContain("长度纪律");
			// 明确禁止 commit 流水账与行号——这两样是上一版摘要最大的噪声来源。
			expect(prompt).toMatch(/git log/);
			expect(prompt).toMatch(/行号/);
			// 必须给出一个可核对的字符上限，而不是只说“保持简洁”。
			expect(prompt).toMatch(/8000\s*字符/);
		});
	}
});
