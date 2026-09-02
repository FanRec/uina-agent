/**
 * shell 工具：让主体能执行命令、操作文件、查询系统——"活在计算机里"的基础。
 *
 * 限制条件对齐 pi（2026-09-02 空纪指令：pi 没有的 Uina 也不能有，pi 取多少 Uina 取多少）：
 *  - 无命令超时（pi 的 bash 工具无超时，靠用户人工打断）——exec 不传 timeout
 *  - 输出截断对齐 pi 内建工具标准：50KB / 2000 行，先到为准；命令输出保尾（truncateTail）
 *  - 截断时写明标记 + 完整输出写临时文件并给出路径（模型可自行读取，对齐 pi 的做法）
 *  - 无命令白名单——这是有副作用的工具；权限模型 = 运行用户的账户权限（pi 同款信任模型）
 */
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "./broker.js";

const execAsync = promisify(exec);

/** pi 内建工具输出上限：50KB 与 2000 行，先到为准 */
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

export interface ShellToolOpts {
	/** 可选：命令执行目录（pi 的 createBashTool(cwd) 同款：仅默认起点，不是沙箱） */
	cwd?: string;
	maxOutputBytes?: number;
	maxOutputLines?: number;
}

export function shellTool(opts: ShellToolOpts): Tool {
	const maxBytes = opts.maxOutputBytes ?? MAX_BYTES;
	const maxLines = opts.maxOutputLines ?? MAX_LINES;

	return {
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
				// 对齐 pi：不设超时（pi 的 bash 无超时，挂死靠用户打断）
				const { stdout, stderr } = await execAsync(command, {
					cwd: opts.cwd,
					maxBuffer: 1024 * 1024,
					windowsHide: true,
				});
				return JSON.stringify({
					stdout: truncateTail(stdout, maxBytes, maxLines),
					stderr: (stderr || "").slice(0, 2000),
				});
			} catch (e) {
				const err = e as { message?: string; stdout?: string; stderr?: string };
				return JSON.stringify({
					error: (err.message ?? "").slice(0, 300),
					stdout: truncateTail(err.stdout ?? "", maxBytes, maxLines),
					stderr: (err.stderr ?? "").slice(0, 2000),
				});
			}
		},
	};
}

/**
 * 对齐 pi 的 truncateTail：保留最后 N 行且不超过 M 字节（先到为准）。
 * 被截断时输出标记 + 完整输出写临时文件、给模型路径（可自行读取）。
 */
function truncateTail(
	output: string,
	maxBytes: number,
	maxLines: number,
): string {
	const totalBytes = Buffer.byteLength(output);
	const allLines = output.split("\n");
	const totalLines = allLines.length;
	if (totalBytes <= maxBytes && totalLines <= maxLines) return output;

	// 从后往前保留行，撞上字节或行数上限即停
	const kept: string[] = [];
	let bytes = 0;
	for (let i = allLines.length - 1; i >= 0; i--) {
		if (kept.length >= maxLines) break;
		const add = Buffer.byteLength(allLines[i]) + 1; // 含换行
		if (bytes + add > maxBytes) break;
		kept.unshift(allLines[i]);
		bytes += add;
	}
	const content = kept.join("\n");

	// 完整输出落临时文件，模型可读路径（对齐 pi 的 temp file + 指针）
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