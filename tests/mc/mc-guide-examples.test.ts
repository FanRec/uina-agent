/**
 * 教学资料的真实性：Guide 里的每段 JS 示例、参考 Program 与 ENV 都必须能被
 * 真实 Program validator 编译，且不得夹带过时的 API 文案。
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { parseProgramSource } from "../../.uina/worlds/minecraft/library/program-source.js";
import { createProgramValidator } from "../../.uina/worlds/minecraft/program/validator.js";

const guidesDir = fileURLToPath(new URL("../../.uina/worlds/minecraft/companion/guides/", import.meta.url));
const examplesDir = fileURLToPath(new URL("../../.uina/worlds/minecraft/examples/", import.meta.url));
const envPath = fileURLToPath(new URL("../../.uina/worlds/minecraft/worlddef/ENV_PROMPT.md", import.meta.url));

const validator = createProgramValidator();
afterAll(async () => {
	await validator.close();
});

function jsBlocks(markdown: string): string[] {
	return [...markdown.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

test("七份官方 Guide 与 ENV 常驻正文都在有界成本内、无过时合同", async () => {
	const files = (await readdir(guidesDir)).filter((name) => name.endsWith(".md"));
	expect(files).toHaveLength(7);
	for (const file of files) {
		const text = await readFile(guidesDir + file, "utf8");
		expect(text.length, file).toBeGreaterThan(200);
		// 常见误读：把 mc.call 的返回值当成 {value:...} 包装。
		expect(text, file).not.toMatch(/mc\.call\([^)]*\)\s*\.value/);
	}
	const env = await readFile(envPath, "utf8");
	expect(env).toContain("Minecraft");
	expect(env).toContain("受理只表示已接单");
	expect(env).toContain("完成时会收到通知");
	expect(env).toContain("describe");
	// 常驻文本只讲环境认知与实践原则，不写 API 参数、当前状态或旧等待机制。
	expect(env).not.toContain("runs.wait");
	expect(env).not.toContain("shortWindow");
	expect(env).not.toContain("placeToReach");
	expect(env).not.toContain("mc.call(");
	expect(Buffer.byteLength(env, "utf8")).toBeLessThan(2400);
});

test("Guide 中的每段 JS 示例与参考 Program 都能被真实 validator 编译", async () => {
	const sources: { name: string; code: string }[] = [];
	for (const file of (await readdir(guidesDir)).filter((name) => name.endsWith(".md"))) {
		const text = await readFile(guidesDir + file, "utf8");
		for (const [index, block] of jsBlocks(text).entries()) sources.push({ name: `${file}#${index}`, code: block });
	}
	for (const file of (await readdir(examplesDir)).filter((name) => name.endsWith(".js")))
		sources.push({ name: file, code: await readFile(examplesDir + file, "utf8") });
	expect(sources.length).toBeGreaterThanOrEqual(7);
	for (const { name, code } of sources) {
		// Program 必须是完整 main(mc, input)，不能是半截片段让模型自己补。
		expect(code, name).toMatch(/\basync function main\s*\(/);
		const program = parseProgramSource(code, null);
		const result = await validator.validate(program);
		expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
	}
});
