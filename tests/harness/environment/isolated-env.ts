import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedEnvOptions {
	readonly prefix?: string;
	readonly keepOnError?: boolean;
}

/**
 * 隔离的测试环境沙箱：
 * 自动在系统临时目录分配独立工作区，提供会话文件路径，并在 dispose 时严格清理。
 */
export class IsolatedEnv {
	readonly cwd: string;
	readonly sessionPath: string;
	private disposed = false;

	private constructor(cwd: string) {
		this.cwd = cwd;
		this.sessionPath = join(cwd, "session.jsonl");
	}

	static async create(options: IsolatedEnvOptions = {}): Promise<IsolatedEnv> {
		const prefix = options.prefix ?? "uina-test-";
		const cwd = await mkdtemp(join(tmpdir(), prefix));
		return new IsolatedEnv(cwd);
	}

	get path(): string {
		return this.cwd;
	}

	resolve(...paths: string[]): string {
		return join(this.cwd, ...paths);
	}

	async writeFile(relativePath: string, content: string | Uint8Array): Promise<string> {
		const fullPath = join(this.cwd, relativePath);
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, typeof content === "string" ? "utf8" : undefined);
		return fullPath;
	}

	async writeExtension(name: string, content: string): Promise<string> {
		return this.writeFile(join(".uina", "extensions", name), content);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await rm(this.cwd, { recursive: true, force: true }).catch(() => undefined);
	}

	async cleanup(): Promise<void> {
		return this.dispose();
	}
}
