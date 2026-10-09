import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NeteaseApiClient } from "../.uina/worlds/netease-jukebox/api-client.js";
import { CompanionManager } from "../.uina/worlds/netease-jukebox/companion.js";

describe("CompanionManager", () => {
	it("returns the child exit reason instead of waiting for the full startup timeout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "uina-netease-companion-"));
		try {
			await writeFile(join(directory, "app.js"), "");
			const child = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn(), unref: vi.fn() });
			const api = { isHealthy: vi.fn(async () => false) } as unknown as NeteaseApiClient;
			const manager = new CompanionManager(directory, 19302, {
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
			const manager = new CompanionManager(directory, 19303, {
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
			const manager = new CompanionManager(directory, 19304, { spawn: (() => child as never) as never });

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
			const manager = new CompanionManager(directory, 19305, { spawn: (() => child as never) as never });
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
			const manager = new CompanionManager(directory, 19306, { spawn: (() => child as never) as never });
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
});
