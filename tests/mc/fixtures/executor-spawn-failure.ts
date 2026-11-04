import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinecraftExecutor } from "../../../.uina/worlds/minecraft/executor/index.js";

const root = await mkdtemp(join(tmpdir(), "uina-spawn-failure-"));
const original = process.execPath;
try {
	process.execPath = join(root, "missing-node.exe");
	await MinecraftExecutor.open({
		ownershipDir: root,
		sessionDataDir: root,
		sharedDataDir: root,
		config: {
			connection: { host: "127.0.0.1", port: 1, username: "spawn-failure", authMode: "offline" },
			binding: null,
		},
	}).then(
		() => {
			throw new Error("missing executable unexpectedly spawned");
		},
		(error: unknown) => {
			console.log(JSON.stringify({ code: (error as { code?: string }).code }));
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 50));
} finally {
	process.execPath = original;
	await rm(root, { recursive: true, force: true });
}
