import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { addonCapabilityModule } from "../../.uina/worlds/minecraft/addons/contribute.js";
import { composeKnowledge } from "../../.uina/worlds/minecraft/addons/knowledge.js";
import { loadAddons } from "../../.uina/worlds/minecraft/addons/loader.js";
import {
	parseAddonManifest,
	readInstalledAddon,
	scanInstalledAddons,
} from "../../.uina/worlds/minecraft/addons/manifest.js";
import {
	installedAddonStatuses,
	resolveAddonPlan,
	selectionDigest,
	writeAddonSelectionFile,
} from "../../.uina/worlds/minecraft/addons/plan.js";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { describeDirectory } from "../../.uina/worlds/minecraft/companion/directory.js";
import type { AddonPlanEntry, AddonSelection } from "../../.uina/worlds/minecraft/contracts/addons.js";
import type {
	CallableDescriptor,
	NativeCallable,
	QueryDescriptor,
} from "../../.uina/worlds/minecraft/contracts/capabilities.js";
import type { RegistryKnowledge } from "../../.uina/worlds/minecraft/contracts/knowledge.js";
import type { LibraryPort } from "../../.uina/worlds/minecraft/contracts/library.js";
import type { ExactRef, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { methods } from "../../.uina/worlds/minecraft/executor/protocol.js";

/**
 * Addon 打包与装配（addons.md §2–§4）。
 *
 * 覆盖的是"不执行第三方代码也能判定"的边界：Manifest 静态校验、Profile 选择解析、
 * 入口 import 后的自报一致性、贡献 ref 命名空间化、包内知识与注册表的优先级。
 * 真服端到端（自定义通道 → 服务端状态 → 事实回读）不在本文件，见 mc-addon-protocol.test.ts。
 */

const temporary: string[] = [];
afterEach(async () => {
	for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "uina-addon-"));
	temporary.push(dir);
	return dir;
}

interface PackageSpec {
	id?: string;
	version?: string;
	api?: number;
	minecraft?: string[];
	requiresAddons?: Record<string, string>;
	serverRequirement?: unknown;
	main?: string;
	source?: string;
}

function defaultSource(id: string): string {
	return [
		"export const api = 1;",
		`export const id = ${JSON.stringify(id)};`,
		"export function create() {",
		'\treturn { knowledge: { items: [{ name: "example:token", displayName: "Token", stackSize: 64 }] } };',
		"}",
		"",
	].join("\n");
}

async function writePackage(root: string, dirName: string, spec: PackageSpec = {}): Promise<string> {
	const id = spec.id ?? dirName;
	const dir = join(root, dirName);
	await mkdir(dir, { recursive: true });
	const pkg = {
		name: `@uina/${dirName}`,
		version: spec.version ?? "1.0.0",
		main: spec.main ?? "./index.js",
		uinaMinecraft: {
			id,
			api: spec.api ?? 1,
			minecraft: spec.minecraft ?? ["1.21.11"],
			...(spec.requiresAddons == null ? {} : { requiresAddons: spec.requiresAddons }),
			...(spec.serverRequirement === undefined ? {} : { serverRequirement: spec.serverRequirement }),
		},
	};
	await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
	if ((spec.main ?? "./index.js") === "./index.js")
		await writeFile(join(dir, "index.js"), spec.source ?? defaultSource(id), "utf8");
	return dir;
}

/** 安装根：`resolveAddonPlan` 只读 `<minecraftRoot>/addons`。 */
async function installRoot(): Promise<{ minecraftRoot: string; addons: string; profileDir: string }> {
	const minecraftRoot = await tempDir();
	const addons = join(minecraftRoot, "addons");
	const profileDir = join(minecraftRoot, "sessions", "a".repeat(64));
	await mkdir(addons, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	return { minecraftRoot, addons, profileDir };
}

function rawPackage(
	manifest: Record<string, unknown> = {},
	pkg: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		name: "@uina/example",
		version: "1.2.3",
		main: "./index.js",
		uinaMinecraft: { id: "example-mod", api: 1, minecraft: ["1.21.11"], ...manifest },
		...pkg,
	};
}

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

function actionDescriptor(ref: ExactRef): CallableDescriptor {
	return {
		ref,
		summary: "test action",
		input: { type: "object", properties: {}, additionalProperties: false },
		output: { type: "object" },
		access: "act",
		completion: { scope: "capability", description: "returns when the test work is done" },
		errors: [],
		requires: [],
		examples: [],
		implementation: "native",
	};
}

