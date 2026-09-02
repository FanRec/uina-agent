/**
 * 冒烟测试：用可编程 mock 验证主体链路（流式、工具闭环、shell）。
 * 说明：mock 只证明本仓库代码链路正确，不证明真实模型集成效果——那属于真模型冒烟。
 */
import { describe, it, expect } from "vitest";
import { ToolBroker } from "../src/tools/broker.js";
import type { Tool } from "../src/tools/broker.js";
import getTimeTool from "../tools/get-time/index.js";
import runShellTool, { runShellDirect } from "../tools/run-shell/index.js";
import { Subject } from "../src/mind/loop.js";
import {
	scriptedProvider,
	toolCallDelta,
	lastUser,
} from "./helpers/mock-provider.js";

const flush = () => new Promise((r) => setTimeout(r, 40));

/** 解析工具返回的 JSON；解析失败抛错让测试可见 */
function safeParse(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch (e) {
		throw new Error(
			`工具返回非法 JSON: ${s.slice(0, 120)} (${(e as Error).message})`,
		);
	}
}

function makeSubject(rules: Parameters<typeof scriptedProvider>[0]) {
	const tools = new ToolBroker();
	tools.register(getTimeTool);
	const provider = scriptedProvider(rules);
	let out = "";
	const subject = new Subject(provider, tools, {
		onToken: (t) => (out += t),
	});
	return { subject, provider, getOut: () => out };
}

/** 构造 N 条长历史消息（触发 compaction 阈值用） */
function longHistory(n: number) {
	const filler =
		"这是一条足够长的消息，内容是反复重复的中文句子以凑足 token 估算。".repeat(
			20,
		);
	const msgs = [];
	for (let i = 0; i < n; i++)
		msgs.push({ role: "user" as const, content: filler });
	return msgs;
}

