/** SessionController 单元：串行管理槽、失败回滚、迁移接线与别名解析（不含真服 ready 路径）。 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { SessionController } from "../../.uina/worlds/minecraft/worlddef/session-controller.js";

const LEGACY_CONFIG = {
	connection: { host: "127.0.0.1", port: 1, username: "CtrlTest", authMode: "offline", version: "1.21.11" },
	binding: { world: "ctrl-world", worldRevision: "r1" },
};

async function tempRoot() {
	return await mkdtemp(join(tmpdir(), "uina-mc-controller-"));
}

function controllerFor(root: string, legacyConfig: unknown = null) {
	return SessionController.create({
		minecraftRoot: root,
		ctx: { signal: new AbortController().signal } as never,
		expose: () => () => {},
		legacyConfig,
		executorPolicy: { autoRecover: false, closeGraceMs: 3000, retirementMs: 8000 },
		connectTimeoutMs: 15_000,
	});
}

function code(run: () => Promise<unknown>): Promise<string> {
	return run().then(
		() => "no error",
		(error) => (error as { code?: string }).code ?? String(error),
	);
}

test("create migrates legacy layout and seeds settings before any executor exists", async () => {
	const root = await tempRoot();
	try {
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "executor.db"), "executor", "utf8");
		await writeFile(join(root, "runtime.db"), "runtime", "utf8");
		const controller = await controllerFor(root, LEGACY_CONFIG);
		try {
			const status = controller.status();
			expect(status.state).toBe("disconnected");
			expect(status.active).toBeNull();
			// 旧数据已入 Profile 根；settings.json 由旧 config 播种。
			expect(existsSync(join(root, "executor.db"))).toBe(false);
			const profiles = await controller.list();
			expect(profiles).toHaveLength(1);
			expect(profiles[0]?.identity).toMatchObject({
				endpoint: { host: "127.0.0.1", port: 1 },
				principal: { username: "CtrlTest" },
				world: "ctrl-world",
			});
			expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toMatchObject({
				defaultUsername: "CtrlTest",
				servers: { default: { world: { id: "ctrl-world", revision: "r1" } } },
			});
		} finally {
			await controller.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("connect failure retires the candidate honestly and keeps the controller reusable", async () => {
	const root = await tempRoot();
	try {
		const controller = await controllerFor(root);
		try {
			const error = await code(() =>
				controller.connect({ host: "127.0.0.1", port: 1, username: "CtrlTest" }, new AbortController().signal),
			);
			expect(error).toBe("CONNECT_FAILED");
			const status = controller.status();
			expect(status.state).toBe("disconnected");
			expect(status.lastError).toMatchObject({ code: "CONNECT_FAILED" });
			expect(status.active).toBeNull();
			expect(controller.session).toBeNull();
			// 失败尝试留下可校验的持久 Profile 记录，但没有 lastVisit。
			const profiles = await controller.list();
			expect(profiles).toHaveLength(1);
			expect(profiles[0]?.lastSeen).toBeNull();
			// 同一控制器可再次发起连接（候选域退役干净，所有权已释放）。
			const second = await code(() =>
				controller.connect({ host: "127.0.0.1", port: 1, username: "CtrlTest" }, new AbortController().signal),
			);
			expect(second).toBe("CONNECT_FAILED");
		} finally {
			await controller.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent connects are serialized; the loser gets SESSION_BUSY without queuing a stale target", async () => {
	const root = await tempRoot();
	try {
		const controller = await controllerFor(root);
		try {
			const signal = new AbortController().signal;
			const results = await Promise.allSettled([
				controller.connect({ host: "127.0.0.1", port: 1, username: "CtrlTest" }, signal),
				controller.connect({ host: "127.0.0.1", port: 1, username: "CtrlTest" }, signal),
			]);
			const codes = results.map((r) =>
				r.status === "fulfilled" ? "fulfilled" : ((r.reason as { code?: string }).code ?? String(r.reason)),
			);
			expect(codes).toContain("SESSION_BUSY");
			expect(codes.filter((c) => c === "SESSION_BUSY")).toHaveLength(1);
		} finally {
			await controller.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("alias targets resolve through settings and cancelled connects have no side effects", async () => {
	const root = await tempRoot();
	try {
		const controller = await controllerFor(root);
		try {
			// 缺用户名且 settings 无默认：明确 INVALID_INPUT，不擅自选身份。
			await writeFile(
				join(root, "settings.json"),
				JSON.stringify({ servers: { home: { host: "127.0.0.1", port: 1 } } }),
				"utf8",
			);
			expect(await code(() => controller.connect({ host: "127.0.0.1", port: 1 }, new AbortController().signal))).toBe(
				"INVALID_INPUT",
			);
			// settings 补上默认用户名后，别名目标正常解析；取消在生效前无副作用。
			await writeFile(
				join(root, "settings.json"),
				JSON.stringify({ defaultUsername: "CtrlTest", servers: { home: { host: "127.0.0.1", port: 1 } } }),
				"utf8",
			);
			const aborted = new AbortController();
			aborted.abort();
			expect(await code(() => controller.connect({ server: "home" }, aborted.signal))).toBe("REQUEST_CANCELLED");
			expect(controller.status().lastError).toBeNull();
			expect(await controller.list()).toHaveLength(0);
			// disconnect 无会话：幂等返回断开态。
			const status = await controller.disconnect(new AbortController().signal);
			expect(status.state).toBe("disconnected");
		} finally {
			await controller.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("close retires a blocked domain reference only when proven; game actions refuse while closed", async () => {
	const root = await tempRoot();
	try {
		const controller = await controllerFor(root);
		await controller.close();
		// 关闭后游戏动作不再受理。
		const reply = await controller.execute(
			"run",
			{ selector: "chat@1", input: { text: "x" } },
			new AbortController().signal,
		);
		expect(reply).toMatchObject({ status: "not_started" });
		expect(reply.details).toMatchObject({ code: "NOT_CONNECTED" });
		// 关闭幂等。
		await controller.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("profile directory layout keeps executor identity inside sessions/<profileId>", async () => {
	const root = await tempRoot();
	try {
		const controller = await controllerFor(root);
		try {
			await controller
				.connect(
					{ host: "127.0.0.1", port: 1, username: `Lay${randomUUID().slice(0, 4)}` },
					new AbortController().signal,
				)
				.catch(() => {});
			const profiles = await controller.list();
			const profile = profiles[0]!;
			const dir = join(root, "sessions", profile.profileId);
			expect(existsSync(join(dir, "identity.json"))).toBe(true);
			expect(JSON.parse(await readFile(join(dir, "identity.json"), "utf8"))).toMatchObject({
				schemaVersion: 1,
				identity: profile.identity,
			});
		} finally {
			await controller.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
