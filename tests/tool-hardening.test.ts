import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ExtensionAPI, ExtensionRunner } from "../src/extensions/runner.js";
import execCommandTool, { DEFAULT_TIMEOUT_S } from "../src/extensions/runtime-tools/exec-command/index.js";
import { activateSessionTools } from "../src/extensions/session-tools/index.js";
import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import type { SessionAccess } from "../src/session/types.js";
import type { Tool } from "../src/tools/broker.js";
import { ToolBroker } from "../src/tools/broker.js";
import { IsolatedEnv } from "./harness/index.js";

const runners: ExtensionRunner[] = [];
const envs: IsolatedEnv[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

/** 与 search-tools.test.ts 相同的轻量装配：ExtensionRunner + workspace-tools + 隔离目录。 */
async function setup(): Promise<{ api: ExtensionAPI; dir: string }> {
	const env = await IsolatedEnv.create({ prefix: "uina-hardening-" });
	envs.push(env);
	const host = new ExtensionRunner({ cwd: env.path, tools: new ToolBroker({ ownerId: "root" }) });
	runners.push(host);
	const captured: ExtensionAPI[] = [];
	await host.activateBuiltin("workspace-tools", (value: ExtensionAPI) => {
		captured.push(value);
		activateWorkspaceTools(value);
	});
	return { api: captured[0], dir: env.path };
}

const q = String.fromCharCode(34);
const sleepCommand = `node -e ${q}setTimeout(()=>{},10000)${q}`;

describe("exec_command 状态映射与默认超时", () => {
	it("默认超时常量为 120 秒", () => {
		expect(DEFAULT_TIMEOUT_S).toBe(120);
	});

	it("超时返回 unknown 并附 reason 与已收集输出，不再是 failed", async () => {
		const result = await execCommandTool.run({ command: sleepCommand, timeout: 1 });
		expect(result.status).toBe("unknown");
		const body = JSON.parse(result.result) as Record<string, unknown>;
		expect(body.reason).toBe("timeout");
		expect(String(body.error)).toContain("命令超时");
		expect(String(body.error)).toContain("timeout 参数延长");
	});

	it("启动后取消返回 unknown，不再是 cancelled", async () => {
		const controller = new AbortController();
		const pending = execCommandTool.run({ command: sleepCommand }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 150));
		controller.abort();
		const result = await pending;
		expect(result.status).toBe("unknown");
		const body = JSON.parse(result.result) as Record<string, unknown>;
		expect(body.reason).toBe("cancelled");
	});

	it("成功调用的 body 不携带截断元数据；失败仍为 failed", async () => {
		const ok = await execCommandTool.run({ command: `node -e ${q}console.log('hardening-ok')${q}` });
		expect(ok.status).toBe("succeeded");
		const body = JSON.parse(ok.result) as Record<string, unknown>;
		expect(body.stdout).toContain("hardening-ok");
		expect(body.fullOutputPath).toBeUndefined();
		expect(body.truncated).toBeUndefined();
		expect(body.stdoutBytes).toBeUndefined();

		const fail = await execCommandTool.run({ command: `node -e ${q}process.exit(3)${q}` });
		expect(fail.status).toBe("failed");
		const failBody = JSON.parse(fail.result) as Record<string, unknown>;
		expect(String(failBody.error)).toContain("退出码 3");
	});
});

describe("read_file / write_file 守卫", () => {
	it("空文件返回（空文件）而不是报错，且计入已读", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "empty.txt"), "", "utf8");
		const read = await api.callTool("read_file", { path: "empty.txt" });
		expect(read.status).toBe("succeeded");
		expect(String(read.result)).toBe("（空文件）");
		// 已读：随后覆盖不需要再读
		const write = await api.callTool("write_file", { path: "empty.txt", text: "now has content" });
		expect(write.status).toBe("succeeded");
		expect(await readFile(join(dir, "empty.txt"), "utf8")).toBe("now has content");
	});

	it("未读过的已存在文件拒绝整体覆盖", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "exists.txt"), "original user content", "utf8");
		const denied = await api.callTool("write_file", { path: "exists.txt", text: "hallucinated rewrite" });
		expect(denied.status).toBe("failed");
		expect(String(denied.result)).toContain("先 read_file");
		expect(await readFile(join(dir, "exists.txt"), "utf8")).toBe("original user content");
	});

	it("读后覆盖放行；读后外部修改再覆盖拒绝", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "tracked.txt"), "v1", "utf8");
		await api.callTool("read_file", { path: "tracked.txt" });
		const allowed = await api.callTool("write_file", { path: "tracked.txt", text: "v2" });
		expect(allowed.status).toBe("succeeded");
		expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe("v2");

		// 模型写入后用户外部改动：mtime 变化，下次覆盖要求重读
		await writeFile(join(dir, "tracked.txt"), "user edit", "utf8");
		const stale = await api.callTool("write_file", { path: "tracked.txt", text: "v3" });
		expect(stale.status).toBe("failed");
		expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe("user edit");
	});

	it("新文件直接创建，不受守卫影响", async () => {
		const { api, dir } = await setup();
		const result = await api.callTool("write_file", { path: "fresh.txt", text: "new" });
		expect(result.status).toBe("succeeded");
		expect(await readFile(join(dir, "fresh.txt"), "utf8")).toBe("new");
	});
});

describe("find_file 上限偷看语义", () => {
	it("恰好 limit 条不报上限；超出一条才报", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "a.txt"), "x", "utf8");
		await writeFile(join(dir, "b.txt"), "x", "utf8");

		const exact = await api.callTool("find_file", { pattern: "*.txt", limit: 2 });
		expect(exact.status).toBe("succeeded");
		expect(String(exact.result)).not.toContain("已达");
		expect(exact.details).toMatchObject({ limitHit: false, entries: 2 });

		await writeFile(join(dir, "c.txt"), "x", "utf8");
		const over = await api.callTool("find_file", { pattern: "*.txt", limit: 2 });
		expect(String(over.result)).toContain("已达 2 条上限（可能还有更多）");
		expect(over.details).toMatchObject({ limitHit: true, entries: 2 });
	});
});

describe("session_read 默认正文上限", () => {
	function activateWith(entry: unknown): Tool {
		const registered = new Map<string, Tool>();
		const api = {
			registerTool: (tool: Tool) => {
				registered.set(tool.def.function.name, tool);
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI;
		const access = {
			list: () => ({}),
			read: () => entry,
		} as unknown as SessionAccess;
		activateSessionTools(() => access)(api);
		const tool = registered.get("session_read");
		if (!tool) throw new Error("session_read 未注册");
		return tool;
	}

	it("省略 max_chars 时按默认上限截断并给出翻页参数", async () => {
		const tool = activateWith({
			kind: "message",
			message: { role: "user", content: "y".repeat(60_000) },
		});
		const result = await tool.run({ id: "node-1" });
		expect(result.status).toBe("succeeded");
		const body = JSON.parse(result.result) as {
			entry: { message: { content: string } };
			truncated: boolean;
			next: { max_chars: number };
		};
		expect(body.truncated).toBe(true);
		expect(body.entry.message.content).toHaveLength(50_000);
		expect(body.next.max_chars).toBe(100_000);
	});

	it("正文低于上限时原样返回", async () => {
		const tool = activateWith({ kind: "message", message: { role: "user", content: "short" } });
		const result = await tool.run({ id: "node-1" });
		const body = JSON.parse(result.result) as { message: { content: string }; truncated?: boolean };
		expect(body.message.content).toBe("short");
		expect(body.truncated).toBeUndefined();
	});
});
