import type { Tool } from "../../../tools/broker.js";
import type { ToolResultStatus } from "../../../core/types.js";
import { executeShellProcess, type ProcessResult } from "./process.js";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, OutputCollector, type OutputSnapshot } from "./output.js";

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
	/** Child process working directory. Defaults to `process.cwd()` when omitted. */
	cwd?: string;
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

/** One process/collector lifecycle for foreground calls. */
async function runCommand(
	command: string,
	signal: AbortSignal | undefined,
	options: ShellRunOptions,
): Promise<ShellResult> {
	const local = new AbortController();
	let collectorError: unknown;
	const fail = (error: unknown): void => {
		collectorError ??= error;
		local.abort(error);
	};
	const stdout = new OutputCollector(fail);
	const stderr = new OutputCollector(fail);
	const collect = (collector: OutputCollector, chunk: Buffer): void => {
		try {
			collector.push(chunk);
		} catch (error) {
			fail(error);
		}
	};
	let result: ProcessResult;
	try {
		result = await executeShellProcess(
			command,
			signal ? AbortSignal.any([signal, local.signal]) : local.signal,
			{
				onStdout: (chunk) => collect(stdout, chunk),
				onStderr: (chunk) => collect(stderr, chunk),
			},
			options,
		);
	} finally {
		const closed = await Promise.allSettled([stdout.close(), stderr.close()]);
		for (const outcome of closed) if (outcome.status === "rejected") fail(outcome.reason);
	}
	if (collectorError) throw collectorError;
	const stdoutMeta = stdout.snapshot();
	const stderrMeta = stderr.snapshot();
	return { ...result, stdout: stdoutMeta.content, stderr: stderrMeta.content, stdoutMeta, stderrMeta };
}

export function createExecCommandTool(cwd?: string): Tool {
	return {
		def: {
			type: "function",
			function: {
				name: "exec_command",
				description: `执行开发或系统诊断命令并返回 stdout、stderr、退出码。当前平台使用 ${shellDisplayName()}；已有领域工具时不要绕过它。输出超过 ${MAX_OUTPUT_BYTES / 1024} KB 或 ${MAX_OUTPUT_LINES} 行时返回尾部并提供 fullOutputPath。`,
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						timeout: { type: "number", description: "超时秒数；省略表示不设超时" },
					},
					required: ["command"],
					additionalProperties: false,
				},
			},
		},
		async run(args, signal) {
			const command = typeof args.command === "string" ? args.command.trim() : "";
			if (!command) return { result: "command 为空", status: "not_started" };
			const timeoutMs = resolveTimeoutMs(args.timeout);
			const result = await execCommandDirect(command, signal, { timeoutMs, cwd });
			const status: ToolResultStatus = result.cancelled
				? "cancelled"
				: result.timedOut
					? "failed"
					: result.code === 0
						? "succeeded"
						: "failed";
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
