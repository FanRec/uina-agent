/**
 * 终端后台任务看板组件 (TaskDashboard)。
 *
 * 核心特性：
 * 1. 内存防泄露环形缓冲区 (RingBuffer)：每个任务固定容量限制 (默认 500 行)，ANSI 彩色安全；
 * 2. 统一后台作业生命周期模型 (BackgroundTask & BackgroundTaskRegistry)：
 *    - 状态管理：running 🟢、stopping 🟡、completed ✓、failed 🔴、killed ⚪；
 *    - 包含：PID、执行命令、工作目录 (Cwd)、起止时间戳、退出码 (Exit Code)、最后末行输出 (liveLine)；
 * 3. 上下双层分屏看板排版：
 *    - 顶栏：全局运行指标聚合 (运行中 / 正常退出 / 崩溃 / 终止)；
 *    - 上半部：任务队列卡片，支持光标聚焦；
 *    - 下半部：实时日志透视器 (tail -f 模式，随着当前选中的任务动态切换输出流)；
 *    - 全屏最大化模式：按 Enter 键一键全屏放大日志，再次按 Enter 恢复双分屏；
 * 4. 全功能控制动作集：
 *    - K (Kill 优雅终止)、R (Restart 重启)、C (Clear 清理已退出)、I (Input 写入 stdin)、Tab (切换列表与日志滚动焦点)、Esc (退出)。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../core/utils.js";

/**
 * 定长环形字符串缓冲区 (RingBuffer)
 */
export class RingBuffer {
	private buffer: string[];
	private head = 0;
	private count = 0;
	readonly capacity: number;

	constructor(capacity = 500) {
		this.capacity = Math.max(1, capacity);
		this.buffer = new Array<string>(this.capacity);
	}

	push(line: string): void {
		const index = (this.head + this.count) % this.capacity;
		this.buffer[index] = line;
		if (this.count < this.capacity) {
			this.count++;
		} else {
			this.head = (this.head + 1) % this.capacity;
		}
	}

	getAll(): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.count; i++) {
			const index = (this.head + i) % this.capacity;
			result.push(this.buffer[index]!);
		}
		return result;
	}

	getTail(n: number): string[] {
		const all = this.getAll();
		return all.slice(Math.max(0, all.length - n));
	}

	clear(): void {
		this.head = 0;
		this.count = 0;
		this.buffer = new Array<string>(this.capacity);
	}

	get size(): number {
		return this.count;
	}
}

export type TaskStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	status: TaskStatus;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	error?: string;
	logs: RingBuffer;
	liveLine?: string;
	onKill?: () => void | Promise<void>;
	onRestart?: () => void | Promise<void>;
	onInput?: (text: string) => void | Promise<void>;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSec = seconds % 60;
	return `${minutes}m${remSec}s`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

/**
 * 统一后台作业与进程注册中心 (BackgroundTaskRegistry)
 */
