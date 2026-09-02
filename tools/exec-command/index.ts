import type { Tool } from "../../src/tools/broker.js";
import type { ToolResultStatus } from "../../src/core/types.js";
import { executeShellProcess, type ProcessResult } from "./process.js";
import {
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	OutputCollector,
	type OutputSnapshot,
} from "./output.js";

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number | null;
	cancelled: boolean;
	stdoutMeta?: OutputSnapshot;
	stderrMeta?: OutputSnapshot;
}

export { createByteDecoder } from "./output.js";

export async function execCommandDirect(
	command: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	const stdout = new OutputCollector();
	const stderr = new OutputCollector();
	let processResult: ProcessResult = {
		code: null,
		cancelled: signal?.aborted ?? false,
	};
	try {
		processResult = await executeShellProcess(command, signal, {
			onStdout: (chunk) => stdout.push(chunk),
			onStderr: (chunk) => stderr.push(chunk),
		});
	} finally {
		stdout.finish();
		stderr.finish();
	}
	const stdoutMeta = stdout.snapshot();
	const stderrMeta = stderr.snapshot();
	return {
		stdout: stdoutMeta.content,
		stderr: stderrMeta.content,
		code: processResult.code,
		cancelled: processResult.cancelled,
		stdoutMeta,
		stderrMeta,
	};
}

const execCommand: Tool = {
	def: {
		type: "function",
		function: {
			name: "exec_command",
			description:
				"执行一条系统命令并返回其输出（stdout、stderr、退出码）。当前平台为 Windows，命令走 PowerShell；命令可读写文件、运行脚本和管理进程。",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
				additionalProperties: false,
			},
		},
	},
	async run(args, signal) {
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (!command) return JSON.stringify({ error: "command 为空", status: "failed" });
		const result = await execCommandDirect(command, signal);
		const body: Record<string, unknown> = {
			stdout: result.stdout,
			stderr: result.stderr,
			status: result.cancelled
				? "cancelled"
				: result.code === 0
					? "succeeded"
					: "failed" satisfies ToolResultStatus,
			stdoutBytes: result.stdoutMeta?.totalBytes,
			stdoutLines: result.stdoutMeta?.totalLines,
			stderrBytes: result.stderrMeta?.totalBytes,
			stderrLines: result.stderrMeta?.totalLines,
			truncated: {
				stdout: result.stdoutMeta?.truncated ?? false,
				stderr: result.stderrMeta?.truncated ?? false,
			},
			fullOutputPath: {
				stdout: result.stdoutMeta?.fullOutputPath,
				stderr: result.stderrMeta?.fullOutputPath,
			},
		};
		if (result.code !== 0 && !result.cancelled) body.error = `退出码 ${result.code}`;
		return JSON.stringify(body);
	},
};

export default execCommand;

export const outputLimits = {
	bytes: MAX_OUTPUT_BYTES,
	lines: MAX_OUTPUT_LINES,
};
