/**
 * Addon 包 Manifest：只读 `package.json` 的 `uinaMinecraft` 段。
 *
 * 唯一定义来源：docs/proposals/mc/addons.md §2。Manifest 只存**静态声明**：
 * 安装、启用、加载是三个独立事实，声明本身不能证明服务端已安装对应插件/Mod。
 * 校验只读文件，不执行第三方代码。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AddonServerRequirement } from "../contracts/addons.js";
import { callFailure } from "../contracts/values.js";
import { ADDON_API_VERSION } from "./sdk.js";

export const ADDON_MANIFEST_KEY = "uinaMinecraft";

export type { AddonServerRequirement };

export interface AddonManifest {
	id: string;
	api: 1;
	version: string;
	name: string;
	packageName: string;
	/** 声明兼容的 Minecraft 版本；空数组 = 未声明（不据此拒绝）。 */
	minecraft: readonly string[];
	requiresAddons: Readonly<Record<string, string>>;
	serverRequirement: AddonServerRequirement | null;
	/** package.json main（包内相对路径，已规范化）。 */
	entry: string;
}

export interface InstalledAddon {
	id: string;
	version: string;
	/** 包根目录（绝对路径）。 */
	dir: string;
	/** 入口文件（绝对路径，已确认位于包根内）。 */
	entry: string;
	manifest: AddonManifest;
}

export interface AddonScanProblem {
	dir: string;
	error: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function manifestFailure(code: string, message: string): Error {
	return callFailure({
		code,
		source: "environment",
		message,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

function objectOf(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** 入口必须留在包根内：不跟随 `..`、不接受绝对路径。 */
function entryPath(dir: string, entry: string): string {
	if (isAbsolute(entry)) throw manifestFailure("ADDON_MANIFEST_INVALID", `entry must be package-relative: ${entry}`);
	const absolute = resolve(dir, entry);
	if (absolute !== dir && !absolute.startsWith(dir + sep))
		throw manifestFailure("ADDON_MANIFEST_INVALID", `entry escapes the package root: ${entry}`);
	return absolute;
}

/** 解析阶段（无包目录）先拒绝绝对路径与 `..` 逃逸，不等到落盘扫描。 */
function assertEntryShape(entry: string): void {
	if (isAbsolute(entry)) throw manifestFailure("ADDON_MANIFEST_INVALID", `entry must be package-relative: ${entry}`);
	const virtualRoot = resolve(sep, "uina-addon-root");
	const resolved = resolve(virtualRoot, entry);
	if (resolved !== virtualRoot && !resolved.startsWith(virtualRoot + sep))
		throw manifestFailure("ADDON_MANIFEST_INVALID", `entry escapes the package root: ${entry}`);
}

export function parseAddonManifest(raw: unknown, source: string): AddonManifest {
	const pkg = objectOf(raw);
	if (!pkg) throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: package.json is not an object`);
	const declared = objectOf(pkg[ADDON_MANIFEST_KEY]);
	if (!declared) throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: missing "${ADDON_MANIFEST_KEY}" section`);
	if (declared.api !== ADDON_API_VERSION)
		throw manifestFailure(
			"ADDON_API_UNSUPPORTED",
			`${source}: api ${JSON.stringify(declared.api)} is not supported (expected ${ADDON_API_VERSION})`,
		);
	const id = typeof declared.id === "string" ? declared.id : "";
	if (!ID_PATTERN.test(id))
		throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: invalid addon id ${JSON.stringify(id)}`);
	const version = typeof pkg.version === "string" ? pkg.version : "";
	if (!VERSION_PATTERN.test(version))
		throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: invalid package version ${JSON.stringify(version)}`);
	const minecraft = declared.minecraft;
	if (minecraft !== undefined && (!Array.isArray(minecraft) || minecraft.some((v) => typeof v !== "string")))
		throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: minecraft must be a string array`);
	const requiresRaw = objectOf(declared.requiresAddons) ?? {};
	const requiresAddons: Record<string, string> = {};
	for (const [key, value] of Object.entries(requiresRaw)) {
		if (!ID_PATTERN.test(key) || typeof value !== "string")
			throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: invalid requiresAddons entry ${key}`);
		requiresAddons[key] = value;
	}
	let serverRequirement: AddonServerRequirement | null = null;
	const requirement = objectOf(declared.serverRequirement);
	if (requirement) {
		const kind = requirement.kind;
		if (kind !== "plugin" && kind !== "mod" && kind !== "mod-or-plugin")
			throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: invalid serverRequirement.kind`);
		if (typeof requirement.id !== "string" || requirement.id.length === 0)
			throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: serverRequirement.id is required`);
		const requiredFor = requirement.requiredFor ?? "feature";
		if (requiredFor !== "feature" && requiredFor !== "connection")
			throw manifestFailure("ADDON_MANIFEST_INVALID", `${source}: invalid serverRequirement.requiredFor`);
		serverRequirement = {
			kind,
			id: requirement.id,
			requiredFor,
			...(typeof requirement.note === "string" ? { note: requirement.note } : {}),
		};
	}
	const main = typeof pkg.main === "string" && pkg.main.length > 0 ? pkg.main : "./index.js";
	assertEntryShape(main);
	return {
		id,
		api: ADDON_API_VERSION,
		version,
		name: typeof pkg.name === "string" ? pkg.name : id,
		packageName: typeof pkg.name === "string" ? pkg.name : id,
		minecraft: Array.isArray(minecraft) ? (minecraft as string[]) : [],
		requiresAddons,
		serverRequirement,
		entry: main,
	};
}

/** 读一个包目录的 Manifest（不执行代码；入口文件必须真实存在）。 */
export async function readInstalledAddon(dir: string): Promise<InstalledAddon> {
	const manifestPath = join(dir, "package.json");
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
	} catch (error) {
		throw manifestFailure("ADDON_MANIFEST_INVALID", `${manifestPath}: unreadable package.json (${String(error)})`);
	}
	const manifest = parseAddonManifest(raw, manifestPath);
	const entry = entryPath(dir, manifest.entry);
	const info = await stat(entry).catch(() => null);
	if (!info?.isFile())
		throw manifestFailure("ADDON_ENTRY_MISSING", `${manifest.id}: entry ${manifest.entry} is not a file under ${dir}`);
	return { id: manifest.id, version: manifest.version, dir, entry, manifest };
}

/**
 * 扫描安装根。坏包不阻止其它包（返回 problems），但启用列表引用坏包时
 * 由 plan 解析显式失败——不静默跳过用户明确启用的包。
 */
export async function scanInstalledAddons(root: string): Promise<{
	addons: InstalledAddon[];
	problems: AddonScanProblem[];
}> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { addons: [], problems: [] };
		throw error;
	}
	const addons: InstalledAddon[] = [];
	const problems: AddonScanProblem[] = [];
	const seen = new Map<string, string>();
	for (const name of entries.sort()) {
		const dir = join(root, name);
		const info = await stat(dir).catch(() => null);
		if (!info?.isDirectory()) continue;
		try {
			const addon = await readInstalledAddon(dir);
			const previous = seen.get(addon.id);
			if (previous) {
				problems.push({ dir, error: `duplicate addon id ${addon.id} (also installed at ${previous})` });
				continue;
			}
			seen.set(addon.id, dir);
			addons.push(addon);
		} catch (error) {
			problems.push({ dir, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { addons, problems };
}