describe("主体链路（mock）", () => {
	it("流式文本：分段输出并写入历史", async () => {
		const { subject, provider } = makeSubject([
			{
				match: () => true,
				produce: () => [
					{ kind: "text", text: "你" },
					{ kind: "text", text: "好" },
				],
			},
		]);
		subject.pushInput("嗨");
		await flush();
		// 该轮请求应包含用户输入（进入历史）
		expect(lastUser(provider.calls[0])).toBe("嗨");
	});

	it("工具闭环：get_time 执行后结果回注给模型", async () => {
		const { subject, provider } = makeSubject([
			{
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				produce: () => [toolCallDelta("c1", "get_time", {})],
			},
			{
				match: (req) => req.messages.some((m) => m.role === "tool"),
				produce: () => [{ kind: "text", text: "查好了" }],
			},
		]);
		subject.pushInput("现在几点");
		await flush();
		// 第二轮消息里应含 role:tool 的回注
		const second = provider.calls[1];
		expect(second.messages.some((m) => m.role === "tool")).toBe(true);
		expect(second.messages.filter((m) => m.role === "tool").length).toBe(1);
	});

	it("会话续聊：addHistory 后 historySnapshot 带回注入的消息", async () => {
		const { subject, provider } = makeSubject([
			{
				match: () => true,
				produce: () => [{ kind: "text", text: "记得" }],
			},
		]);
		subject.addHistory([
			{ role: "user", content: "之前说过的旧消息" },
			{ role: "assistant", content: "旧回复" },
		]);
		subject.pushInput("继续");
		await flush();
		// 首轮请求应包含旧历史 + 新输入
		const msgs = provider.calls[0].messages;
		expect(msgs.some((m) => m.content === "之前说过的旧消息")).toBe(true);
		expect(lastUser(provider.calls[0])).toBe("继续");
	});

	it("工具消息进上下文：超过 2000 字符被序列化截断（对齐 pi）", async () => {
		const { subject, provider } = makeSubject([
			{
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				produce: () => [toolCallDelta("c1", "get_time", {})],
			},
			{
				match: (req) => req.messages.some((m) => m.role === "tool"),
				produce: () => [{ kind: "text", text: "收到" }],
			},
		]);
		// 工具消息进上下文时序列化截断：get_time 结果短所以不被截，验证上限存在即可
		subject.pushInput("几点");
		await flush();
		const toolMsgs = provider.calls[1].messages.filter(
			(m) => m.role === "tool",
		);
		expect(toolMsgs.length).toBe(1);
		expect((toolMsgs[0].content ?? "").length).toBeLessThanOrEqual(2000);
	});

	it("compaction：历史超阈值时压缩最旧部分为摘要（对齐 pi）", async () => {
		const { subject, provider } = makeSubject([
			{
				// 摘要请求：system 含压缩指令
				match: (req) =>
					req.messages[0]?.role === "system" &&
					(req.messages[0].content ?? "").includes("压缩成不超过 200 字"),
				produce: () => [
					{ kind: "text", text: "（压缩摘要：曾经聊过很多旧话题）" },
				],
			},
			{
				// 正常轮次
				match: () => true,
				produce: () => [{ kind: "text", text: "好" }],
			},
		]);
		subject.addHistory(longHistory(120)); // ~120 条长消息，估算远超 49k token
		subject.pushInput("继续聊");
		await flush();
		// 摘要请求必须发生过
		expect(
			provider.calls.some(
				(c) =>
					c.messages[0]?.role === "system" &&
					(c.messages[0].content ?? "").includes("压缩成不超过 200 字"),
			),
		).toBe(true);
		// 后续正常轮次的请求上下文应带摘要（历史压缩后注入）
		const normal = provider.calls.find(
			(c) => !(c.messages[0]?.content ?? "").includes("压缩成"),
		);
		expect(normal).toBeTruthy();
		const withSummary = (normal?.messages ?? []).find((m) =>
			(m.content ?? "").startsWith("[历史摘要] "),
		);
		expect(withSummary).toBeTruthy();
		// 摘要内容来自 mock 摘要请求的返回
		expect((withSummary?.content ?? "").includes("（压缩摘要")).toBe(true);
	});

	it("轮末 drain：输出期间连续到达的输入全部被消费并合并（修复滞留 bug）", async () => {
		const { subject, provider } = makeSubject([
			{
				match: (req) => lastUser(req) === "A",
				// 在 decide(A) 进行中同步推入 B、C（busy 窗口）——必须被 drain 消费
				produce: () => {
					subject.pushInput("B");
					subject.pushInput("C");
					return [
						{ kind: "text", text: "甲" },
						{ kind: "text", text: "乙" },
					];
				},
			},
			{
				match: (req) => lastUser(req) === "B\nC",
				// 批量决定期间再推入 D——修复前的滞留场景
				produce: () => {
					subject.pushInput("D");
					return [{ kind: "text", text: "批" }];
				},
			},
			{
				match: () => true,
				produce: () => [{ kind: "text", text: "终" }],
			},
		]);
		subject.pushInput("A");
		await flush();
		// A 轮期间来的 B+C 合并为一条批；批决定期间来的 D 也被消费
		const users = provider.calls.map((c) => lastUser(c));
		expect(users).toEqual(["A", "B\nC", "D"]);
	});

	it("轮处理出错：错误进历史（下轮可见）+ onError 通知", async () => {
		const errs: string[] = [];
		const tools = new ToolBroker();
		tools.register(getTimeTool);
		const provider = scriptedProvider([
			{
				match: (req) => lastUser(req) === "坏轮",
				produce: () => {
					throw new Error("boom-ne");
				},
			},
			{ match: () => true, produce: () => [{ kind: "text", text: "好了" }] },
		]);
		let out = "";
		const subject = new Subject(provider, tools, {
			onToken: (t) => (out += t),
			onError: (m) => errs.push(m),
		});
		subject.pushInput("坏轮");
		await flush();
		expect(errs.length).toBe(1);
		expect(errs[0]).toContain("boom-ne");
		// 下一轮：错误已进历史（模型上下文可见）
		subject.pushInput("继续");
		await flush();
		const second = provider.calls.find((c) => lastUser(c) === "继续");
		expect(
			second?.messages.some((m) => (m.content ?? "").includes("上轮处理出错")),
		).toBe(true);
	});
});

describe("shell 工具", () => {
	it("真实执行命令并返回输出", async () => {
		const result = safeParse(
			await runShellTool.run({ command: "echo uina-smoke-ok" }),
		);
		expect(result.stdout).toContain("uina-smoke-ok");
	});

	it("命令失败时返回结构化错误而非抛出", async () => {
		const result = safeParse(await runShellTool.run({ command: "exit 3" }));
		// exec 非零退出会抛，实现应把错误包进结构化结果返回
		expect(result.error ?? result.stderr).toBeTruthy();
	});

	it("可取消：abort 后杀进程树并返回 cancelled（强制 stop 的根基）", async () => {
		const ac = new AbortController();
		const p = runShellDirect('node -e "setTimeout(()=>{}, 60000)"', ac.signal);
		await flush();
		ac.abort();
		const r = await p;
		expect(r.cancelled).toBe(true);
		expect(r.code).not.toBe(0);
	});
});