export class BackgroundTaskRegistry {
	private tasks = new Map<string, BackgroundTask>();
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {}
		}
	}

	list(): BackgroundTask[] {
		return Array.from(this.tasks.values());
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	register(options: {
		id: string;
		command: string;
		cwd?: string;
		pid?: number;
		status?: TaskStatus;
		onKill?: () => void | Promise<void>;
		onRestart?: () => void | Promise<void>;
		onInput?: (text: string) => void | Promise<void>;
	}): BackgroundTask {
		const existing = this.tasks.get(options.id);
		if (existing) {
			existing.command = options.command;
			if (options.cwd) existing.cwd = options.cwd;
			if (options.pid) existing.pid = options.pid;
			if (options.status) existing.status = options.status;
			this.notify();
			return existing;
		}

		const task: BackgroundTask = {
			id: options.id,
			command: options.command,
			cwd: options.cwd ?? process.cwd(),
			pid: options.pid,
			status: options.status ?? "running",
			startedAt: Date.now(),
			logs: new RingBuffer(500),
			onKill: options.onKill,
			onRestart: options.onRestart,
			onInput: options.onInput,
		};
		this.tasks.set(options.id, task);
		this.notify();
		return task;
	}

	appendLog(id: string, text: string): void {
		const task = this.tasks.get(id);
		if (!task) return;
		const clean = text.replace(/\r/g, "");
		const lines = clean.split("\n");
		for (const line of lines) {
			if (line.trim() || lines.length === 1) {
				task.logs.push(line);
				task.liveLine = line;
			}
		}
		this.notify();
	}

	setTaskStatus(id: string, status: TaskStatus, exitCode?: number | null, error?: string): void {
		const task = this.tasks.get(id);
		if (!task) return;
		task.status = status;
		if (exitCode !== undefined) task.exitCode = exitCode;
		if (error) task.error = error;
		if (status === "completed" || status === "failed" || status === "killed") {
			task.finishedAt = Date.now();
		}
		this.notify();
	}

	async kill(id: string): Promise<boolean> {
		const task = this.tasks.get(id);
		if (!task || task.status === "completed" || task.status === "failed" || task.status === "killed") {
			return false;
		}
		task.status = "stopping";
		this.notify();

		try {
			if (task.onKill) {
				await task.onKill();
			}
		} catch (err) {
			task.error = String(err);
		}

		task.status = "killed";
		task.finishedAt = Date.now();
		task.logs.push(`[system] 任务已被用户手动终止 (Killed by user)`);
		this.notify();
		return true;
	}

	async restart(id: string): Promise<boolean> {
		const task = this.tasks.get(id);
		if (!task) return false;

		task.status = "running";
		task.startedAt = Date.now();
		task.finishedAt = undefined;
		task.exitCode = undefined;
		task.error = undefined;
		task.logs.push(`[system] 正在重新启动任务: ${task.command}`);
		this.notify();

		try {
			if (task.onRestart) {
				await task.onRestart();
			}
		} catch (err) {
			task.status = "failed";
			task.error = String(err);
			this.notify();
			return false;
		}
		return true;
	}

	async sendInput(id: string, text: string): Promise<boolean> {
		const task = this.tasks.get(id);
		if (!task || task.status !== "running") return false;
		task.logs.push(`[stdin] > ${text}`);
		if (task.onInput) {
			try {
				await task.onInput(text);
			} catch (err) {
				task.logs.push(`[error] 写入 stdin 失败: ${String(err)}`);
			}
		}
		this.notify();
		return true;
	}

	clearSettled(): void {
		for (const [id, task] of this.tasks.entries()) {
			if (task.status === "completed" || task.status === "failed" || task.status === "killed") {
				this.tasks.delete(id);
			}
		}
		this.notify();
	}

	/** 加载内置高质量开箱即用演练数据 */
	loadSampleData(): void {
		this.tasks.clear();

		// 1. 运行中 Vite 开发服务器
		const t1 = this.register({
			id: "task-01",
			command: "pnpm dev",
			cwd: "e:/Uina/Uina",
			pid: 18420,
			status: "running",
		});
		t1.logs.push("  VITE v5.4.2  ready in 340 ms");
		t1.logs.push("");
		t1.logs.push("  ➜  Local:   http://localhost:5173/");
		t1.logs.push("  ➜  Network: use --host to expose");
		t1.logs.push("  ➜  press h + enter to show help");
		t1.logs.push("[15:32:01] [vite] hmr update /src/ui_new/editor/input-line.ts");
		t1.logs.push("[15:32:01] [vite] (x2) page reload");
		t1.liveLine = "hmr update /src/ui_new/editor/input-line.ts";

		// 2. 运行中 TypeScript 增量编译监听
		const t2 = this.register({
			id: "task-02",
			command: "tsc --watch",
			cwd: "e:/Uina/Uina",
			pid: 21044,
			status: "running",
		});
		t2.logs.push("[15:22:00] Starting compilation in watch mode...");
		t2.logs.push("[15:22:04] Found 0 errors. Watching for file changes.");
		t2.liveLine = "Found 0 errors. Watching for file changes.";

		// 3. 正常退出的单元测试
		const t3 = this.register({
			id: "task-03",
			command: "pnpm vitest run",
			cwd: "e:/Uina/Uina",
			pid: 9412,
			status: "completed",
		});
		t3.finishedAt = Date.now();
		t3.exitCode = 0;
		t3.logs.push(" RUN  v4.1.11 E:/Uina/Uina");
		t3.logs.push(" ✓ tests/ui_new.test.ts (32 tests) 338ms");
		t3.logs.push(" Test Files  1 passed (1)");
		t3.logs.push("      Tests  32 passed (32)");

		// 4. 报错异常退出的容器/服务
		const t4 = this.register({
			id: "task-04",
			command: "docker compose up",
			cwd: "e:/Uina/Uina/deploy",
			pid: 1402,
			status: "failed",
		});
		t4.finishedAt = Date.now();
		t4.exitCode = 1;
		t4.error = "Error response from daemon: driver failed programming external connectivity on endpoint redis";
		t4.logs.push("[compose] Attaching to redis, postgres");
		t4.logs.push("[compose] redis | 1:M 03 Sep 15:25:01.120 # Bind: Address already in use (port 6379)");
		t4.logs.push("[compose] redis exited with code 1");
	}
}