function queryDescriptor(ref: ExactRef): QueryDescriptor {
	return {
		ref,
		summary: "test query",
		input: { type: "object", properties: {}, additionalProperties: false },
		output: { type: "object" },
		access: "read",
		watchable: false,
		feedback: false,
		examples: [],
	};
}

function registryKnowledge(names: readonly string[]): RegistryKnowledge {
	const items = new Map(
		names.map((name) => [
			name,
			{
				name,
				displayName: name,
				stackSize: 64,
				placeAs: null,
				tool: null,
				food: null,
				fuel: null,
				sources: [],
				sourcesComplete: true,
			},
		]),
	);
	return {
		dataVersion: "1.21.11",
		item: (name) => items.get(name) ?? null,
		recipesFor: () => [],
		blockDrops: () => null,
		canonicalItemName: (name) => (items.has(name) ? name : null),
		entityKind: () => null,
		enchantment: () => null,
	};
}

describe("addon manifest：静态声明，不执行代码", () => {
	test("完整声明被规范化为纯值（含 requiresAddons / serverRequirement）", () => {
		const manifest = parseAddonManifest(
			rawPackage({
				requiresAddons: { "core-lib": "2.0.0" },
				serverRequirement: {
					kind: "plugin",
					id: "uina-example-plugin",
					requiredFor: "feature",
					note: "counter lives on the server",
				},
			}),
			"package.json",
		);
		expect(manifest).toMatchObject({
			id: "example-mod",
			api: 1,
			version: "1.2.3",
			minecraft: ["1.21.11"],
			requiresAddons: { "core-lib": "2.0.0" },
			entry: "./index.js",
		});
		expect(manifest.serverRequirement).toEqual({
			kind: "plugin",
			id: "uina-example-plugin",
			requiredFor: "feature",
			note: "counter lives on the server",
		});
	});

	test("缺 uinaMinecraft 段 / 非法 id / 非法版本都被拒绝", () => {
		expect(codeOf(() => parseAddonManifest({ name: "x", version: "1.0.0" }, "pkg"))).toBe("ADDON_MANIFEST_INVALID");
		expect(codeOf(() => parseAddonManifest(rawPackage({ id: "Example_Mod" }), "pkg"))).toBe("ADDON_MANIFEST_INVALID");
		expect(codeOf(() => parseAddonManifest(rawPackage({}, { version: "1.0" }), "pkg"))).toBe("ADDON_MANIFEST_INVALID");
	});

	test("api 不匹配是显式的不支持，不是静默跳过", () => {
		expect(codeOf(() => parseAddonManifest(rawPackage({ api: 2 }), "pkg"))).toBe("ADDON_API_UNSUPPORTED");
	});

	test("入口不得逃出包根", () => {
		expect(codeOf(() => parseAddonManifest(rawPackage({}, { main: "../escape.js" }), "pkg"))).toBe(
			"ADDON_MANIFEST_INVALID",
		);
		expect(codeOf(() => parseAddonManifest(rawPackage({}, { main: "/etc/passwd" }), "pkg"))).toBe(
			"ADDON_MANIFEST_INVALID",
		);
	});

	test("serverRequirement 的 kind/requiredFor 取值受限", () => {
		expect(
			codeOf(() => parseAddonManifest(rawPackage({ serverRequirement: { kind: "datapack", id: "x" } }), "pkg")),
		).toBe("ADDON_MANIFEST_INVALID");
		expect(
			codeOf(() =>
				parseAddonManifest(rawPackage({ serverRequirement: { kind: "mod", id: "x", requiredFor: "always" } }), "pkg"),
			),
		).toBe("ADDON_MANIFEST_INVALID");
	});
});

