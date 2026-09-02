/**
 * exec_command 工具：执行一条系统命令（spawn 子进程），返回 stdout/stderr/退出码。
 * 被 src/tools/loader.ts 自动发现并注册。
 *
 * 两个入口同一实现：
 *  - default Tool：给模型的 JSON 封装（结构化结果，含截断/临时指针）
 *  - execCommandDirect：直接执行（! 命令用，原样输出 stdout/stderr）
 *
 * 限制条件对齐 pi：
 *  - 无命令超时（pi 的 bash 无超时，挂死靠用户打断）——打断走 signal：abort → 杀进程树
 *  - 输出截断 50KB / 2000 行，先到为准，保尾；截断时标记 + 完整输出写临时文件给路径
 *  - 无命令白名单；权限模型 = 运行进程的用户账户权限（pi 同款信任模型）
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../../src/tools/broker.js";

/** pi 内建工具输出上限：50KB 与 2000 行，先到为准 */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
/** 收集期间的滚动缓冲上限（对齐原 maxBuffer 1MB）；超限丢最旧保留尾部 */
const BUF_CAP = 1024 * 1024;

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number | null;
	cancelled: boolean;
}

/**
 * Windows shell 选择（想法来自 Nott 的 FindShell）：pwsh(7) → powershell(5.1) → cmd。
 * 优先 PowerShell：cmd 的引号剥离规则会吞 $/\" 等特殊字符（模型实测被坑），
 * powershell 用 -Command 直接收整段命令，特殊字符安全传递。
 * 编码：spawn 的 stdout 是字节流，Windows 默认代码页下中文易乱码——
 * powershell 5.1 用前缀强制本进程输出 UTF-8；py 类程序用 PYTHONIOENCODING；
 * 解码侧再启发式兜底（UTF-8 严格解码失败 → latin1，不产生 U+FFFD 替换符）。
 */
function resolveShell(): {
	shell: string;
	args: (c: string) => string[];
} {
	if (process.platform !== "win32") {
		return { shell: "/bin/sh", args: (c) => ["-c", c] };
	}
	const progFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const pwsh = join(progFiles, "PowerShell", "7", "pwsh.exe");
	if (existsSync(pwsh)) {
		// pwsh 7 默认输出 UTF-8，无需前缀
		return { shell: pwsh, args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c] };
	}
	const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershell = join(
		sysRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	if (existsSync(powershell)) {
		// PowerShell 5.1 默认按控制台代码页（GBK）输出到管道：
		//  - 设置 [Console]::OutputEncoding = UTF-8 使 cmdlet/stdout 输出 UTF-8；
		//  - runtime 错误（管道模式下）天然 UTF-8，无需处理；
		//  - 注意：不能覆写 [Console]::SetError（实测会丢掉整个错误流）；
		//    parse 错误在脚本执行前产生、干不过编码前缀（模型重试时靠行号自纠，接受）。
		const prefix =
			"[Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
		return {
			shell: powershell,
			args: (c) => ["-NoProfile", "-NonInteractive", "-Command", `${prefix}${c}`],
		};
	}
	// 兜底：cmd（引号剥离规则最差，但机器上总存在）
	return { shell: "cmd.exe", args: (c) => ["/d", "/s", "/c", c] };
}

/** 字节 → 文本：UTF-8 严格解码优先，失败回退 latin1（不吞字节、不产生替换符） */
function decodeBuffer(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return buf.toString("latin1");
	}
}

/**
 * 直接执行命令（spawn，不经过 shell 字符串拼接执行）。
 * signal.abort 时杀整个进程树（Windows: taskkill /T；POSIX: 进程组 SIGKILL）。
 */