/**
 * 单个任务卡片排版
 */
export function formatTaskCard(task: BackgroundTask, innerWidth: number, isFocused: boolean): string[] {
	const isRunning = task.status === "running";
	const elapsed = task.finishedAt ? task.finishedAt - task.startedAt : Date.now() - task.startedAt;

	let glyph = "🟢";
	let statusDesc = "运行中";
	if (isRunning) {
		glyph = "🟢";
		statusDesc = "运行中";
	} else if (task.status === "stopping") {
		glyph = "🟡";
		statusDesc = "正在停止";
	} else if (task.status === "completed") {
		glyph = "✓ ";
		statusDesc = `已完成 (退出码: ${task.exitCode ?? 0})`;
	} else if (task.status === "failed") {
		glyph = "🔴";
		statusDesc = `异常退出 (退出码: ${task.exitCode ?? 1})`;
	} else if (task.status === "killed") {
		glyph = "⚪";
		statusDesc = "已人工终止";
	}

	const focusPrefix = isFocused ? `${C.bold}${C.glowWhite}❯ ` : "  ";
	const idTag = `${C.bold}[${task.id}]${C.reset}`;
	const cmdStyled = isFocused ? `${C.bold}${C.cyan}${task.command}${C.reset}` : `${C.bold}${task.command}${C.reset}`;
	const pidText = task.pid ? `${C.gray}·${C.reset} ${C.dim}PID ${task.pid}${C.reset}` : "";
	const durationText = `${C.gray}·${C.reset} ${C.dim}${formatDuration(elapsed)}${C.reset}`;
	const statusBadge = `${C.gray}·${C.reset} ${task.status === "failed" ? C.red : task.status === "completed" ? C.green : C.yellow}${statusDesc}${C.reset}`;

	const headerRaw = `${focusPrefix}${glyph} ${idTag} ${cmdStyled} ${pidText} ${durationText} ${statusBadge}`;
	const headerLine = truncateToWidth(headerRaw, innerWidth, "…");

	const lines = [headerLine];

	// 若处于运行中且有 liveLine，输出单行预览
	if (isRunning && task.liveLine) {
		const liveText = `     ${C.gray}│${C.reset} ${C.dim}${task.liveLine}${C.reset}`;
		lines.push(truncateToWidth(liveText, innerWidth, "…"));
	}

	return lines;
}

/**
 * 后台任务看板组件 (TaskDashboard)
 */
export class TaskDashboard {
	private registry: BackgroundTaskRegistry;
	private focusIndex = 0;
	private focusPane: "list" | "log" = "list";
	private logScrollOffset = 0;
	private maximizedLog = false;

	constructor(registry: BackgroundTaskRegistry) {
		this.registry = registry;
	}

	getTasks(): BackgroundTask[] {
		return this.registry.list();
	}

	getFocusedTask(): BackgroundTask | undefined {
		const list = this.getTasks();
		return list[this.focusIndex];
	}

	getFocusPane(): "list" | "log" {
		return this.focusPane;
	}

