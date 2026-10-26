import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ bot: null as unknown }));
vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/adapter.js", () => ({
	connectMinecraftClient: () => state.bot,
	fromMineflayerVec3: (v: unknown) => v,
}));
vi.mock("../../.uina/worlds/minecraft/driver/mineflayer/protocol.js", () => ({ protocolFor: () => ({}) }));
import { ClientHost } from "../../.uina/worlds/minecraft/driver/client-host.js";

test("ready retains lifecycle listeners; death invalidates immediately and respawn replaces incarnation", async () => {
	const emitter = new EventEmitter();
	const bot = Object.assign(emitter, {
		game: { dimension: "overworld" },
		quit() {
			emitter.emit("end");
		},
	});
	state.bot = bot;
	const host = new ClientHost();
	const events: unknown[] = [];
	host.on((event) => events.push(event));
	const pending = host.connect({ host: "test", port: 1, username: "test" });
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
});
