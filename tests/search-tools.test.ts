import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRunner, type ExtensionAPI } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import { createJsonLineParser, globToRegExp, GitignoreMatcher } from "../src/extensions/workspace-tools/search-core.js";
import { formatGrepOutput, runGrep } from "../src/extensions/workspace-tools/search-core.js";

const runners: ExtensionRunner[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(): Promise<{ api: ExtensionAPI; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "uina-search-"));
	directories.push(dir);
	const host = new ExtensionRunner({ cwd: dir, tools: new ToolBroker({ ownerId: "root" }) });
	runners.push(host);
	const captured: ExtensionAPI[] = [];
	await host.activateBuiltin("workspace-tools", (value: ExtensionAPI) => {
		captured.push(value);
		activateWorkspaceTools(value);
	});
	return { api: captured[0], dir };
}

async function seedProject(dir: string): Promise<void> {
	await writeFile(join(dir, "app.ts"), "export const alpha = 1;\nexport const beta = 2;\nconst num = 42; // beta 7\n", "utf8");
	await writeFile(join(dir, "readme.md"), "# alpha docs\n", "utf8");
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "src", "util.ts"), "const alphaHidden = 3;\n", "utf8");
	await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(dir, "node_modules", "pkg", "index.js"), "alpha noise\n", "utf8");
	await writeFile(
		join(dir, ".gitignore"),
		"node_modules/\n*.log\n",
		"utf8",
	);
	await writeFile(join(dir, "debug.log"), "alpha in log\n", "utf8");
	// 模拟 .git 内部文件：文本可匹配，两引擎都不应搜索它
	await mkdir(join(dir, ".git"), { recursive: true });
	await writeFile(join(dir, ".git", "config"), "alpha inside git config\n", "utf8");
}

describe("grep_file 工具", () => {
	it("finds matches with path:line:text and skips gitignored files", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const result = await api.callTool("grep_file", { pattern: "alpha", literal: true });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("app.ts:1:");
		expect(text).toContain("src/util.ts:1:");
		expect(text).toContain("readme.md:1:");
		// node_modules 与 *.log 被 .gitignore 排除；.git 内部文件也不应出现
		expect(text).not.toContain("node_modules");
		expect(text).not.toContain("debug.log");
		expect(text).not.toContain(".git");
	});

	it("applies glob filter and literal mode", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const result = await api.callTool("grep_file", { pattern: "alpha", glob: "*.ts", literal: true });
		const text = String(result.result);
		expect(text).toContain("app.ts:1:");
		expect(text).toContain("src/util.ts:1:");
		expect(text).not.toContain("readme.md");
	});

	it("regex mode works and reports no matches cleanly", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const hit = await api.callTool("grep_file", { pattern: "beta \\d" });
		expect(String(hit.result)).toContain("app.ts:3:");
		const miss = await api.callTool("grep_file", { pattern: "不存在的内容xyz" });
		expect(miss.status).toBe("succeeded");
		expect(String(miss.result)).toBe("No matches found");
	});

	it("respects limit and signals paging", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const result = await api.callTool("grep_file", { pattern: "alpha", literal: true, limit: 1 });
		const text = String(result.result);
		expect(text).toContain("已达 1 条匹配上限");
		expect(result.details).toMatchObject({ limitHit: true });
	});
});

describe("find_file 工具", () => {
	it("finds files by name glob, ignoring gitignored dirs", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const result = await api.callTool("find_file", { pattern: "*.ts" });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("app.ts");
		expect(text).toContain(join("src", "util.ts").split("\\").join("/"));
		expect(text).not.toContain("node_modules");
	});

	it("supports ** cross-segment globs and reports no matches", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const hit = await api.callTool("find_file", { pattern: "src/**/*.ts" });
		const text = String(hit.result);
		expect(text).toContain("src/util.ts");
		expect(text).not.toContain("app.ts");
		const miss = await api.callTool("find_file", { pattern: "*.xyz" });
		expect(String(miss.result)).toBe("No matches found");
	});
});

