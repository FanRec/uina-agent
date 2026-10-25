import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinecraftExecutor } from "../../../.uina/worlds/minecraft/executor/index.js";

const root = await mkdtemp(join(tmpdir(), "uina-executor-fault-"));
let executor: MinecraftExecutor | null = null;
try {
	executor = await MinecraftExecutor.open({
		worldDataDir: root,
		config: {
			connection: {
				host: "127.0.0.1",
				port: 1,
				username: `T${randomUUID().slice(0, 8)}`,
				authMode: "offline",
				version: "1.21.11",
			},
			binding: null,
		},
		policy: { autoRecover: false, heartbeatIntervalMs: 25, heartbeatDeadlineMs: 250, closeGraceMs: 3000 },
	});
	const deadline = Date.now() + 6000;
	const blocking = process.env.UINA_TEST_EXECUTOR_FAULT === "block";
	while (blocking ? executor.status().phase !== "faulted" : executor.status().diagnostics.discardedBytes === 0) {
		if (Date.now() > deadline)
			throw new Error(`fault injection was not observed: ${JSON.stringify(executor.status())}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (blocking) {
		const ownership = (
			executor as unknown as { ownership: { activeProcesses(): { directory: number; account: number } } }
		).ownership;
		while (ownership.activeProcesses().directory !== 0 || ownership.activeProcesses().account !== 0) {
			if (Date.now() > deadline) throw new Error("unresponsive companion tree was not retired");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		console.log(
			JSON.stringify({
				phase: executor.status().phase,
				side: executor.status().side,
				blockObserved: executor.status().diagnostics.tail.includes("MC_FAULT_BLOCK_STARTED"),
				...ownership.activeProcesses(),
			}),
		);
	} else {
		const status = await executor.inspect();
		console.log(
			JSON.stringify({
				phase: status.phase,
				discardedBytes: status.diagnostics.discardedBytes,
				tailBytes: Buffer.byteLength(status.diagnostics.tail),
				runtime: status.side?.runtime,
			}),
		);
	}
} finally {
	await executor?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
