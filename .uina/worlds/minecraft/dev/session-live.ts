/**
 * 批25 真服验收（v3 M2 放行缩样）：长驻 World 不连接即 describe/library；connect→ready→
 * observe/chat；disconnect 后同 Profile 重访；换离线用户名换 Profile（T04 缩样）；连失败
 * 端口如实回滚（T02/T10 缩样）。服务器管理同 review-live：自行起停 paper jar。
 * 用法：pnpm dev:mc:session（需 dev-env 就绪；自行起停服）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMinecraftWorld } from "../worlddef/index.js";
import type { SessionStatus } from "../worlddef/session-controller.js";
import type { ServiceCompanionContext, WorldDef } from "../../../../src/extensions/world-framework/types.js";
import type { ToolExecutionResult } from "../../../../src/tools/broker.js";
import type { HostDeliveryPort } from "../../../../src/core/types.js";

const SERVER_DIR = fileURLToPath(new URL("../dev-env/server", import.meta.url));
const STOP_SCRIPT = fileURLToPath(new URL("../dev-env/stop-server.mjs", import.meta.url));
const PORT = 25565;

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = await read();
		if (check(value)) return value;
		if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(value)?.slice(0, 400)}`);
		await sleep(200);
	}
}
async function portOpen(port = PORT): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = new Socket();
		socket.connect(port, "127.0.0.1", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});
}

async function startServer(): Promise<ChildProcess> {
	const child = spawn("java", ["-Xmx2G", "-jar", "paper-1.21.11-132.jar", "--nogui"], {
		cwd: SERVER_DIR,
		stdio: ["ignore", "ignore", "ignore"],
	});
	child.unref();
	try {
		await until(
			async () => portOpen(),
			(open) => open,
			180_000,
		);
		await until(
			async () => {
				try {
					const log = await readFile(join(SERVER_DIR, "logs", "latest.log"), "utf8");
					return log.includes("Done (");
				} catch {
					return false;
				}
			},
			(done) => done,
			120_000,
		);
	} catch (error) {
		child.kill();
		throw error;
	}
	await sleep(2000);
	return child;
}

async function stopServer(): Promise<void> {
	if (!(await portOpen())) return;
	const stopBot = spawn(process.execPath, [STOP_SCRIPT], { cwd: SERVER_DIR, stdio: "ignore" });
	stopBot.unref();
	await until(
		async () => !(await portOpen()),
		(closed) => closed,
		60_000,
	);
}

function stubContext(root: string): { ctx: ServiceCompanionContext; exposed: Map<string, unknown> } {
	const exposed = new Map<string, unknown>();
	const delivery = {
		namespace: "world:minecraft",
		session: "session-live",
		durability: "durable",
		inspect: async () => ({ kind: "absent" }),
		retire: async () => ({ kind: "retired" }),
	} as unknown as HostDeliveryPort;
	return {
		exposed,
		ctx: {
			signal: new AbortController().signal,
			worldDataDir: root,
			emitEvent: async () => ({ accepted: true }),
			onHostEvent: () => () => {},
			isBusy: () => false,
			expose: (name: string, value: unknown) => {
				exposed.set(name, value);
				return () => exposed.delete(name);
			},
			delivery,
		} as ServiceCompanionContext,
	};
}

function act(world: WorldDef, action: string) {
	return async (params: Record<string, unknown>): Promise<ToolExecutionResult> =>
		await world.actions[action]!.run(params, {
			operationIdentity: `world:minecraft/${action}`,
			signal: new AbortController().signal,
		});
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "uina-mc-session-"));
	// 旧 config.json：只作为 settings 种子与迁移输入；连接全部走 session.connect。
	const legacyPath = join(root, "..", "uina-mc-session-config.json");
	await writeFile(
		legacyPath,
		JSON.stringify({
			connection: { host: "127.0.0.1", port: PORT, username: "UinaDev", authMode: "offline", version: "1.21.11" },
			binding: { world: "dev-session-world", worldRevision: "r1" },
		}),
		"utf8",
	);
	console.log(`[mc-session] data root: ${root}`);
	console.log("[mc-session] starting Paper server…");
	await startServer();
	console.log("[mc-session] server up");

	const world = createMinecraftWorld({ diagnostics: true, legacyConfigPath: legacyPath });
	const { ctx, exposed } = stubContext(root);
	const session = act(world, "session");
	const describe = act(world, "describe");
	const library = act(world, "library");
	const chat = act(world, "chat");
	const observe = act(world, "observe");
	let passed = 0;
	const step = async (name: string, execute: () => Promise<void>) => {
		await execute();
		passed++;
		console.log(`[mc-session] PASS ${name}`);
	};
	const status = async () => JSON.parse((await session({ op: "status" })).result as string);
	const asStatus = (reply: ToolExecutionResult): SessionStatus => reply.details as SessionStatus;

	try {
		await world.onStart!(ctx);
		await step("T01：启用未连接——status/describe/library 可用，游戏动作 NOT_CONNECTED，无 Body 端点", async () => {
			const st = (await status()) as SessionStatus;
			assert(st.state === "disconnected" && st.active === null, JSON.stringify(st));
			assert(exposed.size === 0, `unexpected body endpoints: ${[...exposed.keys()]}`);
			const described = await describe({ query: "chat" });
			assert(
				described.status === "succeeded" && JSON.stringify(described.details).includes("chat@1"),
				"offline describe failed",
			);
			const saved = await library({
				op: "save",
				name: "session-live-echo",
				summary: "echo probe",
				source: "async function main(mc,input){return input;}",
			});
			assert(saved.status === "succeeded", JSON.stringify(saved.details).slice(0, 200));
			const refused = await chat({ text: "not connected" });
			const refusedDetails = refused.details as { code?: string };
			assert(
				refused.status === "not_started" && refusedDetails.code === "NOT_CONNECTED",
				JSON.stringify(refused.details),
			);
			const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
			assert(settings.defaultUsername === "UinaDev", `settings not seeded: ${JSON.stringify(settings)}`);
		});
		await step("T02：connect→ready，观测登录身份与 world 关联，observe/chat 可用", async () => {
			const reply = await session({ op: "connect", target: { server: "default" } });
			assert(reply.status === "succeeded", JSON.stringify(reply.details).slice(0, 300));
			const st = reply.details as SessionStatus;
			const active = st.active!;
			assert(st.state === "connected", JSON.stringify(st));
			assert(active.actualUsername === "UinaDev", `username mismatch: ${JSON.stringify(active)}`);
			assert(active.worldAssociation === "explicit", `alias world should be explicit: ${active.worldAssociation}`);
			assert(active.executorPhase === "ready" && active.actionsAllowed === true, JSON.stringify(active));
			assert(active.history === "ready", `history not ready: ${active.history}`);
			assert(
				[...exposed.keys()].some((key) => key.startsWith("body.endpoint:")),
				"body endpoint not exposed",
			);
			await until(
				async () => (await observe({ selector: "self@1" })).status === "succeeded",
				(ok) => ok,
				30_000,
			);
			const self = (await observe({ selector: "self@1" })).details as { value: { place: { position: unknown } } };
			assert(self.value?.place?.position != null, `self observation empty: ${JSON.stringify(self).slice(0, 200)}`);
			const chatReply = await chat({ text: "session-live hello" });
			assert(chatReply.status === "succeeded", JSON.stringify(chatReply.details).slice(0, 200));
		});
		await step("disconnect→同 Profile 重访复用（T03 缩样），list 记录 lastSeen", async () => {
			const first = await status();
			const before = first.active.visitId;
			await session({ op: "disconnect" });
			const after = (await status()) as SessionStatus;
			assert(after.state === "disconnected" && after.active === null, JSON.stringify(after));
			assert(exposed.size === 0, "body endpoint not detached after disconnect");
			const reconnect = asStatus(await session({ op: "connect", target: { server: "default" } }));
			assert(reconnect.state === "connected", JSON.stringify(reconnect).slice(0, 300));
			assert(reconnect.active!.visitId !== before, "visitId reused across visits");
			const profiles = JSON.parse((await session({ op: "list" })).result as string);
			assert(profiles.length === 1 && profiles[0].lastSeen != null, JSON.stringify(profiles).slice(0, 200));
			// 同 Profile 再 connect：幂等返回当前 visit，不重建执行域。
			const idempotent = asStatus(await session({ op: "connect", target: { server: "default" } }));
			assert(idempotent.active!.visitId === reconnect.active!.visitId, "idempotent connect rebuilt the visit");
		});
		await step("T04 缩样：同服换离线用户名→新 Profile，places 分区共享前提保留", async () => {
			const switched = asStatus(
				await session({
					op: "connect",
					target: { host: "127.0.0.1", port: PORT, username: "UinaDev2" },
				}),
			);
			assert(switched.state === "connected", JSON.stringify(switched).slice(0, 300));
			assert(switched.active!.actualUsername === "UinaDev2", JSON.stringify(switched.active));
			const profiles = JSON.parse((await session({ op: "list" })).result as string);
			assert(profiles.length === 2, `expected two profiles: ${JSON.stringify(profiles).slice(0, 300)}`);
		});
		await step("T02/T10 缩样：连失败端口→CONNECT_FAILED 回滚，旧会话已退役、可再连", async () => {
			const failed = await session({ op: "connect", target: { host: "127.0.0.1", port: 25599, username: "UinaDev" } });
			assert(
				failed.status === "failed" && (failed.details as { code?: string }).code === "CONNECT_FAILED",
				JSON.stringify(failed.details),
			);
			const st = (await status()) as SessionStatus;
			assert(st.state === "disconnected" && st.active === null, JSON.stringify(st));
			assert(st.lastError?.code === "CONNECT_FAILED", JSON.stringify(st.lastError));
			assert(exposed.size === 0, "body endpoint leaked after failed connect");
			const retry = asStatus(await session({ op: "connect", target: { server: "default" } }));
			assert(retry.state === "connected", JSON.stringify(retry).slice(0, 300));
		});
		await step("收尾：会话内 /stop 优雅停服 + world onStop 收口", async () => {
			const st = (await status()) as SessionStatus;
			console.log(`[mc-session] pre-stop status: ${JSON.stringify(st).slice(0, 400)}`);
			const stopReply = await chat({ text: "/stop" });
			console.log(
				`[mc-session] stop chat reply: status=${stopReply.status} ${JSON.stringify(stopReply.details).slice(0, 300)}`,
			);
			const closed = await until(
				async () => !(await portOpen()),
				(closed) => closed,
				90_000,
			).catch(() => false);
			if (!closed) await stopServer();
			await world.onStop!(ctx);
			const end = (await status()) as SessionStatus;
			assert(end.active === null, JSON.stringify(end));
			await rm(legacyPath, { force: true });
		});
		console.log(`[mc-session] PASS ${passed}/6`);
	} finally {
		await Promise.resolve(world.onStop!(ctx)).catch(() => {});
		if (await portOpen()) await stopServer().catch(() => {});
	}
}

await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
