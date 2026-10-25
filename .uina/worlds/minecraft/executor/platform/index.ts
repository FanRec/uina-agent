import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export interface ProcessIdentity {
	readonly pid: number;
	/** Exact Windows process creation FILETIME, encoded as decimal 100 ns ticks. */
	readonly createdAt: string;
}

interface NativeBinding {
	selfIdentity(): ProcessIdentity;
	acquire(directory: string, accountDigest: string): object;
	openProcess(owner: object, pid: number): { handle: object; identity: ProcessIdentity };
	closeProcess(process: object): void;
	terminateProcess(process: object): void;
	assign(owner: object, process: object): void;
	terminate(owner: object): void;
	active(owner: object): { directory: number; account: number };
	waitRetired(owner: object, process: object, timeoutMs: number): Promise<boolean>;
	close(owner: object): void;
}

let loaded: NativeBinding | undefined;
function platformError(code: string, message: string, cause?: unknown): Error & { code: string } {
	return Object.assign(new Error(message, { cause }), { code });
}
function binding(): NativeBinding {
	if (process.platform !== "win32" || process.arch !== "x64") {
		throw platformError(
			"EXECUTOR_PLATFORM_UNSUPPORTED",
			`Minecraft ownership requires Windows x64 (${process.platform}/${process.arch})`,
		);
	}
	if (!loaded) {
		try {
			loaded = createRequire(import.meta.url)("./native/win32-x64.node") as NativeBinding;
		} catch (cause) {
			throw platformError(
				"EXECUTOR_OWNERSHIP_UNAVAILABLE",
				`Minecraft native ownership could not load: ${String(cause)}`,
				cause,
			);
		}
	}
	return loaded;
}

export interface ManagedProcess {
	readonly identity: ProcessIdentity;
	terminate(): void;
	close(): void;
}

const processes = new WeakMap<ManagedProcess, { owner: object; handle: object }>();

class ProcessHandle implements ManagedProcess {
	readonly identity: ProcessIdentity;
	#handle: object;
	constructor(owner: object, handle: object, identity: ProcessIdentity) {
		this.#handle = handle;
		processes.set(this, { owner, handle });
		this.identity = Object.freeze(identity);
	}
	terminate(): void {
		binding().terminateProcess(this.#handle);
	}
	close(): void {
		binding().closeProcess(this.#handle);
	}
}

export class WindowsOwnership {
	#handle: object;
	constructor(handle: object) {
		this.#handle = handle;
	}
	openProcess(pid: number): ManagedProcess {
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("INVALID_PID");
		const process = binding().openProcess(this.#handle, pid);
		return new ProcessHandle(this.#handle, process.handle, process.identity);
	}
	#process(process: ManagedProcess): object {
		const managed = processes.get(process);
		if (!managed || managed.owner !== this.#handle) throw new Error("PROCESS_OWNERSHIP");
		return managed.handle;
	}
	assign(process: ManagedProcess): void {
		binding().assign(this.#handle, this.#process(process));
	}
	terminate(): void {
		binding().terminate(this.#handle);
	}
	activeProcesses(): { directory: number; account: number } {
		return binding().active(this.#handle);
	}
	waitRetired(process: ManagedProcess, timeoutMs: number): Promise<boolean> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0xffffffff) throw new Error("INVALID_TIMEOUT");
		return binding().waitRetired(this.#handle, this.#process(process), timeoutMs);
	}
	close(): void {
		binding().close(this.#handle);
	}
}

export function selfProcessIdentity(): ProcessIdentity {
	return Object.freeze(binding().selfIdentity());
}

export function acquireOwnership(dataDir: string, accountKey: string): WindowsOwnership {
	if (!dataDir || dataDir.includes("\0") || !accountKey || accountKey.includes("\0"))
		throw new Error("INVALID_OWNERSHIP_IDENTITY");
	const native = binding();
	try {
		return new WindowsOwnership(native.acquire(dataDir, createHash("sha256").update(accountKey).digest("hex")));
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && (cause.code === "DATA_DIR_BUSY" || cause.code === "ACCOUNT_BUSY"))
			throw cause;
		throw platformError(
			"EXECUTOR_OWNERSHIP_UNAVAILABLE",
			`Minecraft ownership acquisition failed: ${String(cause)}`,
			cause,
		);
	}
}
