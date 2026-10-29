/**
 * W2a 验收：工具状态矩阵与展示投影节点。
 *
 * 钉住三条纪律：
 * 1. 终态词汇只有 ToolResultStatus 五态，图标/文案来自单一矩阵；
 * 2. 节点身份稳定（turn:${n} / turn:${n}:tool:${callId}），与展示面无关；
 * 3. 时间只来自 Fact 的 at，缺任一端 durationMs 保持 undefined。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_STATUSES } from "../src/core/types.js";
import type { HostEventRecord } from "../src/host/events.js";
import { type FactDraft, FactStore } from "../src/presentation/facts.js";
import { ingestLive } from "../src/presentation/ingest-live.js";
import { ingestReplay } from "../src/presentation/ingest-replay.js";
import {
	PresentationProjection,
	type ProjectionInput,
	toolNodeId,
	turnNodeId,
} from "../src/presentation/projection.js";
import { TOOL_STATUS_SPEC } from "../src/presentation/tool-status.js";
import { TrajectoryProjection } from "../src/presentation/trajectory.js";
import type { SessionEntry, SessionEventRecord } from "../src/session/types.js";

const T0 = 1_700_000_000_000;

function project(facts: readonly ProjectionInput[]): PresentationProjection {
	const projection = new PresentationProjection();
	projection.applyAll(facts);
	return projection;
}

function store(drafts: readonly FactDraft[]): ProjectionInput[] {
	const facts = new FactStore();
	for (const draft of drafts) facts.append(draft);
	return [...facts.list()];
}

describe("工具状态矩阵", () => {
	it("覆盖且只覆盖 core 定义的 ToolResultStatus 五态", () => {
		expect(Object.keys(TOOL_STATUS_SPEC).sort()).toEqual([...TOOL_RESULT_STATUSES].sort());
		expect(TOOL_STATUS_SPEC).toEqual({
			succeeded: { icon: "✓", label: "完成", tone: "success", emptyText: "执行完成，无输出" },
			failed: { icon: "✗", label: "失败", tone: "error", emptyText: "失败，无输出" },
			cancelled: { icon: "⊘", label: "已取消", tone: "warning", emptyText: "已取消，无输出" },
			unknown: { icon: "?", label: "结果未知", tone: "warning", emptyText: "结果未知" },
			not_started: { icon: "○", label: "未执行", tone: "neutral", emptyText: "未执行" },
		});
	});
});

describe("PresentationProjection", () => {
	it("节点身份稳定：回合与工具 ID 只由序号和 callId 决定", () => {
		const facts = store([
			{ kind: "turn.started", turn: 3, userText: "查目录", origin: "live", at: T0 },
			{ kind: "tool.started", callId: "call-a", name: "list_dir", args: {}, origin: "live", at: T0 + 10 },
			{
				kind: "tool.finished",
				callId: "call-a",
				name: "list_dir",
				status: "succeeded",
				result: "ok",
				origin: "live",
				at: T0 + 110,
			},
		]);
		const projection = project(facts);
		const turn = projection.turn(3);
		const tool = projection.tool("call-a");
		expect(turn?.id).toBe(turnNodeId(3));
		expect(turn?.id).toBe("turn:3");
		expect(tool?.id).toBe(toolNodeId(3, "call-a"));
		expect(tool?.id).toBe("turn:3:tool:call-a");
		expect(tool?.turn).toBe(3);
		expect(tool?.durationMs).toBe(100);
	});

	it("工具归属当前回合，回合切换后不串号", () => {
		const facts = store([
			{ kind: "turn.started", turn: 1, userText: "第一轮", origin: "live", at: T0 },
			{ kind: "tool.started", callId: "call-1", name: "read_file", args: {}, origin: "live", at: T0 + 1 },
			{ kind: "turn.started", turn: 2, userText: "第二轮", origin: "live", at: T0 + 100 },
			{ kind: "tool.started", callId: "call-2", name: "read_file", args: {}, origin: "live", at: T0 + 101 },
		]);
		const projection = project(facts);
		expect(projection.tool("call-1")?.turn).toBe(1);
		expect(projection.tool("call-2")?.turn).toBe(2);
		expect(projection.list().map((node) => node.id)).toEqual([
			"turn:1",
			"turn:1:tool:call-1",
			"turn:2",
			"turn:2:tool:call-2",
		]);
	});

	it("缺开始时间不产生耗时；缺结束时间同样保持未知", () => {
		const facts = store([
			{ kind: "turn.started", turn: 1, userText: "任务", origin: "live" },
			{ kind: "tool.started", callId: "call-1", name: "exec", args: {}, origin: "live" },
			{
				kind: "tool.finished",
				callId: "call-1",
				name: "exec",
				status: "succeeded",
				result: "out",
				origin: "live",
				at: T0 + 100,
			},
			{ kind: "tool.started", callId: "call-2", name: "exec", args: {}, origin: "live", at: T0 + 200 },
		]);
		const projection = project(facts);
		const noStart = projection.tool("call-1");
		expect(noStart?.startedAt).toBeUndefined();
		expect(noStart?.endedAt).toBe(T0 + 100);
		expect(noStart?.durationMs).toBeUndefined();
		const noEnd = projection.tool("call-2");
		expect(noEnd?.startedAt).toBe(T0 + 200);
		expect(noEnd?.endedAt).toBeUndefined();
		expect(noEnd?.durationMs).toBeUndefined();
	});

	it("恢复缺口：只有完成事实时仍生成终态节点，时间未知", () => {
		const facts = store([
			{ kind: "turn.started", turn: 1, userText: "任务", origin: "replay", at: T0 },
			{
				kind: "tool.finished",
				callId: "call-9",
				name: "exec",
				status: "unknown",
				result: "opaque",
				origin: "replay",
				at: T0 + 50,
			},
		]);
		const projection = project(facts);
		const node = projection.tool("call-9");
		expect(node).toMatchObject({
			id: "turn:1:tool:call-9",
			turn: 1,
			name: "exec",
			status: "unknown",
			result: "opaque",
			endedAt: T0 + 50,
		});
		expect(node?.startedAt).toBeUndefined();
		expect(node?.durationMs).toBeUndefined();
	});

	it("五种终态原样进入节点，不被解释成成功", () => {
		const facts = store([
			{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
			{ kind: "tool.started", callId: "call-1", name: "exec", args: {}, origin: "live", at: T0 },
			{
				kind: "tool.finished",
				callId: "call-1",
				name: "exec",
				status: "cancelled",
				result: "stopped",
				origin: "live",
				at: T0 + 1,
			},
		]);
		expect(project(facts).tool("call-1")?.status).toBe("cancelled");

		const notStarted = store([
			{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
			{
				kind: "tool.finished",
				callId: "call-2",
				name: "exec",
				status: "not_started",
				result: "",
				origin: "live",
				at: T0,
			},
		]);
		expect(project(notStarted).tool("call-2")?.status).toBe("not_started");
	});

	it("回合终结：completed 携带 usage；aborted 保持中止且不伪造 usage", () => {
		const usage = { callId: "call-1", totalTokens: 2048 } as const;
		const completed = project(
			store([
				{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
				{ kind: "turn.ended", turn: 1, usage, origin: "live", at: T0 + 100 },
			]),
		);
		expect(completed.turn(1)).toMatchObject({ status: "completed", endedAt: T0 + 100, usage });

		const aborted = project(
			store([
				{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
				{ kind: "turn.aborted", turn: 1, origin: "live", at: T0 + 100 },
			]),
		);
		expect(aborted.turn(1)).toMatchObject({ status: "aborted", endedAt: T0 + 100 });
		expect(aborted.turn(1)?.usage).toBeUndefined();
	});

	it("回溯后 continueTurn 决定后续工具归属", () => {
		const projection = new PresentationProjection();
		projection.reset();
		projection.continueTurn(7);
		const nodes = projection.apply({
			kind: "tool.started",
			callId: "call-x",
			name: "exec",
			at: T0,
		});
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ id: "turn:7:tool:call-x", turn: 7, status: "running" });
	});
});

describe("思考块与回合结算", () => {
	it("思考增量累积到同一块，助手内容开始即完成关闭", () => {
		const projection = new PresentationProjection();
		projection.apply({ kind: "turn.started", turn: 1, userText: "任务", at: T0 });
		projection.apply({ kind: "thinking.delta", text: "先看", at: T0 + 10 });
		projection.apply({ kind: "thinking.delta", text: "调用链", at: T0 + 20 });
		expect(projection.list().at(-1)).toMatchObject({
			id: "turn:1:thinking:1",
			text: "先看调用链",
			status: "running",
		});

		const closed = projection.apply({ kind: "assistant.delta", text: "回复", at: T0 + 30 });
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatchObject({ kind: "thinking", status: "completed", durationMs: 20 });
	});

	it("回合中止把在途工具结算为 cancelled，正常结束缺完成事实标为 unknown", () => {
		const aborted = project(
			store([
				{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
				{ kind: "tool.started", callId: "call-1", name: "exec", args: {}, origin: "live", at: T0 + 10 },
				{ kind: "turn.aborted", turn: 1, origin: "live", at: T0 + 50 },
			]),
		);
		expect(aborted.tool("call-1")).toMatchObject({ status: "cancelled", endedAt: T0 + 50, durationMs: 40 });

		const ended = project(
			store([
				{ kind: "turn.started", turn: 1, userText: "任务", origin: "live", at: T0 },
				{ kind: "tool.started", callId: "call-2", name: "exec", args: {}, origin: "live", at: T0 + 10 },
				{ kind: "turn.ended", turn: 1, origin: "live", at: T0 + 50 },
			]),
		);
		expect(ended.tool("call-2")).toMatchObject({ status: "unknown", endedAt: T0 + 50 });
	});
});

describe("TrajectoryProjection（节点消费者）", () => {
	it("聚合键不含回合号：多回合同名工具合并为一行", () => {
		const projection = new TrajectoryProjection();
		for (const turn of [1, 2]) {
			projection.apply({
				kind: "tool",
				id: `turn:${turn}:tool:call-${turn}`,
				turn,
				callId: `call-${turn}`,
				name: "exec",
				status: "succeeded",
				durationMs: 10,
				result: "ok",
			});
		}
		const rows = projection.aggregate("duration").filter((row) => row.name === "exec");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ count: 2, totalDurationMs: 20, avgDurationMs: 10 });
	});

	it("5000 上限淘汰后聚合仍累计历史总量", () => {
		const projection = new TrajectoryProjection();
		for (let index = 0; index < 5001; index++) {
			projection.apply({
				kind: "tool",
				id: `turn:1:tool:call-${index}`,
				turn: 1,
				callId: `call-${index}`,
				name: "exec",
				status: "succeeded",
				durationMs: 1,
				result: "ok",
			});
		}
		expect(projection.list()).toHaveLength(5000);
		expect(projection.aggregate("duration").find((row) => row.name === "exec")).toMatchObject({
			count: 5001,
			totalDurationMs: 5001,
		});
	});

	it("replaceAll 丢弃旧节点并按回合尾部补出 model_stream", () => {
		const projection = new TrajectoryProjection();
		projection.apply({ kind: "turn", id: "turn:1", turn: 1, userText: "旧", status: "completed", endedAt: 20 });
		projection.replaceAll([
			{
				kind: "turn",
				id: "turn:2",
				turn: 2,
				userText: "新",
				status: "completed",
				startedAt: 100,
				endedAt: 200,
				usage: { callId: "call-2", totalTokens: 7 },
			},
		]);
		expect(projection.list().map((node) => node.id)).toEqual(["turn:2", "turn:2:stream"]);
		expect(projection.list().find((node) => node.kind === "model_stream")).toMatchObject({
			startedAt: 100,
			endedAt: 200,
			tokens: { total: 7 },
		});
	});
});

describe("展示层静态约束", () => {
	it("presentation 目录不出现时钟、进程、终端与文件模块（递归含子目录）", () => {
		const dir = new URL("../src/presentation/", import.meta.url);
		const forbidden = /Date\.now|performance\.now|setInterval|setTimeout|process\.|node:fs|node:process|node:readline/;
		const walk = (url: URL): void => {
			for (const name of readdirSync(url)) {
				const child = new URL(`${name}${name.endsWith("/") ? "" : "/"}`, url);
				if (statSync(child).isDirectory()) {
					walk(child);
					continue;
				}
				expect(readFileSync(child, "utf8"), name).not.toMatch(forbidden);
			}
		};
		walk(dir);
	});
});

describe("live 与 replay 投影等价", () => {
	const T0_ISO = "2026-10-29T10:00:00.000Z";
	const T1_ISO = "2026-10-29T10:00:02.000Z";
	const T2_ISO = "2026-10-29T10:00:05.000Z";
	const T3_ISO = "2026-10-29T10:00:07.000Z";

	const entries: SessionEntry[] = [
		{
			kind: "message",
			id: "u1",
			seq: 1,
			timestamp: T0_ISO,
			message: { role: "user", content: "检查目录", timestamp: T0_ISO },
		},
		{
			kind: "message",
			id: "a1",
			seq: 2,
			timestamp: T1_ISO,
			message: {
				role: "assistant",
				content: "执行",
				tool_calls: [{ id: "call-1", name: "exec_command", args: { command: "dir" } }],
				timestamp: T1_ISO,
			},
		},
		{
			kind: "message",
			id: "r1",
			seq: 3,
			timestamp: T2_ISO,
			message: {
				role: "tool",
				tool_call_id: "call-1",
				name: "exec_command",
				content: "ok",
				status: "succeeded",
				timestamp: T2_ISO,
			},
		},
	];

	const auxiliary: SessionEventRecord[] = [
		{
			kind: "event",
			id: "e1",
			seq: 2,
			timestamp: T1_ISO,
			event: "tool_started",
			data: { callId: "call-1", name: "exec_command", args: { command: "dir" } },
		},
		{
			kind: "event",
			id: "e2",
			seq: 3,
			timestamp: T2_ISO,
			event: "tool_finished",
			data: { callId: "call-1", name: "exec_command", status: "succeeded" },
		},
	];

	const liveEvents: HostEventRecord[] = [
		{ at: Date.parse(T0_ISO), event: { type: "turn_start", turnNumber: 1, userText: "检查目录" } },
		{
			at: Date.parse(T1_ISO),
			event: { type: "tool_call", toolName: "exec_command", args: { command: "dir" }, callId: "call-1" },
		},
		{
			at: Date.parse(T2_ISO),
			event: {
				type: "tool_result",
				toolName: "exec_command",
				args: { command: "dir" },
				result: "ok",
				status: "succeeded",
				callId: "call-1",
			},
		},
		{ at: Date.parse(T3_ISO), event: { type: "turn_end", turnNumber: 1 } },
	];

	it("同一 journal：live 与 replay 的工具节点等价（含耗时）", () => {
		const storeFacts = new FactStore();
		for (const record of liveEvents) {
			for (const draft of ingestLive(record)) storeFacts.append(draft);
		}
		const live = project(storeFacts.list());
		const replayed = project(ingestReplay({ entries, auxiliary }));
		expect(live.tool("call-1")).toEqual(replayed.tool("call-1"));
		expect(live.tool("call-1")?.durationMs).toBe(Date.parse(T2_ISO) - Date.parse(T1_ISO));
		// 回合终局两侧一致；但 journal 没有回合结束时间戳，replay 的 endedAt 保持未知。
		expect(live.turn(1)?.status).toBe("completed");
		expect(replayed.turn(1)?.status).toBe("completed");
		expect(live.turn(1)?.endedAt).toBe(Date.parse(T3_ISO));
		expect(replayed.turn(1)?.endedAt).toBeUndefined();
	});

	it("replay 缺时间戳时耗时保持未知", () => {
		const facts = ingestReplay({
			entries: [
				{ kind: "message", message: { role: "user", content: "任务" } },
				{
					kind: "message",
					message: {
						role: "assistant",
						content: "执行",
						tool_calls: [{ id: "call-1", name: "exec", args: {} }],
					},
				},
				{
					kind: "message",
					message: { role: "tool", tool_call_id: "call-1", name: "exec", content: "ok", status: "succeeded" },
				},
			],
		});
		const node = project(facts).tool("call-1");
		expect(node?.status).toBe("succeeded");
		expect(node?.startedAt).toBeUndefined();
		expect(node?.endedAt).toBeUndefined();
		expect(node?.durationMs).toBeUndefined();
	});
});
