import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * 跨平台杀死进程及其整棵派生进程树（对齐 Pi utils/shell.ts killProcessTree）。
 */
export function killTree(pid: number): void {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], {
			windowsHide: true,
			stdio: "ignore",
		});
		killer.on("error", () => undefined);
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已提前退出
		}
	}
}

/**
 * 追踪系统中分离出来的子进程，确保在宿主退出或发生灾难性故障时级联清理，不留孤儿进程。
 */
const trackedDetachedPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedPids) {
		killTree(pid);
	}
	trackedDetachedPids.clear();
}
