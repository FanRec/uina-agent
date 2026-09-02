import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface ProcessResult {
	code: number | null;
	cancelled: boolean;
}

export interface ProcessCallbacks {
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
}

/** Execute one command through the platform's normal shell. */
export function executeShellProcess(
	command: string,
	signal: AbortSignal | undefined,
	callbacks: ProcessCallbacks,
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const { shell, args } = resolveShell();
		const child = spawn(shell, args(command), {
			cwd: process.cwd(),
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
			detached: process.platform !== "win32",
		});

		let settled = false;
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", kill);
			resolve({ code, cancelled: signal?.aborted ?? false });
		};
		const kill = (): void => {
			if (child.pid !== undefined) killTree(child.pid);
		};

		child.stdout?.on("data", callbacks.onStdout);
		child.stderr?.on("data", callbacks.onStderr);
		child.on("error", (error) => {
			callbacks.onStderr(Buffer.from(`spawn 失败: ${safeError(error)}\n`));
			finish(null);
		});
		// close waits for stdout/stderr pipes to close; exit alone can precede their flush.
		child.on("close", (code) => finish(code));
		// After an explicit abort, the shell can exit while a descendant still owns a pipe.
		// In that case close may never arrive; cancellation has no successful output to flush.
		child.on("exit", (code) => {
			if (signal?.aborted) finish(code);
		});

		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		child.on("spawn", () => {
			if (signal?.aborted) kill();
		});
	});
}

function resolveShell(): { shell: string; args: (command: string) => string[] } {
	if (process.platform !== "win32") {
		return { shell: "/bin/sh", args: (command) => ["-c", command] };
	}
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const pwsh = join(programFiles, "PowerShell", "7", "pwsh.exe");
	if (existsSync(pwsh)) {
		return {
			shell: pwsh,
			args: (command) => ["-NoProfile", "-NonInteractive", "-Command", command],
		};
	}
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershell = join(
		systemRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	if (existsSync(powershell)) {
		const prefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
		return {
			shell: powershell,
			args: (command) => [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`${prefix}${command}`,
			],
		};
	}
	return { shell: "cmd.exe", args: (command) => ["/d", "/s", "/c", command] };
}

function killTree(pid: number): void {
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
			windowsHide: true,
			stdio: "ignore",
		});
		killer.on("error", () => undefined);
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process already exited.
		}
	}
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
