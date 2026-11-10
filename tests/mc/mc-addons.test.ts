import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { addonCapabilityModule } from "../../.uina/worlds/minecraft/addons/contribute.js";
import { composeKnowledge } from "../../.uina/worlds/minecraft/addons/knowledge.js";
import { loadAddons } from "../../.uina/worlds/minecraft/addons/loader.js";
import { parseAddonManifest, readInstalledAddon } from "../../.uina/worlds/minecraft/addons/manifest.js";
import {
	assemblyDigest,
	configDigest,
	installedAddonStatuses,
	resolveAddonPlan,
	writeAddonSelectionFile,
} from "../../.uina/worlds/minecraft/addons/plan.js";
import {
	atomicWriteJson,
	directoryDigest,
	installAddonArtifact,
	readInstalledIndex,
	scanInstalledArtifacts,
} from "../../.uina/worlds/minecraft/addons/store.js";
import { createCapabilityCatalog } from "../../.uina/worlds/minecraft/capabilities/index.js";
import { describeDirectory } from "../../.uina/worlds/minecraft/companion/directory.js";
import type { AssemblyPlan, ResolvedAddon } from "../../.uina/worlds/minecraft/contracts/addons.js";
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
 * Addon 打包与装配。
 *
 * 覆盖的是"不执行第三方代码也能判定"的边界：Manifest 静态校验、Profile 选择解析、
 * 入口 import 后的自报一致性、贡献 ref 命名空间化、包内知识与注册表的优先级。
 * 依赖图算法与不可变存储见 mc-addon-graph.test.ts；连接协议见 mc-addon-protocol.test.ts。
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
	configRequired?: boolean;
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

/** 只写来源目录；真正成为可加载的包必须经 installAddonArtifact 提交为 artifact。 */
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
			...(spec.configRequired === undefined ? {} : { configRequired: spec.configRequired }),
			...(spec.serverRequirement === undefined ? {} : { serverRequirement: spec.serverRequirement }),
		},
	};
	await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
	if ((spec.main ?? "./index.js") === "./index.js")
		await writeFile(join(dir, "index.js"), spec.source ?? defaultSource(id), "utf8");
	return dir;
}

