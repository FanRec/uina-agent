// CRAP C4：world-loader 入口发现与 WorldDef 提取覆盖。
// resolveDirectoryEntry 是模块私有函数，经公共面 discoverExternalWorldEntries
// 用临时目录夹具覆盖其全部分支（package.json main/uina.entry/坏 JSON/index 回退/无入口）。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverExternalWorldEntries, extractWorldDef } from "../src/extensions/world-framework/world-loader.js";

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 每个用例一个临时扫描根；worldDir 在其下建子目录。 */
async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "uina-world-c4-"));
	tempRoots.push(root);
	return root;
}

async function makeWorldDir(root: string, name: string, files: Record<string, string>): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		await writeFile(join(dir, file), content, "utf8");
	}
	return dir;
}

const MINIMAL_DEF = `export default { name: "w", description: "d", actions: {} };`;

describe("discoverExternalWorldEntries：目录入口解析（resolveDirectoryEntry 分支）", () => {
	it("package.json 的 uina.entry 优先于 main，且必须存在并是源码文件", async () => {
		const root = await makeRoot();
		await makeWorldDir(root, "w-entry", {
			"package.json": JSON.stringify({ main: "missing.js", uina: { entry: "custom.ts" } }),
			"custom.ts": MINIMAL_DEF,
			"index.ts": MINIMAL_DEF,
		});
		const entries = await discoverExternalWorldEntries([root]);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.endsWith("custom.ts")).toBe(true);
	});

	it("uina.entry 缺失时回退 main；main 指向不存在文件时回退 index.*", async () => {
		const root = await makeRoot();
		await makeWorldDir(root, "w-main", { "package.json": JSON.stringify({ main: "main.ts" }), "main.ts": MINIMAL_DEF });
		await makeWorldDir(root, "w-fallback", { "package.json": JSON.stringify({ main: "missing.ts" }), "index.js": "" });
		const entries = await discoverExternalWorldEntries([root]);
		expect(entries.some((e) => e.endsWith("main.ts"))).toBe(true);
		expect(entries.some((e) => e.endsWith("index.js"))).toBe(true);
	});

	it("坏 package.json 静默忽略并走 index 回退；无任何入口的目录不产出", async () => {
		const root = await makeRoot();
		await makeWorldDir(root, "w-broken", { "package.json": "{not json", "index.mts": "" });
		await makeWorldDir(root, "w-empty", { "readme.md": "" });
		const entries = await discoverExternalWorldEntries([root]);
		expect(entries.some((e) => e.endsWith("index.mts"))).toBe(true);
		expect(entries.some((e) => e.includes("w-empty"))).toBe(false);
	});

	it("顶层源码文件直接收录；点前缀与 node_modules 目录跳过", async () => {
		const root = await makeRoot();
		await makeWorldDir(root, ".hidden", { "index.ts": MINIMAL_DEF });
		await makeWorldDir(root, "node_modules", { "index.ts": MINIMAL_DEF });
		await writeFile(join(root, "standalone.mjs"), MINIMAL_DEF, "utf8");
		const entries = await discoverExternalWorldEntries([root]);
		expect(entries.some((e) => e.endsWith("standalone.mjs"))).toBe(true);
		expect(entries.some((e) => e.includes(".hidden") || e.includes("node_modules"))).toBe(false);
	});
});

describe("extractWorldDef：WorldDef 提取契约", () => {
	const def = { name: "w", description: "d", actions: {} };

	it("对象本身即是 WorldDef：原样返回", async () => {
		expect(await extractWorldDef(def)).toBe(def);
	});

	it("default 导出为无参工厂：调用并校验产物", async () => {
		expect(await extractWorldDef(() => def)).toBe(def);
	});

	it("工厂不得读取宿主参数（无参调用，收不到注入）", async () => {
		expect(
			await extractWorldDef((...args: unknown[]) => {
				expect(args).toHaveLength(0);
				return def;
			}),
		).toBe(def);
	});

	it("命名空间导出（worldDef/default 键）不属于入口合同：返回 null", async () => {
		expect(await extractWorldDef({ worldDef: def })).toBeNull();
		expect(await extractWorldDef({ default: def })).toBeNull();
	});

	it("产物不是 WorldDef / 形状不齐 / 非对象非函数：返回 null", async () => {
		expect(await extractWorldDef(() => ({ name: "" }))).toBeNull();
		expect(await extractWorldDef({ name: "w", description: "d" })).toBeNull();
		expect(await extractWorldDef("text")).toBeNull();
		expect(await extractWorldDef(null)).toBeNull();
	});
});
