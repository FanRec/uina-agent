import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { MinecraftExecutor } from "../../.uina/worlds/minecraft/executor/index.js";

const config = () => ({
	connection: {
		host: "127.0.0.1",
		port: 1,
		username: `T${randomUUID().slice(0, 8)}`,
		authMode: "offline",
		version: "1.21.11",
	},
	binding: null,
});
async function root() {
	return await mkdtemp(join(tmpdir(), "uina-executor-session-"));
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("a remote pre-acceptance gate rejection remains not accepted while the parent cache is stale", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		const owner = executor.status().side!.owner!;
		// A gate can change in the execution domain before the next parent heartbeat/status refresh.
		await executor.rpc("runtime.setOwnerGate", {
			requestId: randomUUID(),
			attachment: owner.attachment,
			gate: "emergency",
			closed: true,
		});
		expect(executor.status().actionsAllowed).toBe(true);
		const reply = await executor.submit({
			requestId: "remote-gate-refusal",
			entry: { kind: "call", selector: "chat@1", input: { text: "must not be sent" } },
			schedule: { kind: "enqueue" },
		});
		expect(reply).toMatchObject({ kind: "not_accepted", code: "OWNER_GATE_CLOSED", requestId: "remote-gate-refusal" });
		expect(await executor.lookup("remote-gate-refusal")).toMatchObject({ kind: "not_found" });
	} finally {
		await executor?.close();
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("real managed bootstrap restores Runtime before game connection, binds owner and persists native request", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		expect(executor.status().side).toMatchObject({
			runtime: "ready",
			program: { workerCount: 1, residentGuests: 0 },
			world: { binding: { state: "unbound" } },
		});
		expect(executor.status().actionsAllowed).toBe(true);
		const accepted = await executor.submit({
			requestId: "q-one",
			entry: { kind: "call", selector: "chat@1", input: { text: "not a server test" } },
			schedule: { kind: "enqueue" },
		});
		expect(accepted.kind).toBe("accepted");
		if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
		expect(await executor.lookup("q-one")).toMatchObject({ kind: "found", segment: accepted.segment });
		const reply = await executor.wait(accepted.snapshot.run, { timeoutMs: 2000 });
		expect(reply).toMatchObject({ kind: "result", snapshot: { outcome: "failed" } });
		const owner = (await executor.inspect()).side!.owner!;
		const closed = await executor.setOwnerGate("emergency", true);
		expect(closed).toMatchObject({ persistence: "confirmed", control: "stopped" });
		expect(
			await executor.submit({
				requestId: "denied",
				entry: { kind: "call", selector: "chat@1", input: { text: "denied" } },
				schedule: { kind: "enqueue" },
			}),
		).toMatchObject({ kind: "not_accepted" });
		await expect(executor.setOwnerGate("emergency", false, owner.gateRevision)).rejects.toMatchObject({
			code: "OWNER_STATE_CHANGED",
		});
		const latest = (await executor.inspect()).side!.owner!;
		expect((await executor.setOwnerGate("emergency", false, latest.gateRevision)).persistence).toBe("confirmed");
		await executor.close();
		executor = undefined;
	} finally {
		await executor?.close().catch(() => {});
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("IPC loss retires the exact launch; recovery changes attachment and keeps owner_lost until explicit CAS", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		const old = executor.status().side!;
		(executor as unknown as { connection: { child: ChildProcess } }).connection.child.disconnect();
		await until(() => executor!.status().phase === "faulted");
		await executor.recover();
		const recovered = executor.status().side!;
		expect(recovered.launch).not.toBe(old.launch);
		expect(recovered.owner!.attachment).not.toBe(old.owner!.attachment);
		expect(recovered.owner!.gates).toContain("owner_lost");
		expect(executor.status().actionsAllowed).toBe(false);
		await expect(
			executor.recover({ attachment: old.owner!.attachment, gateRevision: recovered.owner!.gateRevision }),
		).rejects.toMatchObject({ code: "OWNER_STATE_CHANGED" });
		await executor.recover({ attachment: recovered.owner!.attachment, gateRevision: recovered.owner!.gateRevision });
		expect(executor.status().actionsAllowed).toBe(true);
	} finally {
		await executor?.close().catch(() => {});
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("recover rebuilds the execution domain when the game client is gone while the executor stays ready", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		const old = executor.status().side!;
		// 不可达服务器：伴生进程健康（phase ready），但游戏连接进入 faulted。
		expect(executor.status().phase).toBe("ready");
		await until(() => {
			const connection = executor!.status().side?.connection;
			return connection === "faulted" || connection === "disconnected";
		});
		await executor.recover();
		expect(executor.status().phase).toBe("ready");
		expect(executor.status().side!.launch).not.toBe(old.launch);
		// 重建成功不等于登录成功：同一不可达服务器下如实回到断线状态。
		await until(() => {
			const connection = executor!.status().side?.connection;
			return connection === "faulted" || connection === "disconnected";
		});
	} finally {
		await executor?.close().catch(() => {});
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("missing initialized Runtime is refused without recreating its database", async () => {
	const dataRoot = await root();
	const connection = config();
	try {
		const executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: connection,
			policy: { closeGraceMs: 3000 },
		});
		await executor.close();
		await rename(join(dataRoot, "runtime.db"), join(dataRoot, "runtime.saved"));
		await expect(
			MinecraftExecutor.open({
				ownershipDir: dataRoot,
				sessionDataDir: dataRoot,
				sharedDataDir: dataRoot,
				config: connection,
			}),
		).rejects.toMatchObject({
			code: "STORAGE_ID_CHANGED",
		});
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("concurrent recover callers share exactly one launch across the ledger await", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	let release!: () => void;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		const hidden = executor as unknown as {
			connection: { child: ChildProcess };
			ledger: { launch(launch: string, activation: string): Promise<void> };
		};
		hidden.connection.child.disconnect();
		await until(() => executor!.status().phase === "faulted");
		const original = hidden.ledger.launch.bind(hidden.ledger);
		let launches = 0;
		const pause = new Promise<void>((resolve) => {
			release = resolve;
		});
		hidden.ledger.launch = async (...args) => {
			launches++;
			await pause;
			await original(...args);
		};
		const first = executor.recover();
		const second = executor.recover();
		try {
			await until(() => launches > 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(launches).toBe(1);
		} finally {
			release();
			await Promise.allSettled([first, second]);
		}
		expect(executor.status().side!.owner!.gates).toContain("owner_lost");
	} finally {
		release?.();
		await executor?.close().catch(() => {});
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("closing emergency while side is unavailable persists local intent before reporting remote failure", async () => {
	const dataRoot = await root();
	let executor: MinecraftExecutor | undefined;
	try {
		executor = await MinecraftExecutor.open({
			ownershipDir: dataRoot,
			sessionDataDir: dataRoot,
			sharedDataDir: dataRoot,
			config: config(),
			policy: { autoRecover: false, closeGraceMs: 3000 },
		});
		(executor as unknown as { connection: { child: ChildProcess } }).connection.child.disconnect();
		await until(() => executor!.status().phase === "faulted");
		await expect(executor.setOwnerGate("emergency", true)).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
		const db = new DatabaseSync(join(dataRoot, "executor.db"), { readOnly: true });
		try {
			expect(db.prepare("SELECT gate FROM local_gates WHERE gate='emergency'").get()?.gate).toBe("emergency");
		} finally {
			db.close();
		}
	} finally {
		await executor?.close().catch(() => {});
		await rm(dataRoot, { recursive: true, force: true });
	}
});