async function installRoot(): Promise<{ minecraftRoot: string; sources: string; profileDir: string }> {
	const minecraftRoot = await tempDir();
	const sources = join(minecraftRoot, "sources");
	const profileDir = join(minecraftRoot, "sessions", "a".repeat(64));
	await mkdir(sources, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	return { minecraftRoot, sources, profileDir };
}

async function addPackage(minecraftRoot: string, dirName: string, spec: PackageSpec = {}): Promise<string> {
	const source = await writePackage(join(minecraftRoot, "sources"), dirName, spec);
	const artifact = await installAddonArtifact(minecraftRoot, source);
	return artifact.dir;
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
	test("完整声明被规范化为纯值（含 SemVer 范围 / serverRequirement）", () => {
		const manifest = parseAddonManifest(
			rawPackage({
				requiresAddons: { "core-lib": "^2.0.0" },
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
			requiresAddons: { "core-lib": "^2.0.0" },
			configRequired: false,
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

	test("requiresAddons 必须是合法 SemVer 范围，不是任意字符串", () => {
		expect(codeOf(() => parseAddonManifest(rawPackage({ requiresAddons: { core: "latest" } }), "pkg"))).toBe(
			"ADDON_MANIFEST_INVALID",
		);
		expect(codeOf(() => parseAddonManifest(rawPackage({ requiresAddons: { core: "" } }), "pkg"))).toBe(
			"ADDON_MANIFEST_INVALID",
		);
		expect(parseAddonManifest(rawPackage({ requiresAddons: { core: ">=1 <3" } }), "pkg").requiresAddons).toEqual({
			core: ">=1 <3",
		});
	});

	test("configRequired 只接受布尔值", () => {
		expect(parseAddonManifest(rawPackage({ configRequired: true }), "pkg").configRequired).toBe(true);
		expect(codeOf(() => parseAddonManifest(rawPackage({ configRequired: "yes" }), "pkg"))).toBe(
			"ADDON_MANIFEST_INVALID",
		);
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

describe("addon artifact 扫描：坏映射不阻止其它包，安装不产生重复 id", () => {
	test("缺入口文件的来源不能成为 artifact", async () => {
		const { minecraftRoot, sources } = await installRoot();
		const dir = await writePackage(sources, "broken", { id: "broken", main: "./missing.js" });
		await expect(readInstalledAddon(dir)).rejects.toMatchObject({ code: "ADDON_ENTRY_MISSING" });
		await expect(installAddonArtifact(minecraftRoot, dir)).rejects.toMatchObject({ code: "ADDON_ENTRY_MISSING" });
	});

	test("同 id 再安装只替换映射；坏映射被记录为 problem", async () => {
		const { minecraftRoot } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		await addPackage(minecraftRoot, "alpha-copy", { id: "alpha", version: "1.0.1" });
		const scan = await scanInstalledArtifacts(minecraftRoot);
		expect(scan.addons).toHaveLength(1);
		expect(scan.addons[0]?.version).toBe("1.0.1");
		expect(scan.problems).toEqual([]);

		const index = await readInstalledIndex(minecraftRoot);
		index.installed.broken = "a".repeat(64);
		await atomicWriteJson(join(minecraftRoot, "addons", "installed.json"), index);
		const withProblem = await scanInstalledArtifacts(minecraftRoot);
		expect(withProblem.addons).toHaveLength(1);
		expect(withProblem.problems).toHaveLength(1);
		expect(withProblem.problems[0]?.error).toContain("package.json");
	});

	test("入口必须是包根内的真实文件", async () => {
		const { minecraftRoot } = await installRoot();
		const dir = await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		const installed = await readInstalledAddon(dir);
		expect(installed.entry).toBe(join(dir, "index.js"));
		expect(installed.dir).toBe(dir);
	});

	test("映射存在但包读不出来：报原始失败原因，不说成未安装", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { broken: {} } });
		const index = await readInstalledIndex(minecraftRoot);
		index.installed.broken = "a".repeat(64);
		await atomicWriteJson(join(minecraftRoot, "addons", "installed.json"), index);
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_MANIFEST_INVALID",
			message: expect.stringContaining("BROKEN_INSTALL"),
		});
	});
});

describe("Profile 选择：enabled 是显式根包，连接前失败", () => {
	test("没有 addons.json 等价于未启用任何包", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.ordered).toEqual([]);
		expect(plan.roots).toEqual([]);
		expect(plan.digest).toBe(assemblyDigest([]));
	});

	test("启用未安装的根包：ADDON_NOT_INSTALLED，并列出已安装项", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { ghost: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_NOT_INSTALLED",
			hint: expect.stringContaining("installed addons: alpha"),
		});
	});

	test("声明版本不含当前会话版本：ADDON_VERSION_MISMATCH", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha", minecraft: ["1.20.4"] });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_VERSION_MISMATCH",
		});
	});

	test("未声明 minecraft 版本不据此拒绝", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha", minecraft: [] });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.ordered.map((entry) => entry.id)).toEqual(["alpha"]);
	});

	test("只启用根包时依赖被自动纳入，且不写回 Profile", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha", requiresAddons: { beta: "*" } });
		await addPackage(minecraftRoot, "beta", { id: "beta", version: "2.1.0" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { verifyTimeoutMs: 500 } } });
		const plan = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(plan.roots).toEqual(["alpha"]);
		expect(plan.ordered.map((entry) => entry.id)).toEqual(["beta", "alpha"]);
		expect(plan.ordered[0]?.config).toEqual({});
		expect(plan.ordered[0]?.requestedBy).toEqual(["alpha"]);
		expect(plan.ordered[1]?.config).toEqual({ verifyTimeoutMs: 500 });
		const { readAddonSelectionFile } = await import("../../.uina/worlds/minecraft/addons/plan.js");
		expect(Object.keys((await readAddonSelectionFile(profileDir)).enabled)).toEqual(["alpha"]);
	});

	test("装配摘要与文件写入顺序无关，与配置内容有关", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { a: 1, b: { c: 2, d: 3 } } } });
		const first = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { b: { d: 3, c: 2 }, a: 1 } } });
		const second = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(second.digest).toBe(first.digest);
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: { a: 2 } } });
		const changed = await resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" });
		expect(changed.digest).not.toBe(first.digest);
		expect(configDigest({ b: { d: 3, c: 2 }, a: 1 })).toBe(configDigest({ a: 1, b: { c: 2, d: 3 } }));
	});

	test("artifact 内容被改动后拒绝装配（不悄悄换代码）", async () => {
		const { minecraftRoot, profileDir } = await installRoot();
		const dir = await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		await writeAddonSelectionFile(profileDir, { enabled: { alpha: {} } });
		await writeFile(join(dir, "index.js"), "// tampered\n", "utf8");
		await expect(resolveAddonPlan({ minecraftRoot, profileDir, minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_ARTIFACT_CHANGED",
		});
	});

	test("来源含符号链接时拒绝安装（摘要必须覆盖真实字节）", async (ctx) => {
		const { minecraftRoot, sources } = await installRoot();
		const outside = await tempDir();
		await writeFile(join(outside, "secret.js"), "export const secret = 1;\n", "utf8");
		const dir = await writePackage(sources, "linked", { id: "linked" });
		try {
			await symlink(join(outside, "secret.js"), join(dir, "link.js"), "file");
		} catch {
			ctx.skip();
			return;
		}
		await expect(installAddonArtifact(minecraftRoot, dir)).rejects.toMatchObject({ code: "ADDON_SOURCE_INVALID" });
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
		const { minecraftRoot } = await installRoot();
		await addPackage(minecraftRoot, "alpha", { id: "alpha" });
		const statuses = await installedAddonStatuses(minecraftRoot);
		expect(statuses).toEqual([
			expect.objectContaining({
				id: "alpha",
				state: "installed",
				evidence: { planned: false, loaded: false, protocol: "unknown", dataReady: false },
				contributed: { actions: 0, queries: 0, knowledgeItems: 0, refs: [] },
			}),
		]);
		expect(statuses[0]?.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("loader：只加载预检过的冻结计划", () => {
	async function planOf(dirs: readonly string[]): Promise<AssemblyPlan> {
		const ordered: ResolvedAddon[] = [];
		for (const dir of dirs) {
			const installed = await readInstalledAddon(dir);
			ordered.push({
				id: installed.id,
				version: installed.version,
				api: 1,
				artifactDigest: await directoryDigest(dir),
				root: installed.dir,
				entry: installed.entry,
				config: {},
				configDigest: configDigest({}),
				dependencies: Object.keys(installed.manifest.requiresAddons).sort(),
				requestedBy: [],
				minecraft: [...installed.manifest.minecraft],
				serverRequirement: installed.manifest.serverRequirement,
			});
		}
		return { roots: ordered.map((entry) => entry.id), ordered, digest: assemblyDigest(ordered) };
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
		const loaded = await loadAddons(await planOf([exampleDir]), { minecraftVersion: "1.21.11" });
		expect(loaded.statuses).toEqual([
			expect.objectContaining({
				id: "example-mod",
				state: "loaded",
				evidence: expect.objectContaining({ planned: true, loaded: true, protocol: "not_required" }),
				contributed: expect.objectContaining({ actions: 1, queries: 2, knowledgeItems: 1 }),
			}),
		]);
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

	test("正式包 spectatorplus：只做协议转换，不贡献能力/知识/事实", async () => {
		const dir = join(process.cwd(), ".uina/worlds/minecraft/packages/spectatorplus");
		const loaded = await loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" });
		expect(loaded.statuses).toEqual([
			expect.objectContaining({
				id: "spectatorplus",
				state: "loaded",
				contributed: { actions: 0, queries: 0, knowledgeItems: 0, refs: [] },
				serverRequirement: expect.objectContaining({ kind: "mod", requiredFor: "feature" }),
			}),
		]);
		expect(loaded.knowledge).toEqual([]);
		expect(loaded.modules.flatMap((module) => module.definitions)).toEqual([]);
		const extension = loaded.extensions[0];
		expect(loaded.extensions.map((entry) => entry.id)).toEqual(["spectatorplus"]);
		expect(extension?.attach).toBeUndefined();
		expect(extension?.install).toBeUndefined();

		const base = { kind: "player_inventory", session: "op:1", connection: "conn:1", incarnation: "inc:1" } as const;
		expect(extension?.localScreen?.({ ...base, phase: "open" })).toEqual({
			channel: "spectatorplus:opened_inventory_sync",
			data: Uint8Array.of(1),
		});
		expect(extension?.localScreen?.({ ...base, phase: "close" })).toEqual({
			channel: "spectatorplus:opened_inventory_sync",
			data: Uint8Array.of(0),
		});
		expect(extension?.localScreen?.({ ...base, kind: "other" } as never)).toBeNull();
		await loaded.close();
	});

	test("目录按状态里的 ref 清单列出包内能力（不靠 id 前缀猜）", async () => {
		const exampleDir = join(process.cwd(), ".uina/worlds/minecraft/examples/addons/example-mod");
		const loaded = await loadAddons(await planOf([exampleDir]), { minecraftVersion: "1.21.11" });
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
		await expect(loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
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
		await expect(loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONTRIBUTION_INVALID",
		});
	});

	test("贡献字段形状非法（localScreen 不是函数）被拒绝", async () => {
		const root = await tempDir();
		const dir = await writePackage(root, "bad-screen", {
			id: "bad-screen",
			source: [
				"export const api = 1;",
				'export const id = "bad-screen";',
				"export function create() {",
				'\treturn { client: { localScreen: "open" } };',
				"}",
				"",
			].join("\n"),
		});
		await expect(loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
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
		await expect(loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
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
		await expect(loadAddons(await planOf([dir]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONFIG_INVALID",
		});
	});

	test("create() 成功后贡献校验失败也要释放刚创建的包", async () => {
		const root = await tempDir();
		const first = await writePackage(root, "first", {
			id: "first",
			source: [
				"export const api = 1;",
				'export const id = "first";',
				"export function create() {",
				"\treturn { close() { globalThis.__uinaGraphClosed.push('first'); } };",
				"}",
				"",
			].join("\n"),
		});
		const second = await writePackage(root, "second", {
			id: "second",
			source: [
				"export const api = 1;",
				'export const id = "second";',
				"export function create() {",
				"\treturn { actions: 'bad', close() { globalThis.__uinaGraphClosed.push('second'); } };",
				"}",
				"",
			].join("\n"),
		});
		const closed: string[] = [];
		(globalThis as { __uinaGraphClosed?: string[] }).__uinaGraphClosed = closed;
		await expect(loadAddons(await planOf([first, second]), { minecraftVersion: "1.21.11" })).rejects.toMatchObject({
			code: "ADDON_CONTRIBUTION_INVALID",
		});
		expect(closed).toEqual(["second", "first"]);
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
		const loaded = await loadAddons(await planOf([first, second]), { minecraftVersion: "1.21.11" });
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
			publishedPrograms: ["collect@1"],
			programSource: null,
			addons: [
				{
					id: "example-mod",
					version: "1.0.0",
					api: 1,
					state: "loaded",
					artifactDigest: "a".repeat(64),
					evidence: { planned: true, loaded: true, protocol: "not_required", dataReady: false },
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
		expect(schema?.output({ ...value, addons: [{ ...value.addons[0], evidence: undefined }] })).toBe(false);
	});

	test("input accepts only the optional exact source selector", () => {
		const schema = methods.get("directory.snapshot");
		expect(schema?.input({})).toBe(true);
		expect(schema?.input({ sourceFor: "collect@1" })).toBe(true);
		expect(schema?.input({ profile: "x" })).toBe(false);
	});
});
