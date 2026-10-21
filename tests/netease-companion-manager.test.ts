import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NeteaseApiClient } from "../.uina/worlds/netease-jukebox/api-client.js";
import { CompanionManager, type CompanionManagerOptions } from "../.uina/worlds/netease-jukebox/companion.js";

/** 默认实现会真跑 generateConfig（子进程 + 网络），单测一律注入空实现。 */
const noopKey = async (): Promise<string | undefined> => undefined;

const createManager = (directory: string, port: number, options: CompanionManagerOptions = {}): CompanionManager =>
	new CompanionManager(directory, port, { ensureXeapiKey: noopKey, ...options });

describe("CompanionManager", () => {
	it("returns the child exit reason instead of waiting for the full startup timeout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = { isHealthy: vi.fn(async () => false) } as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19302, {
				spawn: (() => {
					queueMicrotask(() => child.emit("exit", 1, null));
					return child as never;
				}) as never,
			});

			const startedAt = Date.now();
			const status = await manager.ensureRunning(api, 5000);

			expect(status.running).toBe(false);
			expect(status.detail).toContain("退出码 1");
			expect(Date.now() - startedAt).toBeLessThan(1000);
			expect(api.isHealthy).toHaveBeenCalledTimes(2);
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reports a process spawn error", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = { isHealthy: vi.fn(async () => false) } as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19303, {
				spawn: (() => {
					queueMicrotask(() => child.emit("error", new Error("executable unavailable")));
					return child as never;
				}) as never,
			});

			const status = await manager.ensureRunning(api, 5000);

			expect(status.running).toBe(false);
			expect(status.detail).toContain("executable unavailable");
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps a ready API companion alive when the World stops", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = {
				isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
			} as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19304, {
				spawn: (() => child as never) as never,
			});

			await expect(manager.ensureRunning(api)).resolves.toMatchObject({ running: true, spawnedByUs: true });
			await manager.stop();

			expect(child.unref).toHaveBeenCalledOnce();
			expect(child.kill).not.toHaveBeenCalled();
			expect(manager.getStatus().running).toBe(true);
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not let one cancelled waiter cancel shared startup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			let releaseHealthCheck: (() => void) | undefined;
			const healthCheck = new Promise<void>((resolve) => {
				releaseHealthCheck = resolve;
			});
			let checks = 0;
			const api = {
				isHealthy: vi.fn(async () => {
					checks++;
					if (checks === 1) return false;
					await healthCheck;
					return true;
				}),
			} as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19305, {
				spawn: (() => child as never) as never,
			});
			const controller = new AbortController();
			const first = manager.ensureRunning(api, 5000, controller.signal);
			while (checks === 0) await new Promise((resolve) => setTimeout(resolve, 0));
			const second = manager.ensureRunning(api, 5000);
			controller.abort(new Error("cancel first waiter"));

			await expect(first).rejects.toThrow("cancel first waiter");
			releaseHealthCheck?.();
			await expect(second).resolves.toMatchObject({ running: true });
			expect(child.kill).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("passes a file-descriptor stdio and creates the daily log file when logDir is set", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		const logDir = join(directory, "logs");
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = {
				isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
			} as unknown as NeteaseApiClient;
			let spawnOptions: { stdio?: unknown } | undefined;
			const manager = createManager(directory, 19307, {
				spawn: ((_path: unknown, _args: unknown, options: { stdio?: unknown }) => {
					spawnOptions = options;
					return child as never;
				}) as never,
				logDir,
			});

			await expect(manager.ensureRunning(api)).resolves.toMatchObject({ running: true, spawnedByUs: true });

			expect(Array.isArray(spawnOptions?.stdio)).toBe(true);
			const [stdin, stdout, stderr] = spawnOptions?.stdio as unknown[];
			expect(stdin).toBe("ignore");
			expect(typeof stdout).toBe("number");
			expect(stderr).toBe(stdout);
			const { readdir } = await import("node:fs/promises");
			expect(await readdir(logDir)).toEqual([expect.stringMatching(/^api-enhanced-\d{4}-\d{2}-\d{2}\.log$/)]);
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("kills an unready child when the World stops during startup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			let releaseHealthCheck: (() => void) | undefined;
			const healthCheck = new Promise<void>((resolve) => {
				releaseHealthCheck = resolve;
			});
			let checks = 0;
			const api = {
				isHealthy: vi.fn(async () => {
					checks++;
					if (checks === 1) return false;
					await healthCheck;
					return false;
				}),
			} as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19306, {
				spawn: (() => child as never) as never,
			});
			const startup = manager.ensureRunning(api, 5000);
			while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 0));
			const stopping = manager.stop();
			releaseHealthCheck?.();

			await expect(startup).resolves.toMatchObject({ running: false });
			await stopping;
			expect(child.kill).toHaveBeenCalledOnce();
			expect(manager.getStatus().running).toBe(false);
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("repairs the xeapi public key before spawning the service", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const order: string[] = [];
			const api = {
				isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
			} as unknown as NeteaseApiClient;
			const manager = createManager(directory, 19308, {
				spawn: (() => {
					order.push("spawn");
					return child as never;
				}) as never,
				ensureXeapiKey: async (dir: string) => {
					order.push(`key:${dir}`);
				},
			});

			await expect(manager.ensureRunning(api)).resolves.toMatchObject({ running: true, spawnedByUs: true });
			expect(order).toEqual([`key:${directory}`, "spawn"]);
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("still starts the service when the xeapi public key cannot be repaired", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = {
				isHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
			} as unknown as NeteaseApiClient;
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const manager = createManager(directory, 19309, {
				spawn: (() => child as never) as never,
				ensureXeapiKey: async () => "network down",
			});

			await expect(manager.ensureRunning(api)).resolves.toMatchObject({ running: true, spawnedByUs: true });
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("network down"));
		} finally {
			vi.restoreAllMocks();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
