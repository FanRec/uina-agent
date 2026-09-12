import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface ProcessResult {
	code: number | null;
	cancelled: boolean;
	timedOut: boolean;
}

export interface ProcessCallbacks {
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
}

export interface ProcessOptions {
	/** Wall-clock limit in milliseconds. No limit when omitted. */
	timeoutMs?: number;
}

/** A quiet inherited stdio handle must not hold the caller hostage forever. */
const EXIT_STDIO_GRACE_MS = 100;

import {
	killTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../../runtime/process-tracker.js";

/** Execute one command through the platform normal shell. */
export function executeShellProcess(
	command: string,
	signal: AbortSignal | undefined,
	callbacks: ProcessCallbacks,
	options: ProcessOptions = {},
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const { shell, args } = resolveShell();
		const child = spawn(shell, args(command), {
			cwd: process.cwd(),
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
			detached: process.platform !== "win32",
		});

		if (child.pid !== undefined) trackDetachedChildPid(child.pid);
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let settled = false;

		const kill = (): void => {
			if (child.pid !== undefined) killTree(child.pid);
		};
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
			signal?.removeEventListener("abort", kill);
			resolve({ code, cancelled: signal?.aborted ?? false, timedOut });
		};

		child.stdout?.on("data", callbacks.onStdout);
		child.stderr?.on("data", callbacks.onStderr);
		child.on("error", (error) => {
			callbacks.onStderr(Buffer.from(`spawn failed: ${safeError(error)}\n`));
			finish(null);
		});

		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				kill();
			}, options.timeoutMs);
		}
		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		child.on("spawn", () => {
			if (signal?.aborted) kill();
		});

		// Resolve on close, but never hang on a detached descendant that keeps an
		// inherited stdio pipe open (Pi: utils/child-process.ts waitForChildProcess).
		waitForChildProcess(child).then(finish, () => finish(null));
	});
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio
 * handles. After `exit` we wait for the pipes to fall idle: the grace timer is
 * re-armed on every chunk, so an actively writing descendant keeps us reading,
 * while a quiet inherited handle releases us after the grace elapses.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = (): void => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const maybeFinalizeAfterExit = (): void => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) finalize(exitCode);
		};
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null): void => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null): void => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

function resolveShell(): { shell: string; args: (command: string) => string[] } {
	if (process.platform !== "win32") {
		return { shell: "/bin/sh", args: (command) => ["-c", command] };
	}
	const utf8Prefix = "$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ";
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const pwsh = join(programFiles, "PowerShell", "7", "pwsh.exe");
	if (existsSync(pwsh)) {
		return {
			shell: pwsh,
			args: (command) => ["-NoProfile", "-NonInteractive", "-Command", `${utf8Prefix}${command}`],
		};
	}
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (existsSync(powershell)) {
		return {
			shell: powershell,
			args: (command) => ["-NoProfile", "-NonInteractive", "-Command", `${utf8Prefix}${command}`],
		};
	}
	return { shell: "cmd.exe", args: (command) => ["/d", "/s", "/c", command] };
}



function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
