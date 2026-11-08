import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	disableAddon,
	enableAddon,
	collectAddonArtifacts,
	migrateAddonLayout,
	removeAddon,
} from "../../.uina/worlds/minecraft/addons/manage.js";
import {
	readAddonSelectionFile,
	resolveAddonPlan,
	writeAddonSelectionFile,
} from "../../.uina/worlds/minecraft/addons/plan.js";
import {
	artifactDir,
	directoryDigest,
	installAddonArtifact,
	readInstalledIndex,
} from "../../.uina/worlds/minecraft/addons/store.js";
import { methods } from "../../.uina/worlds/minecraft/executor/protocol.js";

/**
 * S1/S2 专项：依赖图算法、装配摘要、不可变 artifact 与原子配置写入。
 * 这一层完全不 import 第三方包代码，也不建立任何 Minecraft 连接。
 */

const temporary: string[] = [];
afterEach(async () => {
	for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	sources: string;
	profile: string;
}

const PROFILE = "a".repeat(64);

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "uina-graph-"));
	temporary.push(root);
	const sources = join(root, "sources");
	const profile = join(root, "sessions", PROFILE);
	await mkdir(sources, { recursive: true });
	await mkdir(profile, { recursive: true });
	return { root, sources, profile };
}

interface Spec {
	id?: string;
	version?: string;
	requires?: Record<string, string>;
	configRequired?: boolean;
}

async function source(root: string, dirName: string, spec: Spec = {}): Promise<string> {
	const id = spec.id ?? dirName;
	const dir = join(root, "sources", dirName);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: `@uina/${dirName}`,
				version: spec.version ?? "1.0.0",
				main: "./index.js",
				uinaMinecraft: {
					id,
					api: 1,
					minecraft: ["1.21.11"],
					requiresAddons: spec.requires ?? {},
					...(spec.configRequired === undefined ? {} : { configRequired: spec.configRequired }),
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(join(dir, "index.js"), `export const api = 1; export const id = ${JSON.stringify(id)};\n`, "utf8");
	return dir;
}

async function install(root: string, dirName: string, spec: Spec = {}): Promise<string> {
	const dir = await source(root, dirName, spec);
	const artifact = await installAddonArtifact(root, dir);
	return artifact.artifactDigest;
}

async function plan(root: string, enabled: Record<string, unknown>) {
	await writeAddonSelectionFile(join(root, "sessions", PROFILE), { enabled: enabled as never });
	return await resolveAddonPlan({
		minecraftRoot: root,
		profileDir: join(root, "sessions", PROFILE),
		minecraftVersion: "1.21.11",
	});
}

describe("Resolver：递归闭包与拓扑排序", () => {
	test("A → B → C 且只启用 A：自动载入 C、B、A，根列表不变", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { b: "^1.0.0" } });
		await install(root, "b", { version: "1.2.0", requires: { c: "*" } });
		await install(root, "c", { version: "2.0.0" });
		const result = await plan(root, { a: {} });
		expect(result.roots).toEqual(["a"]);
		expect(result.ordered.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
		expect(result.ordered[0]?.requestedBy).toEqual(["b"]);
		expect(result.ordered[1]?.requestedBy).toEqual(["a"]);
		expect(result.ordered[2]?.requestedBy).toEqual([]);
		expect(result.ordered.map((entry) => entry.dependencies)).toEqual([[], ["c"], ["b"]]);
		const selection = await readAddonSelectionFile(join(root, "sessions", PROFILE));
		expect(Object.keys(selection.enabled)).toEqual(["a"]);
	});

	test("共享前置只解析一次，多个请求者都记录在 requestedBy", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { core: "^1.0.0" } });
		await install(root, "b", { requires: { core: ">=1 <2" } });
		await install(root, "core", { version: "1.5.0" });
		const result = await plan(root, { b: {}, a: {} });
		expect(result.ordered.map((entry) => entry.id)).toEqual(["core", "a", "b"]);
		expect(result.ordered[0]?.requestedBy).toEqual(["a", "b"]);
	});

	test("已解析的共享前置被另一条范围不满足的边引用：仍判版本失败", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { core: "^1.0.0" } });
		await install(root, "b", { requires: { core: "^2.0.0" } });
		await install(root, "core", { version: "1.5.0" });
		// core 在处理 a 时已 done；b 的依赖边仍必须独立判范围，不能因访问顺序漏检。
		await expect(plan(root, { a: {}, b: {} })).rejects.toMatchObject({ code: "ADDON_DEPENDENCY_VERSION" });
	});

	test("显式移除启用条目但对另一根包仍是前置：仍被纳入", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { core: "*" } });
		await install(root, "core");
		await enableAddon({ root, profileId: PROFILE, id: "a" });
		await enableAddon({ root, profileId: PROFILE, id: "core", config: { explicit: true } });
		await disableAddon({ root, profileId: PROFILE, id: "core" });
		const result = await plan(root, { a: {} });
		expect(result.ordered.map((entry) => entry.id)).toEqual(["core", "a"]);
		expect(result.ordered[0]?.config).toEqual({});
	});

	test("SemVer 范围：精确、^、区间、* 都按 semver 语义判定", async () => {
		const { root } = await fixture();
		await install(root, "sat", { version: "1.4.2", requires: { dep: "^1.2.0" } });
		await install(root, "dep", { version: "1.9.0" });
		const ok = await plan(root, { sat: {} });
		expect(ok.ordered.map((entry) => entry.id)).toEqual(["dep", "sat"]);

		await install(root, "dep-v2", { id: "dep", version: "2.0.0" });
		await expect(plan(root, { sat: {} })).rejects.toMatchObject({ code: "ADDON_DEPENDENCY_VERSION" });
	});
});

