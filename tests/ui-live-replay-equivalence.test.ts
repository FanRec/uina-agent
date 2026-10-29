/**
 * W1 事实层验收：
 * - 同一 journal 的 live 与 replay 产生同一 Fact 序列（除 origin/seq/at）；
 * - 工具耗时来自 journal 时间戳之差，而不是任何现算时钟；
 * - 缺时间戳保持 undefined；中止沿用 journal 终局；
 * - 展示层源码不出现时钟读取与终端/进程/文件模块。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostEvent, HostEventRecord } from "../src/host/events.js";
import type { FactDraft, PresentationFact } from "../src/presentation/facts.js";
import { ingestLive } from "../src/presentation/ingest-live.js";
import { ingestReplay } from "../src/presentation/ingest-replay.js";
import { sanitizeExternal } from "../src/presentation/sanitize.js";
import type { SessionEntry, SessionEventRecord } from "../src/session/types.js";

const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-29T10:00:02.000Z";
const T2 = "2026-10-29T10:00:05.000Z";
const T3 = "2026-10-29T10:00:07.000Z";
const T4 = "2026-10-29T10:00:09.000Z";

function at(iso: string): number {
	return Date.parse(iso);
}

const entries: SessionEntry[] = [
	{
		kind: "message",
		id: "u1",
		seq: 1,
		timestamp: T0,
		message: { role: "user", content: "帮我检查目录", timestamp: T0 },
	},
	{
		kind: "message",
		id: "a1",
		seq: 2,
		timestamp: T1,
		message: {
			role: "assistant",
			content: "我来执行",
			thinking: "先看看命令",
			tool_calls: [{ id: "call-1", name: "exec_command", args: { command: "dir" } }],
			timestamp: T1,
		},
	},
	{
		kind: "message",
		id: "r1",
		seq: 3,
		timestamp: T2,
		message: {
			role: "tool",
			tool_call_id: "call-1",
			name: "exec_command",
			content: "ok",
			status: "succeeded",
			timestamp: T2,
		},
	},
	{
		kind: "message",
		id: "a2",
		seq: 4,
		timestamp: T3,
		message: { role: "assistant", content: "做完了", timestamp: T3 },
	},
];

const auxiliary: SessionEventRecord[] = [
	{
		kind: "event",
		id: "e1",
		seq: 2,
		timestamp: T1,
		event: "tool_started",
		data: { callId: "call-1", name: "exec_command", args: { command: "dir" } },
	},
	{
		kind: "event",
		id: "e2",
		seq: 3,
		timestamp: T2,
		event: "tool_finished",
		data: { callId: "call-1", name: "exec_command", status: "succeeded" },
	},
];

const liveEvents: HostEventRecord[] = [
	record(T0, { type: "turn_start", turnNumber: 1, userText: "帮我检查目录" }),
	record(T1, { type: "output_update", streamId: "s1", offset: 0, channel: "thinking", text: "先看看命令" }),
	record(T1, { type: "output_update", streamId: "s1", offset: 0, channel: "content", text: "我来执行" }),
	record(T1, { type: "tool_call", toolName: "exec_command", args: { command: "dir" }, callId: "call-1" }),
	record(T2, {
		type: "tool_result",
		toolName: "exec_command",
		args: { command: "dir" },
		result: "ok",
		status: "succeeded",
		callId: "call-1",
	}),
	record(T3, { type: "output_update", streamId: "s1", offset: 0, channel: "content", text: "做完了" }),
	record(T4, { type: "turn_end", turnNumber: 1 }),
];

function record(iso: string, event: HostEvent): HostEventRecord {
	return { at: at(iso), event };
}

/** 等价比较只认语义：序号、来源与时刻由路径决定，不参与比较。 */
function semantic(fact: FactDraft | PresentationFact): Record<string, unknown> {
	const { seq: _seq, origin: _origin, at: _at, ...rest } = fact as PresentationFact;
	return rest as unknown as Record<string, unknown>;
}

