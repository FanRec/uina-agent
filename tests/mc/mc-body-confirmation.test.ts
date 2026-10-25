import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BlockTarget } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { DriverExecutionFact } from "../../.uina/worlds/minecraft/contracts/runtime.js";
import { callFailure } from "../../.uina/worlds/minecraft/contracts/values.js";
import { runMining } from "../../.uina/worlds/minecraft/driver/body/mining.js";
import type { BodyOperationDeps } from "../../.uina/worlds/minecraft/driver/body/operation.js";
import { runSign } from "../../.uina/worlds/minecraft/driver/body/sign.js";
import { EffectRecorder } from "../../.uina/worlds/minecraft/driver/execution.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";
import { protocolFor } from "../../.uina/worlds/minecraft/driver/mineflayer/protocol.js";

const require = createRequire(import.meta.url);
const mf = createRequire(require.resolve("mineflayer"));
const target: BlockTarget = {
	place: { world: "world:test", worldRevision: "rev:test", dimension: "overworld", position: { x: 0, y: 64, z: 0 } },
	block: { x: 0, y: 64, z: 0 },
};

function harness() {
	const bot = new EventEmitter() as EventEmitter & Record<string, any>;
	bot._client = new EventEmitter();
	bot.version = "1.21.11";
	bot.registry = mf("prismarine-registry")("1.21.11");
	bot.entity = { position: { x: 0, y: 64, z: 1 }, eyeHeight: 1.62 };
	bot.heldItem = null;
	bot.blockAt = () => ({ name: "stone", type: bot.registry.blocksByName.stone.id, getProperties: () => ({}) });
	bot.digTime = () => 100;
	bot.lookAt = vi.fn(async () => {});
	bot.swingArm = vi.fn();
	const packets: { name: string; input: Record<string, any> }[] = [];
	bot._client.write = (name: string, input: Record<string, any>) => packets.push({ name, input });
	const abort = new AbortController();
	const facts: DriverExecutionFact[] = [];
	let live = true;
	let serial = 0;
	const deps: BodyOperationDeps = {
		bot: bot as unknown as MineflayerBot,
		protocol: protocolFor(bot as unknown as MineflayerBot),
		signal: abort.signal,
		guard: () => {
			if (!live || abort.signal.aborted)
				throw callFailure({
					code: "CONTROL_INVALID",
					source: "capability",
					message: "test qualification retired",
					dispatch: "not_sent",
					effects: [],
					recoverable: false,
				});
		},
		canCleanup: () => live,
		recorder: new EffectRecorder({
			record: (fact) => {
				facts.push(fact);
				return { instance: "test", sequence: facts.length };
			},
		}),
		mintOp: () => `op:${++serial}`,
		mintEff: () => `eff:${++serial}`,
	};
	const serverBlock = (air: boolean, position = target.block) =>
		bot._client.emit("block_change", {
			location: position,
			type: air ? bot.registry.blocksByName.air.minStateId : bot.registry.blocksByName.stone.minStateId,
		});
	const sign = () => {
		bot.blockAt = () => ({ name: "oak_sign", getProperties: () => ({ is_waxed: false }) });
	};
	const editor = (front = true, position = target.block) =>
		bot._client.emit("open_sign_entity", { location: position, isFrontText: front });
	const signUpdate = (position = target.block) => bot._client.emit("tile_entity_data", { location: position });
	const end = () => {
		live = false;
		bot.emit("end");
	};
	return { bot, deps, abort, facts, packets, serverBlock, sign, editor, signUpdate, end };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("controlled mining server confirmation", () => {
	test("local air prediction and protocol ACK cannot confirm a break", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" });
		await vi.advanceTimersByTimeAsync(100);
		h.bot.blockAt = () => ({ name: "air", type: 0 });
		h.bot.emit("blockUpdate", null, { name: "air" });
		h.bot._client.emit("acknowledge_player_digging", { sequenceId: 2 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(await pending).toMatchObject({ completion: "unknown", dispatch: "sent" });
		expect(h.packets.filter((p) => p.name === "block_dig").map((p) => p.input.status)).toEqual([0, 2]);
		expect(h.facts.at(-1)).toMatchObject({ contract: "body.dig@1", completion: "unknown", kind: "receipt" });
	});

	test("a real same-position server air update confirms the break and stops the finish timer", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" });
		await vi.advanceTimersByTimeAsync(0);
		h.serverBlock(true, { x: 1, y: 64, z: 0 });
		h.serverBlock(true);
		expect(await pending).toMatchObject({ completion: "met", dispatch: "sent" });
		await vi.advanceTimersByTimeAsync(10000);
		expect(h.packets.filter((p) => p.name === "block_dig").map((p) => p.input.status)).toEqual([0]);
	});

	test("a real multi-block update is decoded by the installed version adapter", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" });
		await vi.advanceTimersByTimeAsync(100);
		h.bot._client.emit("multi_block_change", { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [0] });
		expect(await pending).toMatchObject({ completion: "met" });
	});

	test("a solid update before finish is not rejection; a solid update after finish is", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" });
		await vi.advanceTimersByTimeAsync(0);
		h.serverBlock(false);
		await vi.advanceTimersByTimeAsync(100);
		h.serverBlock(false);
		expect(await pending).toMatchObject({ completion: "not_met", dispatch: "sent" });
	});

	test("cancellation dispatches one owned cancel immediately and prevents any later finish", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" }).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		h.abort.abort();
		expect(await pending).toMatchObject({ name: "CallFailure", dispatch: "sent", effects: [expect.any(String)] });
		await vi.advanceTimersByTimeAsync(10000);
		expect(h.packets.filter((p) => p.name === "block_dig").map((p) => p.input.status)).toEqual([0, 1]);
		expect(h.facts.some((fact) => fact.kind === "cleanup")).toBe(true);
	});

	test("disconnect removes timers without sending cleanup into a retired connection", async () => {
		const h = harness();
		const pending = runMining(h.deps, target, { aim: "preserve" }).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		h.end();
		expect(await pending).toMatchObject({ code: "DISCONNECTED", dispatch: "sent" });
		await vi.advanceTimersByTimeAsync(10000);
		expect(h.packets.filter((p) => p.name === "block_dig").map((p) => p.input.status)).toEqual([0]);
	});

	test("cancellation during look settles promptly and the late look cannot start digging", async () => {
		const h = harness();
		let release: () => void = () => {};
		h.bot.lookAt = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const pending = runMining(h.deps, target).catch((error) => error);
		h.abort.abort();
		expect(await pending).toMatchObject({ dispatch: "not_sent" });
		release();
		await vi.advanceTimersByTimeAsync(10000);
		expect(h.packets).toEqual([]);
	});

	test("an unclassified socket write failure cannot be reported as definitely not sent", async () => {
		const h = harness();
		h.bot._client.write = () => {
			throw new Error("socket write failed");
		};
		const error = await runMining(h.deps, target, { aim: "preserve" }).catch((failure) => failure);
		expect(error).toMatchObject({ dispatch: "unknown", effects: [expect.any(String)] });
		expect(h.facts.at(-1)).toMatchObject({ dispatch: "unknown", completion: "unknown" });
	});
});

