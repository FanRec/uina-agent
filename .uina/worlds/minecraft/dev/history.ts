/** Explicit, offline history maintenance. No default data root, partition, or cutoff. */
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import type { WorldHistoryPrune } from "../contracts/world.js";
import type { WorkerRequest, WorkerResponse } from "../world/sqlite-worker.js";

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((argument) => argument !== "--"),
		options: {
			"data-root": { type: "string" },
			partition: { type: "string" },
			"before-store-seq": { type: "string" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		console.log(
			'Usage: pnpm dev:mc:history -- --data-root <directory> --partition \'["binding","world","worldRevision"]\' --before-store-seq <exclusive cutoff>',
		);
		return;
	}
	if (!values["data-root"] || !values.partition || values["before-store-seq"] === undefined)
		throw new Error("explicit --data-root, --partition and --before-store-seq are required (see --help)");
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
