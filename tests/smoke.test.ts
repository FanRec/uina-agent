/**
 * 冒烟测试：用可编程 mock 验证主体链路（流式、工具闭环、shell）。
 * 说明：mock 只证明本仓库代码链路正确，不证明真实模型集成效果——那属于真模型冒烟。
 */
import { describe, it, expect } from "vitest";
import { ToolBroker } from "../src/tools/broker.js";
import { getTimeTool } from "../src/tools/builtin.js";
import { shellTool } from "../src/tools/shell.js";
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
	tools.register(getTimeTool());
	const provider = scriptedProvider(rules);
	let out = "";
	const subject = new Subject(provider, tools, {
		onToken: (t) => (out += t),
	});
	return { subject, provider, getOut: () => out };
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
});

describe("shell 工具", () => {
	it("真实执行命令并返回输出", async () => {
		const tool = shellTool({ cwd: process.cwd() });
		const result = safeParse(await tool.run({ command: "echo uina-smoke-ok" }));
		expect(result.stdout).toContain("uina-smoke-ok");
	});

	it("命令失败时返回结构化错误而非抛出", async () => {
		const tool = shellTool({ cwd: process.cwd() });
		const result = safeParse(await tool.run({ command: "exit 3" }));
		// exec 非零退出会抛，实现应把错误包进结构化结果返回
		expect(result.error ?? result.stderr).toBeTruthy();
	});
});
