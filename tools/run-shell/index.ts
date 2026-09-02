/**
 * run_shell 工具：执行 shell 命令——"活在计算机里"的基础。
 * 被 src/tools/loader.ts 自动发现并注册。
 *
 * 两个入口同一实现：
 *  - default Tool：给模型的 JSON 封装（结构化结果，含截断/临时指针）
 *  - runShellDirect：直接执行（! 命令用，原样输出 stdout/stderr）
 *
 * 限制条件对齐 pi：
 *  - 无命令超时（pi 的 bash 无超时，挂死靠用户打断）——打断走 signal：abort → 杀进程树
 *  - 输出截断 50KB / 2000 行，先到为准，保尾；截断时标记 + 完整输出写临时文件给路径
 *  - 无命令白名单；权限模型 = 运行进程的用户账户权限（pi 同款信任模型）
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
 * 直接执行命令（spawn，不经过 shell 字符串拼接执行）。
 * signal.abort 时杀整个进程树（Windows: taskkill /T；POSIX: 进程组 SIGKILL）。
 */
export async function runShellDirect(
	command: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return new Promise((resolve) => {
		const isWin = process.platform === "win32";
		const child = spawn(
			isWin ? "cmd.exe" : "/bin/sh",
			isWin ? ["/d", "/s", "/c", command] : ["-c", command],
			{
				cwd: process.cwd(),
				windowsHide: true,
				// POSIX 下独立进程组：取消时可 kill(-pid) 杀整组；Windows 忽略 detached
				detached: !isWin,
			},
		);

		let stdout = "";
		let stderr = "";
		let outCapped = false;
		let errCapped = false;

		child.stdout?.on("data", (d: Buffer) => {
			if (outCapped) return;
			stdout += d.toString();
			if (stdout.length > BUF_CAP) {
				stdout = stdout.slice(-BUF_CAP);
				outCapped = true;
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (errCapped) return;
			stderr += d.toString();
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

		child.on("error", (e) => {
			signal?.removeEventListener("abort", kill);
			resolve({
				stdout: "",
				stderr: `spawn 失败: ${e.message}`,
				code: null,
				cancelled: signal?.aborted ?? false,
			});
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", kill);
			resolve({
				stdout,
				stderr,
				code,
				cancelled: signal?.aborted ?? false,
			});
		});
	});
}

/** 杀进程树：Windows 用 taskkill /T(树) /F(强杀)；POSIX 用进程组 SIGKILL */
function killTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			void spawn(
				"taskkill",
				["/pid", String(pid), "/t", "/f"],
				{ windowsHide: true, stdio: "ignore" },
			);
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

const runShell: Tool = {
	def: {
		type: "function",
		function: {
			name: "run_shell",
			description:
				"执行一条 shell 命令并返回输出。用于查询系统信息、读写文件、运行脚本、查看目录等。",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "要执行的 shell 命令" },
				},
				required: ["command"],
			},
		},
	},
	async run(args, signal) {
		const command = String(args.command ?? "").trim();
		if (!command) return JSON.stringify({ error: "command 为空" });
		const r = await runShellDirect(command, signal);
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
			`uina-shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.out.txt`,
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

export default runShell;