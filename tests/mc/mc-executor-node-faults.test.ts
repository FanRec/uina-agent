import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

function probe(mode: "block" | "logs"): Record<string, unknown> {
	const preloader = fileURLToPath(new URL("./fixtures/executor-fault-preload.cjs", import.meta.url));
	const parent = fileURLToPath(new URL("./fixtures/executor-fault-parent.ts", import.meta.url));
	const stdout = execFileSync(process.execPath, ["--import", "tsx", parent], {
		encoding: "utf8",
		timeout: 15_000,
		windowsHide: true,
		env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preloader)}`, UINA_TEST_EXECUTOR_FAULT: mode },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(stdout.trim()) as Record<string, unknown>;
}
test("real blocked companion main thread loses heartbeat and its exact Job tree is retired", () => {
	expect(probe("block")).toEqual({ phase: "faulted", side: null, blockObserved: true, directory: 0, account: 0 });
});
test("real stdout peak is continuously drained into a bounded tail while IPC stays responsive", () => {
	const result = probe("logs");
	expect(result.phase).toBe("ready");
	expect(result.runtime).toBe("ready");
	expect(result.tailBytes).toBeLessThanOrEqual(65536);
	expect(result.discardedBytes).toBeGreaterThan(0);
});

test("asynchronous fork failure rejects startup without an uncaught ChildProcess error", () => {
	const fixture = fileURLToPath(new URL("./fixtures/executor-spawn-failure.ts", import.meta.url));
	const result = execFileSync(process.execPath, ["--import", "tsx", fixture], {
		encoding: "utf8",
		timeout: 15_000,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	expect(JSON.parse(result.trim())).toEqual({ code: "EXECUTOR_UNAVAILABLE" });
});