describe("controlled sign editor and submission", () => {
	const input = { side: "front" as const, lines: ["test", "", "", ""] as [string, string, string, string] };

	test("only an editor followed by a real same-position block-entity update confirms submission", async () => {
		const h = harness();
		h.sign();
		const pending = runSign(h.deps, target, input);
		await vi.advanceTimersByTimeAsync(0);
		h.signUpdate(); // pre-submit data cannot settle the write
		h.editor();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.packets.map((p) => p.name)).toEqual(["block_place", "update_sign"]);
		h.signUpdate({ x: 1, y: 64, z: 0 });
		h.signUpdate();
		expect(await pending).toMatchObject({ completion: "met", dispatch: "sent" });
	});

	test("confirmation listener is installed before synchronous sign submission", async () => {
		const h = harness();
		h.sign();
		const write = h.bot._client.write;
		h.bot._client.write = (name: string, packet: Record<string, unknown>) => {
			write(name, packet);
			if (name === "update_sign") h.signUpdate();
		};
		const pending = runSign(h.deps, target, input);
		await vi.advanceTimersByTimeAsync(0);
		h.editor();
		expect(await pending).toMatchObject({ completion: "met" });
	});

	test("editor response followed by cancellation cannot send a sign update", async () => {
		const h = harness();
		h.sign();
		const pending = runSign(h.deps, target, input).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		h.editor();
		h.abort.abort();
		expect(await pending).toMatchObject({ name: "CallFailure", dispatch: "sent" });
		await vi.advanceTimersByTimeAsync(10000);
		expect(h.packets.map((p) => p.name)).toEqual(["block_place"]);
		expect(h.facts.at(-1)).toMatchObject({ completion: "unknown" });
	});

	test("wrong editor side fails without writing the requested text", async () => {
		const h = harness();
		h.sign();
		const pending = runSign(h.deps, target, input).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		h.editor(false);
		expect(await pending).toMatchObject({ code: "WRONG_STATE", dispatch: "sent" });
		expect(h.packets.map((p) => p.name)).toEqual(["block_place"]);
	});

	test("missing submission confirmation returns unknown and removes all operation timers", async () => {
		const h = harness();
		h.sign();
		const pending = runSign(h.deps, target, input);
		await vi.advanceTimersByTimeAsync(0);
		h.editor();
		await vi.advanceTimersByTimeAsync(2000);
		expect(await pending).toMatchObject({ completion: "unknown", dispatch: "sent" });
		expect(vi.getTimerCount()).toBe(0);
	});

	test("editor timeout and disconnect never submit text later", async () => {
		for (const disconnected of [false, true]) {
			const h = harness();
			h.sign();
			const pending = runSign(h.deps, target, input).catch((error) => error);
			await vi.advanceTimersByTimeAsync(0);
			if (disconnected) h.end();
			else await vi.advanceTimersByTimeAsync(2000);
			expect(await pending).toMatchObject({ code: disconnected ? "DISCONNECTED" : "TIMEOUT", dispatch: "sent" });
			h.editor();
			h.signUpdate();
			await vi.advanceTimersByTimeAsync(10000);
			expect(h.packets.map((p) => p.name)).toEqual(["block_place"]);
		}
	});

	test("an unclassified activation write failure keeps the uncertain dispatch", async () => {
		const h = harness();
		h.sign();
		h.bot._client.write = () => {
			throw new Error("socket write failed");
		};
		const error = await runSign(h.deps, target, input).catch((failure) => failure);
		expect(error).toMatchObject({ dispatch: "unknown", effects: [expect.any(String)] });
		expect(h.facts.at(-1)).toMatchObject({ dispatch: "unknown", completion: "unknown" });
	});
});
