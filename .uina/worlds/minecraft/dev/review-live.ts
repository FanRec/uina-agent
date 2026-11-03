/**
 * 批23 真服验收：断线证据入库与推送（P0-7）、私聊推送（P1-5）、recover 游戏断线重建
 * （P1-10）、慢读测量（P1-9 取证）、未绑定世界警告（P1-8）。
 * 服务器管理：起服用 dev-env/server 的 paper jar，停服由 op 账号 /stop（优雅保存）。
 * 用法：pnpm dev:mc:review（需 dev-env 就绪；自行起停服）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SelfState } from "../contracts/body.js";
import type { GameNotice } from "../contracts/executor.js";
import type { JsonValue } from "../contracts/values.js";
import { MinecraftExecutor } from "../executor/index.js";

const SERVER_DIR = fileURLToPath(new URL("../dev-env/server", import.meta.url));
const STOP_SCRIPT = fileURLToPath(new URL("../dev-env/stop-server.mjs", import.meta.url));
const WHISPER_SCRIPT = fileURLToPath(new URL("../dev-env/whisper-once.mjs", import.meta.url));
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
async function portOpen(): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = new Socket();
		socket.connect(PORT, "127.0.0.1", () => {
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
	// Paper 先绑端口后写 Done：端口 + 日志 Done 双确认。
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
	await sleep(2000);
	return child;
}

interface ConnectionEventPayload {
	kind: "connection";
	state: string;
	reason: string | null;
}

async function main(): Promise<void> {
	const root = process.env.MC_EXECUTOR_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "uina-mc-review-")));
	const config = {
		connection: {
			host: "127.0.0.1",
			port: PORT,
			username: "UinaDev",
			version: "1.21.11",
			authMode: "offline" as const,
		},
		// 有意用默认体验（binding null）：未绑定警告与分区行为都在被测面上。
		binding: null,
	};
	console.log(`[mc-review] data root: ${root}`);
	console.log("[mc-review] starting Paper server…");
	await startServer();
	console.log("[mc-review] server up");

	let executor: MinecraftExecutor | null = await MinecraftExecutor.open({
		worldDataDir: root,
		config,
		policy: { autoRecover: false },
	});
	const notices: GameNotice[] = [];
	executor.subscribe((events) => notices.push(...events));
	let passed = 0;
	const step = async (name: string, execute: () => Promise<void>) => {
		await execute();
		passed++;
		console.log(`[mc-review] PASS ${name}`);
	};
	const self = async () => (await executor!.observe<SelfState>("self@1")).value;
	const connectionEvents = async () => {
		const page = await executor!.observe<{ events: { payload: ConnectionEventPayload }[] }>("events@1", {
			kinds: ["connection"],
			limit: 100,
		});
		return page.value.events.map((entry) => entry.payload);
	};
	const chatNotice = (channel: string) =>
		notices.find(
			(notice) =>
				(notice.payload as { kind?: string; channel?: string } | null)?.kind === "chat" &&
				(notice.payload as { channel?: string }).channel === channel,
		);

	try {
		await step("连接就绪 + 未绑定世界启动警告（P1-8）", async () => {
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			const tail = executor!.status().diagnostics.tail;
			assert(
				tail.includes("config.binding is null"),
				`unbound warning missing from companion diagnostics tail:\n${tail.slice(-800)}`,
			);
			const connections = await connectionEvents();
			assert(
				connections.some((payload) => payload.state === "connected"),
				`no connected record in events@1: ${JSON.stringify(connections).slice(0, 300)}`,
			);
		});
		await step("慢读测量：radius-64 稀有方块 + 8192 体素 region（P1-9 取证）", async () => {
			const here = await self();
			const feet = here.place.position;
			const slowReads: Record<string, number> = {};
			const timed = async (label: string, selector: string, input: JsonValue): Promise<void> => {
				const startedAt = Date.now();
				await executor!.observe(selector, input);
				slowReads[label] = Date.now() - startedAt;
			};
			await timed("blocks@1 radius64 diamond_ore", "blocks@1", {
				name: "diamond_ore",
				radius: 64,
				limit: 256,
			});
			await timed("region@1 8192 voxels", "region@1", {
				at: { x: Math.floor(feet.x) - 10, y: Math.max(-60, Math.floor(feet.y) - 10), z: Math.floor(feet.z) - 10 },
				size: { x: 20, y: 20, z: 20 },
			});
			console.log(`[mc-review] slow reads: ${JSON.stringify(slowReads)}`);
			assert(slowReads["blocks@1 radius64 diamond_ore"]! < 10_000, "radius-64 scan pathologically slow");
			assert(slowReads["region@1 8192 voxels"]! < 10_000, "8192-voxel read pathologically slow");
		});
		await step("私聊推送：whisper 分类为 private 并经 importantEvents 上行（P1-5）", async () => {
			// 好友小号走 dev-env 的 .mjs 工具（与 stop-server.mjs 同家法：原始 bot 不进 .ts 树）。
			spawn(process.execPath, [WHISPER_SCRIPT, "meet me at base"], { cwd: SERVER_DIR, stdio: "ignore" }).unref();
			await until(
				() => Promise.resolve(chatNotice("private") != null),
				(found) => found,
				30_000,
			);
			const notice = chatNotice("private")!;
			const payload = notice.payload as { kind: string; channel: string; text: string; self: boolean };
			assert(payload.text.includes("meet me at base"), `wrong private text: ${JSON.stringify(payload)}`);
			assert(payload.self === false, `private self flag wrong: ${JSON.stringify(payload)}`);
			const chats = await executor!.observe<{ events: { payload: { channel?: string; text?: string } }[] }>(
				"events@1",
				{ kinds: ["chat"], limit: 20 },
			);
			assert(
				chats.value.events.some(
					(entry) => entry.payload.channel === "private" && entry.payload.text?.includes("meet me at base"),
				),
				"private record missing from events@1",
			);
		});
		await step("断线证据先入库并推送，执行侧保持 ready（P0-7）", async () => {
			notices.length = 0;
			// op 账号优雅停服：bot 收到 kick（Server closed）→ end。
			const run = await executor!.submit({
				requestId: `q:stop:${randomUUID()}`,
				entry: { kind: "call", selector: "chat@1", input: { text: "/stop" } },
				schedule: { kind: "enqueue" },
			});
			void run;
			await until(
				async () => executor!.status(),
				(state) => state.side?.connection === "disconnected",
				60_000,
			);
			// 核心断言：断线通知经 importantEvents 上行（旧实现此分支死路）。
			await until(
				() =>
					Promise.resolve(
						notices.some((notice) => (notice.payload as ConnectionEventPayload | null)?.state === "disconnected"),
					),
				(found) => found,
				10_000,
			);
			// 核心断言：断线事实落库（旧实现 captureEvent 在 attachedBot==null 守卫空转）。
			await until(
				async () => (await connectionEvents()).some((payload) => payload.state === "disconnected"),
				(found) => found,
				10_000,
			);
			const disconnected = (await connectionEvents()).find((payload) => payload.state === "disconnected");
			console.log(`[mc-review] disconnect reason: ${JSON.stringify(disconnected?.reason)}`);
			assert(executor!.status().phase === "ready", "executor phase should stay ready on game disconnect");
		});
		await step("重启服务器 + runs recover 重建执行域（P1-10）", async () => {
			const oldLaunch = executor!.status().side?.launch;
			await startServer();
			await executor!.recover();
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			const newLaunch = executor!.status().side!.launch;
			assert(newLaunch !== oldLaunch, `launch unchanged after recover: ${newLaunch}`);
			// 非优雅退役 → unclean 恢复 → owner_lost 如实关闭：按惯例 CAS 解除后再提交。
			const current = executor!.status().side!.owner!;
			assert(current.gates.includes("owner_lost"), "owner_lost missing after non-graceful rebuild");
			await executor!.recover({ attachment: current.attachment, gateRevision: current.gateRevision });
			assert(executor!.status().actionsAllowed, "explicit recovery did not open owner_lost");
			const accepted = await executor!.submit({
				requestId: `q:hello:${randomUUID()}`,
				entry: { kind: "call", selector: "chat@1", input: { text: "back online" } },
				schedule: { kind: "enqueue" },
			});
			assert(accepted.kind === "accepted", JSON.stringify(accepted));
			const result = await executor!.wait(accepted.snapshot.run, { timeoutMs: 15_000 });
			assert(
				result.kind === "result" && result.snapshot.phase === "finished" && result.snapshot.outcome === "succeeded",
				JSON.stringify(result.snapshot),
			);
		});
		await step("收尾：优雅停服，端口关闭", async () => {
			void executor!.submit({
				requestId: `q:stop2:${randomUUID()}`,
				entry: { kind: "call", selector: "chat@1", input: { text: "/stop" } },
				schedule: { kind: "enqueue" },
			});
			await until(
				async () => !(await portOpen()),
				(closed) => closed,
				60_000,
			);
			await executor!.close();
			executor = null;
		});
		console.log(`[mc-review] PASS ${passed}/6`);
	} finally {
		await executor?.close().catch(() => {});
		if (await portOpen()) {
			// 兜底：用独立 stop 脚本收尾（不依赖本进程 bot 还在线）。
			const stopBot = spawn(process.execPath, [STOP_SCRIPT], { cwd: SERVER_DIR, stdio: "ignore" });
			stopBot.unref();
		}
	}
}
await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
