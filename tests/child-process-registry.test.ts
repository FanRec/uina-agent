import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	killTrackedChildProcesses,
	trackChildProcess,
	untrackChildProcess,
} from "../src/extensions/world-framework/child-process-registry.js";

function spawnSleeper(): ChildProcess {
	return spawn(process.execPath, ["-e", "setInterval(() => 0, 50)"], { stdio: "ignore" });
}

async function isAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("child-process-registry", () => {
	it("kills tracked children", async () => {
		const child = spawnSleeper();
		const pid = child.pid!;
		// 注意：不能用 kill(pid, 0) 判死——测试进程自己持有子进程句柄，TerminateProcess
		// 后进程对象在句柄释放前依然可被 OpenProcess，探测恒为"存活"。以 exit 事件为准。
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

		trackChildProcess(pid);
		killTrackedChildProcesses();
		await Promise.race([
			exited,
			new Promise((_, reject) => setTimeout(() => reject(new Error("tracked child was not killed")), 3000)),
		]);
	});

	it("does not kill children that were untracked", async () => {
		const child = spawnSleeper();
		const pid = child.pid!;
		await waitFor(() => isAlive(pid));

		trackChildProcess(pid);
		untrackChildProcess(pid);
		killTrackedChildProcesses();
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(await isAlive(pid)).toBe(true);
		child.kill();
	}, 10_000);

	it("does not throw when the pid is already gone", () => {
		expect(() => killTrackedChildProcesses()).not.toThrow();
	});
});