describe("addon 安装扫描：坏包不阻止其它包，重复 id 被记录", () => {
	test("缺入口文件时该包不可安装", async () => {
		const { addons } = await installRoot();
		const dir = await writePackage(addons, "broken", { id: "broken", main: "./missing.js" });
		await expect(readInstalledAddon(dir)).rejects.toMatchObject({ code: "ADDON_ENTRY_MISSING" });
	});

	test("扫描返回可用包与 problems（坏包、重复 id 都不静默覆盖）", async () => {
		const { addons } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha" });
		await writePackage(addons, "broken", { id: "broken", main: "./missing.js" });
		await writePackage(addons, "alpha-copy", { id: "alpha" });
		const scan = await scanInstalledAddons(addons);
		expect(scan.addons.map((addon) => addon.id)).toEqual(["alpha"]);
		expect(scan.problems).toHaveLength(2);
		expect(scan.problems.some((problem) => problem.error.includes("duplicate addon id alpha"))).toBe(true);
	});

	test("入口必须是包根内的真实文件", async () => {
		const { addons } = await installRoot();
		const dir = await writePackage(addons, "alpha", { id: "alpha" });
		const installed = await readInstalledAddon(dir);
		expect(installed.entry).toBe(join(dir, "index.js"));
		expect(installed.dir).toBe(dir);
	});
});

describe("Profile 选择：enabled 是显式列表，连接前失败", () => {
	test("没有 addons.json 等价于未启用任何包", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.entries).toEqual([]);
		expect(plan.digest).toBe(selectionDigest([]));
	});

	test("启用未安装的包：ADDON_NOT_INSTALLED，并列出已安装项", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { ghost: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_NOT_INSTALLED",
			hint: "installed addons: alpha",
		});
	});

	test("声明版本不含当前会话版本：ADDON_VERSION_MISMATCH", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha", minecraft: ["1.20.4"] });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_VERSION_MISMATCH",
		});
	});

	test("未声明 minecraft 版本不据此拒绝", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha", minecraft: [] });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.entries.map((entry) => entry.id)).toEqual(["alpha"]);
	});

	test("依赖未启用或版本不符：ADDON_DEPENDENCY_MISSING", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha", requiresAddons: { beta: "1.0.0" } });
		await writePackage(addons, "beta", { id: "beta", version: "2.0.0" });

		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_DEPENDENCY_MISSING",
		});

		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {}, beta: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_DEPENDENCY_MISSING",
			message: expect.stringContaining("installed 2.0.0"),
		});
	});

	test("依赖与配置进入冻结计划；digest 与启用顺序无关", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha", requiresAddons: { beta: "*" } });
		await writePackage(addons, "beta", { id: "beta", version: "2.1.0" });
		await writeAddonSelectionFile(profileDir, {
			enabled: { beta: { mode: "fast" }, alpha: { verifyTimeoutMs: 500 } },
		});
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.entries.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
		expect(plan.entries[0]?.config).toEqual({ verifyTimeoutMs: 500 });
		expect(plan.entries[1]?.config).toEqual({ mode: "fast" });
		expect(plan.entries[1]?.version).toBe("2.1.0");

		await writeAddonSelectionFile(profileDir, {
			enabled: { alpha: { verifyTimeoutMs: 500 }, beta: { mode: "fast" } },
		});
		const reordered = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(reordered.digest).toBe(plan.digest);

		await writeAddonSelectionFile(profileDir, {
			enabled: { alpha: { verifyTimeoutMs: 900 }, beta: { mode: "fast" } },
		});
		const reconfigured = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(reconfigured.digest).not.toBe(plan.digest);
	});

	test("配置键序不影响 digest（同一配置不产生两种摘要）", async () => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { a: 1, b: { c: 2, d: 3 } } } });
		const first = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { b: { d: 3, c: 2 }, a: 1 } } });
		const second = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(second.digest).toBe(first.digest);
	});

	test("符号链接指到安装根外：ADDON_PATH_UNTRUSTED", async (ctx) => {
		const { minecraftRoot, addons, profileDir } = await installRoot();
		const outside = await tempDir();
		await writePackage(outside, "outside", { id: "outside" });
		try {
			await symlink(join(outside, "outside"), join(addons, "outside"), "junction");
		} catch {
			ctx.skip();
			return;
		}
		await writeAddonSelectionFile(profileDir, { enabled: { outside: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_PATH_UNTRUSTED",
		});
	});

	test("非法 addons.json 不静默当作未启用", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await writeFile(join(profileDir, "addons.json"), "{ not json", "utf8");
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_SELECTION_INVALID",
		});
	});
});

describe("离线目录：installed 不等于 loaded", () => {
	test("已安装包只报 installed，贡献计数为 0（不 import 代码）", async () => {
		const { minecraftRoot, addons } = await installRoot();
		await writePackage(addons, "alpha", { id: "alpha" });
		const statuses = await installedAddonStatuses(minecraftRoot);
		expect(statuses).toEqual([
			expect.objectContaining({
				id: "alpha",
				state: "installed",
				contributed: { actions: 0, queries: 0, knowledgeItems: 0, refs: [] },
			}),
		]);
	});
});

