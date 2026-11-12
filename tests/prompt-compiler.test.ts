import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { compilePromptFile } from "../src/extensions/prompt-compiler.js";

/** 每个用例独立的临时资源根（Windows symlink 需要特权，创建失败时相关用例显式跳过并注明）。 */
const roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "uina-prompt-"));
	roots.push(root);
	return root;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("Prompt File Compiler（扩展 Prompt 文件机制）", () => {
	it("入口与嵌套 include 原地展开；entry/sources 为相对资源根的 posix 路径", async () => {
		const root = await makeRoot();
		await mkdir(join(root, "prompts"), { recursive: true });
		await writeFile(join(root, "PROMPT.md"), "# Speech\n\n{{include:prompts/expression.md}}\n\n尾声\n", "utf8");
		await writeFile(join(root, "prompts", "expression.md"), "表达规则\n\n{{include:tone.md}}\n", "utf8");
		await writeFile(join(root, "prompts", "tone.md"), "语气要轻。", "utf8");

		const compiled = await compilePromptFile("PROMPT.md", root);
		expect(compiled.text).toBe("# Speech\n\n表达规则\n\n语气要轻。\n\n尾声");
		expect(compiled.hash).toBe(sha256(compiled.text));
		expect(compiled.entry).toBe("PROMPT.md");
		expect(compiled.sources).toEqual(["PROMPT.md", "prompts/expression.md", "prompts/tone.md"]);
	});

	it("同一文件多处引用按位置重复展开；根内 ../ 合法；两次编译结果一致", async () => {
		const root = await makeRoot();
		await mkdir(join(root, "a"), { recursive: true });
		await writeFile(join(root, "shared.md"), "共享段\n", "utf8");
		// include 必须独立成行：两个引用各占一行，按位置重复展开、不跨位置去重
		await writeFile(join(root, "a", "entry.md"), "{{include:../shared.md}}\n{{include:../shared.md}}", "utf8");

		const first = await compilePromptFile("a/entry.md", root);
		const second = await compilePromptFile("a/entry.md", root);
		expect(first.text).toBe("共享段\n共享段");
		expect(first.sources).toEqual(["a/entry.md", "shared.md"]);
		expect(second.text).toBe(first.text);
		expect(second.hash).toBe(first.hash);
	});

	it("围栏内的同形文本是字面量；转义行去掉反斜杠；行内同形文本不展开", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "real.md"), "真实内容", "utf8");
		await writeFile(
			join(root, "PROMPT.md"),
			[
				"```md",
				"{{include:real.md}}",
				"~~~",
				"{{include:real.md}}",
				"~~~",
				"```",
				"\\{{include:real.md}}",
				"句子里的 {{include:real.md}} 不展开",
			].join("\n"),
			"utf8",
		);
		const compiled = await compilePromptFile("PROMPT.md", root);
		expect(compiled.text).toBe(
			[
				"```md",
				"{{include:real.md}}",
				"~~~",
				"{{include:real.md}}",
				"~~~",
				"```",
				"{{include:real.md}}",
				"句子里的 {{include:real.md}} 不展开",
			].join("\n"),
		);
		expect(compiled.sources).toEqual(["PROMPT.md"]);
	});

	it("闭合围栏不得带 info string：围栏内带标注的 ``` 行不终止围栏", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "real.md"), "真实内容", "utf8");
		await writeFile(
			join(root, "PROMPT.md"),
			[
				"```md",
				"{{include:real.md}}",
				"```text",
				"{{include:real.md}}",
				"```",
				"围栏结束后的独立指令应展开：",
				"{{include:real.md}}",
			].join("\n"),
			"utf8",
		);
		const compiled = await compilePromptFile("PROMPT.md", root);
		expect(compiled.text).toBe(
			[
				"```md",
				"{{include:real.md}}",
				"```text",
				"{{include:real.md}}",
				"```",
				"围栏结束后的独立指令应展开：",
				"真实内容",
			].join("\n"),
		);
	});

	it("CRLF 与 UTF-8 BOM 归一化；正文内部空行与缩进保留；结果首尾 trim", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "PROMPT.md"), "﻿第一行\r\n\r\n  缩进段  \r\n{{include:part.md}}\r\n尾行\r\n", "utf8");
		await writeFile(join(root, "part.md"), "CRLF 部分\r\n", "utf8");
		const compiled = await compilePromptFile("PROMPT.md", root);
		expect(compiled.text).toBe("第一行\n\n  缩进段  \nCRLF 部分\n尾行");
	});

	it("非 include 形式的 {{name}} 原样保留，不视为变量引用", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "PROMPT.md"), "{{name}} 与 {{include}} 都是普通文本", "utf8");
		const compiled = await compilePromptFile("PROMPT.md", root);
		expect(compiled.text).toBe("{{name}} 与 {{include}} 都是普通文本");
	});

	it("循环引用（自引用与互引用）准确报错，不产出半成品", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "self.md"), "前文\n{{include:self.md}}\n后文", "utf8");
		await writeFile(join(root, "a.md"), "{{include:b.md}}", "utf8");
		await writeFile(join(root, "b.md"), "{{include:a.md}}", "utf8");

		await expect(compilePromptFile("self.md", root)).rejects.toThrow(/循环引用: self\.md -> self\.md/);
		await expect(compilePromptFile("a.md", root)).rejects.toThrow(/循环引用: a\.md -> b\.md -> a\.md/);
	});

	it("错误报告触发文件、行号与引用链", async () => {
		const root = await makeRoot();
		await mkdir(join(root, "prompts"), { recursive: true });
		await writeFile(join(root, "PROMPT.md"), "第一段\n\n{{include:prompts/expression.md}}\n", "utf8");
		await writeFile(join(root, "prompts", "expression.md"), "规则 A\n\n{{include:missing.md}}\n", "utf8");
		const error = await compilePromptFile("PROMPT.md", root).then(
			() => undefined as Error | undefined,
			(e: Error) => e,
		);
		expect(error).toBeDefined();
		expect(error!.message).toContain("prompts/expression.md:3");
		expect(error!.message).toContain("引用的文件不存在: missing.md");
	});

	it("绝对路径、根外相对路径、非 .md、目录均拒绝", async () => {
		const outer = await makeRoot();
		const root = join(outer, "ext");
		await mkdir(root, { recursive: true });
		await writeFile(join(outer, "outside.md"), "外部", "utf8");
		await writeFile(join(root, "inside.md"), "内部", "utf8");
		await writeFile(join(root, "notes.txt"), "文本", "utf8");
		await mkdir(join(root, "folder.md"), { recursive: true });
		await writeFile(join(root, "PROMPT.md"), "{{include:missing.md}}", "utf8");

		// 入口合同是相对资源根的路径：绝对路径（无论是否在根内）明确拒绝
		await expect(compilePromptFile(join(outer, "outside.md"), root)).rejects.toThrow(/不支持绝对路径引用/);
		await expect(compilePromptFile(join(root, "inside.md"), root)).rejects.toThrow(/不支持绝对路径引用/);
		await expect(compilePromptFile("../outside.md", root)).rejects.toThrow(/越出扩展资源根/);
		await expect(compilePromptFile("notes.txt", root)).rejects.toThrow(/只支持 \.md 文件/);
		await expect(compilePromptFile("folder.md", root)).rejects.toThrow(/不是普通文件/);
		await expect(compilePromptFile("PROMPT.md", root)).rejects.toThrow(/引用的文件不存在/);
	});

	it("无效 UTF-8 编码拒绝", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "PROMPT.md"), Buffer.from([0xff, 0xfe, 0x68, 0x69]));
		await expect(compilePromptFile("PROMPT.md", root)).rejects.toThrow(/UTF-8/);
	});

	it("展开文本超过 64 KiB 上界立即拒绝", async () => {
		const root = await makeRoot();
		await writeFile(join(root, "PROMPT.md"), "x".repeat(64 * 1024 + 1), "utf8");
		await expect(compilePromptFile("PROMPT.md", root)).rejects.toThrow(/64 KiB|65536/);
	});

	it("资源根不存在时明确报错", async () => {
		const root = await makeRoot();
		await expect(compilePromptFile("PROMPT.md", join(root, "nope"))).rejects.toThrow(/资源根不存在/);
	});

	it("根内符号链接可用，指向根外的符号链接拒绝", async () => {
		const root = await makeRoot();
		const outside = await makeRoot();
		await writeFile(join(root, "real.md"), "根内实体", "utf8");
		await writeFile(join(outside, "secret.md"), "根外内容", "utf8");
		try {
			await symlink(join(root, "real.md"), join(root, "alias.md"));
			await symlink(join(outside, "secret.md"), join(root, "escape.md"));
		} catch {
			console.warn("当前环境无 symlink 特权，符号链接用例已跳过（路径越界用例仍覆盖）");
			return;
		}
		await writeFile(join(root, "inner.md"), "{{include:alias.md}}", "utf8");
		const compiled = await compilePromptFile("inner.md", root);
		expect(compiled.text).toBe("根内实体");
		// sources 记录"实际读取的文件"（真实路径），不是引用别名
		expect(compiled.sources).toEqual(["inner.md", "real.md"]);

		await writeFile(join(root, "bad.md"), "{{include:escape.md}}", "utf8");
		await expect(compilePromptFile("bad.md", root)).rejects.toThrow(/越出扩展资源根/);
	});
});
