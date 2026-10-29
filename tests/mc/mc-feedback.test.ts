import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { ControlInput, SelfState } from "../../.uina/worlds/minecraft/contracts/body.js";
import type { Fact } from "../../.uina/worlds/minecraft/contracts/values.js";
import { FeedbackController } from "../../.uina/worlds/minecraft/driver/body/feedback.js";
import type { MineflayerBot } from "../../.uina/worlds/minecraft/driver/mineflayer/adapter.js";

function fixture() {
	const events = new EventEmitter();
	const bot = Object.assign(events, {
		entity: { yaw: 0, pitch: 0 },
		jumpQueued: false,
		physics: {
			simulatePlayer(state: { control: object; yaw?: number; apply(bot: unknown): void }) {
				return state;
			},
		},
	});
	let installed: ControlInput | null = null;
	const applied: ControlInput[] = [];
	const controller = new AbortController();
	const realControl = {};
	const stream = new FeedbackController({
		body: "body:test",
		operation: "op:test",
		identity: { connection: "c", incarnation: "i" },
		bot: bot as unknown as MineflayerBot,
		signal: controller.signal,
		guard: () => {},
		sample: () => ({ self: { value: { health: 20 } as SelfState } as Fact<SelfState>, sensors: {} }),
		install: (input) => {
			installed = input;
		},
		clear: () => {
			installed = null;
		},
		record: () => ({ effect: "e", dispatch: "sent", completion: "met", evidence: [] }),
	});
	function step() {
		bot.physics
			.simulatePlayer({
				control: realControl,
				apply() {
					if (installed) applied.push(installed);
				},
			})
			.apply(bot);
	}
	const predict = (yaw: number) => bot.physics.simulatePlayer({ control: {}, yaw, apply() {} }).yaw;
	return { stream, step, controller, applied, predict, installed: () => installed };
}

test("feedback latest-only frame is consumed once in a later actual simulation", async () => {
	const h = fixture();
	h.step();
	h.step();
	h.step();
	const frame = await h.stream.next(null, new AbortController().signal);
	expect(frame.step.sequence).toBe(3);
	let finished = false;
	const result = h.stream.apply(frame, { keys: { forward: true } }).then((r) => {
		finished = true;
		return r;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	h.step();
	expect((await result).appliedStep.sequence).toBe(4);
	expect(h.applied).toHaveLength(1);
	await expect(h.stream.apply(frame, { keys: {} })).rejects.toMatchObject({ code: "FRAME_STALE" });
	await h.stream.close();
	expect(h.installed()).toBeNull();
});

test("expiry before actual simulation rejects input without installing it", async () => {
	const h = fixture();
	h.step();
	const frame = await h.stream.next(null, new AbortController().signal);
	const result = h.stream.apply(frame, { keys: { forward: true } });
	const rejected = expect(result).rejects.toMatchObject({ code: "FRAME_EXPIRED" });
	await new Promise((r) => setTimeout(r, 270));
	h.step();
	await rejected;
	expect(h.applied).toHaveLength(0);
	await h.stream.close();
});

test("abort closes a pending next without guest cooperation", async () => {
	const h = fixture();
	const result = expect(h.stream.next(null, new AbortController().signal)).rejects.toMatchObject({
		code: "INTERRUPTED",
	});
	h.controller.abort();
	await result;
	expect(h.installed()).toBeNull();
});

test("new samples preserve a valid delivered frame, but next delivery retires the previous one", async () => {
	const h = fixture();
	h.step();
	const first = await h.stream.next(null, new AbortController().signal);
	h.step();
	h.step();
	const application = h.stream.apply(first, { keys: { forward: true } });
	h.step();
	await application;
	const next = await h.stream.next(first.sequence, new AbortController().signal);
	expect(next.sequence).toBe(4);
	await expect(h.stream.apply(first, { keys: {} })).rejects.toMatchObject({ code: "FRAME_STALE" });
	await h.stream.close();
});

test("installed continuous input expires even when physics stops", async () => {
	const h = fixture();
	h.step();
	const first = await h.stream.next(null, new AbortController().signal);
	const application = h.stream.apply(first, { keys: { forward: true } });
	h.step();
	await application;
	expect(h.installed()).not.toBeNull();
	await new Promise((r) => setTimeout(r, 280));
	expect(h.installed()).toBeNull();
	await h.stream.close();
});

test("pathfinder predictive simulations neither install feedback nor overwrite candidate yaw", async () => {
	const h = fixture();
	h.step();
	const frame = await h.stream.next(null, new AbortController().signal);
	const application = h.stream.apply(frame, { keys: { forward: true } });
	expect(h.predict(2)).toBe(2);
	expect(h.installed()).toBeNull();
	h.step();
	expect((await application).appliedStep.sequence).toBe(2);
	await h.stream.close();
	expect(h.predict(3)).toBe(3);
});
