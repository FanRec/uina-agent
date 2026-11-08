/**
 * Addon 运维入口（list / inspect / install / enable / disable / remove / status / migrate / gc）。
 *
 * 这是**运维 API**，不是 Agent 的普通 mc.call：Agent 不能通过 connect 参数提供任意 JS 路径执行代码。
 * 不开发第二套包管理器：安装 = 把已校验的包目录提交为不可变 artifact，依赖交给 npm/pnpm。
 * 所有配置写入都是同进程串行 + 同目录临时文件 + rename；失败不会留下半写入状态。
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AddonStatus } from "../contracts/addons.js";
import type { JsonValue } from "../contracts/values.js";
import { callFailure } from "../contracts/values.js";
import { installedAddonStatuses, readAddonSelectionFile, resolveAddonPlan, writeAddonSelectionFile } from "./plan.js";
import {
	type AddonScanProblem,
	collectUnreferencedArtifacts,
	installAddonArtifact,
	type InstalledArtifact,
	migrateLegacyLayout,
	removeAddonArtifact,
	scanInstalledArtifacts,
	withFileLock,
} from "./store.js";

export interface AddonInventoryEntry {
	addon: InstalledArtifact;
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

function profileDir(root: string, profileId: string): string {
	return join(root, "sessions", profileId);
}

function selectionPath(root: string, profileId: string): string {
	return join(profileDir(root, profileId), "addons.json");
}

function assertProfileId(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value))
		throw manageFailure("INVALID_INPUT", "profile id must be a 64-hex digest (see `list` output)");
}

/** 所有 Profile 的启用集合。坏配置文件不能被当成"未启用"，否则卸载会误删在用的包。 */
async function enabledByProfile(root: string): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>();
	const sessions = join(root, "sessions");
	let entries: string[];
	try {
		entries = await readdir(sessions);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	for (const entry of entries) {
		if (!/^[a-f0-9]{64}$/.test(entry)) continue;
		const selection = await readAddonSelectionFile(join(sessions, entry));
		result.set(entry, Object.keys(selection.enabled).sort());
	}
	return result;
}

export async function listInstalledAddons(
	root: string,
): Promise<{ addons: AddonInventoryEntry[]; problems: AddonScanProblem[] }> {
	const installed = await scanInstalledArtifacts(root);
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
			`addon ${id} is not installed under ${join(root, "addons")}`,
			known.length > 0 ? `installed: ${known.join(", ")}` : "no addons are installed",
		);
	}
	return found;
}

/** 安装只提交一份新 artifact 并替换映射；当前会话继续用已加载的旧字节。 */
export async function installAddon(root: string, sourceDir: string): Promise<InstalledArtifact> {
	return await installAddonArtifact(root, sourceDir);
}

export async function enableAddon(options: {
	root: string;
	profileId: string;
	id: string;
	config?: JsonValue;
}): Promise<void> {
	assertProfileId(options.profileId);
	await inspectAddon(options.root, options.id);
	const dir = profileDir(options.root, options.profileId);
	await mkdir(dir, { recursive: true });
	await withFileLock(selectionPath(options.root, options.profileId), async () => {
		const selection = await readAddonSelectionFile(dir);
		selection.enabled[options.id] = options.config ?? {};
		await writeAddonSelectionFile(dir, selection);
	});
}

export async function disableAddon(options: { root: string; profileId: string; id: string }): Promise<void> {
	assertProfileId(options.profileId);
	const dir = profileDir(options.root, options.profileId);
	await withFileLock(selectionPath(options.root, options.profileId), async () => {
		const selection = await readAddonSelectionFile(dir);
		if (!(options.id in selection.enabled))
			throw manageFailure("ADDON_NOT_ENABLED", `addon ${options.id} is not enabled on profile ${options.profileId}`);
		delete selection.enabled[options.id];
		await writeAddonSelectionFile(dir, selection);
	});
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
	await removeAddonArtifact(root, id);
}

/** 状态：已安装包 + 可选 Profile 的装配预检（不 import 代码）。 */
export async function addonStatus(
	root: string,
	profileId?: string,
): Promise<{
	addons: AddonStatus[];
	problems: AddonScanProblem[];
	selection: { digest: string; roots: string[]; ids: string[] } | null;
}> {
	const installed = await scanInstalledArtifacts(root);
	const statuses = await installedAddonStatuses(root);
	if (profileId === undefined) return { addons: statuses, problems: installed.problems, selection: null };
	assertProfileId(profileId);
	const plan = await resolveAddonPlan({
		minecraftRoot: root,
		profileDir: profileDir(root, profileId),
		minecraftVersion: process.env.UINA_MC_VERSION ?? "1.21.11",
	});
	return {
		addons: statuses,
		problems: installed.problems,
		selection: {
			digest: plan.digest,
			roots: [...plan.roots],
			ids: plan.ordered.map((entry) => `${entry.id}@${entry.version}`),
		},
	};
}

/** 一次性旧布局迁移：必须在所有会话关闭后执行。 */
export async function migrateAddonLayout(root: string): Promise<string[]> {
	return await migrateLegacyLayout(root);
}

/** 离线回收无引用的 artifact；同样必须在所有会话关闭后执行。 */
export async function collectAddonArtifacts(root: string): Promise<string[]> {
	return await collectUnreferencedArtifacts(root);
}