describe("loader：只加载预检过的计划", () => {
	async function selectionOf(dirs: readonly string[]): Promise<AddonSelection> {
		const entries: AddonPlanEntry[] = [];
		for (const dir of dirs) {
			const installed = await readInstalledAddon(dir);
			entries.push({
				id: installed.id,
				version: installed.version,
				api: 1,
				root: installed.dir,
				entry: installed.entry,
				config: {},
				minecraft: [...installed.manifest.minecraft],
				serverRequirement: installed.manifest.serverRequirement,
			});
		}
		return { digest: selectionDigest(entries), entries };
	}

	test("空计划不产生任何模块/扩展/知识", async () => {
		const loaded = await loadAddons(undefined, { minecraftVersion: "1.21.11" });
		expect(loaded.modules).toEqual([]);
		expect(loaded.extensions).toEqual([]);
		expect(loaded.knowledge).toEqual([]);
		expect(loaded.statuses).toEqual([]);
		await expect(loaded.close()).resolves.toBeUndefined();
	});

	test("真实示例包：贡献进入同一次 Catalog，ref 带命名空间", async () => {
		const exampleDir = join(process.cwd(), ".uina/worlds/minecraft/examples/addons/example-mod");
		const loaded = await loadAddons(await selectionOf([exampleDir]), { minecraftVersion: "1.21.11" });
		expect(loaded.statuses).toEqual([
			expect.objectContaining({
				id: "example-mod",
				state: "loaded",
				contributed: expect.objectContaining({ actions: 1, queries: 2, knowledgeItems: 1 }),
			}),
		]);
		// ref 命名空间不必等于 addon id：状态里必须带确切 ref 清单，目录不能靠前缀猜。
		expect(loaded.statuses[0]?.contributed.refs).toEqual(
			expect.arrayContaining(["example.machine@1", "example.recipes@1", "example.press@1"]),
		);
		expect(loaded.extensions.map((extension) => extension.id)).toEqual(["example-mod"]);
		expect(typeof loaded.extensions[0]?.attach).toBe("function");

		const catalog = createCapabilityCatalog(loaded.modules);
		const refs = catalog.allDescriptors().map((descriptor) => descriptor.ref);
		expect(refs).toEqual(expect.arrayContaining(["example.machine@1", "example.recipes@1", "example.press@1"]));

		const knowledge = composeKnowledge(registryKnowledge(["minecraft:iron_ingot"]), loaded.knowledge);
		expect(knowledge.knowledge?.item("example:uina_token")).toMatchObject({
			displayName: "Uina Token",
			stackSize: 64,
			sources: [],
			sourcesComplete: false,
		});
		expect(knowledge.conflicts).toEqual([]);
		await loaded.close();
	});

	test("目录按状态里的 ref 清单列出包内能力（不靠 id 前缀猜）", async () => {
		const exampleDir = join(process.cwd(), ".uina/worlds/minecraft/examples/addons/example-mod");
		const loaded = await loadAddons(await selectionOf([exampleDir]), { minecraftVersion: "1.21.11" });
		const catalog = createCapabilityCatalog(loaded.modules);
		const entry = (await describeDirectory(
			catalog.allDescriptors(),
			{} as LibraryPort,
			{ kind: "addon", name: "example-mod" },
			loaded.statuses,
		)) as unknown as { kind: string; capabilities: string[]; note: string };
		expect(entry.kind).toBe("addon");
		expect(entry.capabilities).toEqual(
			expect.arrayContaining(["example.machine@1", "example.recipes@1", "example.press@1"]),
		);
		expect(entry.note).toContain("uina-example-plugin");
		await loaded.close();
	});

	test("模块自报 id 与 Manifest 不一致：拒绝装配", async () => {
		const root = await tempDir();
		const dir = await writePackage(root, "liar", {
			id: "liar",
			source: 'export const api = 1; export const id = "other"; export function create() { return {}; }\n',
		});
		await expect(loadAddons(await selectionOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_ENTRY_INVALID",
		});
	});

	test("贡献字段形状非法（actions 不是数组）被拒绝", async () => {
		const root = await tempDir();
		const dir = await writePackage(root, "bad-actions", {
			id: "bad-actions",
			source: [
				"export const api = 1;",
				'export const id = "bad-actions";',
				"export function create() {",
				'\treturn { actions: "press" };',
				"}",
				"",
			].join("\n"),
		});
		await expect(loadAddons(await selectionOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONTRIBUTION_INVALID",
		});
	});

	test("包内知识必须是 namespace:path（坏身份在装配前失败）", async () => {
		const root = await tempDir();
		const dir = await writePackage(root, "bad-knowledge", {
			id: "bad-knowledge",
			source: [
				"export const api = 1;",
				'export const id = "bad-knowledge";',
				"export function create() {",
				'\treturn { knowledge: { items: [{ name: "token", displayName: "Token", stackSize: 64 }] } };',
				"}",
				"",
			].join("\n"),
		});
		await expect(loadAddons(await selectionOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONTRIBUTION_INVALID",
		});
	});

	test("create() 抛出的失败码被保留（不是笼统 LOAD_FAILED）", async () => {
		const root = await tempDir();
		const dir = await writePackage(root, "angry", {
			id: "angry",
			source: [
				"export const api = 1;",
				'export const id = "angry";',
				"export function create() {",
				'\tconst error = new Error("bad config");',
				'\terror.code = "ADDON_CONFIG_INVALID";',
				"\tthrow error;",
				"}",
				"",
			].join("\n"),
		});
		await expect(loadAddons(await selectionOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONFIG_INVALID",
		});
	});

	test("close 逆序释放（后装配先释放）", async () => {
		const root = await tempDir();
		const source = (id: string): string =>
			[
				"export const api = 1;",
				`export const id = ${JSON.stringify(id)};`,
				"export function create() {",
				`\treturn { close() { globalThis.__uinaClosed.push(${JSON.stringify(id)}); } };`,
				"}",
				"",
			].join("\n");
		const closed: string[] = [];
		(globalThis as { __uinaClosed?: string[] }).__uinaClosed = closed;
		const first = await writePackage(root, "close-a", { id: "close-a", source: source("close-a") });
		const second = await writePackage(root, "close-b", { id: "close-b", source: source("close-b") });
		const loaded = await loadAddons(await selectionOf([first, second]), { minecraftVersion: "1.21.11" });
		await loaded.close();
		await loaded.close();
		expect(closed).toEqual(["close-b", "close-a"]);
	});
});

