import { describe, expect, it } from "vitest";
import type { ModelStreamFn, StreamDelta } from "../src/core/types.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { ToolBroker } from "../src/tools/broker.js";
import { SubjectHarness } from "./harness/index.js";

const deltas: StreamDelta[] = [
	{ kind: "text", text: "好的" },
	{ kind: "finish", reason: "stop" },
];

interface CapturedRequest {
	requestId?: string;
	messages: import("../src/core/types.js").ChatMsg[];
}

/** 捕获每次真实模型请求的语义内容（providerHooks 携带函数，不可整体克隆）。 */
function capturingStream(): { stream: ModelStreamFn; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const stream: ModelStreamFn = async (_model, req, onDelta) => {
		requests.push({
			requestId: req.requestId,
			messages: structuredClone(req.messages as import("../src/core/types.js").ChatMsg[]),
		});
		for (const delta of deltas) onDelta(delta);
	};
	return { stream, requests };
}

/** 从真实 ModelRequest 中提取装配事实（guidance 落 System 后的固定前缀 User；动态来源落运行时参考消息）。 */
function assemblyOf(req: CapturedRequest) {
	const guidanceMessage = req.messages.find((m) => m.context?.kind === "runtime.guidance");
	const reference = req.messages.filter((m) => m.context?.kind === "runtime.perception");
	const text = reference.map((m) => m.content).join("\n");
	return {
		guidanceMessage,
		guidanceText: guidanceMessage?.content ?? "",
		guidance: [...(guidanceMessage?.content ?? "").matchAll(/^## (.+) \/ (.+)$/gm)].map((m) => `${m[1]}::${m[2]}`),
		referenceMessages: reference.length,
		referenceText: text,
		internalSources: [...text.matchAll(/- source: ([^;]+); origin: internal/g)].map((m) => m[1]!),
		externalSources: [...text.matchAll(/- source: ([^;]+); origin: external/g)].map((m) => m[1]!),
	};
}

describe("Context Source 注入（真实 decide() 请求链）", () => {
	it("guidance 与两份动态 Source 各出现一次；顺序与激活顺序无关；origin 在请求正文中可读", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			// 后激活的扩展 owner 字母序在前：装配顺序必须与激活顺序无关
			await runner.activateBuiltin("zeta", (pi) => {
				pi.provideContext({ id: "note-protocol", kind: "guidance", text: "Zeta 的记录协议。" });
			});
			await runner.activateBuiltin("alpha", (pi) => {
				pi.provideContext({
					id: "battery",
					kind: "capability",
					read: () => ({ text: "电量 80%", source: { type: "alpha.battery", origin: "internal" } }),
				});
				pi.provideContext({
					id: "weather",
					kind: "observation",
					read: () => ({
						text: "晴，25 度",
						source: { type: "alpha.weather", origin: "external" },
						observedAt: "2026-11-13T09:00:00.000Z",
					}),
				});
			});

			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await harness.subject.pushInput("看一下环境");
			await harness.subject.waitForIdle();

			expect(requests).toHaveLength(1);
			const assembly = assemblyOf(requests[0]!);
			expect(assembly.guidance).toEqual(["builtin:zeta::note-protocol"]);
			expect(assembly.guidanceText).toContain("Zeta 的记录协议。");
			// 固定前缀位置：messages[0] 是 system，messages[1] 是唯一的扩展指南 User，且全请求仅此一条
			const messages = requests[0]!.messages;
			expect(messages[0]!.role).toBe("system");
			expect(messages[1]!.context?.kind).toBe("runtime.guidance");
			expect(
				messages.map((m, index) => (m.context?.kind === "runtime.guidance" ? index : -1)).filter((i) => i >= 0),
			).toEqual([1]);
			expect(assembly.referenceMessages).toBe(1);
			expect(assembly.internalSources).toEqual(["alpha.battery"]);
			expect(assembly.externalSources).toEqual(["alpha.weather"]);
			// 参考消息自我声明"不是用户新请求"
			expect(assembly.referenceText).toContain("不是用户新请求");
			// requestId 已随请求建立（诊断关联；不在此断言具体格式）
			expect(requests[0]!.requestId).toBeTruthy();
		} finally {
			await runner.dispose();
		}
	});

	it("preflight rebuild 后重新装配：Source 重新读取，不叠加两次装配的临时消息", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			let reads = 0;
			await runner.activateBuiltin("probe", (pi) => {
				pi.provideContext({
					id: "clock",
					kind: "observation",
					read: () => {
						reads++;
						return { text: `读取 #${reads}`, source: { type: "probe.clock", origin: "internal" } };
					},
				});
			});
			// 首个 pass 要求 rebuild 一次，第二个 pass 放行（模拟 compaction preflight 流程）
			let passSeen = 0;
			const hooks = runner.runtimeHooks();
			const guarded = {
				...hooks,
				turn: {
					...hooks.turn,
					preflight: async (input: { pass: number }) => {
						passSeen++;
						return input.pass === 0 ? { action: "rebuild" as const } : { action: "send" as const };
					},
				},
			};
			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: guarded as typeof hooks, stream });
			await harness.subject.pushInput("触发重建");
			await harness.subject.waitForIdle();

			// pass 0（rebuild 拒绝，不发请求）+ pass 1（放行）各装配一次：两条请求只有一条发送
			expect(requests).toHaveLength(1);
			expect(passSeen).toBe(2);
			const assembly = assemblyOf(requests[0]!);
			expect(assembly.referenceMessages).toBe(1);
			// pass 1 的装配重新读取：正文是第二次读取的快照，不残留 pass 0 的内容
			expect(assembly.referenceText).toContain("读取 #2");
			expect(assembly.referenceText).not.toContain("读取 #1");
		} finally {
			await runner.dispose();
		}
	});

	it("同一运行内两次请求：第二次看到新快照，且不累积上一次临时注入", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			let generation = 0;
			await runner.activateBuiltin("probe", (pi) => {
				pi.provideContext({
					id: "clock",
					kind: "observation",
					read: () => ({
						text: `快照 #${generation}`,
						source: { type: "probe.clock", origin: "internal" },
					}),
				});
			});
			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await harness.subject.pushInput("第一问");
			await harness.subject.waitForIdle();
			generation = 1;
			await harness.subject.pushInput("第二问");
			await harness.subject.waitForIdle();

			expect(requests).toHaveLength(2);
			const first = assemblyOf(requests[0]!);
			const second = assemblyOf(requests[1]!);
			expect(first.referenceText).toContain("快照 #0");
			expect(second.referenceText).toContain("快照 #1");
			expect(first.referenceMessages).toBe(1);
			expect(second.referenceMessages).toBe(1);
			// 两次请求的 requestId 不同（每次 Model Request 重新装配）
			expect(requests[0]!.requestId).not.toEqual(requests[1]!.requestId);
		} finally {
			await runner.dispose();
		}
	});

	it("Source 注销后下一次请求无旧内容残留", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			let disposeSource: (() => void) | undefined;
			await runner.activateBuiltin("ghost", (pi) => {
				disposeSource = pi.provideContext({ id: "hint", kind: "guidance", text: "过期的指引。" });
			});
			const { stream, requests } = capturingStream();
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await harness.subject.pushInput("第一问");
			await harness.subject.waitForIdle();
			const first = assemblyOf(requests[0]!);
			expect(first.guidance).toEqual(["builtin:ghost::hint"]);
			expect(first.guidanceText).toContain("过期的指引。");

			disposeSource?.();
			await harness.subject.pushInput("第二问");
			await harness.subject.waitForIdle();
			const second = assemblyOf(requests[1]!);
			// 无有效 guidance 时不创建空消息：下一次请求不再含其章节，也没有前缀容器
			expect(second.guidance).toEqual([]);
			expect(second.guidanceMessage).toBeUndefined();
			expect(requests[1]!.messages.some((m) => m.context?.kind === "runtime.guidance")).toBe(false);
			expect(second.referenceMessages).toBe(0);
		} finally {
			await runner.dispose();
		}
	});

	it("inspectRequest 是 preview：独立身份、带装配追踪，且与活动请求身份不同", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			await runner.activateBuiltin("probe", (pi) => {
				pi.provideContext({
					id: "state",
					kind: "capability",
					read: () => ({ text: "就绪", source: { type: "probe.state", origin: "internal" } }),
				});
			});
			const harness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks() });
			const inspection = await harness.subject.inspectRequest();
			expect(inspection.basis).toBe("preview");
			expect(inspection.requestId).toMatch(/^preview-/);
			expect(inspection.assembly?.sources.some((s) => s.status === "included" && s.id === "state")).toBe(true);
			expect(inspection.projection.messages.some((m) => m.context?.kind === "runtime.perception")).toBe(true);

			const { stream, requests } = capturingStream();
			const activeHarness = SubjectHarness.create({ runtimeHooks: runner.runtimeHooks(), stream });
			await activeHarness.subject.pushInput("真实发送");
			await activeHarness.subject.waitForIdle();
			const observation = activeHarness.subject.getRequestObservation();
			expect(observation).toBeDefined();
			expect(observation!.requestId).toEqual(requests[0]!.requestId);
			expect(observation!.requestId).not.toMatch(/^preview-/);
			expect(observation!.assembly.sources.some((s) => s.status === "included" && s.id === "state")).toBe(true);
		} finally {
			await runner.dispose();
		}
	});

	it("Context Source 不唤醒主体也不产生 Journal 消息；读失败在下一次请求如实可见", async () => {
		const runner = new ExtensionRunner({ cwd: process.cwd(), tools: new ToolBroker({ ownerId: "root" }) });
		try {
			let fail = false;
			await runner.activateBuiltin("flaky", (pi) => {
				pi.provideContext({
					id: "sensor",
					kind: "observation",
					read: () => {
						if (fail) throw new Error("传感器离线");
						return { text: "一切正常", source: { type: "flaky.sensor", origin: "external" } };
					},
				});
			});
			const harness = SubjectHarness.create({
				runtimeHooks: runner.runtimeHooks(),
				store: new MemorySessionStore(),
			});
			const idleBaseline = harness.store!.readRecords().length;

			// 读取（含失败的读取）都不入队、不落史、不唤醒
			const before = await harness.subject.inspectRequest();
			fail = true;
			const duringFailure = await harness.subject.inspectRequest();
			fail = false;
			expect(before.assembly?.sources.every((s) => s.status !== "error")).toBe(true);
			const failedEntry = duringFailure.assembly?.sources.find((s) => s.id === "sensor");
			expect(failedEntry?.status).toBe("error");
			expect(failedEntry?.reason).toContain("传感器离线");
			expect(harness.subject.isBusy()).toBe(false);
			expect(harness.subject.queuedSnapshot()).toHaveLength(0);
			expect(harness.store!.readRecords().length).toBe(idleBaseline);
		} finally {
			await runner.dispose();
		}
	});
});