describe("Resolver：失败必须带完整链且不产生部分计划", () => {
	test("缺失前置：ADDON_DEPENDENCY_MISSING 带 path 与安装建议", async () => {
		const { root } = await fixture();
		await install(root, "machine-automation", { version: "1.2.0", requires: { "machine-mod": "2.1.0" } });
		await install(root, "machine-mod", { version: "2.1.0", requires: { "fabric-compat": "^1.0.0" } });
		await expect(plan(root, { "machine-automation": {} })).rejects.toMatchObject({
			code: "ADDON_DEPENDENCY_MISSING",
			path: ["machine-automation@1.2.0", "machine-mod@2.1.0", "fabric-compat@^1.0.0"],
			hint: expect.stringContaining("install fabric-compat@^1.0.0 first"),
			message: expect.stringContaining("→ fabric-compat@^1.0.0 [NOT_INSTALLED]"),
		});
	});

	test("循环依赖：ADDON_DEPENDENCY_CYCLE 截取环，不无限递归", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { b: "*" } });
		await install(root, "b", { requires: { c: "*" } });
		await install(root, "c", { requires: { a: "*" } });
		await expect(plan(root, { a: {} })).rejects.toMatchObject({
			code: "ADDON_DEPENDENCY_CYCLE",
			path: ["a@1.0.0", "b@1.0.0", "c@1.0.0", "a@1.0.0"],
		});
	});

	test("configRequired 的自动前置不给默认配置，显式启用才通过", async () => {
		const { root } = await fixture();
		await install(root, "a", { requires: { tuned: "*" } });
		await install(root, "tuned", { configRequired: true });
		await expect(plan(root, { a: {} })).rejects.toMatchObject({
			code: "ADDON_CONFIG_MISSING",
			path: ["a@1.0.0", "tuned@1.0.0"],
		});
		const ok = await plan(root, { a: {}, tuned: { mode: "fast" } });
		expect(ok.ordered.find((entry) => entry.id === "tuned")?.config).toEqual({ mode: "fast" });
	});

	test("装配摘要包含确切字节：同版本不同内容得到不同 digest", async () => {
		const { root } = await fixture();
		const digest = await install(root, "alpha");
		const before = await plan(root, { alpha: {} });
		expect(before.ordered[0]?.artifactDigest).toBe(digest);

		const changedDir = artifactDir(root, "alpha", digest);
		await writeFile(join(changedDir, "index.js"), "// changed\n", "utf8");
		await expect(plan(root, { alpha: {} })).rejects.toMatchObject({ code: "ADDON_ARTIFACT_CHANGED" });

		const newDigest = await install(root, "alpha-updated", { id: "alpha" });
		expect(newDigest).not.toBe(digest);
		const after = await plan(root, { alpha: {} });
		expect(after.digest).not.toBe(before.digest);
		expect(after.ordered[0]?.artifactDigest).toBe(newDigest);
	});
});

