import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	bot: null as unknown,
	resumed: 0,
	aborted: 0,
}));
vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/adapter.js", () => ({
	connectMinecraftClient: () => state.bot,
	fromMineflayerVec3: (v: unknown) => v,
}));
vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/protocol.js", () => ({ protocolFor: () => ({}) }));
// 真服首包探针已证明这条接缝的行为；单测只替换"创建未连接 Client"这一步。
vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/pending-client.js", () => ({
	createPendingClient: () => ({
		client: {},
		resume() {
			state.resumed += 1;
		},
		abort() {
			state.aborted += 1;
		},
	}),
}));

import type { ProtocolBootstrap } from "../../.uina/worlds/minecraft/contracts/protocol.js";
import { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";

const opts = { host: "test", port: 1, username: "test", version: "1.21.11" };

function botFixture(): EventEmitter & { game: { dimension: string }; quit(): void } {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		game: { dimension: "overworld" },
		quit() {
			emitter.emit("end");
		},
	});
}

beforeEach(() => {
	state.resumed = 0;
	state.aborted = 0;
	state.bot = botFixture();
});

test("ready retains lifecycle listeners; death invalidates immediately and respawn replaces incarnation", async () => {
	const bot = state.bot as ReturnType<typeof botFixture>;
	const host = new ClientHost();
	const events: unknown[] = [];
	host.on((event) => events.push(event));
	const pending = host.connect(opts);
	bot.emit("spawn");
	await pending;
	const first = host.identity!;
	bot.emit("spawn");
	expect(host.identity).toEqual(first);
	bot.emit("death");
	expect(host.state).toBe("syncing");
	bot.emit("spawn");
	expect(host.state).toBe("ready");
	expect(host.identity?.incarnation).not.toBe(first.incarnation);
	bot.game.dimension = "the_nether";
	const beforeDimension = host.identity;
	bot.emit("spawn");
	expect(host.identity).not.toEqual(beforeDimension);
	bot.emit("kicked", "test kick");
	bot.emit("end");
	expect(host.state).toBe("disconnected");
	expect(host.bot).toBeNull();
	expect(host.disconnectFacts?.reason).toBe("test kick");
	expect(events).toContainEqual(expect.objectContaining({ kind: "incarnation_invalidated" }));
	expect(bot.listenerCount("spawn")).toBe(0);
	expect(state.resumed).toBe(1);
	expect(state.aborted).toBe(0);
});

test("voluntary close records a truthful disconnect reason and detaches lifecycle listeners", async () => {
	const bot = state.bot as ReturnType<typeof botFixture>;
	const host = new ClientHost();
	const pending = host.connect(opts);
	bot.emit("spawn");
	await pending;
	await host.close();
	expect(host.state).toBe("disconnected");
	expect(host.disconnectFacts?.reason).toBe("closed");
	expect(bot.listenerCount("spawn")).toBe(0);
});

test("install 冲突在放行连接之前失败：未连接 Client 被回滚，不留半连接", async () => {
	const host = new ClientHost();
	const claim = (boot: ProtocolBootstrap): void => boot.claim("login", "fml");
	await expect(
		host.connect(opts, {
			extensions: [
				{ id: "alpha", install: claim },
				{ id: "beta", install: claim },
			],
		}),
	).rejects.toMatchObject({ code: "ADDON_PROTOCOL_CONFLICT" });
	expect(state.resumed).toBe(0);
	expect(state.aborted).toBe(1);
	expect(host.state).toBe("faulted");
	expect(host.bot).toBeNull();
});

test("预连接阶段协议错误：结束真实 Client、只报一次断开、状态停在 faulted", async () => {
	const bot = state.bot as ReturnType<typeof botFixture>;
	const host = new ClientHost();
	const events: { kind: string }[] = [];
	host.on((event) => events.push(event as { kind: string }));
	const pending = host.connect(opts);
	bot.emit("error", new Error("login failed"));
	await pending;
	expect(host.state).toBe("faulted");
	expect(host.bot).toBeNull();
	expect(host.disconnectFacts?.reason).toBe("login failed");
	// 真实 Client 必须先结束再丢引用；否则这个半连接再也关不掉。
	expect(state.aborted).toBe(1);
	expect(events.filter((event) => event.kind === "disconnected")).toHaveLength(1);
	// 收口后迟到的 end 不得把 faulted 翻回 disconnected，也不得重复上报。
	bot.emit("end");
	expect(host.state).toBe("faulted");
	expect(events.filter((event) => event.kind === "disconnected")).toHaveLength(1);
});

test("install 抛错时主错误原样抛出，连接同样不 resume", async () => {
	const host = new ClientHost();
	await expect(
		host.connect(opts, {
			extensions: [
				{
					id: "alpha",
					install() {
						throw new Error("bad addon");
					},
				},
			],
		}),
	).rejects.toThrow("bad addon");
	expect(state.resumed).toBe(0);
	expect(state.aborted).toBe(1);
	expect(host.state).toBe("faulted");
});
