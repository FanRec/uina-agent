import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../src/agent/context.js";
import type { ModelStreamFn, RequestProjection, ToolResultStatus } from "../src/core/types.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import type { RuntimeHooks } from "../src/runtime/hooks.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { ToolBroker, type ToolExecutionResult } from "../src/tools/broker.js";
import { mockTool, SubjectHarness } from "./harness/index.js";

const envs: string[] = [];
afterEach(async () => {
	await Promise.all(envs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempSession(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "uina-tool-view-"));
	envs.push(dir);
	return join(dir, "session.jsonl");
}

/** 静态 RuntimeHooks：只挂 transformResult 改写，其余 no-op（context 端口为空）。 */
function hooksWithTransform(
	transform: (input: { name: string; result: string; status: ToolResultStatus }) => Partial<ToolExecutionResult>,
): RuntimeHooks {
	return {
		turn: {
			prepare: async () => ({}),
			transformContext: async (projection: RequestProjection) => projection,
			preflight: async () => ({ action: "send" as const }),
			afterEnd: async () => {},
			shouldStop: async () => ({}),
		},
		tools: {
			beforeCall: async () => ({}),
			transformResult: async (input) => transform({ name: input.name, result: input.result, status: input.status }),
		},
		provider: {
			transformHeaders: async (_provider: string, headers: Record<string, string>) => headers,
			transformPayload: async (_provider: string, payload: unknown) => payload,
			observeResponse: async () => {},
		},
		context: { collect: async () => ({ contributions: [], omitted: [] }) },
		events: {
			emit: async (_event: RuntimeEvent) => {},
			observe: () => {},
			flush: async () => {},
		},
	};
}

function capturingStream(toolCalls: Array<{ id: string; name: string }>): {
	stream: ModelStreamFn;
	requests: Array<{ requestId?: string; messages: import("../src/core/types.js").ChatMsg[] }>;
} {
	const requests: Array<{ requestId?: string; messages: import("../src/core/types.js").ChatMsg[] }> = [];
	let requestsSeen = 0;
	const stream: ModelStreamFn = async (_model, req, onDelta) => {
		requests.push({
			requestId: req.requestId,
			messages: structuredClone(req.messages as import("../src/core/types.js").ChatMsg[]),
		});
		requestsSeen++;
		if (requestsSeen === 1) {
			// 第一轮发起工具调用；此后所有请求都以 stop 收尾
			for (const call of toolCalls) {
				onDelta({ kind: "tool_call", call: { id: call.id, name: call.name, args: "{}" } });
			}
			onDelta({ kind: "finish", reason: "tool_calls" });
			return;
		}
		onDelta({ kind: "text", text: "收到" });
		onDelta({ kind: "finish", reason: "stop" });
	};
	return { stream, requests };
}

function storedToolMessages(store: { readRecords(): readonly { kind: string; message?: unknown }[] }): Array<{
	content: string;
	status?: string;
	modelView?: { content: string; images?: unknown; details?: unknown };
}> {
	return store
		.readRecords()
		.filter((r) => r.kind === "message" && (r.message as { role?: string } | undefined)?.role === "tool")
		.map((r) => r.message) as never[];
}

describe("Tool Result 模型视图（事实与模型可见投影分离）", () => {
	it("tools.transformResult 改写后：canonical 保存原文，下一次模型请求实际收到改写正文", async () => {
		const path = await tempSession();
		const opened = await openJsonlSession(path);
		try {
			const broker = new ToolBroker();
			broker.register(mockTool("fetch", () => ({ result: "原始执行正文", status: "succeeded" as const })));
			const { stream, requests } = capturingStream([{ id: "call-1", name: "fetch" }]);
			const harness = SubjectHarness.create({
				store: opened.store,
				broker,
				runtimeHooks: hooksWithTransform(() => ({ result: "[改写] 原始执行正文（已渲染为表格）" })),
				stream,
			});
			await harness.subject.pushInput("取一下数据");
			await harness.subject.waitForIdle();

			// canonical journal 落原文 + 可选 modelView（执行事实只有一份）
			const toolMessages = storedToolMessages(opened.store);
			expect(toolMessages).toHaveLength(1);
			expect(toolMessages[0]!.content).toBe("原始执行正文");
			expect(toolMessages[0]!.status).toBe("succeeded");
			expect(toolMessages[0]!.modelView).toEqual({ content: "[改写] 原始执行正文（已渲染为表格）" });

			// 下一次真实模型请求从历史重建：模型实际收到改写正文
			await harness.subject.pushInput("再确认一下");
			await harness.subject.waitForIdle();
			const nextRequest = requests[2]!;
			const projected = nextRequest.messages.find((m) => m.role === "tool");
			expect(projected?.content).toBe("[改写] 原始执行正文（已渲染为表格）");
			expect(projected?.status).toBe("succeeded");
			// Wire 上没有 details/modelView 的泄漏位：tool 消息只带正文
			expect(projected).not.toHaveProperty("modelView");
		} finally {
			await opened.store.close();
		}
	});

	it("关闭并重开 JSONL 后模型视图保持一致；没有改写时不写冗余 modelView", async () => {
		const path = await tempSession();
		{
			const opened = await openJsonlSession(path);
			const broker = new ToolBroker();
			broker.register(mockTool("plain", () => ({ result: "原样返回", status: "succeeded" as const })));
			broker.register(mockTool("rewritten", () => ({ result: "原始", status: "succeeded" as const })));
			const { stream } = capturingStream([
				{ id: "c1", name: "plain" },
				{ id: "c2", name: "rewritten" },
			]);
			const harness = SubjectHarness.create({
				store: opened.store,
				broker,
				runtimeHooks: hooksWithTransform(({ name }) => (name === "rewritten" ? { result: "模型视图版" } : {})),
				stream,
			});
			await harness.subject.pushInput("跑两个工具");
			await harness.subject.waitForIdle();
			await opened.store.close();
		}
		const reopened = await openJsonlSession(path);
		try {
			const toolMessages = storedToolMessages(reopened.store);
			expect(toolMessages).toHaveLength(2);
			const plain = toolMessages.find((m) => m.content === "原样返回")!;
			const rewritten = toolMessages.find((m) => m.content === "原始")!;
			// 未改写不写冗余视图；改写正文随消息持久化
			expect(plain.modelView).toBeUndefined();
			expect(rewritten.modelView).toEqual({ content: "模型视图版" });

			const projected = convertToolViews(reopened.store.readRecords());
			expect(projected.map((m) => m.content)).toEqual(["原样返回", "模型视图版"]);
		} finally {
			await reopened.store.close();
		}
	});
});

function convertToolViews(
	records: readonly { kind: string; message?: unknown }[],
): Array<{ content: string; status?: string }> {
	const messages = records.filter((r) => r.kind === "message").map((r) => r.message);
	return convertToLlm(messages as never[]).filter((m) => m.role === "tool") as unknown as Array<{
		role: "tool";
		content: string;
		status?: string;
	}>;
}