describe("Artifact store：不可变、原子映射、离线回收", () => {
	test("内容摘要与文件顺序无关，覆盖全部字节", async () => {
		const { root, sources } = await fixture();
		const dir = await source(root, "alpha");
		const digest = await directoryDigest(dir);
		await writeFile(join(dir, "extra.js"), "export const x = 1;\n", "utf8");
		expect(await directoryDigest(dir)).not.toBe(digest);
		expect(await directoryDigest(join(sources, "alpha"))).toMatch(/^[a-f0-9]{64}$/);
	});

	test("更新同 id 只替换映射，不覆盖旧 artifact 目录", async () => {
		const { root } = await fixture();
		const first = await install(root, "alpha");
		const firstDir = artifactDir(root, "alpha", first);
		const second = await install(root, "alpha-v2", { id: "alpha", version: "2.0.0" });
		const index = await readInstalledIndex(root);
		expect(index.installed.alpha).toBe(second);
		expect((await stat(firstDir)).isDirectory()).toBe(true);
		expect(await readFile(join(firstDir, "package.json"), "utf8")).toContain('"1.0.0"');
		expect((await stat(artifactDir(root, "alpha", second))).isDirectory()).toBe(true);
	});

	test("并发 enable 不丢更新；坏配置文件不会被当作空选择", async () => {
		const { root } = await fixture();
		await install(root, "alpha");
		await install(root, "beta");
		await Promise.all([
			enableAddon({ root, profileId: PROFILE, id: "alpha" }),
			enableAddon({ root, profileId: PROFILE, id: "beta" }),
		]);
		const selection = await readAddonSelectionFile(join(root, "sessions", PROFILE));
		expect(Object.keys(selection.enabled).sort()).toEqual(["alpha", "beta"]);
		expect((await readdir(join(root, "sessions", PROFILE))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("remove 只解除映射，gc 才真正删除无引用 artifact", async () => {
		const { root } = await fixture();
		const digest = await install(root, "alpha");
		await removeAddon(root, "alpha");
		expect((await readInstalledIndex(root)).installed.alpha).toBeUndefined();
		expect((await stat(artifactDir(root, "alpha", digest))).isDirectory()).toBe(true);
		expect(await collectAddonArtifacts(root)).toEqual([`alpha/${digest}`]);
		await expect(stat(artifactDir(root, "alpha", digest))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("remove 拒绝仍在 Profile 启用中的包", async () => {
		const { root } = await fixture();
		await install(root, "alpha");
		await enableAddon({ root, profileId: PROFILE, id: "alpha" });
		await expect(removeAddon(root, "alpha")).rejects.toMatchObject({ code: "ADDON_IN_USE" });
	});

	test("一次性迁移旧布局：旧目录被搬进 artifact 后删除，运行时不再读旧路径", async () => {
		const { root } = await fixture();
		const legacy = join(root, "addons", "legacy-mod");
		await mkdir(legacy, { recursive: true });
		await writeFile(
			join(legacy, "package.json"),
			`${JSON.stringify({ name: "legacy", version: "1.0.0", main: "./index.js", uinaMinecraft: { id: "legacy-mod", api: 1, minecraft: [] } })}\n`,
			"utf8",
		);
		await writeFile(join(legacy, "index.js"), "export const api = 1;\n", "utf8");
		expect(await migrateAddonLayout(root)).toEqual(["legacy-mod@1.0.0"]);
		await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
		const index = await readInstalledIndex(root);
		const digest = index.installed["legacy-mod"];
		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		// 可重入：已经迁完再跑一次什么都不做，映射不变（半途失败后能直接重跑）。
		expect(await migrateAddonLayout(root)).toEqual([]);
		expect((await readInstalledIndex(root)).installed["legacy-mod"]).toBe(digest);
	});
});

describe("IPC：init 只接受完整的 AssemblyPlan", () => {
	test("roots / ordered / digest 与全部 ResolvedAddon 字段都进入严格 schema", async () => {
		const { root } = await fixture();
		const digest = await install(root, "alpha", { requires: { beta: "^1.0.0" } });
		await install(root, "beta");
		const resolved = await plan(root, { alpha: {} });
		const schema = methods.get("init");
		expect(
			schema?.input({
				launch: "launch:t:1",
				origin: { worldOwner: "w:1", activation: "a:1" },
				storageId: "s:1",
				sessionDataDir: "/tmp/session",
				sharedDataDir: "/tmp/shared",
				config: {},
				addons: resolved,
				unclean: false,
				oldControlRetired: true,
				ownerLifetimeMs: 1000,
				localGates: [],
			}),
		).toBe(true);
		expect(resolved.ordered.find((entry) => entry.id === "alpha")?.artifactDigest).toBe(digest);
		expect(
			schema?.input({
				launch: "launch:t:1",
				origin: { worldOwner: "w:1", activation: "a:1" },
				storageId: "s:1",
				sessionDataDir: "/tmp/session",
				sharedDataDir: "/tmp/shared",
				config: {},
				// 旧的 entries 形状必须被拒绝，不留双格式后备。
				addons: { digest: resolved.digest, entries: resolved.ordered },
				unclean: false,
				oldControlRetired: true,
				ownerLifetimeMs: 1000,
				localGates: [],
			}),
		).toBe(false);
	});
});