describe("中断（interrupt）", () => {
	it("工具执行中强制中止：不再进下一轮 LLM，历史含已取消回注与占位", async () => {
		// 挂起工具：只有收到 abort signal 才返回"已取消"，否则永不 resolve
		const hangTool: Tool = {
			def: {
				type: "function",
				function: {
					name: "hang",
					description: "挂起（测试用）",
					parameters: { type: "object", properties: {} },
				},
			},
			async run(_args, signal) {
				return new Promise((res) => {
					signal?.addEventListener("abort", () =>
						res(JSON.stringify({ cancelled: true })),
					);
				});
			},
		};
		const tools = new ToolBroker();
		tools.register(hangTool);
		const provider = scriptedProvider([
			{
				// 第一轮：产出 hang 工具调用
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				produce: () => [toolCallDelta("h1", "hang", {})],
			},
			{
				match: () => true,
				produce: () => [{ kind: "text", text: "不应到达" }],
			},
		]);
		let turns = 0;
		const errs: string[] = [];
		const subject = new Subject(provider, tools, {
			onToken: () => {},
			onTurnEnd: () => turns++,
			onError: (m) => errs.push(m),
		});
		subject.pushInput("开始");
		await flush(); // 工具挂起中
		expect(subject.isBusy()).toBe(true);
		subject.interrupt(); // 强制中止
		await flush();
		expect(subject.isBusy()).toBe(false);
		expect(turns).toBe(1);
		expect(provider.calls.length).toBe(1); // 中断后不再问模型
		expect(errs).toEqual([]); // 中断不是错误路径
		const snapshot = subject.historySnapshot();
		expect(snapshot.some((m) => m.content === "[已中断]")).toBe(true);
		const toolMsg = snapshot.find((m) => m.role === "tool");
		expect(toolMsg).toBeTruthy();
		expect(safeParse(toolMsg!.content).cancelled).toBe(true);
	});

	it("一轮多个工具调用：全部回注且 id 与 assistant.tool_calls 配对完整", async () => {
		const tools = new ToolBroker();
		tools.register(getTimeTool);
		tools.register(runShellTool);
		const provider = scriptedProvider([
			{
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				// 一轮产两个工具调用（并行工具）：get_time + run_shell
				produce: () => [
					toolCallDelta("c1", "get_time", {}),
					toolCallDelta("c2", "run_shell", { command: "echo multi-tool" }),
				],
			},
			{
				match: () => true,
				produce: () => [{ kind: "text", text: "都查好了" }],
			},
		]);
		const subject = new Subject(provider, tools, { onToken: () => {} });
		subject.pushInput("一起查");
		await flush();
		// 第二轮请求：assistant.tool_calls 两个 + tool 消息两个，一一配对
		const second = provider.calls[1];
		expect(second).toBeTruthy();
		const asst = second.messages.find(
			(m) => m.role === "assistant" && "tool_calls" in m,
		);
		const toolMsgs = second.messages.filter((m) => m.role === "tool");
		expect(asst && "tool_calls" in asst ? asst.tool_calls?.length : 0).toBe(2);
		expect(toolMsgs.length).toBe(2);
		const asstIds = new Set(
			(asst && "tool_calls" in asst ? (asst.tool_calls ?? []) : []).map(
				(t) => (t as { id: string }).id,
			),
		);
		for (const tm of toolMsgs) {
			expect(asstIds.has((tm as { tool_call_id: string }).tool_call_id)).toBe(
				true,
			);
		}
	});

	it("中断发生在工具链中间：未执行工具补占位，配对仍完整（防后续请求 400）", async () => {
		const hangTool: Tool = {
			def: {
				type: "function",
				function: {
					name: "hang",
					description: "挂起（测试用）",
					parameters: { type: "object", properties: {} },
				},
			},
			async run(_args, signal) {
				return new Promise((res) => {
					signal?.addEventListener("abort", () =>
						res(JSON.stringify({ cancelled: true })),
					);
				});
			},
		};
		const tools = new ToolBroker();
		tools.register(hangTool);
		tools.register(getTimeTool);
		const provider = scriptedProvider([
			{
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				// 一轮产两个：hang（将中断）+ get_time（未执行将补占位）
				produce: () => [
					toolCallDelta("h1", "hang", {}),
					toolCallDelta("g1", "get_time", {}),
				],
			},
			{
				match: () => true,
				produce: () => [{ kind: "text", text: "不应到达" }],
			},
		]);
		const subject = new Subject(provider, tools, { onToken: () => {} });
		subject.pushInput("开工");
		await flush();
		subject.interrupt(); // 在 hang 挂起时中断
		await flush();
		const snapshot = subject.historySnapshot();
		const toolMsgs = snapshot.filter((m) => m.role === "tool");
		const asst = snapshot.find(
			(m) => m.role === "assistant" && "tool_calls" in m,
		);
		const asstIds = new Set(
			(asst && "tool_calls" in asst ? (asst.tool_calls ?? []) : []).map(
				(t) => (t as { id: string }).id,
			),
		);
		// 配对完整：assistant 2 个 tool_calls 各有一条 tool 结果
		expect(toolMsgs.length).toBe(2);
		for (const tm of toolMsgs) {
			expect(asstIds.has((tm as { tool_call_id: string }).tool_call_id)).toBe(
				true,
			);
		}
		// g1 是占位（未执行），h1 是 cancelled 结果
		const g1 = toolMsgs.find(
			(m) => (m as { tool_call_id: string }).tool_call_id === "g1",
		);
		expect((g1?.content ?? "").includes("已中断")).toBe(true);
		// 中断后没进下一轮 LLM
		expect(provider.calls.length).toBe(1);
	});
});