	togglePane(): void {
		this.focusPane = this.focusPane === "list" ? "log" : "list";
	}

	toggleMaximize(): void {
		this.maximizedLog = !this.maximizedLog;
	}

	isMaximized(): boolean {
		return this.maximizedLog;
	}

	navigateUp(): void {
		if (this.focusPane === "list" && !this.maximizedLog) {
			const total = this.getTasks().length;
			if (total === 0) return;
			this.focusIndex = (this.focusIndex - 1 + total) % total;
			this.logScrollOffset = 0; // 重置日志滚动
		} else {
			// 日志视口向上滚动
			this.logScrollOffset = Math.max(0, this.logScrollOffset - 3);
		}
	}

	navigateDown(): void {
		if (this.focusPane === "list" && !this.maximizedLog) {
			const total = this.getTasks().length;
			if (total === 0) return;
			this.focusIndex = (this.focusIndex + 1) % total;
			this.logScrollOffset = 0; // 重置日志滚动
		} else {
			// 日志视口向下滚动
			this.logScrollOffset += 3;
		}
	}

	setFocusIndex(index: number): void {
		const total = this.getTasks().length;
		if (index >= 0 && index < total) {
			this.focusIndex = index;
			this.logScrollOffset = 0;
		}
	}

	async killCurrent(): Promise<void> {
		const task = this.getFocusedTask();
		if (task) {
			await this.registry.kill(task.id);
		}
	}

	async restartCurrent(): Promise<void> {
		const task = this.getFocusedTask();
		if (task) {
			await this.registry.restart(task.id);
		}
	}

	clearSettled(): void {
		this.registry.clearSettled();
		const total = this.getTasks().length;
		if (this.focusIndex >= total && total > 0) {
			this.focusIndex = total - 1;
		}
	}

	async sendInputToCurrent(text: string): Promise<void> {
		const task = this.getFocusedTask();
		if (task) {
			await this.registry.sendInput(task.id, text);
		}
	}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		const boxWidth = getContentBoxWidth(terminalWidth - 4);
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const tasks = this.getTasks();
		const focusedTask = this.getFocusedTask();

		// 1. 顶边框与右上角 ✕ 退出按钮
		const titleTag = `─ 后台任务看板 (Background Tasks) `;
		const exitTag = ` ✕ ─`;
		const fillCount = Math.max(1, boxWidth - 2 - visibleWidth(titleTag) - visibleWidth(exitTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(fillCount)}${exitTag}╮${C.reset}`;

		// 2. 状态指标行聚合
		const runningCount = tasks.filter((t) => t.status === "running").length;
		const completedCount = tasks.filter((t) => t.status === "completed").length;
		const failedCount = tasks.filter((t) => t.status === "failed").length;
		const killedCount = tasks.filter((t) => t.status === "killed").length;

		const metricsBar = `  ${C.green}🟢 ${runningCount} 运行中${C.reset}    ${C.cyan}✓ ${completedCount} 正常退出${C.reset}    ${failedCount > 0 ? `${C.red}🔴 ${failedCount} 异常退出${C.reset}` : `${C.dim}🔴 0 异常${C.reset}`}    ${killedCount > 0 ? `${C.yellow}⚪ ${killedCount} 已终止${C.reset}` : ""}`;
		const metricsPad = Math.max(0, innerW - visibleWidth(metricsBar));
		const metricsLine = `  ${borderCol}│${C.reset} ${metricsBar}${" ".repeat(metricsPad)} ${borderCol}│${C.reset}`;

		const dividerLine = `  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`;

		const wrapRow = (text: string) => {
			const pad = Math.max(0, innerW - visibleWidth(text));
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(pad)} ${borderCol}│${C.reset}`;
		};

