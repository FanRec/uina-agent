/** M1 硬前置：稳定根目录 Job 跨 Profile 唯一、close 三事实与入服终态回执（v3 §4.1/§6.2/§6.3）。 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";

const config = (username: string) => ({
	connection: {
		host: "127.0.0.1",
		port: 1, // 无服务器：连接必败，满足纯进程/所有权层面的验证。
		username,
		authMode: "offline",
		version: "1.21.11",
	},
	binding: null,
});

test("two profiles on one stable root cannot hold the directory Job concurrently; release re-enables", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-executor-roots-"));
	let first: MinecraftExecutor | undefined;
	try {
		first = await MinecraftExecutor.open({
			ownershipDir: root,
			sessionDataDir: join(root, "sessions", randomUUID().replaceAll("-", "")),
			sharedDataDir: root,
			config: config("RootsA"),
			policy: { autoRecover: false, closeGraceMs: 3000, retirementMs: 8000 },
		});
		// 不同账号（account Job 键不同）也必须被目录 Job 挡住：单活跃写源跨 Profile 成立。
		await expect(
			MinecraftExecutor.open({
				ownershipDir: root,
				sessionDataDir: join(root, "sessions", randomUUID().replaceAll("-", "")),
				sharedDataDir: root,
				config: config("RootsB"),
				policy: { autoRecover: false },
			}),
		).rejects.toMatchObject({ code: "DATA_DIR_BUSY" });

		const result = await first.close();
		first = undefined;
		expect(result).toEqual({ process: "retired", ownership: "released", runtime: "clean" });

		const second = await MinecraftExecutor.open({
			ownershipDir: root,
			sessionDataDir: join(root, "sessions", randomUUID().replaceAll("-", "")),
			sharedDataDir: root,
			config: config("RootsB"),
			policy: { autoRecover: false, closeGraceMs: 3000, retirementMs: 8000 },
		});
		try {
			expect(second.status().phase).toBe("ready");
			// 换目录重开同样放行（v3 M1 放行：脏退出但进程确认退出后可换目录重开）。
		} finally {
			const closed = await second.close();
			expect(closed.process).toBe("retired");
			expect(closed.ownership).toBe("released");
		}
	} finally {
		await first?.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("open() success does not imply game login: connection.wait returns the honest failure snapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-executor-roots-"));
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: root,
			sessionDataDir: root,
			sharedDataDir: root,
			config: config("RootsWait"),
			policy: { autoRecover: false, closeGraceMs: 3000, retirementMs: 8000 },
		});
		// Executor IPC/Runtime ready 不代表入服；终态回执必须来自真实连接结果。
		const snapshot = await executor.waitGameConnection(15_000);
		expect(["disconnected", "faulted"]).toContain(snapshot.state);
		expect(snapshot.username).toBeNull();
		// 失败连接仍如实保持 Executor ready；掉线不是 executor.phase=faulted 的同义词。
		expect(executor.status().phase).toBe("ready");
	} finally {
		await executor?.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("session data stays under sessionDataDir while shared roots remain untouched by the executor", async () => {
	const root = await mkdtemp(join(tmpdir(), "uina-executor-roots-"));
	const sessionDataDir = join(root, "sessions", randomUUID().replaceAll("-", ""));
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: root,
			sessionDataDir,
			sharedDataDir: root,
			config: config("RootsLayout"),
			policy: { autoRecover: false, closeGraceMs: 3000, retirementMs: 8000 },
		});
		await executor.waitGameConnection(15_000);
	} finally {
		const closed = await executor?.close().catch(() => ({ process: "unknown" as const }));
		expect(closed && closed.process).toBe("retired");
	}
	// executor.db / runtime.db / runs 归 Profile 根；world-history.db 只在伴生装配后出现。
	expect(existsSync(join(sessionDataDir, "executor.db"))).toBe(true);
	expect(existsSync(join(sessionDataDir, "runtime.db"))).toBe(true);
	expect(existsSync(join(root, "executor.db"))).toBe(false);
	expect(existsSync(join(root, "runtime.db"))).toBe(false);
});
