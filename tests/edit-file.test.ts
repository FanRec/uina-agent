import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRunner, type ExtensionAPI } from "../src/extensions/runner.js";
import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import { ToolBroker } from "../src/tools/broker.js";
import { IsolatedEnv } from "./harness/index.js";

const runners: ExtensionRunner[] = [];
const envs: IsolatedEnv[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(envs.splice(0).map((env) => env.cleanup()));
});

async function setup(): Promise<{ api: ExtensionAPI; dir: string }> {
	const env = await IsolatedEnv.create({ prefix: "uina-edit-" });
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

describe("edit_file", () => {
	it("replaces a unique occurrence and preserves the rest of the file", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "a.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [{ oldText: "beta", newText: "BETA" }],
		});
		expect(result.status).toBe("succeeded");
		expect(await readFile(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
	});

	it("applies multiple disjoint edits against the original content in one call", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "multi.txt");
		await writeFile(file, "one\ntwo\nthree\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [
				{ oldText: "three", newText: "3" },
				{ oldText: "one", newText: "1" },
			],
		});
		expect(result.status).toBe("succeeded");
		expect(await readFile(file, "utf8")).toBe("1\ntwo\n3\n");
	});

	it("matches LF oldText inside a CRLF file and preserves CRLF line endings", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "crlf.txt");
		await writeFile(file, "first\r\nsecond\r\nthird\r\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [{ oldText: "second\nthird", newText: "second!\nthird!" }],
		});
		expect(result.status).toBe("succeeded");
		expect(await readFile(file, "utf8")).toBe("first\r\nsecond!\r\nthird!\r\n");
	});

	it("preserves a BOM prefix it stripped before matching", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "bom.txt");
		await writeFile(file, "\uFEFFhello world\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [{ oldText: "hello", newText: "hi" }],
		});
		expect(result.status).toBe("succeeded");
		expect(await readFile(file, "utf8")).toBe("\uFEFFhi world\n");
	});

	it("rejects when oldText matches multiple locations", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "dup.txt");
		await writeFile(file, "x\nx\n", "utf8");
		const dup = await api.callTool("edit_file", { path: file, edits: [{ oldText: "x", newText: "y" }] });
		expect(dup.status).toBe("failed");
		expect(String(dup.result)).toContain("出现 2 次，必须唯一");
		expect(await readFile(file, "utf8")).toBe("x\nx\n");
	});

	it("rejects when oldText does not exist", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "missing.txt");
		await writeFile(file, "content\n", "utf8");
		const missing = await api.callTool("edit_file", { path: file, edits: [{ oldText: "nope", newText: "y" }] });
		expect(missing.status).toBe("failed");
		expect(String(missing.result)).toContain("不存在");
	});

	it("rejects overlapping edits instead of silently corrupting the file", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "overlap.txt");
		await writeFile(file, "abcdef\n", "utf8");
		const overlap = await api.callTool("edit_file", {
			path: file,
			edits: [
				{ oldText: "abc", newText: "x" },
				{ oldText: "bcd", newText: "y" },
			],
		});
		expect(overlap.status).toBe("failed");
		expect(String(overlap.result)).toContain("重叠");
		expect(await readFile(file, "utf8")).toBe("abcdef\n");
	});

	it("returns a line-numbered diff summary so callers can confirm without re-reading", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "diff.txt");
		await writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [{ oldText: "l5", newText: "L5\nL5b" }],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("-  5 l5");
		expect(text).toContain("+  5 L5");
		expect(text).toContain("+  6 L5b");
		expect(text).toContain("   4 l4"); // 上文
		expect(text).toContain("   7 l7"); // 下文
		expect(text).not.toContain("l9"); // 远处折叠不出现
		expect(result.details).toMatchObject({ firstChangedLine: 5 });
	});

	it("shifts line numbers across multiple hunks in one call", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "multi-hunk.txt");
		await writeFile(file, "a\nb\nc\nd\ne\nf\n", "utf8");
		const result = await api.callTool("edit_file", {
			path: file,
			edits: [
				{ oldText: "a", newText: "A1\nA2" },
				{ oldText: "e", newText: "E1\nE2\nE3" },
			],
		});
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("+ 1 A1");
		expect(text).toContain("+ 2 A2");
		// 第二个 hunk 的新文件行号要计入前一 hunk 净增 1 行
		expect(text).toContain("+ 6 E1");
		expect(text).toContain("- 5 e");
		expect(result.details).toMatchObject({ firstChangedLine: 1 });
	});

	it("rejects when oldText appears multiple times overlapping", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "overlap-dup.txt");
		await writeFile(file, "aaaa\n", "utf8");
		const res = await api.callTool("edit_file", { path: file, edits: [{ oldText: "aaa", newText: "b" }] });
		expect(res.status).toBe("failed");
		expect(String(res.result)).toContain("出现 2 次，必须唯一");
	});

	it("rejects an empty edits array", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "empty.txt");
		await writeFile(file, "content\n", "utf8");
		// 空数组在参数校验层（Ajv minItems）即被拒绝，请求未启动。
		const empty = await api.callTool("edit_file", { path: file, edits: [] });
		expect(empty.status).toBe("not_started");
	});
});

describe("write_file", () => {
	it("automatically creates non-existent parent directories recursively", async () => {
		const { api, dir } = await setup();
		const file = join(dir, "sub", "deep", "nested.txt");
		const res = await api.callTool("write_file", { path: file, text: "hello nested" });
		expect(res.status).toBe("succeeded");
		expect(await readFile(file, "utf8")).toBe("hello nested");
	});
});

