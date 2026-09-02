/**
 * 冒烟测试：用可编程 mock 验证主体链路（流式、工具闭环、shell、记忆跨会话）。
 * 说明：mock 只证明本仓库代码链路正确，不证明真实模型集成效果——那属于真模型冒烟。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/core/bus.js";
import { RuntimeStore } from "../src/core/store.js";
import { createFileMemory } from "../src/memory/port.js";
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
	const bus = new Bus();
	const store = new RuntimeStore();
	const memory = createFileMemory(mkdtempSync(join(tmpdir(), "uina-test-")));
	memory.load();
	const tools = new ToolBroker();
	tools.register(getTimeTool());
	const provider = scriptedProvider(rules);
	let out = "";
	const subject = new Subject(bus, store, provider, memory, tools, {
		onToken: (t) => (out += t),
	});
	return { bus, subject, provider, memory, getOut: () => out };
}

describe("主体链路（mock）", () => {
	it("流式文本：分段输出并写入历史", async () => {
		const { bus, provider } = makeSubject([
			{
				match: () => true,
				produce: () => [
					{ kind: "text", text: "你" },
					{ kind: "text", text: "好" },
				],
			},
		]);
		bus.emit({ type: "user_input", text: "嗨", from: "test" });
		await flush();
		// 该轮请求应包含用户输入（进入历史）
		expect(lastUser(provider.calls[0])).toBe("嗨");
	});

	it("工具闭环：get_time 执行后结果回注给模型", async () => {
		const { bus, provider } = makeSubject([
			{
				match: (req) => !req.messages.some((m) => m.role === "tool"),
				produce: () => [toolCallDelta("c1", "get_time", {})],
			},
			{
				match: (req) => req.messages.some((m) => m.role === "tool"),
				produce: () => [{ kind: "text", text: "查好了" }],
			},
		]);
		bus.emit({ type: "user_input", text: "现在几点", from: "test" });
		await flush();
		// 第二轮消息里应含 role:tool 的回注
		const second = provider.calls[1];
		expect(second.messages.some((m) => m.role === "tool")).toBe(true);
		expect(second.messages.filter((m) => m.role === "tool").length).toBe(1);
	});
});

describe("shell 工具", () => {
	it("真实执行命令并返回输出", async () => {
		const tool = shellTool({ baseDir: process.cwd(), maxOutput: 500 });
		const result = safeParse(
			await tool.run(
				{ command: "echo uina-smoke-ok" },
				{ onJobDone: () => {} },
			),
		);
		expect(result.stdout).toContain("uina-smoke-ok");
	});

	it("命令失败时返回结构化错误而非抛出", async () => {
		const tool = shellTool({ baseDir: process.cwd() });
		const result = safeParse(
			await tool.run({ command: "exit 3" }, { onJobDone: () => {} }),
		);
		// exec 非零退出会抛，实现应把错误包进结构化结果返回
		expect(result.error ?? result.stderr).toBeTruthy();
	});
});

describe("记忆跨会话（重启仍在）", () => {
	it("remember 写入后重建实例仍能 recall", () => {
		const dir = mkdtempSync(join(tmpdir(), "uina-mem-"));
		const m1 = createFileMemory(dir);
		m1.load();
		m1.remember("用户叫张三", "fact");

		// 模拟重启：新的实例，同一目录
		const m2 = createFileMemory(dir);
		m2.load();
		const hits = m2.recall("张三", 5);
		expect(hits.length).toBe(1);
		expect(hits[0].text).toContain("张三");
	});

	it("archive 后不再被 recall", () => {
		const dir = mkdtempSync(join(tmpdir(), "uina-mem-"));
		const m = createFileMemory(dir);
		m.load();
		const item = m.remember("旧习惯：喝咖啡", "fact");
		expect(m.recall("咖啡", 5).length).toBe(1);
		m.archive(item.id);
		expect(m.recall("咖啡", 5).length).toBe(0);
	});
});
