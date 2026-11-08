/**
 * Addon 不可变包存储。
 *
 * 唯一数据布局：
 *   addons/artifacts/<id>/<完整内容摘要>/...  （安装后不再改写）
 *   addons/installed.json                      （id -> 当前生效摘要，原子替换）
 *
 * 安装先把来源复制进同文件系统的暂存目录，校验 Manifest/入口与全部字节摘要，
 * 再 rename 成 artifact 目录，最后原子更新映射。运行中更新/移除只换映射，
 * 当前会话已经加载的旧字节继续可用。摘要覆盖稳定相对路径 + 文件字节，
 * 排除包根 `.git`；符号链接一律拒绝，否则摘要无法代表真实执行内容。
 */

import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { callFailure } from "../contracts/values.js";
import { type InstalledAddon, readInstalledAddon } from "./manifest.js";

export const INSTALLED_INDEX_FILE = "installed.json";

export interface InstalledIndex {
	version: 1;
	/** addon id -> 当前生效的 artifact 内容摘要。 */
	installed: Record<string, string>;
}

export interface InstalledArtifact extends InstalledAddon {
	artifactDigest: string;
}

export interface AddonScanProblem {
	/** 映射里的 addon id；坏到读不出 id 时用目录名，仍可定位。 */
	id: string;
	dir: string;
	/** 原始失败码（CallFailure.code 或 ADDON_STORE_INVALID），供调用方区分"没装"与"装坏了"。 */
	code: string;
	error: string;
}

function storeFailure(code: string, message: string): Error {
	return callFailure({
		code,
		source: "environment",
		message,
		dispatch: "not_sent",
		effects: [],
		recoverable: false,
	});
}

export function addonsRoot(minecraftRoot: string): string {
	return join(minecraftRoot, "addons");
}

function artifactsRoot(minecraftRoot: string): string {
	return join(addonsRoot(minecraftRoot), "artifacts");
}

export function artifactDir(minecraftRoot: string, id: string, digest: string): string {
	return join(artifactsRoot(minecraftRoot), id, digest);
}

function indexPath(minecraftRoot: string): string {
	return join(addonsRoot(minecraftRoot), INSTALLED_INDEX_FILE);
}

