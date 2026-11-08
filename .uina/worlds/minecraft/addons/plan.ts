/**
 * Profile 级 Addon 选择：`sessions/<profileId>/addons.json` → 冻结的装配计划。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §2、§4。规则：
 * - `enabled` 是显式选用列表；未列出的已安装包不运行、不 import；
 * - 每次 connect 读一次，解析后冻结（连接期间改文件不生效）；
 * - 只做路径与 Manifest 校验，不在主进程 import 第三方代码；
 * - 校验失败显式抛错（不静默跳过用户明确启用的包），失败码带 ADDON_ 前缀。
 */

import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AddonPlanEntry, AddonSelection, AddonStatus } from "../contracts/addons.js";
import type { JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { scanInstalledAddons } from "./manifest.js";
import { ADDON_API_VERSION } from "./sdk.js";

export interface AddonSelectionFile {
	enabled: Record<string, JsonValue>;
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
	return { enabled: enabled as Record<string, JsonValue> };
}

export async function writeAddonSelectionFile(profileDir: string, value: AddonSelectionFile): Promise<void> {
	const path = join(profileDir, "addons.json");
	await writeFile(path, `${JSON.stringify({ enabled: value.enabled }, null, "\t")}\n`, "utf8");
}

/** 键序不影响装配含义：摘要前把对象键递归排序，避免同一配置产生不同 digest。 */
function canonicalJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key] as JsonValue);
		return sorted;
	}
	return value;
}

/** 稳定摘要：只覆盖影响装配含义的字段（id/version/api/配置）。 */
export function selectionDigest(entries: readonly AddonPlanEntry[]): string {
	const material = entries
		.map((entry) => ({
			id: entry.id,
			version: entry.version,
			api: entry.api,
			config: canonicalJson(entry.config),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

/**
 * 解析并校验本次连接的装配计划。任何一条不满足都在建立执行域之前失败：
 * 包 ID / 依赖 / 版本 / 路径 / 入口文件。
 */
export async function resolveAddonPlan(options: {
	/** `<worldDataDir>`：安装根与 Profile 根的共同祖先。 */
	minecraftRoot: string;
	profileDir: string;
	minecraftVersion: string;
}): Promise<AddonSelection> {
	const root = join(options.minecraftRoot, "addons");
	const selection = await readAddonSelectionFile(options.profileDir);
	const enabledIds = Object.keys(selection.enabled).sort();
	if (enabledIds.length === 0) return { digest: selectionDigest([]), entries: [] };
	const installed = await scanInstalledAddons(root);
	const byId = new Map(installed.addons.map((addon) => [addon.id, addon]));
	const realRoot = await realpath(root).catch(() => root);
	const entries: AddonPlanEntry[] = [];
	for (const id of enabledIds) {
		const addon = byId.get(id);
		if (!addon) {
			const known = installed.addons.map((candidate) => candidate.id).sort();
			throw selectionFailure(
				"ADDON_NOT_INSTALLED",
				`profile enables addon ${id} but it is not installed under ${root}`,
				known.length > 0 ? `installed addons: ${known.join(", ")}` : "no addons are installed",
			);
		}
		const declared = addon.manifest.minecraft;
		if (declared.length > 0 && !declared.includes(options.minecraftVersion))
			throw selectionFailure(
				"ADDON_VERSION_MISMATCH",
				`addon ${id}@${addon.version} declares minecraft ${declared.join(", ")}, session is ${options.minecraftVersion}`,
			);
		for (const [requiredId, requiredVersion] of Object.entries(addon.manifest.requiresAddons)) {
			if (!enabledIds.includes(requiredId))
				throw selectionFailure(
					"ADDON_DEPENDENCY_MISSING",
					`addon ${id} requires addon ${requiredId} to be enabled on this profile`,
				);
			const dependency = byId.get(requiredId);
			if (dependency && requiredVersion !== "*" && dependency.version !== requiredVersion)
				throw selectionFailure(
					"ADDON_DEPENDENCY_MISSING",
					`addon ${id} requires ${requiredId}@${requiredVersion}, installed ${dependency.version}`,
				);
		}
		// 真实路径必须留在安装根内：符号链接指到别处时不执行。
		const [realDir, realEntry] = await Promise.all([
			realpath(addon.dir).catch(() => addon.dir),
			realpath(addon.entry).catch(() => addon.entry),
		]);
		if (realDir !== realRoot && !realDir.startsWith(realRoot + sep))
			throw selectionFailure("ADDON_PATH_UNTRUSTED", `addon ${id} resolves outside the install root: ${realDir}`);
		if (!realEntry.startsWith(realDir + sep))
			throw selectionFailure("ADDON_PATH_UNTRUSTED", `addon ${id} entry resolves outside its package: ${realEntry}`);
		entries.push({
			id,
			version: addon.version,
			api: ADDON_API_VERSION,
			root: realDir,
			entry: realEntry,
			config: selection.enabled[id] ?? {},
			minecraft: [...declared],
			serverRequirement: addon.manifest.serverRequirement,
		});
	}
	return { digest: selectionDigest(entries), entries };
}

/**
 * 离线目录摘要：只读 Manifest，不 import 第三方代码。
 * 这些包的能力**不会**出现在离线目录里——"已安装"不等于"可执行"。
 */
export async function installedAddonStatuses(minecraftRoot: string): Promise<AddonStatus[]> {
	const installed = await scanInstalledAddons(join(minecraftRoot, "addons"));
	return installed.addons.map((addon) => ({
		id: addon.id,
		version: addon.version,
		api: ADDON_API_VERSION,
		state: "installed" as const,
		minecraft: [...addon.manifest.minecraft],
		serverRequirement: addon.manifest.serverRequirement,
		dir: addon.dir,
		contributed: { actions: 0, queries: 0, knowledgeItems: 0, refs: [] },
	}));
}