		// 3. 上半部：任务卡片列表 (若全屏最大化日志则折叠任务列表)
		const listLines: string[] = [];
		if (!this.maximizedLog) {
			const paneHeader = `  ${this.focusPane === "list" ? `${C.bold}${C.cyan}▼ 任务队列${C.reset}` : `${C.dim}▽ 任务队列 (按 Tab 聚焦)${C.reset}`}`;
			listLines.push(wrapRow(paneHeader));

			if (tasks.length === 0) {
				listLines.push(wrapRow(`  ${C.dim}暂无正在运行或历史后台任务${C.reset}`));
			} else {
				for (let i = 0; i < tasks.length; i++) {
					const task = tasks[i]!;
					const isFocused = i === this.focusIndex;
					const cardLines = formatTaskCard(task, innerW, isFocused);
					for (const cl of cardLines) {
						listLines.push(wrapRow(cl));
					}
					if (i < tasks.length - 1) {
						listLines.push(wrapRow(`   ${C.gray}${"─".repeat(Math.max(10, innerW - 6))}${C.reset}`));
					}
				}
			}
		}

		// 4. 下半部：实时日志透视器 (Log Inspector Pane)
		const logLines: string[] = [];
		const logHeaderTitle = focusedTask
			? `【实时日志透视 · ${focusedTask.id} (${focusedTask.command}) · tail -f】`
			: `【实时日志透视】`;
		const logPaneHeader = `  ${this.focusPane === "log" || this.maximizedLog ? `${C.bold}${C.cyan}▼ ${logHeaderTitle}${C.reset}` : `${C.dim}▽ ${logHeaderTitle} (按 Tab 聚焦)${C.reset}`}`;
		logLines.push(wrapRow(logPaneHeader));

		// 计算日志展示行数预算
		const totalAvailable = Math.max(12, terminalHeight - 10);
		const visibleLogRows = this.maximizedLog
			? Math.max(8, totalAvailable)
			: Math.max(5, Math.min(8, totalAvailable - listLines.length));

		if (!focusedTask) {
			logLines.push(wrapRow(`  ${C.dim}请在上方队列中选中任务查看输出日志${C.reset}`));
			while (logLines.length < visibleLogRows + 1) {
				logLines.push(wrapRow(""));
			}
		} else {
			const allLogs = focusedTask.logs.getAll();
			if (allLogs.length === 0) {
				logLines.push(wrapRow(`  ${C.dim}暂无控制台日志输出...${C.reset}`));
				while (logLines.length < visibleLogRows + 1) {
					logLines.push(wrapRow(""));
				}
			} else {
				// tail -f 自动吸底或支持滚动
				const maxScroll = Math.max(0, allLogs.length - visibleLogRows);
				let effScroll = maxScroll;
				if (this.logScrollOffset > 0) {
					effScroll = Math.max(0, maxScroll - this.logScrollOffset);
				}
				const slicedLogs = allLogs.slice(effScroll, effScroll + visibleLogRows);

				for (const raw of slicedLogs) {
					const styled = raw.startsWith("[error]") || raw.includes("error") || raw.includes("Error")
						? `${C.red}  ${raw}${C.reset}`
						: raw.startsWith("[system]")
							? `${C.yellow}  ${raw}${C.reset}`
							: `${C.dim}  ${raw}${C.reset}`;
					logLines.push(wrapRow(truncateToWidth(styled, innerW)));
				}

				while (logLines.length < visibleLogRows + 1) {
					logLines.push(wrapRow(""));
				}
			}
		}

		// 5. 底部快捷操作指引栏
		const maximizeTip = this.maximizedLog ? "Enter 恢复分屏" : "Enter 全屏日志";
		const hintText = `${C.dim}↑/↓ 移动 · Tab 切换分屏 · ${C.bold}K${C.reset}${C.dim} 终止 · ${C.bold}R${C.reset}${C.dim} 重启 · ${C.bold}C${C.reset}${C.dim} 清理 · ${maximizeTip} · ${C.bold}Esc${C.reset}${C.dim} 退出${C.reset}`;
		const hintLine = wrapRow(hintText);

		// 6. 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;

		if (this.maximizedLog) {
			return [
				topLine,
				`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
				metricsLine,
				dividerLine,
				...logLines,
				dividerLine,
				hintLine,
				botLine,
			];
		}

		return [
			topLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			metricsLine,
			dividerLine,
			...listLines,
			dividerLine,
			...logLines,
			dividerLine,
			hintLine,
			botLine,
		];
	}
}