/** 同一路径的读-改-写在进程内串行；写入本身仍是临时文件 + rename，杜绝丢更新。 */
const tails = new Map<string, Promise<void>>();
export async function withFileLock<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = tails.get(key);
	let done!: () => void;
	const current = new Promise<void>((resolve) => {
		done = resolve;
	});
	tails.set(key, current);
	if (previous) await previous;
	try {
		return await work();
	} finally {
		done();
		if (tails.get(key) === current) tails.delete(key);
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export async function readInstalledIndex(minecraftRoot: string): Promise<InstalledIndex> {
	const path = indexPath(minecraftRoot);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, installed: {} };
		throw storeFailure("ADDON_STORE_INVALID", `${path}: unreadable (${String(error)})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw storeFailure("ADDON_STORE_INVALID", `${path}: invalid JSON (${String(error)})`);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
		throw storeFailure("ADDON_STORE_INVALID", `${path}: expected an object`);
	const record = parsed as Record<string, unknown>;
	if (
		record.version !== 1 ||
		record.installed == null ||
		typeof record.installed !== "object" ||
		Array.isArray(record.installed)
	)
		throw storeFailure("ADDON_STORE_INVALID", `${path}: expected { version: 1, installed }`);
	const installed: Record<string, string> = {};
	for (const [id, digest] of Object.entries(record.installed as Record<string, unknown>)) {
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
			throw storeFailure("ADDON_STORE_INVALID", `${path}: invalid installed entry ${id}`);
		installed[id] = digest;
	}
	return { version: 1, installed };
}

/** 路径按字节序排序，摘要与文件系统遍历顺序无关。 */
function compareName(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 全目录内容摘要：稳定相对路径 + 每个文件的字节 hash。 */
export async function directoryDigest(dir: string): Promise<string> {
	const hash = createHash("sha256");
	const files: string[] = [];
	async function walk(current: string): Promise<void> {
		const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => compareName(a.name, b.name));
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const full = join(current, entry.name);
			if (entry.isSymbolicLink())
				throw storeFailure("ADDON_SOURCE_INVALID", `addon source contains a symbolic link: ${full}`);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) files.push(full);
			else throw storeFailure("ADDON_SOURCE_INVALID", `addon source contains a non-file entry: ${full}`);
		}
	}
	await walk(dir);
	for (const file of files.sort(compareName)) {
		const path = relative(dir, file).split(sep).join("/");
		hash.update(`f\0${path}\0`);
		hash.update(
			createHash("sha256")
				.update(await readFile(file))
				.digest(),
		);
	}
	return hash.digest("hex");
}

/**
 * 安装一份不可变执行快照。同 id 的更新只替换 `installed.json` 映射，
 * 不改写任何已存在的 artifact 目录（活动会话可能仍在用旧字节）。
 */
export async function installAddonArtifact(minecraftRoot: string, sourceDir: string): Promise<InstalledArtifact> {
	const source = await stat(sourceDir).catch(() => null);
	if (!source?.isDirectory()) throw storeFailure("ADDON_SOURCE_INVALID", `${sourceDir} is not a directory`);
	await readInstalledAddon(sourceDir);
	const root = addonsRoot(minecraftRoot);
	await mkdir(root, { recursive: true });
	const staging = join(root, `.staging-${randomUUID()}`);
	try {
		await cp(sourceDir, staging, {
			recursive: true,
			// 精确排除包根 .git；`source/.gitignore` 不能被子串匹配误删。
			filter: (path) => path !== join(sourceDir, ".git"),
		});
		const staged = await readInstalledAddon(staging);
		const digest = await directoryDigest(staging);
		const target = artifactDir(minecraftRoot, staged.id, digest);
		const relativeEntry = relative(staging, staged.entry);
		const present = await stat(target).catch(() => null);
		if (present == null) {
			await mkdir(dirname(target), { recursive: true });
			await rename(staging, target);
		}
		await withFileLock(indexPath(minecraftRoot), async () => {
			const index = await readInstalledIndex(minecraftRoot);
			index.installed[staged.id] = digest;
			await atomicWriteJson(indexPath(minecraftRoot), index);
		});
		return {
			...staged,
			dir: target,
			entry: join(target, relativeEntry),
			artifactDigest: digest,
		};
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/** 只解除安装映射；artifact 目录留给仍在运行的会话，离线回收另行执行。 */
export async function removeAddonArtifact(minecraftRoot: string, id: string): Promise<void> {
	await withFileLock(indexPath(minecraftRoot), async () => {
		const index = await readInstalledIndex(minecraftRoot);
		if (!(id in index.installed)) throw storeFailure("ADDON_NOT_INSTALLED", `addon ${id} is not installed`);
		delete index.installed[id];
		await atomicWriteJson(indexPath(minecraftRoot), index);
	});
}

/** 离线回收：删除已无任何映射引用的 artifact 目录。必须在所有会话关闭后执行。 */
export async function collectUnreferencedArtifacts(minecraftRoot: string): Promise<string[]> {
	const index = await readInstalledIndex(minecraftRoot);
	const referenced = new Set(Object.entries(index.installed).map(([id, digest]) => `${id}/${digest}`));
	const removed: string[] = [];
	const byId = await readdir(artifactsRoot(minecraftRoot), { withFileTypes: true }).catch(() => []);
	for (const idEntry of byId.sort((a, b) => compareName(a.name, b.name))) {
		if (!idEntry.isDirectory()) continue;
		const dir = join(artifactsRoot(minecraftRoot), idEntry.name);
		const digests = await readdir(dir, { withFileTypes: true });
		for (const digestEntry of digests.sort((a, b) => compareName(a.name, b.name))) {
			if (!digestEntry.isDirectory() || referenced.has(`${idEntry.name}/${digestEntry.name}`)) continue;
			await rm(join(dir, digestEntry.name), { recursive: true, force: true });
			removed.push(`${idEntry.name}/${digestEntry.name}`);
		}
	}
	return removed;
}

/** 按 installed.json 列出当前生效的包；坏映射记入 problems，不静默跳过。 */
export async function scanInstalledArtifacts(minecraftRoot: string): Promise<{
	addons: InstalledArtifact[];
	problems: AddonScanProblem[];
}> {
	const index = await readInstalledIndex(minecraftRoot);
	const addons: InstalledArtifact[] = [];
	const problems: AddonScanProblem[] = [];
	for (const [id, digest] of Object.entries(index.installed).sort(([a], [b]) => compareName(a, b))) {
		const dir = artifactDir(minecraftRoot, id, digest);
		try {
			const installed = await readInstalledAddon(dir);
			if (installed.id !== id) throw new Error(`installed.json maps ${id} to an artifact declaring ${installed.id}`);
			addons.push({ ...installed, artifactDigest: digest });
		} catch (error) {
			problems.push({
				id,
				dir,
				code:
					typeof (error as { code?: unknown }).code === "string"
						? (error as { code: string }).code
						: "ADDON_STORE_INVALID",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { addons, problems };
}

/**
 * 一次性迁移旧的 `<root>/addons/<id>` 布局。数据根必须先关闭所有会话。
 * 只在 CLI 显式执行 `migrate` 时调用；运行时永远只读 installed.json，没有旧格式后备。
 */
export async function migrateLegacyLayout(minecraftRoot: string): Promise<string[]> {
	const root = addonsRoot(minecraftRoot);
	// 可重入：内容摘要相同即命中同一 artifact，重复执行只替换同一映射。
	// 半途失败后能直接重跑，不会因为"映射非空"卡死在半迁移状态。
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const migrated: string[] = [];
	for (const entry of entries.sort((a, b) => compareName(a.name, b.name))) {
		if (!entry.isDirectory() || entry.name === "artifacts" || entry.name.startsWith(".staging-")) continue;
		const legacy = join(root, entry.name);
		const artifact = await installAddonArtifact(minecraftRoot, legacy);
		await rm(legacy, { recursive: true, force: false });
		migrated.push(`${artifact.id}@${artifact.version}`);
	}
	return migrated;
}