describe("取消与共享 walker", () => {
	it("abort 的调用不启动（not_started）；grep/find 遍历尊重 signal", async () => {
		const { api, dir } = await setup();
		await seedProject(dir);
		const controller = new AbortController();
		controller.abort();
		// broker 契约：启动前已 abort -> not_started，工具体根本不执行
		const grep = await api.callTool("grep_file", { pattern: "alpha", literal: true }, { signal: controller.signal });
		expect(grep.status).toBe("not_started");
		const find = await api.callTool("find_file", { pattern: "*.ts" }, { signal: controller.signal });
		expect(find.status).toBe("not_started");
	});
});

describe("search-core 单元", () => {
	it("createJsonLineParser: 跨 chunk 劈开的 JSON 行不丢失", () => {
		const parser = createJsonLineParser();
		const line1 = JSON.stringify({ type: "match", n: 1 });
		const line2 = JSON.stringify({ type: "begin" });
		const half = Math.floor(line1.length / 2);
		// chunk1 = line1 前半（被劈开，无换行）；chunk2 = line1 后半 + 换行 + line2 完整行
		const first = parser.push(line1.slice(0, half));
		expect(first).toHaveLength(0);
		const rest = parser.push(line1.slice(half) + "\n" + line2 + "\n");
		expect(rest).toHaveLength(2);
		expect(rest[0]).toMatchObject({ type: "match", n: 1 });
		expect(rest[1]).toMatchObject({ type: "begin" });
		expect(parser.flush()).toHaveLength(0);
	});

	it("createJsonLineParser: 完整行立即产出，非法行跳过", () => {
		const parser = createJsonLineParser();
		const out = parser.push('"a"\nnot-json\n"b"\n');
		expect(out).toHaveLength(2);
		expect(parser.flush()).toHaveLength(0);
	});

	it("globToRegExp: * within segment, ** across segments, literal chars escaped", () => {
		expect(globToRegExp("*.ts").test("app.test.ts")).toBe(true);
		expect(globToRegExp("*.ts").test("src/app.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts").test("src/a/b/app.ts")).toBe(true);
		expect(globToRegExp("a+b.ts").test("a+b.ts")).toBe(true);
		expect(globToRegExp("a+b.ts").test("aab.ts")).toBe(false);
	});

	it("GitignoreMatcher: loaded patterns ignore matching paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-gi-"));
		directories.push(dir);
		await writeFile(join(dir, ".gitignore"), "node_modules/\n*.log\n", "utf8");
		const m = new GitignoreMatcher(dir);
		await m.addDir(dir);
		expect(m.ignored("node_modules/pkg/index.js", false)).toBe(true);
		expect(m.ignored("node_modules", true)).toBe(true);
		expect(m.ignored("debug.log", false)).toBe(true);
		expect(m.ignored("app.ts", false)).toBe(false);
	});

	it("formatGrepOutput truncates long lines and caps output bytes", () => {
		const longLine = "x".repeat(2000);
		const out = formatGrepOutput([{ file: "/root/a.txt", line: 1, text: longLine }], "/root", false, 100);
		expect(out).toContain("…[截断]");
		expect(out.length).toBeLessThan(longLine.length);

		const many = Array.from({ length: 300 }, (_, i) => ({ file: `/root/f${i}.txt`, line: 1, text: "y".repeat(500) }));
		const capped = formatGrepOutput(many, "/root", false, 100);
		expect(capped).toContain("50KB");
	});
});

describe("runGrep node 降级引擎", () => {
	it("falls back to node engine semantics via runGrep (engine reported)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-nodegrep-"));
		directories.push(dir);
		await seedProject(dir);
		// 无论本机是否有 rg，runGrep 都应返回一致的结果集；本机有 rg 时 engine=rg，否则 node
		const outcome = await runGrep({ pattern: "alpha", root: dir, literal: true });
		const files = outcome.matches.map((m) => m.file);
		expect(outcome.matches.length).toBeGreaterThanOrEqual(3);
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
		expect(files.some((f) => f.includes("debug.log"))).toBe(false);
		expect(["rg", "node"]).toContain(outcome.engine);
	});
});
