import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneBotTransport } from "../.uina/worlds/qq/src/transport.js";

class RecoverySocket {
	static instances: RecoverySocket[] = [];
	readyState = 0;
	readonly sent: { action: string; echo: string }[] = [];
	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	constructor(_url: string) {
		RecoverySocket.instances.push(this);
	}

	addEventListener(event: string, listener: (...args: unknown[]) => void): void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
	}

	removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
		this.listeners.get(event)?.delete(listener);
	}

	emit(event: string, value?: unknown): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value);
	}

	open(): void {
		this.readyState = 1;
		this.emit("open");
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "closed by test" });
	}

	send(raw: string): void {
		this.sent.push(JSON.parse(raw));
	}

	reply(data: unknown): void {
		this.emit("message", JSON.stringify({ status: "ok", retcode: 0, echo: this.sent.at(-1)?.echo, data }));
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const connection = {
	url: "ws://fake.invalid",
	role: "Universal" as const,
	accessToken: "",
	requestTimeoutMs: 100,
	reconnect: { retries: 2, minDelayMs: 10, maxDelayMs: 20 },
};

const transports: OneBotTransport[] = [];

function createTransport(expectedSelfId?: string): OneBotTransport {
	const transport = new OneBotTransport({ connection, webSocketFactory: RecoverySocket, expectedSelfId });
	transports.push(transport);
	return transport;
}

async function ready(transport = createTransport()): Promise<{ transport: OneBotTransport; socket: RecoverySocket }> {
	const started = transport.start();
	const socket = RecoverySocket.instances.at(-1)!;
	socket.open();
	await flush();
	expect(socket.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
	socket.reply({ user_id: 10001 });
	expect(await started).toEqual({ selfId: 10001 });
	return { transport, socket };
}

beforeEach(() => {
	vi.useFakeTimers();
	RecoverySocket.instances = [];
});

afterEach(async () => {
	for (const transport of transports.splice(0)) await transport.stop();
	await flush();
	vi.useRealTimers();
});

describe("QQ transport recovery identity and request boundaries", () => {
	it("reports the open socket independently while reconnect identity is still pending", async () => {
		const { transport, socket } = await ready();
		socket.close();
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		expect(transport.snapshot()).toMatchObject({ connected: true, identityVerified: false, selfId: "10001" });
		replacement.reply({ user_id: 10001 });
		await flush();
		expect(transport.snapshot()).toMatchObject({ connected: true, identityVerified: true });
	});

	it("revalidates every open and publishes recovery only after matching identity", async () => {
		const transport = createTransport();
		const statuses: { connected: boolean; error?: string }[] = [];
		transport.onStatus((status) => statuses.push(status));
		const { socket } = await ready(transport);
		socket.close();
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
		expect(statuses.at(-1)?.connected).toBe(false);
		replacement.reply({ user_id: 10001 });
		await flush();
		expect(statuses.at(-1)).toEqual({ connected: true });
		expect(transport.snapshot()).toMatchObject({
			connected: true,
			identityVerified: true,
			selfId: "10001",
			lastError: null,
		});
	});

	it("waits for reconnect identity before dispatching external writes", async () => {
		const { transport, socket } = await ready();
		socket.close();
		const called = transport.call("send_private_msg", { user_id: 20002, message: "once" });
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
		replacement.reply({ user_id: 10001 });
		await flush();
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info", "send_private_msg"]);
		replacement.reply({ message_id: 42 });
		expect(await called).toEqual({ status: "ok", data: { message_id: 42 } });
	});

	it("rejects configured initial identity and never reports a usable connection", async () => {
		const transport = createTransport("99999");
		const statuses: boolean[] = [];
		transport.onStatus((status) => statuses.push(status.connected));
		const started = transport.start().catch((error: Error) => error);
		const socket = RecoverySocket.instances.at(-1)!;
		socket.open();
		await flush();
		socket.reply({ user_id: 10001 });
		expect(await started).toBeInstanceOf(Error);
		expect(statuses).not.toContain(true);
		expect(await transport.call("send_private_msg")).toMatchObject({ status: "failed", kind: "not_connected" });
	});

	it("pins first successful identity and blocks changed reconnect accounts", async () => {
		const { transport, socket } = await ready();
		socket.close();
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		replacement.reply({ user_id: 99999 });
		await flush();
		expect(await transport.call("send_private_msg")).toMatchObject({ status: "failed", kind: "not_connected" });
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
		expect(transport.snapshot()).toMatchObject({
			connected: false,
			identityVerified: false,
			selfId: "10001",
			lastError: expect.stringMatching(/identity|身份/),
		});
	});

	it("bounds a socket that never opens and prevents late opening work", async () => {
		const transport = createTransport();
		let failure: unknown;
		void transport.start().catch((error) => {
			failure = error;
		});
		const socket = RecoverySocket.instances.at(-1)!;
		await vi.advanceTimersByTimeAsync(100);
		expect(failure).toBeInstanceOf(Error);
		socket.open();
		await flush();
		expect(socket.sent).toHaveLength(0);
	});

	it("cancels connecting start without waiting for socket open", async () => {
		const transport = createTransport();
		const controller = new AbortController();
		let failure: unknown;
		void transport.start(controller.signal).catch((error) => {
			failure = error;
		});
		const socket = RecoverySocket.instances.at(-1)!;
		controller.abort();
		await flush();
		expect(failure).toBeInstanceOf(Error);
		socket.open();
		await flush();
		expect(socket.sent).toHaveLength(0);
	});

	it("does not publish connected after stop during login verification", async () => {
		const transport = createTransport();
		const statuses: boolean[] = [];
		transport.onStatus((status) => statuses.push(status.connected));
		const started = transport.start().catch((error: Error) => error);
		const socket = RecoverySocket.instances.at(-1)!;
		socket.open();
		await flush();
		const echo = socket.sent[0]!.echo;
		await transport.stop();
		socket.emit("message", JSON.stringify({ status: "ok", retcode: 0, echo, data: { user_id: 10001 } }));
		expect(await started).toBeInstanceOf(Error);
		expect(statuses).not.toContain(true);
		expect(transport.snapshot()).toMatchObject({ connected: false, identityVerified: false });
	});

	it("cancels login verification without accepting its late response", async () => {
		const transport = createTransport();
		const statuses: boolean[] = [];
		transport.onStatus((status) => statuses.push(status.connected));
		const controller = new AbortController();
		const started = transport.start(controller.signal).catch((error: Error) => error);
		const socket = RecoverySocket.instances.at(-1)!;
		socket.open();
		await flush();
		expect(socket.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
		controller.abort();
		expect(await started).toBeInstanceOf(Error);
		socket.reply({ user_id: 10001 });
		await flush();
		expect(statuses).not.toContain(true);
		expect(await transport.call("send_private_msg")).toMatchObject({ kind: "not_connected" });
	});

	it("stop immediately after start cannot resurrect the connection", async () => {
		const transport = createTransport();
		const started = transport.start().catch((error: Error) => error);
		const socket = RecoverySocket.instances.at(-1)!;
		await transport.stop();
		socket.open();
		expect(await started).toBeInstanceOf(Error);
		expect(socket.sent).toHaveLength(0);
		expect(await transport.call("send_private_msg")).toMatchObject({ kind: "not_connected" });
	});

	it("shares call deadline across reconnect handshake and dispatched receipt", async () => {
		const { transport, socket } = await ready();
		socket.close();
		let outcome: unknown;
		void transport.call("send_private_msg").then((value) => {
			outcome = value;
		});
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		await vi.advanceTimersByTimeAsync(70);
		replacement.reply({ user_id: 10001 });
		await flush();
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info", "send_private_msg"]);
		await vi.advanceTimersByTimeAsync(20);
		expect(outcome).toMatchObject({ status: "failed", kind: "timeout" });
		expect(replacement.sent.filter((frame) => frame.action === "send_private_msg")).toHaveLength(1);
	});

	it("never reconnects or revalidates an external write interrupted by close", async () => {
		const { transport, socket } = await ready();
		const called = transport.call("send_private_msg");
		await flush();
		socket.close();
		expect(await called).toMatchObject({ status: "failed", kind: "connection" });
		await vi.advanceTimersByTimeAsync(10);
		const replacement = RecoverySocket.instances.at(-1)!;
		replacement.open();
		await flush();
		replacement.reply({ user_id: 10001 });
		await flush();
		expect(replacement.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
	});

	it("cancels a call waiting for handshake as definitely not dispatched", async () => {
		const { transport, socket } = await ready();
		socket.close();
		const controller = new AbortController();
		const called = transport.call("send_private_msg", {}, controller.signal);
		await flush();
		controller.abort();
		expect(await called).toMatchObject({ status: "failed", kind: "not_connected" });
		expect(
			RecoverySocket.instances
				.flatMap((candidate) => candidate.sent)
				.filter((frame) => frame.action === "send_private_msg"),
		).toHaveLength(0);
	});

	it("bounds call connection waiting and never sends after its deadline", async () => {
		const { transport, socket } = await ready();
		socket.close();
		let outcome: unknown;
		void transport.call("send_private_msg").then((value) => {
			outcome = value;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(outcome).toMatchObject({ status: "failed", kind: "not_connected" });
		expect(
			RecoverySocket.instances
				.flatMap((candidate) => candidate.sent)
				.filter((frame) => frame.action === "send_private_msg"),
		).toHaveLength(0);
	});

	it("does not create hidden SDK connections when configured retries are zero", async () => {
		const transport = new OneBotTransport({
			connection: { ...connection, reconnect: { ...connection.reconnect, retries: 0 } },
			webSocketFactory: RecoverySocket,
		});
		transports.push(transport);
		const { socket } = await ready(transport);
		socket.close();
		const called = transport.call("send_private_msg");
		await vi.advanceTimersByTimeAsync(100);
		expect(await called).toMatchObject({ status: "failed", kind: "not_connected" });
		expect(RecoverySocket.instances).toHaveLength(1);
		expect(socket.sent.map((frame) => frame.action)).toEqual(["get_login_info"]);
	});

	it("keeps cancellation after dispatch uncertain without resending", async () => {
		const { transport, socket } = await ready();
		const controller = new AbortController();
		const called = transport.call("send_private_msg", {}, controller.signal);
		await flush();
		expect(socket.sent.at(-1)?.action).toBe("send_private_msg");
		controller.abort();
		expect(await called).toMatchObject({ status: "failed", kind: "connection" });
		expect(socket.sent.filter((frame) => frame.action === "send_private_msg")).toHaveLength(1);
	});

	it("ignores old socket frames after replacement starts", async () => {
		const { transport, socket } = await ready();
		const events: unknown[] = [];
		const raw: unknown[] = [];
		transport.onEvent((event) => events.push(event));
		transport.onRaw((frame) => raw.push(frame));
		socket.close();
		await vi.advanceTimersByTimeAsync(10);
		socket.emit("message", JSON.stringify({ post_type: "message", self_id: 10001 }));
		await flush();
		expect(events).toEqual([]);
		expect(raw).toEqual([]);
	});
});
