/** Real Paper acceptance through the managed bootstrap/IPC, no WorldTool or model claim. */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelfState } from "../contracts/body.js";
import type { Acceptance, RunSummary } from "../contracts/runtime.js";
import type { JsonValue } from "../contracts/values.js";
import { MinecraftExecutor } from "../executor/index.js";

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = await read();
		if (check(value)) return value;
		if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(value)}`);
		await sleep(100);
	}
}
function runOf(acceptance: Acceptance): string {
	assert(acceptance.kind === "accepted", JSON.stringify(acceptance));
	return acceptance.snapshot.run;
}
function distance(a: SelfState, b: SelfState): number {
	const p = a.place.position;
	const q = b.place.position;
	return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

async function main(): Promise<void> {
	const root = process.env.MC_EXECUTOR_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "uina-mc-executor-")));
	const config = {
		connection: {
			host: "127.0.0.1",
			port: 25565,
			username: process.env.MC_DEV_USER ?? "UinaDev",
			version: "1.21.11",
			authMode: "offline",
		},
		binding: { world: "dev-executor-world", worldRevision: "dev-executor-world-2026-10-25" },
	};
	let executor: MinecraftExecutor | null = await MinecraftExecutor.open({
		ownershipDir: root,
		sessionDataDir: root,
		sharedDataDir: root,
		config,
		policy: { autoRecover: false },
	});
	console.log(`[mc-executor] data root: ${root}`);
	let passed = 0;
	const step = async (name: string, execute: () => Promise<void>) => {
		await execute();
		passed++;
		console.log(`[mc-executor] PASS ${name}`);
	};
	let sequence = 0;
	const submit = (selector: string, input: JsonValue) =>
		executor!.submit({
			requestId: `q:${++sequence}:${randomUUID()}`,
			entry: { kind: "call", selector, input },
			schedule: { kind: "enqueue" },
		});
	const finish = async (run: string, timeoutMs = 15_000): Promise<Extract<RunSummary, { phase: "finished" }>> => {
		const result = await executor!.wait(run, { timeoutMs });
		assert(result.kind === "result" && result.snapshot.phase === "finished", JSON.stringify(result));
		return result.snapshot;
	};
	const self = async () => (await executor!.observe<SelfState>("self@1")).value;
	const command = async (text: string) => {
		const result = await finish(runOf(await submit("chat@1", { text })));
		assert(result.outcome === "succeeded", JSON.stringify(result));
		await sleep(200);
	};
	try {
		await step("managed source/asset entry, actual connection and current observation", async () => {
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			const state = await self();
			assert(state.place.dimension != null, "missing dimension");
		});
		await step("chat through Runtime and prepare dedicated survival platform", async () => {
			await command(`/gamemode creative ${config.connection.username}`);
			await command(`/tp ${config.connection.username} 12000.5 205 12000.5`);
			await until(self, (state) => Math.abs(state.place.position.x - 12000.5) < 1);
			for (const [x, z] of [
				[11996, 11996],
				[12090, 11996],
				[11996, 12004],
				[12090, 12004],
			]) {
				await until(
					async () =>
						(await executor!.observe<{ block: { name: string } | null }>("block@1", { at: { x: x!, y: 199, z: z! } }))
							.value,
					(value) => value.block != null,
				);
			}
			await command("/fill 11996 199 11996 12090 199 12004 minecraft:stone");
			await command("/fill 11996 200 11996 12090 203 12004 minecraft:air");
			await until(
				async () =>
					(
						await executor!.observe<{ block: { name: string } | null }>("block@1", {
							at: { x: 12000, y: 199, z: 12000 },
						})
					).value,
				(value) => value.block?.name === "stone",
			);
			await command(`/tp ${config.connection.username} 12000.5 200 12000.5`);
			await command(`/gamemode survival ${config.connection.username}`);
			await until(self, (state) => state.onGround === true && Math.abs(state.place.position.y - 200) < 0.1);
		});
		await step("goto completes through private IPC and durable lookup", async () => {
			const requestId = `q:goto:${randomUUID()}`;
			const accepted = await executor!.submit({
				requestId,
				entry: {
					kind: "call",
					selector: "goto@1",
					input: { at: { x: 12005, y: 200, z: 12000 }, tolerance: 1, maxTimeMs: 10_000 },
				},
				schedule: { kind: "enqueue" },
			});
			const result = await finish(runOf(accepted));
			assert(result.outcome === "succeeded", JSON.stringify(result));
			assert((await executor!.lookup(requestId)).kind === "found", "missing durable submission");
		});
		await step("cancelled wait preserves movement; explicit stop retires input", async () => {
			const before = await self();
			const run = runOf(
				await submit("goto@1", { at: { x: 12080, y: 200, z: 12000 }, tolerance: 1, maxTimeMs: 30_000 }),
			);
			await until(self, (state) => distance(before, state) > 1);
			const abort = new AbortController();
			const waiting = executor!.wait(run, {}, abort.signal);
			abort.abort();
			await waiting.then(
				() => {
					throw new Error("wait unexpectedly completed");
				},
				(error: unknown) => assert((error as { code?: string }).code === "REQUEST_CANCELLED", String(error)),
			);
			assert((await executor!.read(run)).phase !== "finished", "wait cancellation stopped Run");
			await executor!.stop({ requestId: randomUUID(), target: { run } });
			assert((await finish(run)).outcome === "cancelled", "stop did not cancel Run");
			await sleep(300);
			const stopped = await self();
			await sleep(500);
			assert(distance(stopped, await self()) < 0.05, "old goto kept moving");
		});
		await step("real owner expiry cancels active movement without reviving on late heartbeat", async () => {
			const before = await self();
			const run = runOf(
				await submit("goto@1", { at: { x: 12080, y: 200, z: 12000 }, tolerance: 1, maxTimeMs: 30_000 }),
			);
			await until(self, (state) => distance(before, state) > 1);
			// Fault injection belongs only to this scenario; production has no pause-heartbeat API.
			clearInterval((executor as unknown as { heartbeatTimer: ReturnType<typeof setInterval> }).heartbeatTimer);
			assert((await finish(run, 10_000)).outcome === "cancelled", "owner expiry did not cancel Run");
			assert((await executor!.inspect()).side!.owner!.gates.includes("owner_lost"), "owner_lost missing");
			await sleep(300);
			const stopped = await self();
			await sleep(500);
			assert(distance(stopped, await self()) < 0.05, "expired owner wrote old controls");
		});
		await step("disconnect retires launch; recovery keeps gate and rejects stale confirmation", async () => {
			const oldOwner = executor!.status().side!.owner!;
			(executor as unknown as { connection: { child: ChildProcess } }).connection.child.disconnect();
			await until(
				async () => executor!.status(),
				(state) => state.phase === "faulted",
			);
			await executor!.recover();
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			assert(!executor!.status().actionsAllowed, "recovery opened old action gate");
			const current = executor!.status().side!.owner!;
			await executor!.recover({ attachment: oldOwner.attachment, gateRevision: current.gateRevision }).then(
				() => {
					throw new Error("old confirmation accepted");
				},
				(error: unknown) => assert((error as { code?: string }).code === "OWNER_STATE_CHANGED", String(error)),
			);
			await executor!.recover({ attachment: current.attachment, gateRevision: current.gateRevision });
			assert(executor!.status().actionsAllowed, "explicit current recovery did not open owner_lost");
		});
		await step("emergency persists across a second retirement and owner recovery", async () => {
			await executor!.setOwnerGate("emergency", true);
			(executor as unknown as { connection: { child: ChildProcess } }).connection.child.disconnect();
			await until(
				async () => executor!.status(),
				(state) => state.phase === "faulted",
			);
			await executor!.recover();
			const current = executor!.status().side!.owner!;
			assert(current.gates.includes("emergency"), "emergency was lost");
			await executor!.recover({ attachment: current.attachment, gateRevision: current.gateRevision });
			assert(!executor!.status().actionsAllowed, "owner recovery bypassed emergency");
			const latest = (await executor!.inspect()).side!.owner!;
			await executor!.setOwnerGate("emergency", false, latest.gateRevision);
		});
		await step("close during active navigation releases both jobs; same storage reopens without replay", async () => {
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			const movingFrom = await self();
			const at = { x: Math.floor(movingFrom.place.position.x) + 20, y: 200, z: 12000 };
			// Login readiness precedes chunk delivery on a fresh connection.
			await until(
				async () =>
					(await executor!.observe<{ block: { name: string } | null }>("block@1", { at: { ...at, y: 199 } })).value,
				(value) => value.block?.name === "stone",
			);
			const run = runOf(await submit("goto@1", { at, tolerance: 1, maxTimeMs: 30_000 }));
			await until(
				async () => {
					const state = await self();
					const progress = await executor!.read(run);
					assert(progress.phase !== "finished", `navigation ended before close: ${JSON.stringify(progress)}`);
					return state;
				},
				(state) => distance(movingFrom, state) > 0.5,
			);
			await executor!.close();
			executor = null;
			executor = await MinecraftExecutor.open({
				ownershipDir: root,
				sessionDataDir: root,
				sharedDataDir: root,
				config,
				policy: { autoRecover: false },
			});
			await until(
				() => executor!.inspect(),
				(state) => state.side?.connection === "ready",
			);
			assert(executor!.status().actionsAllowed, "clean activation incorrectly requires owner recovery");
			await sleep(300);
			const before = await self();
			await sleep(500);
			assert(distance(before, await self()) < 0.05, "old movement replayed on reopen");
			await executor!.close();
			executor = null;
		});
		console.log(`[mc-executor] PASS ${passed}/8`);
	} finally {
		await executor?.close();
	}
}
await main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
