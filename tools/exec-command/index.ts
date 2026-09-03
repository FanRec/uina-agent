import type { Tool } from "../../src/tools/broker.js";
import type { ToolResultStatus } from "../../src/core/types.js";
import type { JobContext, JobHandle, JobOutcome } from "../../src/extensions/jobs/registry.js";
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

function safeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
	let collectorError: unknown;
	try {
		processResult = await executeShellProcess(command, signal, {
			onStdout: (chunk) => { try { stdout.push(chunk); } catch (error) { collectorError ??= error; } },
			onStderr: (chunk) => { try { stderr.push(chunk); } catch (error) { collectorError ??= error; } },
		});
	} finally {
		stdout.finish();
		stderr.finish();
	}
	if (collectorError) throw collectorError;
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

export function startBackgroundCommand(command: string, context: JobContext): JobHandle {
	const stdout = new OutputCollector();
	const stderr = new OutputCollector();
	let settled = false;
	let resolveDone!: (outcome: JobOutcome) => void;
	const done = new Promise<JobOutcome>((resolve) => { resolveDone = resolve; });
	const finish = (result: ProcessResult): void => {
		if (settled) return;
		settled = true;
		try {
			stdout.finish();
			stderr.finish();
			const stdoutMeta = stdout.snapshot();
			const stderrMeta = stderr.snapshot();
			const status = context.signal.aborted
				? "killed"
				: result.code === 0 ? "completed" : "failed";
			resolveDone({
				status,
				detail: result.code === 0 ? "命令执行完成" : `退出码 ${result.code ?? "unknown"}`,
				output: {
					result: JSON.stringify({
						stdout: stdoutMeta.content,
						stderr: stderrMeta.content,
						code: result.code,
						status,
						truncated: { stdout: stdoutMeta.truncated, stderr: stderrMeta.truncated },
						fullOutputPath: { stdout: stdoutMeta.fullOutputPath, stderr: stderrMeta.fullOutputPath },
					}),
					truncated: stdoutMeta.truncated || stderrMeta.truncated,
					fullOutputPath: stdoutMeta.fullOutputPath ?? stderrMeta.fullOutputPath,
				},
			});
		} catch (error) {
			resolveDone({ status: "failed", detail: `输出收集失败：${safeError(error)}` });
		}
	};
	void executeShellProcess(command, context.signal, {
		onStdout: (chunk) => {
			try { const text = stdout.push(chunk); if (text) context.observe({ stream: "stdout", text }); }
			catch (error) { context.update({ detail: `stdout 收集失败：${safeError(error)}` }); resolveDone({ status: "failed", detail: safeError(error) }); }
		},
		onStderr: (chunk) => {
			try { const text = stderr.push(chunk); if (text) context.observe({ stream: "stderr", text }); }
			catch (error) { context.update({ detail: `stderr 收集失败：${safeError(error)}` }); resolveDone({ status: "failed", detail: safeError(error) }); }
		},
	}).then(finish, (error) => resolveDone({ status: "failed", detail: safeError(error) }));
	return { cancel: (reason) => { context.update({ detail: reason ?? "已请求取消" }); }, done };
}

export function createExecCommandTool(
	jobs?: import("../../src/extensions/jobs/registry.js").JobRegistry,
	ownerId = "root",
): Tool {
	return {
	def: {
		type: "function",
		function: {
			name: "exec_command",
			description:
				"执行一条系统命令并返回其输出（stdout、stderr、退出码）。当前平台为 Windows，命令走 PowerShell；命令可读写文件、运行脚本和管理进程。",
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, run_in_background: { type: "boolean" } },
				required: ["command"],
				additionalProperties: false,
			},
		},
	},
	async run(args, signal) {
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (!command) return JSON.stringify({ error: "command 为空", status: "failed" });
		if (args.run_in_background === true) {
			if (!jobs) throw new Error("后台任务服务未加载");
			const id = jobs.start({
				label: command,
				ownerId,
				source: { extension: "shell", operation: "exec" },
				start: (context) => startBackgroundCommand(command, context),
			});
			return JSON.stringify({ jobId: id, source: { extension: "shell", operation: "exec" }, status: "running" });
		}
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
}

const execCommand: Tool = createExecCommandTool();

export default execCommand;

export const outputLimits = {
	bytes: MAX_OUTPUT_BYTES,
	lines: MAX_OUTPUT_LINES,
};