describe("live/replay 事实等价", () => {
	it("同一 journal 产生同一 Fact 序列（除 origin/seq/at）", () => {
		const live = liveEvents.flatMap((item) => ingestLive(item));
		const replayed = ingestReplay({ entries, auxiliary });

		expect(replayed.map((fact) => fact.kind)).toEqual(live.map((fact) => fact.kind));
		expect(replayed.map(semantic)).toEqual(live.map(semantic));
	});

	it("工具耗时等于 journal 的 finished 与 started 时间戳之差", () => {
		const facts = ingestReplay({ entries, auxiliary });
		const started = facts.find((fact) => fact.kind === "tool.started");
		const finished = facts.find((fact) => fact.kind === "tool.finished");
		expect(started?.at).toBe(at(T1));
		expect(finished?.at).toBe(at(T2));
		expect((finished?.at ?? 0) - (started?.at ?? 0)).toBe(at(T2) - at(T1));
	});

	it("缺时间戳保持 undefined，不补当前时钟", () => {
		const facts = ingestReplay({
			entries: [
				{
					kind: "message",
					message: { role: "user", content: "无时间戳" },
				},
			],
		});
		expect(facts[0]?.kind).toBe("turn.started");
		expect(facts[0]?.at).toBeUndefined();
	});

	it("journal 的中止终局成为 turn.aborted，而不是伪造完成", () => {
		const abortedAux: SessionEventRecord[] = [
			{
				kind: "event",
				id: "e-abort",
				seq: 5,
				timestamp: T4,
				event: "turn_aborted",
				data: { turnId: 1 },
			},
		];
		const facts = ingestReplay({
			entries: entries.slice(0, 2),
			auxiliary: [...auxiliary, ...abortedAux],
		});
		const closing = facts.at(-1);
		expect(closing?.kind).toBe("turn.aborted");
		expect(closing?.at).toBe(at(T4));
	});

	it("tool_finished 缺失且消息无状态时保持未知，不写成完成", () => {
		const facts = ingestReplay({
			entries: [
				...entries.slice(0, 2),
				{
					kind: "message",
					id: "r1",
					seq: 3,
					timestamp: T2,
					message: { role: "tool", tool_call_id: "call-1", name: "exec_command", content: "ok" },
				},
			],
		});
		const finished = facts.find((fact) => fact.kind === "tool.finished");
		expect(finished?.kind === "tool.finished" ? finished.status : undefined).toBe("unknown");
	});
});

describe("sanitizeExternal", () => {
	it("移除 OSC 超链接与剪贴板序列", () => {
		expect(sanitizeExternal("a\x1b]8;;https://evil.example\x07b\x1b]8;;\x07c")).toBe("abc");
		expect(sanitizeExternal("x\x1b]52;c;AAAA\x07y")).toBe("xy");
	});

	it("移除 CSI（含 SGR）、DCS 与裸 ESC", () => {
		expect(sanitizeExternal("a\x1b[31mb\x1b[0mc")).toBe("abc");
		expect(sanitizeExternal("a\x1bPq\x1b\\b")).toBe("ab");
		expect(sanitizeExternal("a\x1b")).toBe("a");
	});

	it("丢弃 C0/C1/DEL，保留换行", () => {
		expect(sanitizeExternal("a\rb\tc\u0000d\u007fe\u009bf")).toBe("abcdef");
		expect(sanitizeExternal("第一行\n第二行")).toBe("第一行\n第二行");
	});

	it("丢弃 bidi 覆盖、零宽字符与孤立代理项", () => {
		expect(sanitizeExternal("\u202Eevil\u202C")).toBe("evil");
		expect(sanitizeExternal("a\u200Bb\uFEFFc")).toBe("abc");
		expect(sanitizeExternal("\uD800x")).toBe("x");
	});
});

describe("Presentation Core 的时钟与终端边界", () => {
	it("src/presentation 不读取时钟、不碰终端/进程/文件", async () => {
		const root = join(process.cwd(), "src", "presentation");
		const offenders: string[] = [];
		for await (const file of sourceFiles(root)) {
			const source = await readFile(file, "utf8");
			if (/Date\.now\(|new Date\(|performance\.now\(/.test(source)) offenders.push(`${file}: clock`);
			if (/from\s+["']node:(tty|process|fs)/.test(source)) offenders.push(`${file}: node module`);
		}
		expect(offenders).toEqual([]);
	});
});

async function* sourceFiles(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(path);
		else if (entry.name.endsWith(".ts")) yield path;
	}
}
