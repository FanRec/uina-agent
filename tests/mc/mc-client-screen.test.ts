import { expect, test, vi } from "vitest";
import type { LocalScreenActivity } from "../../.uina/worlds/minecraft/contracts/protocol.js";
import { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

/**
 * ClientHost 的本地界面派发（addons.md §4.2）。
 *
 * 这里守三条底线：
 * 1. 身份：连接/化身不匹配或未 ready 的事件一律丢弃——旧事务的 close 绝不能写到新连接；
 * 2. 顺序：同步编码同步写入，`minecraft:register` 先于 Payload；
 * 3. 隔离：单个包的编码/发送失败只留诊断，不打断同一次事件里的其它包。
 */

const EVENT: LocalScreenActivity = {
	kind: "player_inventory",
	phase: "open",
	session: "op:1",
	connection: "conn:1",
	incarnation: "inc:1",
};

interface Write {
	name: string;
	data: { channel: string; data: Uint8Array };
}

function makeBot(): { bot: MineflayerBot; writes: Write[] } {
	const writes: Write[] = [];
	const bot = {
		version: "1.21.11",
		_client: {
			state: "play",
			write: (name: string, data: Write["data"]): number => writes.push({ name, data }),
			on: (): void => {},
			removeListener: (): void => {},
		},
		on: (): void => {},
		removeListener: (): void => {},
		game: { dimension: "minecraft:overworld" },
		entity: { position: { x: 0, y: 64, z: 0 } },
	};
	return { bot: bot as unknown as MineflayerBot, writes };
}

type Encoder = (event: Readonly<LocalScreenActivity>) => unknown;

/** ClientHost 的私有字段在测试里直接装配：不为了测试在生产代码上开注册口。 */
function hostWith(
	encoders: { id: string; localScreen: Encoder }[],
	overrides: Partial<{ state: string; connection: string; incarnation: string; bot: null }> = {},
): { host: ClientHost; writes: Write[] } {
	const host = new ClientHost();
	const internals = host as unknown as Record<string, unknown>;
	const { bot, writes } = makeBot();
	internals._state = overrides.state ?? "ready";
	internals._bot = overrides.bot === undefined ? bot : overrides.bot;
	internals._connection = overrides.connection ?? "conn:1";
	internals._incarnation = overrides.incarnation ?? "inc:1";
	internals._screenExtensions = encoders;
	return { host, writes };
}

/** 取本次写入的 Payload（跳过 minecraft:register）。 */
function payloads(writes: Write[]): Write[] {
	return writes.filter((write) => write.data.channel !== "minecraft:register");
}

test("按连接身份派发：先声明通道，再写 Payload", () => {
	const { host, writes } = hostWith([
		{ id: "spectatorplus", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(1) }) },
	]);
	expect(host.emitLocalScreen(EVENT)).toBe(true);
	expect(writes[0]?.data.channel).toBe("minecraft:register");
	const sent = payloads(writes);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.name).toBe("custom_payload");
	expect(sent[0]?.data.channel).toBe("uina:test");
	// 协议层按字节写入（Buffer 是 Uint8Array 的子类），内容必须与编码器返回的一致。
	expect([...(sent[0]?.data.data as Uint8Array)]).toEqual([1]);
});

test("旧连接的 close 不会写到新连接（连接号不匹配）", () => {
	const { host, writes } = hostWith([
		{ id: "a", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(0) }) },
	]);
	expect(host.emitLocalScreen({ ...EVENT, phase: "close", connection: "conn:0" })).toBe(false);
	expect(writes).toEqual([]);
});

test("化身换代后的迟到事件被丢弃", () => {
	const { host, writes } = hostWith([
		{ id: "a", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(0) }) },
	]);
	expect(host.emitLocalScreen({ ...EVENT, phase: "close", incarnation: "inc:0" })).toBe(false);
	expect(writes).toEqual([]);
});

test("未 ready 的连接不派发", () => {
	const { host, writes } = hostWith(
		[{ id: "a", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(1) }) }],
		{ state: "syncing" },
	);
	expect(host.emitLocalScreen(EVENT)).toBe(false);
	expect(writes).toEqual([]);
});

test("没有客户端时不派发", () => {
	const { host, writes } = hostWith(
		[{ id: "a", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(1) }) }],
		{ bot: null },
	);
	expect(host.emitLocalScreen(EVENT)).toBe(false);
	expect(writes).toEqual([]);
});

test("没有包接收时返回 false，不写入任何 Payload", () => {
	const { host, writes } = hostWith([]);
	expect(host.emitLocalScreen(EVENT)).toBe(false);
	expect(payloads(writes)).toEqual([]);
});

test("一个包抛错不打断同一次事件里的其它包", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { host } = hostWith([
		{
			id: "broken",
			localScreen: () => {
				throw new Error("encoder blew up");
			},
		},
		{ id: "good", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(1) }) },
	]);
	expect(host.emitLocalScreen(EVENT)).toBe(true);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("[mc-addon:broken]"));
	warn.mockRestore();
});

test("返回 null 的包被跳过，不算已提交", () => {
	const { host } = hostWith([{ id: "quiet", localScreen: () => null }]);
	expect(host.emitLocalScreen(EVENT)).toBe(false);
});

test("非法 Payload 形状被拒绝，不把坏字节写到连接上", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { host, writes } = hostWith([{ id: "bad", localScreen: () => ({ channel: "uina:test", data: [1, 2, 3] }) }]);
	expect(host.emitLocalScreen(EVENT)).toBe(false);
	expect(payloads(writes)).toEqual([]);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed payload"));
	warn.mockRestore();
});

test("通道名非法时发送失败只记诊断，不影响其它包", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { host } = hostWith([
		{ id: "bad", localScreen: () => ({ channel: "not a channel", data: Uint8Array.of(1) }) },
		{ id: "good", localScreen: () => ({ channel: "uina:test", data: Uint8Array.of(1) }) },
	]);
	expect(host.emitLocalScreen(EVENT)).toBe(true);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("was not sent"));
	warn.mockRestore();
});
