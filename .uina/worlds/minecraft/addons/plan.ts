/**
 * Profile 级 Addon 选择 → 冻结的装配计划。
 *
 * `enabled` 只是**显式请求的根包**；Resolver 递归求必需前置的完整闭包，
 * 用 DFS 三色标记做拓扑排序，前置先加载、逆序释放。任何缺失/版本不符/循环/
 * 缺配置/执行字节被改动都在 import 代码与建立连接之前失败，并给出 root → ...
 * → failing node 的完整链。计划冻结后，连接期间改 addons.json 不生效。
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AddonStatus, AssemblyPlan, DependencyError, ResolvedAddon } from "../contracts/addons.js";
import type { JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { ADDON_API_VERSION } from "./sdk.js";
import { isValidVersion, versionSatisfies } from "./semver-range.js";
import {
	addonsRoot,
	atomicWriteJson,
	directoryDigest,
	type InstalledArtifact,
	scanInstalledArtifacts,
} from "./store.js";

export interface AddonSelectionFile {
	enabled: Record<string, JsonValue>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function compareName(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function selectionFailure(code: string, message: string, hint?: string): Error {
	return callFailure({
		code,
		source: "environment",
		message,
		...(hint === undefined ? {} : { hint }),
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 读 Profile 的 addons.json；缺失等价于"未启用任何包"。 */
export async function readAddonSelectionFile(profileDir: string): Promise<AddonSelectionFile> {
	const path = join(profileDir, "addons.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: {} };
		throw selectionFailure("ADDON_SELECTION_INVALID", `${path}: unreadable (${String(error)})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw selectionFailure("ADDON_SELECTION_INVALID", `${path}: invalid JSON (${String(error)})`);
	}
	if (!isPlainObject(parsed)) throw selectionFailure("ADDON_SELECTION_INVALID", `${path}: expected an object`);
	const enabled = parsed.enabled ?? {};
	if (!isPlainObject(enabled))
		throw selectionFailure("ADDON_SELECTION_INVALID", `${path}: "enabled" must be an object`);
	for (const id of Object.keys(enabled)) {
		if (!ID_PATTERN.test(id))
			throw selectionFailure("ADDON_SELECTION_INVALID", `${path}: invalid addon id ${JSON.stringify(id)}`);
	}
	return { enabled: enabled as Record<string, JsonValue> };
}

/** 同目录临时文件 + rename；读-改-写由 manage 层用 withFileLock 串行。 */
export async function writeAddonSelectionFile(profileDir: string, value: AddonSelectionFile): Promise<void> {
	await atomicWriteJson(join(profileDir, "addons.json"), { enabled: value.enabled });
}

/** 键序不影响装配含义：摘要前把对象键递归排序。 */
export function canonicalJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort(compareName)) sorted[key] = canonicalJson(value[key] as JsonValue);
		return sorted;
	}
	return value;
}

export function configDigest(config: JsonValue): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalJson(config)))
		.digest("hex");
}

/** 装配摘要：覆盖确切执行字节、配置、依赖形状；顺序无关。 */
export function assemblyDigest(ordered: readonly ResolvedAddon[]): string {
	const material = ordered
		.map((entry) => ({
			id: entry.id,
			version: entry.version,
			api: entry.api,
			artifactDigest: entry.artifactDigest,
			configDigest: entry.configDigest,
			dependencies: entry.dependencies,
		}))
		.sort((a, b) => compareName(a.id, b.id));
	return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

export function emptyAssemblyPlan(): AssemblyPlan {
	return { roots: [], ordered: [], digest: assemblyDigest([]) };
}

/** 带完整递归路径的装配失败；`path` 也作为结构化字段挂在错误上。 */
type AssemblyErrorCode =
	| DependencyError["code"]
	| "ADDON_NOT_INSTALLED"
	| "ADDON_VERSION_MISMATCH"
	| "ADDON_ARTIFACT_CHANGED";

function dependencyFailure(
	code: AssemblyErrorCode | string,
	path: readonly string[],
	terminal: string,
	hint?: string,
): Error & { path: readonly string[] } {
	const lines = path.map((node, index) => `${index === 0 ? "" : "  → "}${node}`);
	lines[lines.length - 1] = `${lines[lines.length - 1]} [${terminal}]`;
	const message = `${code}\n${lines.join("\n")}\n本次未 import 任何 Addon，未创建 Minecraft 连接。`;
	const error = callFailure({
		code,
		source: "environment",
		message,
		...(hint === undefined ? {} : { hint }),
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	}) as unknown as Error & { path: readonly string[] };
	Object.assign(error, { path: [...path] });
	return error;
}

function resolvedFrom(
	artifact: InstalledArtifact,
	config: JsonValue,
	requestedBy: readonly string[],
	realDir: string,
	realEntry: string,
): ResolvedAddon {
	return {
		id: artifact.id,
		version: artifact.version,
		api: ADDON_API_VERSION,
		artifactDigest: artifact.artifactDigest,
		root: realDir,
		entry: realEntry,
		config,
		configDigest: configDigest(config),
		dependencies: Object.keys(artifact.manifest.requiresAddons).sort(compareName),
		requestedBy: [...requestedBy].sort(compareName),
		minecraft: [...artifact.manifest.minecraft],
		serverRequirement: artifact.manifest.serverRequirement,
	};
}

/**
 * 解析并冻结本次连接的装配计划。失败不产生任何部分计划：
 * 依赖闭包、版本范围、Minecraft 版本、配置要求、路径可信、执行字节摘要都在这里判定。
 */
export async function resolveAddonPlan(options: {
	/** `<worldDataDir>`：安装根与 Profile 根的共同祖先。 */
	minecraftRoot: string;
	profileDir: string;
	minecraftVersion: string;
}): Promise<AssemblyPlan> {
	const selection = await readAddonSelectionFile(options.profileDir);
	const roots = Object.keys(selection.enabled).sort(compareName);
	if (roots.length === 0) return emptyAssemblyPlan();

	const scan = await scanInstalledArtifacts(options.minecraftRoot);
	const byId = new Map(scan.addons.map((artifact) => [artifact.id, artifact]));
	// 映射存在但包读不出来，与"没安装"是两件事：前者带原始失败原因，不能被说成 NOT_INSTALLED。
	const broken = new Map(scan.problems.map((problem) => [problem.id, problem]));
	const known = [...byId.keys()].sort(compareName);
	const installHint = (id: string, range: string): string =>
		`install ${id}@${range} first; installed addons: ${known.length > 0 ? known.join(", ") : "(none)"} — no automatic download`;

	const artifactsRoot = join(addonsRoot(options.minecraftRoot), "artifacts");
	const realArtifacts = await realpath(artifactsRoot).catch(() => artifactsRoot);

	const colors = new Map<string, "visiting" | "done">();
	const requestedBy = new Map<string, Set<string>>();
	// 请求关系是整张图的聚合结果：共享前置可能在首次访问之后又被别的包请求。
	// 因此遍历阶段只记录拓扑顺序和解析出的纯值，ResolvedAddon 在闭包完成后一次性定稿。
	const order: {
		artifact: InstalledArtifact;
		config: JsonValue;
		realDir: string;
		realEntry: string;
	}[] = [];
	const stack: string[] = [];
	const stackLabel = (): string[] => stack.map((node) => `${node}@${byId.get(node)?.version ?? "*"}`);

	async function visit(id: string, range: string, from: string | null): Promise<void> {
		if (from != null) {
			const requesters = requestedBy.get(id) ?? new Set<string>();
			requesters.add(from);
			requestedBy.set(id, requesters);
		}
		const artifact = byId.get(id);
		const label = artifact == null ? `${id}@${range}` : `${id}@${artifact.version}`;
		const path = [...stackLabel(), label];
		if (artifact == null) {
			const problem = broken.get(id);
			if (problem != null)
				throw dependencyFailure(problem.code, path, "BROKEN_INSTALL", `${problem.dir}: ${problem.error}`);
			throw dependencyFailure(
				from == null ? "ADDON_NOT_INSTALLED" : "ADDON_DEPENDENCY_MISSING",
				path,
				"NOT_INSTALLED",
				installHint(id, range),
			);
		}
		if (!isValidVersion(artifact.version) || !versionSatisfies(artifact.version, range))
			throw dependencyFailure(
				"ADDON_DEPENDENCY_VERSION",
				path,
				`INSTALLED ${artifact.version} DOES NOT SATISFY ${range}`,
				`required range ${range}, installed ${artifact.version}`,
			);

		const color = colors.get(id);
		if (color === "visiting") {
			const start = stack.indexOf(id);
			throw dependencyFailure(
				"ADDON_DEPENDENCY_CYCLE",
				[...stackLabel().slice(start), `${id}@${artifact.version}`],
				"CYCLE",
			);
		}
		if (color === "done") return;

		const declared = artifact.manifest.minecraft;
		if (declared.length > 0 && !declared.includes(options.minecraftVersion))
			throw dependencyFailure(
				"ADDON_VERSION_MISMATCH",
				path,
				`MINECRAFT ${options.minecraftVersion} NOT IN ${declared.join(", ")}`,
			);
		const explicit = id in selection.enabled;
		if (!explicit && artifact.manifest.configRequired)
			throw dependencyFailure(
				"ADDON_CONFIG_MISSING",
				path,
				"CONFIG_REQUIRED",
				`enable ${id} explicitly with a config on this profile; no default is guessed`,
			);

		// 执行字节必须与安装映射里的摘要一致：运行中改包目录不能悄悄换代码。
		const actual = await directoryDigest(artifact.dir);
		if (actual !== artifact.artifactDigest)
			throw dependencyFailure(
				"ADDON_ARTIFACT_CHANGED",
				path,
				"CONTENT_DIGEST_MISMATCH",
				`reinstall ${id} to refresh the installed mapping`,
			);

		const [realDir, realEntry] = await Promise.all([
			realpath(artifact.dir).catch(() => artifact.dir),
			realpath(artifact.entry).catch(() => artifact.entry),
		]);
		if (realDir !== realArtifacts && !realDir.startsWith(realArtifacts + sep))
			throw selectionFailure("ADDON_PATH_UNTRUSTED", `addon ${id} resolves outside the artifact root: ${realDir}`);
		if (!realEntry.startsWith(realDir + sep))
			throw selectionFailure("ADDON_PATH_UNTRUSTED", `addon ${id} entry resolves outside its package: ${realEntry}`);

		colors.set(id, "visiting");
		stack.push(id);
		const dependencies = Object.entries(artifact.manifest.requiresAddons).sort(([a], [b]) => compareName(a, b));
		for (const [dependencyId, dependencyRange] of dependencies) await visit(dependencyId, dependencyRange, id);
		stack.pop();
		colors.set(id, "done");

		order.push({
			artifact,
			config: explicit ? (selection.enabled[id] as JsonValue) : {},
			realDir,
			realEntry,
		});
	}

	for (const id of roots) await visit(id, "*", null);
	const ordered = order.map((node) =>
		resolvedFrom(
			node.artifact,
			node.config,
			[...(requestedBy.get(node.artifact.id) ?? [])],
			node.realDir,
			node.realEntry,
		),
	);
	return { roots, ordered, digest: assemblyDigest(ordered) };
}

/**
 * 离线目录摘要：只读 installed.json 与 Manifest，不 import 第三方代码。
 * 这些包的能力不会出现在离线目录里——"已安装"不等于"可执行"。
 */
export async function installedAddonStatuses(minecraftRoot: string): Promise<AddonStatus[]> {
	const scan = await scanInstalledArtifacts(minecraftRoot);
	return scan.addons.map((artifact) => ({
		id: artifact.id,
		version: artifact.version,
		api: ADDON_API_VERSION,
		state: "installed" as const,
		artifactDigest: artifact.artifactDigest,
		evidence: { planned: false, loaded: false, protocol: "unknown" as const, dataReady: false },
		minecraft: [...artifact.manifest.minecraft],
		serverRequirement: artifact.manifest.serverRequirement,
		dir: artifact.dir,
		contributed: { actions: 0, queries: 0, knowledgeItems: 0, refs: [] },
	}));
}
