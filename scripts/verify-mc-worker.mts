/**
 * 验证专用 SQLite Worker 在**真实构建产物**中可启动（不经 tsx/vitest 变换路径）。
 *
 * 为什么需要它：vitest 用 TS 源码 + import.meta.url 指向 .ts 所在目录，天然能找到
 * `sqlite-worker.mjs`；真实构建产物是另一套路径与模块格式，必须单独证明：
 *   1. emit 后 `store.js` 仍按自身目录解析 Worker，模块格式是 ESM；
 *   2. 没复制 `sqlite-worker.mjs` 时**明确失败**，不静默降级；
 *   3. 复制后写入/读取/关闭可用，且 Worker 确实运行在独立线程；
 *   4. 进程在 close 之前退出（崩溃）后，已提交数据可从 WAL 恢复。
 *
 * 运行：pnpm verify:mc-worker
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const moduleRoot = join(repoRoot, ".uina", "worlds", "minecraft");
const workDir = join(repoRoot, ".workbuddy", "mc-worker-verify");
const distDir = join(workDir, "dist");
const dataDir = join(workDir, "data");
const emittedStore = join(distDir, "world", "internal", "store.js");
const workerAsset = join(distDir, "world", "internal", "sqlite-worker.mjs");

let failures = 0;

function check(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
	}
}

function runNode(args: string[], label: string): string {
	const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${label} 失败（status=${result.status}）\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout ?? "";
}

function fact(sequence: number): unknown {
	const stream = "mcw:verify:stream";
	return {
		kind: "fact",
		record: {
			ref: `${stream}:${sequence}`,
			schema: "client.verify@1",
			mark: { stream, sequence },
			stamp: {
				source: "mcw:verify:source",
				epoch: "mcw:verify:epoch:e1",
				sequence,
				connection: "c1",
				incarnation: "i1",
			},
			scope: {
				binding: "mcw:verify:b1",
				world: "mcw:verify:world",
				worldRevision: "mcw:verify:rev",
				dimension: "minecraft:overworld",
			},
			fact: {
				value: { note: `verify-${sequence}` },
				observedAt: "2026-10-17T00:00:00.000Z",
				source: "server",
				coverage: "complete",
				unknown: [],
				evidence: [],
			},
		},
	};
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log("── emit 构建产物（tsc，不经 vitest/tsx 变换）");
runNode(
	[
		join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
		join(moduleRoot, "world", "index.ts"),
		"--outDir",
		distDir,
		"--rootDir",
		moduleRoot,
		"--module",
		"nodenext",
		"--moduleResolution",
		"nodenext",
		"--target",
		"es2023",
		"--strict",
		"--skipLibCheck",
		"--types",
		"node",
		"--ignoreConfig",
	],
	"tsc emit",
);
// 产物目录自身声明 ESM（与 .uina/worlds/minecraft/package.json 的 type:module 一致）。
writeFileSync(join(distDir, "package.json"), '{ "type": "module" }\n', "utf8");
let emitted: Record<string, any> | null = null;
try {
	emitted = await import(pathToFileURL(emittedStore).href);
} catch (error) {
	console.error(error);
}
check("emit 产物存在且可按 ESM 动态加载（模块格式正确）", () => {
	if (!existsSync(emittedStore)) throw new Error(`未生成 ${emittedStore}`);
	if (!emitted || typeof emitted.openSqliteWorkerStore !== "function") {
		throw new Error("产物未导出 openSqliteWorkerStore");
	}
});
if (!emitted) {
	rmSync(workDir, { recursive: true, force: true });
	process.exit(1);
}

console.log("\n── 缺少 Worker 资产时必须明确失败（不静默降级）");
const missingAssetDataDir = join(workDir, "data-missing");
let missingAssetFailure: string | null = null;
try {
	const opened = await emitted.openSqliteWorkerStore(missingAssetDataDir);
	await opened.close();
} catch (error) {
	missingAssetFailure = String(error);
}
check("未复制 sqlite-worker.mjs 时打开失败，且原因指向缺失资产", () => {
	if (missingAssetFailure === null) throw new Error("竟然打开成功：Worker 资产缺失被静默容忍");
	if (!missingAssetFailure.includes("sqlite-worker.mjs")) {
		throw new Error(`失败原因不是缺失 Worker 资产：${missingAssetFailure}`);
	}
});

console.log("\n── 复制 Worker 资产后：写入 / 读取 / 关闭");
cpSync(join(moduleRoot, "world", "internal", "sqlite-worker.mjs"), workerAsset);
const store = await emitted.openSqliteWorkerStore(dataDir);
check("Worker 运行在独立线程（threadId != 0）", () => {
	if (!store.workerThreadId) throw new Error("workerThreadId 为 0，Worker 未启动");
});
check("持久性配置为 WAL + synchronous=FULL", () => {
	const durability = store.durability;
	if (durability?.journalMode !== "wal" || durability?.synchronous !== 2) {
		throw new Error(`实际配置：${JSON.stringify(durability)}`);
	}
});
const appended = await store.append([fact(1), fact(2), fact(3)]);
check("append 返回提交版本", () => {
	if (!appended.ok || typeof appended.version !== "number") throw new Error(JSON.stringify(appended));
});
const page = await store.listEvidence({ limit: 10 });
check("listEvidence 在同一视图返回数据与版本", () => {
	if (page?.items.length !== 3) throw new Error(`items=${page?.items.length}`);
	if (page.version !== appended.version) throw new Error(`page.version=${page.version} vs ${appended.version}`);
});
await store.close();

console.log("\n── 进程在 close 之前退出（崩溃）：已提交数据从 WAL 恢复");
const child = join(workDir, "crash-child.mjs");
writeFileSync(
	child,
	`import { openSqliteWorkerStore } from ${JSON.stringify(pathToFileURL(emittedStore).href)};
const store = await openSqliteWorkerStore(process.argv[2]);
const append = await store.append(${JSON.stringify([fact(4), fact(5)])});
if (!append.ok) throw new Error("append 失败");
// 不 close：模拟进程崩溃，验证 WAL 恢复而不是"关闭时补写"。
process.exit(0);
`,
	"utf8",
);
runNode([child, dataDir], "崩溃子进程");

const reopened = await emitted.openSqliteWorkerStore(dataDir);
const afterCrash = await reopened.listEvidence({ limit: 10 });
check("崩溃前已提交的证据全部可见（5 条，无重复）", () => {
	const refs = new Set(
		afterCrash?.items.map((item: { entry: { kind: string; record?: { ref: string } } }) =>
			item.entry.kind === "fact" ? (item.entry.record?.ref ?? "") : "",
		),
	);
	if (refs.size !== 5) throw new Error(`去重后 ref 数=${refs.size}`);
});
const recovery = await reopened.recoverySnapshot();
check("恢复快照从真实持久状态起步", () => {
	const seqs = recovery?.[0]?.persistedFactSeqs ?? [];
	if (seqs.sort((a: number, b: number) => a - b).join(",") !== "1,2,3,4,5") throw new Error(`seqs=${seqs.join(",")}`);
});
await reopened.close();

rmSync(workDir, { recursive: true, force: true });
if (failures > 0) {
	console.error(`\n构建产物验证失败：${failures} 项`);
	process.exit(1);
}
console.log("\n构建产物验证通过：Worker 在 emit 产物中可启动、可持久、可恢复。");
