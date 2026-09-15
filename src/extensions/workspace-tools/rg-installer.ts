/**
 * ripgrep 获取：PATH → ~/.uina/bin 缓存 → GitHub release 下载（失败则由调用方降级 node 引擎）。
 *
 * 机制参考 pi tools-manager.ts，按 Uina 边界精简：
 * - 版本固定（14.1.1）而非拉 latest：少一次 API 往返、可预期、不受 GitHub API 限额影响；
 * - 解压依赖系统 tar（Windows 10+ 自带 bsdtar，可直接解 zip），不引解压库；
 * - 并发去重：同一进程内多次调用共享同一次下载。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const RG_VERSION = "14.1.1";

function binDir(): string {
	return join(homedir(), ".uina", "bin");
}

function rgBinaryName(): string {
	return platform() === "win32" ? "rg.exe" : "rg";
}

/** 缓存路径（不保证存在）；ensureRg 探测顺序：缓存 → PATH → 下载。 */
function cachedPath(): string {
	return join(binDir(), rgBinaryName());
}

function commandExists(cmd: string): boolean {
	const result = spawnSync(cmd, ["--version"], { stdio: "pipe", shell: false });
	return !result.error && result.status === 0;
}

let inflight: Promise<string | null> | undefined;
/** 进程内 memo：成功结果不再重探；失败负缓存 10 分钟（离线机器不每次撞 120s 超时）。 */
let resolved: string | null | undefined;
let lastFailureAt = 0;
const FAILURE_TTL_MS = 10 * 60 * 1000;

export async function ensureRg(): Promise<string | null> {
	if (resolved !== undefined) return resolved;
	if (inflight) return inflight;
	if (Date.now() - lastFailureAt < FAILURE_TTL_MS) return null;
	inflight = ensureRgInner()
		.then((value) => {
			resolved = value;
			return value;
		})
		.catch((error) => {
			inflight = undefined;
			lastFailureAt = Date.now();
			throw error;
		});
	try {
		return await inflight;
	} catch {
		return null; // 下载失败交由调用方降级 node 引擎
	}
}

async function ensureRgInner(): Promise<string | null> {
	const local = cachedPath();
	if (existsSync(local) && commandExists(local)) return local;
	if (commandExists("rg")) return "rg";
	return downloadRg();
}

function downloadRg(): Promise<string | null> {
	inflight ??= downloadRgInner().catch((error) => {
		inflight = undefined;
		throw error;
	});
	return inflight;
}

async function downloadRgInner(): Promise<string> {
	const plat = platform();
	const architecture = arch();
	let assetName: string | null = null;
	if (plat === "win32") {
		assetName = `ripgrep-${RG_VERSION}-${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.zip`;
	} else if (plat === "darwin") {
		assetName = `ripgrep-${RG_VERSION}-${architecture === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`;
	} else if (plat === "linux") {
		assetName = `ripgrep-${RG_VERSION}-${architecture === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl.tar.gz`;
	}
	if (!assetName) throw new Error(`不支持的 ${plat}/${architecture} 平台`);

	const dir = binDir();
	mkdirSync(dir, { recursive: true });
	const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${assetName}`;
	const archivePath = join(dir, assetName);
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath));

	const extractDir = join(dir, `extract_tmp_${process.pid}_${Date.now()}`);
	mkdirSync(extractDir, { recursive: true });
	try {
		// Windows 10+ 的 System32 tar.exe 是 bsdtar，可直接解 zip
		const tar = plat === "win32" ? join(process.env.SystemRoot ?? "", "System32", "tar.exe") : "tar";
		const extract = spawnSync(tar, ["xf", archivePath, "-C", extractDir], { stdio: "pipe", shell: false });
		if (extract.error || extract.status !== 0) {
			throw new Error(`解压失败：${extract.error?.message ?? extract.stderr?.toString().trim() ?? "tar 退出码 " + extract.status}`);
		}
		const binaryFileName = rgBinaryName();
		const nested = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""), binaryFileName);
		const binary = [nested, join(extractDir, binaryFileName)].find(existsSync) ?? findRgRecursively(extractDir, binaryFileName);
		if (!binary) throw new Error(`压缩包内未找到 ${binaryFileName}`);
		const target = cachedPath();
		renameSync(binary, target);
		if (plat !== "win32") chmodSync(target, 0o755);
		return target;
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}
}

function findRgRecursively(dir: string, fileName: string): string | null {
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isFile() && entry.name === fileName) return full;
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return null;
}