describe("贡献边界：ref 命名空间与访问模式", () => {
	test("动作 ref 必须带命名空间前缀（裸名会与内置 ref 混淆）", () => {
		const callable: NativeCallable<JsonValue, JsonValue> = {
			descriptor: actionDescriptor("press@1"),
			invoke: async () => ({}),
		};
		expect(() => addonCapabilityModule("example-mod", { actions: [callable] })).toThrow(
			expect.objectContaining({ code: "ADDON_REF_INVALID" }),
		);
	});

	test("命名空间不必等于 addon id（规格示例 example.machine@1 合法）", () => {
		const callable: NativeCallable<JsonValue, JsonValue> = {
			descriptor: actionDescriptor("example.press@1"),
			invoke: async () => ({}),
		};
		const module = addonCapabilityModule("example-mod", { actions: [callable] });
		expect(module.definitions.map((definition) => definition.descriptor.ref)).toEqual(["example.press@1"]);
	});

	test("动作必须声明 access act；查询必须声明 read 且有 reader", () => {
		const badAction = {
			descriptor: { ...actionDescriptor("example-mod.press@1"), access: "read" },
			invoke: async () => ({}),
		} as unknown as NativeCallable<JsonValue, JsonValue>;
		expect(() => addonCapabilityModule("example-mod", { actions: [badAction] })).toThrow(
			expect.objectContaining({ code: "ADDON_DESCRIPTOR_INVALID" }),
		);

		expect(() =>
			addonCapabilityModule("example-mod", {
				queries: [
					{
						descriptor: queryDescriptor("example-mod.machine@1"),
						reader: undefined as never,
					},
				],
			}),
		).toThrow(expect.objectContaining({ code: "ADDON_DESCRIPTOR_INVALID" }));
	});

	test("包与内置 ref 重名：Catalog 唯一性校验直接拒绝（不静默覆盖）", () => {
		const callable: NativeCallable<JsonValue, JsonValue> = {
			descriptor: actionDescriptor("build.plan@1"),
			invoke: async () => ({}),
		};
		const module = addonCapabilityModule("build", { actions: [callable] });
		expect(() => createCapabilityCatalog([module])).toThrow(/duplicate capability ref: build\.plan@1/);
	});

	test("注入模块与 addon 模块共用同一次装配（没有第二个注册表）", () => {
		const injected: NativeCallable<JsonValue, JsonValue> = {
			descriptor: actionDescriptor("injected.probe@1"),
			invoke: async () => ({ ok: true }),
		};
		const catalog = createCapabilityCatalog([
			{
				id: "injected:test",
				definitions: [{ kind: "action", descriptor: injected.descriptor, bind: () => injected.invoke }],
			},
		]);
		expect(catalog.allDescriptors().some((descriptor) => descriptor.ref === "injected.probe@1")).toBe(true);
	});
});

