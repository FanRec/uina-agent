/**
 * run_shell 工具：执行 shell 命令——"活在计算机里"的基础。
 * 被 src/tools/loader.ts 自动发现并注册。
 *
 * 限制条件对齐 pi：
 *  - 无命令超时（pi 的 bash 无超时，挂死靠用户打断）
 *  - 输出截断 50KB / 2000 行，先到为准，保尾；截断时标记 + 完整输出写临时文件给路径
 *  - 无命令白名单；权限模型 = 运行进程的用户账户权限（pi 同款信任模型）
 */
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "../../src/tools/broker.js";

const execAsync = promisify(exec);

/** pi 内建工具输出上限：50KB 与 2000 行，先到为准 */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

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
	async run(args) {
		const command = String(args.command ?? "").trim();
		if (!command) return JSON.stringify({ error: "command 为空" });
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: process.cwd(),
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			});
			return JSON.stringify({
				stdout: truncateTail(stdout),
				stderr: (stderr || "").slice(0, 2000),
			});
		} catch (e) {
			const err = e as { message?: string; stdout?: string; stderr?: string };
			return JSON.stringify({
				error: (err.message ?? "").slice(0, 300),
				stdout: truncateTail(err.stdout ?? ""),
				stderr: (err.stderr ?? "").slice(0, 2000),
			});
		}
	},
};

/**
 * 对齐 pi 的 truncateTail：保留最后 N 行且不超过 M 字节（先到为准）。
 * 被截断时输出标记 + 完整输出写临时文件、给模型路径（可自行读取）。
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
