import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { accountKey, parseExecutorConfig } from "../../.uina/worlds/minecraft/executor/config.js";
import { RpcPeer, type WireEndpoint } from "../../.uina/worlds/minecraft/executor/ipc.js";

function link() {
	const listeners = [new Set<(v: unknown) => void>(), new Set<(v: unknown) => void>()];
	const sent: JsonValue[][] = [[], []];
	const endpoints = [0, 1].map(
		(i): WireEndpoint => ({
			send(value, done) {
				sent[i]!.push(value);
				queueMicrotask(() => {
					for (const listener of listeners[1 - i]!) listener(structuredClone(value));
					done(null);
				});
			},
			onMessage(listener) {
				listeners[i]!.add(listener);
				return () => {
					listeners[i]!.delete(listener);
				};
			},
			onDisconnect() {
				return () => {};
			},
		}),
	);
	return {
		endpoints,
		sent,
		inject: (i: number, value: unknown) => {
			for (const listener of listeners[i]!) listener(value);
		},
	};
}

describe("MC private IPC", () => {
	test("cancel_wait ends one reader while an independent request completes", async () => {
		const wire = link();
		let cancelled = false;
		const side = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[1]!,
			handleRequest: async (method, _payload, signal) => {
				if (method === "runtime.wait")
					return await new Promise((_resolve, reject) =>
						signal.addEventListener("abort", () => {
							cancelled = true;
							reject(new Error("cancelled"));
						}),
					);
				return { attachment: "a", gates: [], gateRevision: 1, validForMs: 5000 };
			},
		});
		const parent = new RpcPeer({ launch: "launch", endpoint: wire.endpoints[0]! });
		try {
			const abort = new AbortController();
			const waiting = parent.call("runtime.wait", { run: "r" }, { signal: abort.signal, timeoutMs: null });
			await Promise.resolve();
			abort.abort();
			await expect(waiting).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
			await expect(parent.call("runtime.heartbeat", { attachment: "a" })).resolves.toMatchObject({ attachment: "a" });
			expect(cancelled).toBe(true);
		} finally {
			parent.close();
			side.close();
		}
	});

	test("waiting cancellation cannot retract a submitted action", async () => {
		const wire = link();
		let finish!: (value: unknown) => void;
		const side = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[1]!,
			handleRequest: async () =>
				await new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const parent = new RpcPeer({ launch: "launch", endpoint: wire.endpoints[0]! });
		try {
			const abort = new AbortController();
			const promise = parent.call(
				"runtime.submit",
				{
					requestId: "q",
					entry: { kind: "call", selector: "chat@1", input: { text: "hello" } },
					schedule: { kind: "enqueue" },
				},
				{ signal: abort.signal },
			);
			await Promise.resolve();
			abort.abort();
			finish({ kind: "unknown", requestId: "q", reason: "not yet verified" });
			await expect(promise).resolves.toMatchObject({ requestId: "q" });
			expect(wire.sent[0]!.some((frame) => (frame as { kind: string }).kind === "cancel_wait")).toBe(false);
		} finally {
			parent.close();
			side.close();
		}
	});

	test("wrong active method faults connection and settles all pending with sent uncertainty", async () => {
		const wire = link();
		let fault: Error | undefined;
		const peer = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[0]!,
			onFault: (error) => {
				fault = error;
			},
		});
		const pending = peer.call("runtime.read", { run: "r" });
		wire.inject(0, {
			v: 1,
			launch: "launch",
			kind: "reply",
			id: 1,
			method: "runtime.stop",
			result: { ok: true, value: null },
		});
		await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR", dispatch: "unknown" });
		expect(fault).toBeDefined();
		peer.close();
	});

	test("oversized request is rejected before send; malformed launch is fatal", async () => {
		const wire = link();
		const peer = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[0]!,
			limits: { frameBytes: 256, queuedBytes: 512 },
		});
		await expect(peer.call("observe", { selector: "self@1", input: { large: "x".repeat(500) } })).rejects.toMatchObject(
			{ code: "REQUEST_TOO_LARGE", dispatch: "not_sent" },
		);
		expect(wire.sent[0]).toHaveLength(0);
		const next = peer.call("runtime.read", { run: "r" });
		wire.inject(0, { v: 1, launch: "old", kind: "cancel_wait", id: 1 });
		await expect(next).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
		peer.close();
	});

	test("control requests overtake queued ordinary work with monotonic wire ids", async () => {
		const wire = link();
		const callbacks: (() => void)[] = [];
		const original = wire.endpoints[0]!.send;
		wire.endpoints[0]!.send = (value, done) =>
			original(value, (error) => {
				callbacks.push(() => done(error));
			});
		const side = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[1]!,
			handleRequest: async () => ({ attachment: "a", gates: [], gateRevision: 1, validForMs: 5000 }),
		});
		const parent = new RpcPeer({ launch: "launch", endpoint: wire.endpoints[0]! });
		try {
			const one = parent.call("runtime.heartbeat", { attachment: "a" });
			const ordinary = parent.call("runtime.attach", {});
			const urgent = parent.call("runtime.heartbeat", { attachment: "a" });
			await one;
			callbacks.shift()!();
			await urgent;
			callbacks.shift()!();
			await ordinary;
			callbacks.shift()!();
			expect(
				wire.sent[0]!.map((value) => ({
					id: (value as { id: number }).id,
					method: (value as { method: string }).method,
				})),
			).toEqual([
				{ id: 1, method: "runtime.heartbeat" },
				{ id: 2, method: "runtime.heartbeat" },
				{ id: 3, method: "runtime.attach" },
			]);
		} finally {
			parent.close();
			side.close();
		}
	});

	test("oversized result does not retire a healthy peer", async () => {
		const wire = link();
		const side = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[1]!,
			limits: { frameBytes: 1024, queuedBytes: 2048 },
			handleRequest: async (method) =>
				method === "runtime.readRecord"
					? { kind: "inline", record: { kind: "run", record: "rec", value: "x".repeat(5000) } }
					: { attachment: "a", gates: [], gateRevision: 1, validForMs: 5000 },
		});
		const parent = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[0]!,
			limits: { frameBytes: 1024, queuedBytes: 2048 },
		});
		try {
			await expect(parent.call("runtime.readRecord", { ref: "rec" })).rejects.toMatchObject({
				code: "QUERY_RESULT_TOO_LARGE",
			});
			await expect(parent.call("runtime.heartbeat", { attachment: "a" })).resolves.toMatchObject({ attachment: "a" });
		} finally {
			parent.close();
			side.close();
		}
	});

	test("ordinary buffered bytes are bounded while heartbeat can enter the control queue", async () => {
		const wire = link();
		wire.endpoints[0]!.send = (value) => {
			wire.sent[0]!.push(value);
		};
		const peer = new RpcPeer({
			launch: "launch",
			endpoint: wire.endpoints[0]!,
			limits: { frameBytes: 256, queuedBytes: 512 },
		});
		const ordinary = Array.from({ length: 8 }, () => peer.call("runtime.attach", {}).catch((error: unknown) => error));
		const heartbeat = peer.call("runtime.heartbeat", { attachment: "a" }).catch((error: unknown) => error);
		peer.close();
		const results = (await Promise.all(ordinary)) as { code: string; dispatch: string }[];
		expect(results.some((result) => result.code === "TRANSPORT_BUSY" && result.dispatch === "not_sent")).toBe(true);
		expect(wire.sent[0]).toHaveLength(1);
		expect(await heartbeat).toMatchObject({ code: "EXECUTOR_UNAVAILABLE", dispatch: "not_sent" });
	});
});

test("offline account identity normalizes endpoint/name but distinguishes servers and rejects microsoft", () => {
	const config = parseExecutorConfig({
		connection: { host: "LOCALHOST.", username: "Uina", authMode: "offline" },
		binding: null,
	});
	expect(config.connection.port).toBe(25565);
	expect(accountKey(config)).toBe(
		accountKey(
			parseExecutorConfig({
				connection: { host: "localhost", username: "uina", port: 25565, authMode: "offline" },
				binding: null,
			}),
		),
	);
	expect(accountKey(config)).not.toBe(
		accountKey(
			parseExecutorConfig({
				connection: { host: "localhost", username: "uina", port: 25566, authMode: "offline" },
				binding: null,
			}),
		),
	);
	expect(() =>
		parseExecutorConfig({ connection: { host: "localhost", username: "Uina", authMode: "microsoft" }, binding: null }),
	).toThrow(/offline/);
});
