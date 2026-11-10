import { EventEmitter } from "node:events";
import { expect, test } from "vitest";

import type {
	PhaseContext,
	ProtocolBootstrap,
	ProtocolExtension,
} from "../../.uina/worlds/minecraft/contracts/protocol.js";
import type { PendingProtocolClient } from "../../.uina/worlds/minecraft/driver/mineflayer/pending-client.js";
import type { DriverProtocol } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";
import { createProtocolAssembly } from "../../.uina/worlds/minecraft/driver/protocol-bootstrap.js";

/** 只模拟 minecraft-protocol 已取证的行为：按包名 emit、client.state 给阶段、write 记录。 */
function fixture() {
	const emitter = new EventEmitter();
	const writes: { name: string; packet: unknown }[] = [];
	const registered: string[] = [];
	const client = Object.assign(emitter, {
		state: "handshaking",
		socket: null as unknown,
		write(name: string, packet: unknown) {
			writes.push({ name, packet });
		},
		end() {},
	});
	const protocol = {
		registerChannels(channels: readonly string[]) {
			registered.push(...channels);
		},
	};
	let current = true;
	const assembly = createProtocolAssembly({
		client: client as unknown as PendingProtocolClient,
		protocol: protocol as unknown as DriverProtocol,
		minecraftVersion: "1.21.11",
		connection: "conn:1",
		isCurrent: () => current,
	});
	return {
		client,
		writes,
		registered,
		assembly,
		retire() {
			current = false;
		},
	};
}

function capture(work: () => void): unknown {
	try {
		work();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

const claimFml = (boot: ProtocolBootstrap): void => boot.claim("login", "fml");

test("两个扩展的 install 都在首包前挂载，且都收到第一个包", () => {
	const f = fixture();
	const seen: string[][] = [[], []];
	const extensions: ProtocolExtension[] = [0, 1].map((index) => ({
		id: `addon-${index}`,
		install(boot) {
			boot.onPacket("login", "login_plugin_request", (packet) => {
				seen[index]?.push(String((packet as { messageId: number }).messageId));
			});
		},
	}));
	f.assembly.installAll(extensions);
	f.assembly.finish();
	expect(f.client.listenerCount("login_plugin_request")).toBe(2);

	f.client.state = "login";
	f.client.emit("login_plugin_request", { messageId: 7 }, { name: "login_plugin_request" });
	expect(seen).toEqual([["7"], ["7"]]);
});

test("阶段过滤：login 阶段的包不派发给 configuration 订阅者", () => {
	const f = fixture();
	const seen: string[] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPayload("configuration", "fabric:sync", () => seen.push("configuration"));
			},
		},
	]);
	f.assembly.finish();
	f.client.state = "login";
	f.client.emit("packet", { channel: "fabric:sync", data: Buffer.from([1]) }, { name: "custom_payload" });
	expect(seen).toEqual([]);
	f.client.state = "configuration";
	f.client.emit("packet", { channel: "fabric:sync", data: Buffer.from([1]) }, { name: "custom_payload" });
	expect(seen).toEqual(["configuration"]);
});

test("claim 冲突立即失败，并回滚本连接已注册的处理器", () => {
	const f = fixture();
	const error = capture(() =>
		f.assembly.installAll([
			{
				id: "alpha",
				install(boot) {
					claimFml(boot);
					boot.onPacket("login", "login_plugin_request", () => {});
				},
			},
			{ id: "beta", install: claimFml },
		]),
	);
	expect(error).toMatchObject({ code: "ADDON_PROTOCOL_CONFLICT" });
	expect(f.client.listenerCount("login_plugin_request")).toBe(0);
});

test("replyPacket 只在本阶段有效；阶段已过就拒绝写入", () => {
	const f = fixture();
	const contexts: PhaseContext[] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPacket("configuration", "custom_query", (_packet, phase) => contexts.push(phase));
			},
		},
	]);
	f.assembly.finish();
	f.client.state = "configuration";
	f.client.emit("custom_query", { messageId: 1 });
	contexts[0]?.replyPacket("custom_query_answer", { messageId: 1 });
	expect(f.writes).toEqual([{ name: "custom_query_answer", packet: { messageId: 1 } }]);

	f.client.state = "play";
	expect(capture(() => contexts[0]?.replyPacket("custom_query_answer", { messageId: 2 }))).toMatchObject({
		code: "ADDON_PROTOCOL_PHASE_EXPIRED",
	});
	expect(f.writes).toHaveLength(1);
});

