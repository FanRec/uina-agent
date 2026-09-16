import type { Tool } from "../../../tools/broker.js";
import { errorMessage } from "../../../core/errors.js";
import type { ToolResultStatus } from "../../../core/types.js";
import type { JobContext, JobHandle, JobOutcome } from "../../jobs/registry.js";
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
	timedOut: boolean;
	stdoutMeta?: OutputSnapshot;
	stderrMeta?: OutputSnapshot;
}

export interface ShellRunOptions {
	/** Wall-clock limit in milliseconds. No limit when omitted. */
	timeoutMs?: number;
}


/** Human-readable shell name for the current platform (used in the tool description). */
function shellDisplayName(): string {
	if (process.platform === "win32") return "PowerShell";
	return "/bin/sh";
}

export async function execCommandDirect(
	command: string,
	signal?: AbortSignal,
	options: ShellRunOptions = {},
): Promise<ShellResult> {
	return runCommand(command, signal, options);
}

/** One process/collector lifecycle for both foreground and background calls. */
async function runCommand(
	command: string,
	signal: AbortSignal | undefined,
	options: ShellRunOptions,
	observe?: JobContext["observe"],
): Promise<ShellResult> {
	const local = new AbortController();
	let collectorError: unknown;
	const fail = (error: unknown): void => {
		collectorError ??= error;
		local.abort(error);
	};
	const stdout = new OutputCollector(fail);
	const stderr = new OutputCollector(fail);
	const collect = (collector: OutputCollector, stream: "stdout" | "stderr", chunk: Buffer): void => {
		try {
			const text = collector.push(chunk);
			if (text) observe?.({ stream, text });
		} catch (error) { fail(error); }
	};
	let result: ProcessResult;
	try {
		result = await executeShellProcess(command, signal ? AbortSignal.any([signal, local.signal]) : local.signal, {
			onStdout: (chunk) => collect(stdout, "stdout", chunk),
			onStderr: (chunk) => collect(stderr, "stderr", chunk),
		}, options);
	} finally {
		const closed = await Promise.allSettled([stdout.close(), stderr.close()]);
		for (const outcome of closed) if (outcome.status === "rejected") fail(outcome.reason);
	}
	if (collectorError) throw collectorError;
	const stdoutMeta = stdout.snapshot();
	const stderrMeta = stderr.snapshot();
	return { ...result, stdout: stdoutMeta.content, stderr: stderrMeta.content, stdoutMeta, stderrMeta };
}

export function startBackgroundCommand(command: string, context: JobContext, options: ShellRunOptions = {}): JobHandle {
	const done = runCommand(command, context.signal, options, context.observe).then((result): JobOutcome => {
		const status = result.cancelled ? "killed" : result.timedOut || result.code !== 0 ? "failed" : "completed";
		return {
			status,
			detail: result.timedOut ? "命令超时" : result.code === 0 ? "命令执行完成" : `退出码 ${result.code ?? "unknown"}`,
			output: {
				result: JSON.stringify({
					stdout: result.stdout, stderr: result.stderr, code: result.code, status,
					truncated: { stdout: result.stdoutMeta?.truncated, stderr: result.stderrMeta?.truncated },
					fullOutputPath: { stdout: result.stdoutMeta?.fullOutputPath, stderr: result.stderrMeta?.fullOutputPath },
				}),
				truncated: result.stdoutMeta?.truncated || result.stderrMeta?.truncated,
				fullOutputPath: result.stdoutMeta?.fullOutputPath ?? result.stderrMeta?.fullOutputPath,
			},
		};
	}, (error): JobOutcome => ({ status: "failed", detail: `命令执行或输出收集失败：${errorMessage(error)}` }));
	return { cancel: (reason) => context.update({ detail: reason ?? "已请求取消" }), done };
}

export function createExecCommandTool(
	jobs?: import("../../jobs/registry.js").JobRegistry,
	ownerId = "root",
): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "exec_command",
				description:
					`执行一条系统命令并返回其输出（stdout、stderr、退出码）。当前平台使用 ${shellDisplayName()}；命令可读写文件、运行脚本和管理进程。输出超过 ${MAX_OUTPUT_BYTES / 1024} KB 或 ${MAX_OUTPUT_LINES} 行时只返回尾部，完整输出写入 fullOutputPath。`,
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						run_in_background: { type: "boolean" },
						timeout: { type: "number", description: "超时秒数；省略表示不设超时" },
					},
					required: ["command"],
					additionalProperties: false,
				},
			},
		},
		async run(args, signal, context) {
			const command = typeof args.command === "string" ? args.command.trim() : "";
			if (!command) return { result: "command 为空", status: "not_started" };
			const timeoutMs = resolveTimeoutMs(args.timeout);
			if (args.run_in_background === true) {
				if (!jobs) throw new Error("后台任务服务未加载");
				const id = jobs.start({
					label: command,
					ownerId: context?.ownerId ?? ownerId,
					source: { extension: "shell", operation: "exec" },
					start: (context) => startBackgroundCommand(command, context, { timeoutMs }),
				});
				return {
					result: JSON.stringify({ jobId: id, source: { extension: "shell", operation: "exec" }, status: "running" }),
					status: "succeeded",
					details: { effects: [{ effectType: "task.dispatch", externalOperationId: id, label: command }] },
				};
			}
			const result = await execCommandDirect(command, signal, { timeoutMs });
			const status: ToolResultStatus = result.cancelled
				? "cancelled"
				: result.timedOut ? "failed" : result.code === 0 ? "succeeded" : "failed";
			const body: Record<string, unknown> = {
				code: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
				status,
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
			if (result.timedOut) body.error = `命令超时（${timeoutMs} ms）`;
			else if (result.code !== 0 && !result.cancelled) body.error = `退出码 ${result.code}`;
			return {
				result: JSON.stringify(body),
				status,
				details: { effects: [{ effectType: "command.exec", label: command }] },
			};
		},
	};
}

/** Reject invalid timeouts instead of silently clamping them (Pi: tools/bash.ts:29-40). */
function resolveTimeoutMs(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("timeout 必须是正数秒数");
	}
	const ms = value * 1000;
	if (ms > 2_147_483_647) throw new Error("timeout 超出允许的最大值");
	return ms;
}

const execCommand: Tool = createExecCommandTool();

export default execCommand;
