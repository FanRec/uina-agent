/**
 * Addon 运维入口（list / inspect / install / enable / disable / remove / status）。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §2.4。这是**运维 API**，不是 Agent 的
 * 普通 mc.call：Agent 不能通过 connect 参数提供任意 JS 路径执行代码。
 * 不开发第二套包管理器：安装=复制已校验的包目录，依赖交给 npm/pnpm。
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AddonStatus } from "../contracts/addons.js";
import type { JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { type AddonScanProblem, type InstalledAddon, readInstalledAddon, scanInstalledAddons } from "./manifest.js";
import { installedAddonStatuses, readAddonSelectionFile, resolveAddonPlan, writeAddonSelectionFile } from "./plan.js";

export interface AddonInventoryEntry {
	addon: InstalledAddon;
	/** 启用了该包的 Profile id（未启用 = 空数组）。 */
	enabledIn: string[];
}

function manageFailure(code: string, message: string, hint?: string): Error {
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

function addonsRoot(root: string): string {
	return join(root, "addons");
}

/** 所有 Profile 的启用集合：`profileId -> enabled ids`。 */
async function enabledByProfile(root: string): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	const sessions = join(root, "sessions");
	let entries: string[];
	try {
		entries = await readdir(sessions);
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (!/^[a-f0-9]{64}$/.test(entry)) continue;
		const selection = await readAddonSelectionFile(join(sessions, entry)).catch(() => null);
		if (selection) result.set(entry, Object.keys(selection.enabled).sort());
	}
	return result;
}

export async function listInstalledAddons(
	root: string,
): Promise<{ addons: AddonInventoryEntry[]; problems: AddonScanProblem[] }> {
	const installed = await scanInstalledAddons(addonsRoot(root));
	const enabled = await enabledByProfile(root);
	const addons = installed.addons.map((addon) => ({
		addon,
		enabledIn: [...enabled.entries()].filter(([, ids]) => ids.includes(addon.id)).map(([profile]) => profile),
	}));
	return { addons, problems: installed.problems };
}

export async function inspectAddon(root: string, id: string): Promise<AddonInventoryEntry> {
	const listed = await listInstalledAddons(root);
	const found = listed.addons.find((entry) => entry.addon.id === id);
	if (!found) {
		const known = listed.addons.map((entry) => entry.addon.id).sort();
		throw manageFailure(
			"ADDON_NOT_INSTALLED",
			`addon ${id} is not installed under ${addonsRoot(root)}`,
			known.length > 0 ? `installed: ${known.join(", ")}` : "no addons are installed",
		);
	}
	return found;
}

/**
 * 安装=把一个已校验的包目录复制到 `<root>/addons/<id>`。
 * 已存在同 id 包时拒绝覆盖（活动会话可能正在用旧版本）：先 remove 再 install。
 */
export async function installAddon(root: string, sourceDir: string): Promise<InstalledAddon> {
	const source = await stat(sourceDir).catch(() => null);
	if (!source?.isDirectory()) throw manageFailure("ADDON_SOURCE_INVALID", `${sourceDir} is not a directory`);
	const addon = await readInstalledAddon(sourceDir);
	const target = join(addonsRoot(root), addon.id);
	const existing = await stat(target).catch(() => null);
	if (existing)
		throw manageFailure(
			"ADDON_ALREADY_INSTALLED",
			`addon ${addon.id} already exists at ${target}`,
			"remove it first; a running session keeps using the version it loaded",
		);
	await mkdir(addonsRoot(root), { recursive: true });
	const gitDir = join(sourceDir, ".git");
	await cp(sourceDir, target, {
		recursive: true,
		// 只剪掉包根下的 .git 目录；用精确比较，否则 `source/.gitignore` 会被子串匹配误删。
		filter: (path) => path !== gitDir,
	});
	const installed = await readInstalledAddon(target);
	return installed;
}

export async function enableAddon(options: {
	root: string;
	profileId: string;
	id: string;
	config?: JsonValue;
}): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(options.profileId))
		throw manageFailure("INVALID_INPUT", "profile id must be a 64-hex digest (see `list` output)");
	await inspectAddon(options.root, options.id);
	const profileDir = join(options.root, "sessions", options.profileId);
	await mkdir(profileDir, { recursive: true });
	const selection = await readAddonSelectionFile(profileDir);
	selection.enabled[options.id] = options.config ?? {};
	await writeAddonSelectionFile(profileDir, selection);
}

export async function disableAddon(options: { root: string; profileId: string; id: string }): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(options.profileId))
		throw manageFailure("INVALID_INPUT", "profile id must be a 64-hex digest");
	const profileDir = join(options.root, "sessions", options.profileId);
	const selection = await readAddonSelectionFile(profileDir);
	if (!(options.id in selection.enabled))
		throw manageFailure("ADDON_NOT_ENABLED", `addon ${options.id} is not enabled on profile ${options.profileId}`);
	delete selection.enabled[options.id];
	await writeAddonSelectionFile(profileDir, selection);
}

/** 卸载：任何 Profile 仍启用时拒绝（先 disable），避免"删了包但配置还引用"的半状态。 */
export async function removeAddon(root: string, id: string): Promise<void> {
	const entry = await inspectAddon(root, id);
	if (entry.enabledIn.length > 0)
		throw manageFailure(
			"ADDON_IN_USE",
			`addon ${id} is enabled on profile(s): ${entry.enabledIn.join(", ")}`,
			"disable it on those profiles first",
		);
	await rm(join(addonsRoot(root), id), { recursive: true, force: false });
}

/** 状态：已安装包 + 可选 Profile 的装配预检（不 import 代码）。 */
export async function addonStatus(
	root: string,
	profileId?: string,
): Promise<{
	addons: AddonStatus[];
	problems: AddonScanProblem[];
	selection: { digest: string; ids: string[] } | null;
}> {
	const installed = await scanInstalledAddons(addonsRoot(root));
	const statuses = await installedAddonStatuses(root);
	if (profileId === undefined) return { addons: statuses, problems: installed.problems, selection: null };
	if (!/^[a-f0-9]{64}$/.test(profileId)) throw manageFailure("INVALID_INPUT", "profile id must be a 64-hex digest");
	const plan = await resolveAddonPlan({
		minecraftRoot: root,
		profileDir: join(root, "sessions", profileId),
		minecraftVersion: process.env.UINA_MC_VERSION ?? "1.21.11",
	});
	return {
		addons: statuses,
		problems: installed.problems,
		selection: { digest: plan.digest, ids: plan.entries.map((entry) => `${entry.id}@${entry.version}`) },
	};
}
