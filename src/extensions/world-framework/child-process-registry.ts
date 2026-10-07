/**
 * 宿主 spawn 子进程的生存兜底登记表。
 *
 * 责任边界（硬约束）：这张表只登记、只击杀**本进程自己 spawn** 的子进程 PID。
 * 不是本进程启动的进程永远进不了这张表，也不归本进程负责。
 *
 * 为什么存在：CLI 退出协调器给优雅清理（含 world onStop 的 mpv quit IPC）的
 * 预算是 600ms race / 800ms 硬熔断，超时即 process.exit——mpv 收不到 quit 就
 * 会变孤儿继续出声。process.on("exit") 是唯一在所有 Node 级退出路径（熔断
 * 超时、强退、Ctrl+C、SIGHUP）都同步执行的点，process.kill(pid, "SIGKILL")
 * 在 Windows 上即同步 TerminateProcess。
 *
 * 已知边界：宿主被 taskkill /F 或系统崩溃时 exit 钩子不会运行，覆盖该场景
 * 需要 Windows Job Object（原生依赖），明确不做。PID 复用窗口极小：子进程
 * exit 事件即刻解除登记。
 */

const tracked = new Set<number>();
let installed = false;

export function killTrackedChildProcesses(): void {
	for (const pid of tracked) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已退出 / 权限不足：无可做的善后。
		}
	}
	tracked.clear();
}

export function trackChildProcess(pid: number): void {
	tracked.add(pid);
	if (installed) return;
	installed = true;
	process.on("exit", killTrackedChildProcesses);
}

export function untrackChildProcess(pid: number): void {
	tracked.delete(pid);
}
