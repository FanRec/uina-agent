/** Explicit, offline history maintenance. No default data root, partition, or cutoff. */
import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import type { WorldHistoryPrune } from "../contracts/world.js";
import type { WorkerRequest, WorkerResponse } from "../world/sqlite-worker.js";

/** G16 体量观测：WAL 库的页级统计 + 文件字节数（离线或活库的只读连接均可）。 */
async function reportStats(dataRoot: string): Promise<void> {
	for (const name of ["runtime.db", "world-history.db"]) {
		const dbPath = join(resolve(dataRoot), name);
		try {
			await stat(dbPath);
		} catch {
			console.log(JSON.stringify({ db: name, present: false }));
			continue;
		}
		const db = new DatabaseSync(dbPath);
		db.exec("PRAGMA busy_timeout = 5000");
		try {
			const scalar = (pragma: string): number =>
				(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[pragma.replace("PRAGMA ", "")];
			const pageSize = scalar("PRAGMA page_size");
			const pageCount = scalar("PRAGMA page_count");
			const freelistPages = scalar("PRAGMA freelist_count");
			const bytes = (await stat(dbPath)).size;
			const walBytes = await stat(`${dbPath}-wal`)
				.then((s) => s.size)
				.catch(() => 0);
			console.log(
				JSON.stringify({
					db: name,
					present: true,
					bytes,
					walBytes,
					pageSize,
					pageCount,
					usedBytes: (pageCount - freelistPages) * pageSize,
					freeBytes: freelistPages * pageSize,
				}),
			);
		} finally {
			db.close();
		}
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((argument) => argument !== "--"),
		options: {
			"data-root": { type: "string" },
			partition: { type: "string" },
			"before-store-seq": { type: "string" },
			stats: { type: "boolean" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		console.log(
			'Usage: pnpm dev:mc:history -- --data-root <directory> [--stats | --partition \'["binding","world","worldRevision"]\' --before-store-seq <exclusive cutoff>]',
		);
		return;
	}
	if (!values["data-root"]) throw new Error("explicit --data-root is required (see --help)");
	if (values.stats) {
		await reportStats(values["data-root"]);
		return;
	}
	if (!values.partition || values["before-store-seq"] === undefined)
		throw new Error("prune needs --partition and --before-store-seq (or use --stats; see --help)");
	const parts: unknown = JSON.parse(values.partition);
	if (!Array.isArray(parts) || parts.length !== 3 || parts.some((part) => typeof part !== "string" || !part.trim()))
		throw new Error("--partition must be a JSON [binding,world,worldRevision] tuple");
	const cutoff = Number(values["before-store-seq"]);
	if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !/^\d+$/.test(values["before-store-seq"]))
		throw new Error("--before-store-seq must be a nonnegative safe integer");
	const dbPath = join(resolve(values["data-root"]), "world-history.db");
	if (!(await stat(dbPath)).isFile()) throw new Error(`history database is not a file: ${dbPath}`);
	const options: WorldHistoryPrune = {
		partition: { binding: String(parts[0]), world: String(parts[1]), worldRevision: String(parts[2]) },
		beforeStoreSeq: cutoff,
	};
	const workerFile = import.meta.url.endsWith(".js") ? "../world/sqlite-worker.js" : "../world/sqlite-worker.ts";
	const worker = new Worker(new URL(workerFile, import.meta.url));
	const post = (request: WorkerRequest) => worker.postMessage(request);
	try {
		await new Promise<void>((resolveDone, reject) => {
			worker.on("error", reject);
			worker.on("exit", (code) => {
				if (code !== 0) reject(new Error(`history worker exited: ${code}`));
			});
			worker.on("message", (message: WorkerResponse) => {
				if (message.type === "opened") post({ type: "prune", id: 1, options });
				else if (message.type === "pruned") {
					console.log(JSON.stringify({ dbPath, partition: options.partition, ...message.result }));
					post({ type: "close" });
				} else if (message.type === "closed") resolveDone();
				else if (message.type === "fatal" || message.type === "conflict" || message.type === "queryFailed")
					reject(new Error(message.message));
			});
			post({ type: "open", dbPath });
		});
	} finally {
		await worker.terminate();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
