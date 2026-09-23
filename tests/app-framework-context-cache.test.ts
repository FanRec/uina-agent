/**
 * 缓存合同：可变世界状态（视口/具身快照）经 tail 相位注入到完整上下文最末尾，
 * systemPrompt 与历史消息保持静态——进度 tick 前后，除尾帧组外所有消息逐字节相同，
 * 前缀（至上一轮输入帧组结束）可被 Prompt Cache 完整命中。
 *
 * 本测试锁定的是**字节级缓存合同**，而非常规行为断言；重排注入位置或破坏
 * buildTailFrame 的内容寻址确定性都属于破坏性变更。
 */
import { describe, expect, it } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";
import { guardRuntimeHooks } from "../src/runtime/guard.js";
import { createRuntimeHooks } from "../src/extensions/runtime-hooks.js";
import { ContextViewport } from "../src/extensions/app-framework/context-viewport.js";
import { appendTailFrame } from "../src/extensions/event-frames/projection.js";
import type { AppRuntime } from "../src/extensions/app-framework/types.js";
import type { ChatMsg } from "../src/core/types.js";

const viewportRuntime = (render: () => string): AppRuntime => ({
	definition: { name: "jukebox", description: "jukebox", render, actions: {} },
	enabled: true,
	surfaceTier: "ambient",
	lastActiveTurn: Date.now(),
});

const inputFrame = (n: number): ChatMsg[] => [
	{ role: "user", content: `第${n}轮输入` },
	{ role: "assistant", content: `第${n}轮回复` },
];
const projection = (messages: readonly ChatMsg[]) => ({ projectionId: "test", modelKey: "test", messages, tools: [] });

describe("尾部瞬态帧的前缀缓存合同", () => {
	it("进度 tick 前后：systemPrompt 不变（静态）、历史前缀逐字节相同、仅尾帧组不同", async () => {
		const runtime = viewportRuntime(() => "[jukebox: 播放中 01:00]");
		const viewport = new ContextViewport({ getRuntimes: () => [runtime] });

		const host = new ExtensionHost();
		host.onHook("turn.transformContext", async (request) => {
			const result = appendTailFrame(request.messages, await viewport.buildTailFrame());
			return result ? { projection: { ...request, messages: result.messages } } : undefined;
		}, { tail: true });
		const hooks = guardRuntimeHooks(createRuntimeHooks(host));

		// ── 第 N 轮请求：history + 当时的视口快照（尾帧是请求的最后部分，模型看它作答）──
		const roundN = [...inputFrame(1), { role: "user" as const, content: "第2轮输入" }];
		const requestN = (await hooks.turn.transformContext(projection(roundN))).messages;

		// ── 视口进度 tick，第 N+1 轮请求：真实时序中第 N 轮回复产生在其尾帧之后——
		// 故第 N 轮完整请求（含旧尾帧）成为历史前缀，随后追加 a2 与新尾帧。──
		runtime.definition.render = () => "[jukebox: 播放中 01:31]";
		const tailN = requestN.slice(-3);
		const roundN1 = [...roundN, ...tailN, { role: "assistant" as const, content: "第2轮回复" }];
		const requestN1 = (await hooks.turn.transformContext(projection(roundN1))).messages;

		// 1. 公共前缀 = sys 之外的第 N 轮全部请求消息，逐字节相同（可被前缀缓存命中）。
		for (let i = 0; i < requestN.length; i++) {
			expect(requestN1[i]).toEqual(requestN[i]);
		}

		// 2. 第 N+1 轮只在尾部多了新消息（输入/回复与新尾帧组）。
		expect(requestN1.length).toBeGreaterThan(requestN.length);

		// 3. 尾帧组内 eventId 内容寻址：内容变化 ⇒ callId 变化（区分两次快照）。
		const oldTail = requestN.slice(-3);
		const newTail = requestN1.slice(-3);
		const callId = (frame: ChatMsg[]) => (frame[1] as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id;
		expect(callId(oldTail)).not.toBe(callId(newTail));
		expect(oldTail[2]!.content).toContain("01:00");
		expect(newTail[2]!.content).toContain("01:31");
	});

	it("视口内容不变：跨请求帧组逐字节稳定（同前缀下尾帧也可缓存）", async () => {
		const runtime = viewportRuntime(() => "[jukebox: 空闲]");
		const viewport = new ContextViewport({ getRuntimes: () => [runtime] });
		const host = new ExtensionHost();
		host.onHook("turn.transformContext", async (request) => {
			const result = appendTailFrame(request.messages, await viewport.buildTailFrame());
			return result ? { projection: { ...request, messages: result.messages } } : undefined;
		}, { tail: true });
		const hooks = guardRuntimeHooks(createRuntimeHooks(host));

		const a = (await hooks.turn.transformContext(projection([{ role: "user", content: "x" }]))).messages;
		const b = (await hooks.turn.transformContext(projection([{ role: "user", content: "x" }]))).messages;
		// 同内容 ⇒ 同 eventId ⇒ 同 callId ⇒ 三消息组逐字节相同
		expect(a).toEqual(b);
	});
});
