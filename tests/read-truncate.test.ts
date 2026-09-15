import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRunner, type ExtensionAPI } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import activateWorkspaceTools from "../src/extensions/workspace-tools/index.js";
import { formatSize, READ_MAX_BYTES, READ_MAX_LINES, truncateReadLines } from "../src/extensions/workspace-tools/read-truncate.js";

const runners: ExtensionRunner[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.dispose();
	await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(): Promise<{ api: ExtensionAPI; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "uina-read-"));
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

describe("truncateReadLines 单元", () => {
	it("未超限时原样返回", () => {
		const r = truncateReadLines(["a", "b", "c"]);
		expect(r.truncated).toBe(false);
		expect(r.text).toBe("a\nb\nc");
		expect(r.truncatedBy).toBeNull();
	});

	it("行数超限：保留前 2000 行，提示命中行上限", () => {
		const lines = Array.from({ length: READ_MAX_LINES + 500 }, (_, i) => `line ${i + 1}`);
		const r = truncateReadLines(lines);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
		expect(r.outputLines).toBe(READ_MAX_LINES);
	});

	it("字节超限：保留完整行，从不返回半行", () => {
		// 每行约 100 字节，600 行 ≈ 60KB > 50KB；行数 600 < 2000。
		const lines = Array.from({ length: 600 }, (_, i) => "x".repeat(90) + ` ${i + 1}`);
		const r = truncateReadLines(lines);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(READ_MAX_BYTES);
		expect(r.outputLines).toBeLessThan(600);
		// 输出的每一行都必须是完整行
		const outLines = r.text.split("\n");
		expect(outLines.every((l, i) => l === lines[i])).toBe(true);
	});

	it("中文字节按 UTF-8 计，不按字符数计", () => {
		// 每行 100 字 x 3 字节 = 300B/行，170 行 ≈ 51KB 超限，但字符数只有 170*100=17000 < 2000 行限
		const lines = Array.from({ length: 200 }, () => "汉".repeat(100));
		expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeGreaterThan(READ_MAX_BYTES);
		const r = truncateReadLines(lines);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(READ_MAX_BYTES);
	});

	it("单行超字节上限：firstLineExceedsLimit，兜底截前 2000 字符", () => {
		const huge = "y".repeat(READ_MAX_BYTES + 1);
		const r = truncateReadLines([huge, "small"]);
		expect(r.truncated).toBe(true);
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.text.length).toBeLessThanOrEqual(READ_MAX_BYTES);
		expect(r.text.startsWith("yyy")).toBe(true);
	});

	it("空文件：不截断", () => {
		const r = truncateReadLines([""]);
		expect(r.truncated).toBe(false);
	});

	it("formatSize 三档", () => {
		expect(formatSize(512)).toBe("512B");
		expect(formatSize(2048)).toBe("2.0KB");
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});
});

describe("read_file 工具（真机套件）", () => {
	it("小文件原样读，details 带截断字段", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8");
		const result = await api.callTool("read_file", { path: "a.txt" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toBe("one\ntwo"); // 结尾换行不产生幽灵空行
		expect(result.details).toMatchObject({ lines: 2, totalLines: 2, truncated: false });
	});

	it("大文件自动截断并附续读 offset 提示", async () => {
		const { api, dir } = await setup();
		const lines = Array.from({ length: READ_MAX_LINES + 300 }, (_, i) => `row ${i + 1}`);
		await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n", "utf8");
		const result = await api.callTool("read_file", { path: "big.txt" });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text.split("\n").length).toBeLessThanOrEqual(READ_MAX_LINES + 3); // 提示占 3 行
		expect(text).toContain("已截断");
		expect(text).toContain(`offset=${READ_MAX_LINES + 1}`);
		expect(result.details).toMatchObject({ truncated: true, truncatedBy: "lines", totalLines: READ_MAX_LINES + 300 });
	});

	it("字节超限的宽文件按字节截断", async () => {
		const { api, dir } = await setup();
		const lines = Array.from({ length: 600 }, (_, i) => "x".repeat(90) + ` ${i + 1}`);
		await writeFile(join(dir, "wide.txt"), lines.join("\n"), "utf8");
		const result = await api.callTool("read_file", { path: "wide.txt" });
		expect(result.status).toBe("succeeded");
		const text = String(result.result);
		expect(text).toContain("已截断");
		expect(text).toContain("50.0KB 上限");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(READ_MAX_BYTES + 200); // + 提示行余量
	});

	it("offset/limit 分页续读，读完剩余段提示续读位置", async () => {
		const { api, dir } = await setup();
		const lines = Array.from({ length: 2500 }, (_, i) => `r${i + 1}`);
		await writeFile(join(dir, "p.txt"), lines.join("\n"), "utf8");
		const first = await api.callTool("read_file", { path: "p.txt" });
		expect(String(first.result)).toContain(`offset=${READ_MAX_LINES + 1}`);
		const second = await api.callTool("read_file", { path: "p.txt", offset: READ_MAX_LINES + 1, limit: 200 });
		expect(second.status).toBe("succeeded");
		expect(String(second.result)).toContain("r2001");
		// limit=200 只读到 2200 行，还有 300 行，应提示续读
		expect(String(second.result)).toContain("offset=2201");
	});

	it("单行超限给出 exec_command 兜底提示", async () => {
		const { api, dir } = await setup();
		// 首行 50KB+10，总体量必然超限；第二行确保 lines>1
		await writeFile(join(dir, "oneline.txt"), "z".repeat(READ_MAX_BYTES + 10) + "\n tail", "utf8");
		const result = await api.callTool("read_file", { path: "oneline.txt" });
		expect(result.status).toBe("succeeded");
		expect(String(result.result)).toContain("exec_command");
		expect(result.details).toMatchObject({ truncated: true, truncatedBy: "bytes", firstLineExceedsLimit: true });
	});

	it("二进制文件拒绝读为文本", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3, 4, 0, 5]));
		const result = await api.callTool("read_file", { path: "blob.bin" });
		expect(result.status).toBe("failed");
		expect(String(result.result)).toContain("二进制");
	});

	it("offset 超出文件末尾报错", async () => {
		const { api, dir } = await setup();
		await writeFile(join(dir, "s.txt"), "a\n", "utf8");
		const result = await api.callTool("read_file", { path: "s.txt", offset: 99 });
		expect(result.status).toBe("failed");
		expect(String(result.result)).toContain("超出文件末尾");
	});
});
