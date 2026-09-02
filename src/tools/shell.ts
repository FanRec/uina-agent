/**
 * shell 工具：让主体能执行命令、操作文件、查询系统——"活在计算机里"的基础。
 *
 * 安全边界（当前刀）：
 *  - 限定在 baseDir 内执行（不可越出项目沙箱）
 *  - 超时与输出截断，防挂死/防刷爆上下文
 *  - 无命令白名单——这是有副作用的工具，模型提议、由调用方决定是否放行。
 *    将来接入权限/策略层时在此收敛（确定性代码拥有授权，模型只提议）。
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./broker.js";

const execAsync = promisify(exec);

export interface ShellToolOpts {
	baseDir: string;
	timeoutMs?: number;
	maxOutput?: number;
}

export function shellTool(opts: ShellToolOpts): Tool {
	const timeoutMs = opts.timeoutMs ?? 15000;
	const maxOutput = opts.maxOutput ?? 2000;

	return {
		def: {
			type: "function",
			function: {
				name: "run_shell",
				description:
					"在沙箱目录内执行一条 shell 命令并返回输出。用于查询系统信息、读写文件、运行脚本、查看目录等。命令须在项目目录内进行。",
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
					cwd: opts.baseDir,
					timeout: timeoutMs,
					maxBuffer: 1024 * 1024,
					windowsHide: true,
				});
				return JSON.stringify({
					stdout: (stdout || "").slice(0, maxOutput),
					stderr: (stderr || "").slice(0, 1000),
				});
			} catch (e) {
				const err = e as { message?: string; stdout?: string; stderr?: string };
				return JSON.stringify({
					error: (err.message ?? "").slice(0, 300),
					stdout: (err.stdout ?? "").slice(0, maxOutput),
					stderr: (err.stderr ?? "").slice(0, 1000),
				});
			}
		},
	};
}