describe("包内知识：注册表优先，冲突不按加载顺序覆盖", () => {
	const base = registryKnowledge(["minecraft:iron_ingot"]);

	test("注册表已有同名项：以注册表为准并记录冲突", () => {
		const composed = composeKnowledge(base, [
			{ addonId: "alpha", items: [{ name: "minecraft:iron_ingot", displayName: "Fake Ingot", stackSize: 1 }] },
		]);
		expect(composed.knowledge?.item("minecraft:iron_ingot")?.displayName).toBe("minecraft:iron_ingot");
		expect(composed.conflicts).toEqual([{ addonId: "alpha", item: "minecraft:iron_ingot", reason: "registry" }]);
	});

	test("两个包声明同名新物品：该项不参与组合（不猜哪个对）", () => {
		const composed = composeKnowledge(base, [
			{ addonId: "alpha", items: [{ name: "example:token", displayName: "A", stackSize: 64 }] },
			{ addonId: "beta", items: [{ name: "example:token", displayName: "B", stackSize: 64 }] },
		]);
		expect(composed.knowledge?.item("example:token")).toBeNull();
		expect(composed.conflicts).toEqual([{ addonId: "beta", item: "example:token", reason: "addon" }]);
	});

	test("裸名只在唯一时解析；歧义保持 null", () => {
		const composed = composeKnowledge(base, [
			{ addonId: "alpha", items: [{ name: "example:token", displayName: "Token", stackSize: 64 }] },
		]);
		expect(composed.knowledge?.canonicalItemName("token")).toBe("example:token");

		const ambiguous = composeKnowledge(base, [
			{ addonId: "alpha", items: [{ name: "alpha:token", displayName: "A", stackSize: 64 }] },
			{ addonId: "beta", items: [{ name: "beta:token", displayName: "B", stackSize: 64 }] },
		]);
		expect(ambiguous.knowledge?.canonicalItemName("token")).toBeNull();
	});

	test("没有包贡献时原样返回注册表（不复制、不伪造）", () => {
		const composed = composeKnowledge(base, []);
		expect(composed.knowledge).toBe(base);
		expect(composed.conflicts).toEqual([]);
	});
});

describe("directory.snapshot：IPC 输出契约", () => {
	test("活动会话快照（含 loaded 包）通过严格 schema", () => {
		const schema = methods.get("directory.snapshot");
		expect(schema).toBeDefined();
		const value = {
			launch: "launch:t:1",
			connection: "ready",
			descriptors: [{ ref: "world@1", access: "read" }],
			addons: [
				{
					id: "example-mod",
					version: "1.0.0",
					api: 1,
					state: "loaded",
					minecraft: ["1.21.11"],
					serverRequirement: { kind: "plugin", id: "uina-example-plugin", requiredFor: "feature" },
					dir: "/tmp/addons/example-mod",
					contributed: { actions: 1, queries: 2, knowledgeItems: 1, refs: ["example.press@1"] },
				},
			],
			selection: { digest: "0123456789abcdef0123456789abcdef" },
		};
		expect(schema?.output(value)).toBe(true);

		const missing = { ...value, addons: undefined };
		expect(schema?.output(missing)).toBe(false);
		expect(schema?.output({ ...value, addons: [{ ...value.addons[0], state: "enabled" }] })).toBe(false);
	});

	test("input 只接受空对象（快照没有参数）", () => {
		const schema = methods.get("directory.snapshot");
		expect(schema?.input({})).toBe(true);
		expect(schema?.input({ profile: "x" })).toBe(false);
	});
});
