import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../.uina/extensions/tts/config.js";
import { ensureSubtitleService } from "../.uina/extensions/tts/subtitle-companion.js";

function healthy(pid = 4242): Response {
	return Response.json({ service: "realtime-subtitles", version: 1, process: { ready: true, pid } });
}
function childProcess() {
	return Object.assign(new EventEmitter(), {
		pid: 4242,
		exitCode: null as number | null,
		signalCode: null,
		stdout: null,
		stderr: null,
	});
}

describe("subtitle service companion", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "uina-subtitle-"));
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist/main.js"), "");
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});
	function config() {
		return loadConfig(undefined, { subtitleServiceDir: dir, subtitleStartupTimeoutMs: 1000 });
	}

	it("reuses a healthy service without killing it", async () => {
		const spawn = vi.fn(() => {
			throw new Error("must not spawn");
		});
		const kill = vi.fn();
		const handle = await ensureSubtitleService(config(), undefined, {
			fetchImpl: async () => healthy(),
			spawnProcess: spawn as never,
			killProcessTree: kill,
		});
		await handle.stop();
		expect(handle.didSpawn).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

	it("rejects unrelated HTTP 200 responses", async () => {
		await expect(
			ensureSubtitleService({ ...config(), subtitleAutoSpawn: false }, undefined, {
				fetchImpl: async () => Response.json({ process: { ready: true } }),
			}),
		).rejects.toThrow("disabled");
	});

	it("starts the built service and stops it once", async () => {
		const child = childProcess();
		let calls = 0;
		const kill = vi.fn(async () => {
			child.exitCode = 0;
			child.emit("exit", 0);
		});
		const handle = await ensureSubtitleService(config(), undefined, {
			fetchImpl: async () => (calls++ ? healthy() : new Response(null, { status: 503 })),
			spawnProcess: (() => child) as never,
			killProcessTree: kill,
		});
		expect(handle).toMatchObject({ didSpawn: true, pid: 4242 });
		await Promise.all([handle.stop(), handle.stop()]);
		expect(kill).toHaveBeenCalledTimes(1);
	});

	it("does not spawn when cancelled during the initial health check", async () => {
		const controller = new AbortController();
		const spawn = vi.fn(() => {
			throw new Error("must not spawn");
		});
		await expect(
			ensureSubtitleService(config(), controller.signal, {
				fetchImpl: async () => {
					controller.abort();
					return new Response(null, { status: 503 });
				},
				spawnProcess: spawn as never,
			}),
		).rejects.toThrow("aborted");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("cleans up when cancelled during startup health checking", async () => {
		const controller = new AbortController();
		const child = childProcess();
		let calls = 0;
		const kill = vi.fn(async () => {
			child.exitCode = 0;
			child.emit("exit", 0);
		});
		await expect(
			ensureSubtitleService(config(), controller.signal, {
				fetchImpl: async () => {
					if (calls++ === 0) return new Response(null, { status: 503 });
					controller.abort();
					return healthy();
				},
				spawnProcess: (() => child) as never,
				killProcessTree: kill,
			}),
		).rejects.toThrow("aborted");
		expect(kill).toHaveBeenCalledOnce();
	});

	it("fails promptly when the process cannot spawn", async () => {
		const child = childProcess();
		Object.assign(child, { pid: undefined });
		await expect(
			ensureSubtitleService(config(), undefined, {
				fetchImpl: async () => new Response(null, { status: 503 }),
				spawnProcess: (() => {
					queueMicrotask(() => child.emit("error", new Error("spawn failed")));
					return child;
				}) as never,
			}),
		).rejects.toThrow("spawn");
	});

	it("does not kill an already exited process", async () => {
		const child = childProcess();
		let calls = 0;
		const kill = vi.fn();
		const handle = await ensureSubtitleService(config(), undefined, {
			fetchImpl: async () => (calls++ ? healthy() : new Response(null, { status: 503 })),
			spawnProcess: (() => child) as never,
			killProcessTree: kill,
		});
		child.exitCode = 0;
		await handle.stop();
		expect(kill).not.toHaveBeenCalled();
	});

	it("reports a process that remains alive after stop", async () => {
		const child = childProcess();
		let calls = 0;
		const handle = await ensureSubtitleService(config(), undefined, {
			fetchImpl: async () => (calls++ ? healthy() : new Response(null, { status: 503 })),
			spawnProcess: (() => child) as never,
			killProcessTree: async () => {},
		});
		vi.useFakeTimers();
		const result = expect(handle.stop()).rejects.toThrow("did not exit");
		await vi.advanceTimersByTimeAsync(5001);
		await result;
	});

	it("does not accept another process as its own successful startup", async () => {
		vi.useFakeTimers();
		const child = childProcess();
		let calls = 0;
		const kill = vi.fn(async () => {
			child.exitCode = 0;
			child.emit("exit", 0);
		});
		const result = expect(
			ensureSubtitleService(config(), undefined, {
				fetchImpl: async () => (calls++ ? healthy(9999) : new Response(null, { status: 503 })),
				spawnProcess: (() => child) as never,
				killProcessTree: kill,
			}),
		).rejects.toThrow("failed to become healthy");
		await vi.advanceTimersByTimeAsync(1001);
		await result;
		expect(kill).toHaveBeenCalledOnce();
	});

	it("reports failed process termination", async () => {
		const child = childProcess();
		let calls = 0;
		const handle = await ensureSubtitleService(config(), undefined, {
			fetchImpl: async () => (calls++ ? healthy() : new Response(null, { status: 503 })),
			spawnProcess: (() => child) as never,
			killProcessTree: async () => {
				throw new Error("kill failed");
			},
		});
		await expect(handle.stop()).rejects.toThrow("kill failed");
	});

	it.each([
		"https://127.0.0.1:18140",
		"http://example.com:18140",
		"http://127.0.0.1:18140/path",
		"http://127.0.0.1:18140/?x=1",
	])("rejects unsupported URL %s", async (url) => {
		await expect(ensureSubtitleService({ ...config(), subtitleServiceUrl: url })).rejects.toThrow("local HTTP origin");
	});

	it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s", async (timeout) => {
		await expect(ensureSubtitleService({ ...config(), subtitleStartupTimeoutMs: timeout })).rejects.toThrow("timeout");
	});
});