test("replyPayload 只在 configuration 阶段允许，且真的写到同一个 Client", () => {
	const f = fixture();
	const contexts: PhaseContext[] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPacket("configuration", "custom_query", (_packet, phase) => contexts.push(phase));
				boot.onPacket("play", "keep_alive", (_packet, phase) => contexts.push(phase));
			},
		},
	]);
	f.assembly.finish();

	f.client.state = "play";
	f.client.emit("keep_alive", { id: 1 });
	expect(capture(() => contexts[0]?.replyPayload("fabric:sync", Uint8Array.of(1)))).toMatchObject({
		code: "ADDON_PROTOCOL_PHASE_FORBIDDEN",
	});

	f.client.state = "configuration";
	f.client.emit("custom_query", { messageId: 1 });
	contexts[1]?.replyPayload("fabric:sync", Uint8Array.of(1, 2));
	expect(f.writes).toEqual([
		{
			name: "custom_payload",
			packet: { channel: "fabric:sync", data: Buffer.from([1, 2]) },
		},
	]);
	expect(capture(() => contexts[1]?.replyPayload("not-a-channel", Uint8Array.of(1)))).toMatchObject({
		code: "ADDON_PROTOCOL_CHANNEL_INVALID",
	});
});

test("declareReceive：play 走真实 minecraft:register，configuration 不伪造注册包", () => {
	const f = fixture();
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.declareReceive("play", "uina:example");
				boot.declareReceive("play", "uina:example");
				boot.declareReceive("configuration", "fabric:sync");
			},
		},
	]);
	f.assembly.finish();
	expect(f.registered).toEqual(["uina:example"]);
	expect(f.writes).toEqual([]);
});

test("onPayload 按阶段和通道派发原始字节", () => {
	const f = fixture();
	const seen: number[][] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPayload("configuration", "fabric:sync", (bytes) => seen.push([...bytes]));
			},
		},
	]);
	f.assembly.finish();
	f.client.state = "play";
	f.client.emit("packet", { channel: "fabric:sync", data: Buffer.from([9]) }, { name: "custom_payload" });
	f.client.state = "configuration";
	f.client.emit("packet", { channel: "fabric:other", data: Buffer.from([8]) }, { name: "custom_payload" });
	f.client.emit("packet", { channel: "fabric:sync", data: Buffer.from([1, 2]) }, { name: "custom_payload" });
	expect(seen).toEqual([[1, 2]]);
});

test("installLowLevel 隐含 claim：同名插件冲突时已安装的 disposer 立刻释放", () => {
	const f = fixture();
	const cleaned: string[] = [];
	const installed: unknown[] = [];
	const error = capture(() =>
		f.assembly.installAll([
			{
				id: "alpha",
				install(boot) {
					boot.installLowLevel("fml", (client) => {
						installed.push(client);
						return () => cleaned.push("fml");
					});
				},
			},
			{ id: "beta", install: (boot) => boot.installLowLevel("fml", () => {}) },
		]),
	);
	expect(error).toMatchObject({ code: "ADDON_PROTOCOL_CONFLICT" });
	expect(installed).toEqual([f.client]);
	expect(cleaned).toEqual(["fml"]);
});

test("dispose 解除全部订阅并执行低层插件 disposer，且幂等", () => {
	const f = fixture();
	const cleaned: string[] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPacket("login", "login_plugin_request", () => {});
				boot.onPayload("play", "uina:example", () => {});
				boot.installLowLevel("fml", () => () => cleaned.push("fml"));
			},
		},
	]);
	f.assembly.finish();
	expect(f.client.listenerCount("login_plugin_request")).toBe(1);
	expect(f.client.listenerCount("packet")).toBe(1);
	f.assembly.dispose();
	f.assembly.dispose();
	expect(f.client.listenerCount("login_plugin_request")).toBe(0);
	expect(f.client.listenerCount("packet")).toBe(0);
	expect(cleaned).toEqual(["fml"]);
});

test("冻结后不允许迟到注册", () => {
	const f = fixture();
	f.assembly.installAll([{ id: "alpha", install: () => {} }]);
	f.assembly.finish();
	expect(capture(() => f.assembly.onPacket("play", "keep_alive", () => {}))).toMatchObject({
		code: "ADDON_PROTOCOL_ASSEMBLY_FROZEN",
	});
});

test("连接退役后旧装配不再回复", () => {
	const f = fixture();
	const contexts: PhaseContext[] = [];
	f.assembly.installAll([
		{
			id: "alpha",
			install(boot) {
				boot.onPacket("configuration", "custom_query", (_packet, phase) => contexts.push(phase));
			},
		},
	]);
	f.client.state = "configuration";
	f.client.emit("custom_query", { messageId: 1 });
	f.retire();
	expect(capture(() => contexts[0]?.replyPacket("custom_query_answer", { messageId: 1 }))).toMatchObject({
		code: "ADDON_PROTOCOL_CONNECTION_RETIRED",
	});
	expect(f.writes).toEqual([]);
});