export async function execCommandDirect(
	command: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return new Promise((resolve) => {
		const { shell, args } = resolveShell();
		const child = spawn(shell, args(command), {
			cwd: process.cwd(),
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
			// POSIX 下独立进程组：取消时可 kill(-pid) 杀整组；Windows 忽略 detached
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let outCapped = false;
		let errCapped = false;

		child.stdout?.on("data", (d: Buffer) => {
			if (outCapped) return;
			stdout += decodeBuffer(d);
			if (stdout.length > BUF_CAP) {
				stdout = stdout.slice(-BUF_CAP);
				outCapped = true;
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (errCapped) return;
			stderr += decodeBuffer(d);
			if (stderr.length > BUF_CAP) {
				stderr = stderr.slice(-BUF_CAP);
				errCapped = true;
			}
		});

		const kill = (): void => {
			if (child.pid !== undefined) killTree(child.pid);
		};
		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		// 竞态修复：abort 可能在 spawn 完成前到达（child.pid 未就绪），kill 会空跳过——
		// 进程随后正常启动就没人再杀。spawn 事件后补查一次 aborted 状态。
		child.on("spawn", () => {
			if (signal?.aborted) kill();
		});

		child.on("error", (e) => {
			signal?.removeEventListener("abort", kill);
			finish(null, signal?.aborted ?? false, `spawn 失败: ${e.message}`);
		});
		// Windows 上强杀进程树后 close 可能因管道残留不触发（实测：powershell 启动早期
		// 被杀时只有 exit 事件到达）——exit 兜底收口，先到先算（管道未 flush 的场景
		// 取消态无所谓，正常完成态数据通常在 exit 前已到齐）
		child.on("close", (code) => {
			signal?.removeEventListener("abort", kill);
			finish(code, signal?.aborted ?? false);
		});
		child.on("exit", (code) => {
			signal?.removeEventListener("abort", kill);
			finish(code, signal?.aborted ?? false);
		});

		let settled = false;
		function finish(
			code: number | null,
			cancelled: boolean,
			spawnError = "",
		): void {
			if (settled) return;
			settled = true;
			if (spawnError) {
				resolve({ stdout: "", stderr: spawnError, code, cancelled });
			} else {
				resolve({ stdout, stderr, code, cancelled });
			}
		}
	});
}

/** 杀进程树：Windows 用 taskkill /T(树) /F(强杀)；POSIX 用进程组 SIGKILL */
function killTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			void spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
				windowsHide: true,
				stdio: "ignore",
			});
		} catch {
			// 忽略：taskkill 失败由 close 事件自然收口
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已退出
			}
		}
	}
}

const execCommand: Tool = {
	def: {
		type: "function",
		function: {
			name: "exec_command",
			description:
				"执行一条系统命令并返回其输出（stdout、stderr、退出码）。可用于查询系统信息、"
				+ "读写文件、运行脚本、管理进程等。当前平台为 Windows，命令走 PowerShell，"
				+ "请使用 PowerShell 语法（Get-ChildItem / Set-Location / Get-Content 等），"
				+ "勿写 bash/POSIX 语法。命令可长可复合（; 分隔）；若退出码非 0，error 字段会说明。",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "要执行的命令（PowerShell 语法）" },
				},
				required: ["command"],
			},
		},
	},
	async run(args, signal) {
		const command = String(args.command ?? "").trim();
		if (!command) return JSON.stringify({ error: "command 为空" });
		const r = await execCommandDirect(command, signal);
		const body: Record<string, unknown> = {
			stdout: truncateTail(r.stdout),
			stderr: r.stderr.slice(0, 2000),
		};
		if (r.cancelled) body.cancelled = true;
		else if (r.code !== 0) body.error = `退出码 ${r.code}`;
		return JSON.stringify(body);
	},
};

/**
 * 对齐 pi 的 truncateTail：保留最后 N 行且不超过 M 字节（先到为准）。
 * 被截断时输出标记 + 完整输出写临时文件、给模型路径（可自行读取）。
 * （完整输出在 spawn 收集期已按 BUF_CAP 滚动保留尾部，这里只做展示级裁剪）
 */
function truncateTail(output: string): string {
	const totalBytes = Buffer.byteLength(output);
	const allLines = output.split("\n");
	const totalLines = allLines.length;
	if (totalBytes <= MAX_BYTES && totalLines <= MAX_LINES) return output;

	const kept: string[] = [];
	let bytes = 0;
	for (let i = allLines.length - 1; i >= 0; i--) {
		if (kept.length >= MAX_LINES) break;
		const add = Buffer.byteLength(allLines[i]) + 1;
		if (bytes + add > MAX_BYTES) break;
		kept.unshift(allLines[i]);
		bytes += add;
	}
	const content = kept.join("\n");

	let pointer = "";
	try {
		const file = join(
			tmpdir(),
			`uina-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.out.txt`,
		);
		writeFileSync(file, output, "utf8");
		pointer = `完整输出已保存到 ${file}`;
	} catch {
		pointer = "（临时文件写入失败）";
	}
	return (
		content +
		`\n\n[输出已截断: 保留 ${kept.length}/${totalLines} 行, ${bytes}/${totalBytes} 字节。${pointer}]`
	);
}

export default execCommand;
