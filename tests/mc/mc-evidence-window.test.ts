/**
 * Driver 证据窗口（awaitHurtEvidence / awaitEvidence）的三态语义回归：
 * hit=false / dead=false 只属于"窗口走完仍无观察"，null 只属于"窗口未走完"；
 * entityHurt/entityDead 只按 networkId 归属。真实受击包形状由真服场景验收。
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { entityT, makeBodyHarness, ownerT } from "./mc-fake-driver.js";

const ID = 42;

function harnessWithEvents() {
	const emitter = new EventEmitter();
	let attacks = 0;
	const harness = makeBodyHarness({
		on: emitter.on.bind(emitter),
		removeListener: emitter.removeListener.bind(emitter),
		attack: (): void => {
			attacks += 1;
		},
		entities: { [ID]: { id: ID, position: { x: 0, y: 64, z: 0 }, isValid: true, type: "hostile" } },
	});
	return { harness, emitter, attacks: () => attacks };
}

function hurtOf(emitter: EventEmitter, id: number): void {
	emitter.emit("entityHurt", { id });
}

function deadOf(emitter: EventEmitter, id: number): void {
	emitter.emit("entityDead", { id });
}

describe("attack 证据窗口三态", () => {
	test("窗口内观察到受击 → hit=true，窗口走完仍无死亡 → dead=false", async () => {
		const { harness, emitter } = harnessWithEvents();
		const session = await harness.port.acquire(ownerT(1), new AbortController().signal);
		const pending = session.attack(entityT());
		await new Promise((resolve) => setTimeout(resolve, 20));
		hurtOf(emitter, ID);
		const outcome = await pending;
		expect(outcome.hit).toBe(true);
		expect(outcome.dead).toBe(false);
	});

	test("观察到死亡 → 提前结算 hit=true/dead=true", async () => {
		const { harness, emitter } = harnessWithEvents();
		const session = await harness.port.acquire(ownerT(1), new AbortController().signal);
		const pending = session.attack(entityT(), { evidenceMs: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		deadOf(emitter, ID);
		const outcome = await pending;
		expect(outcome.hit).toBe(true);
		expect(outcome.dead).toBe(true);
	});

	test("窗口走完仍无观察 → hit=false/dead=false（不是 null）", async () => {
		const { harness } = harnessWithEvents();
		const session = await harness.port.acquire(ownerT(1), new AbortController().signal);
		const outcome = await session.attack(entityT(), { evidenceMs: 100 });
		expect(outcome.hit).toBe(false);
		expect(outcome.dead).toBe(false);
	});

	test("中止未走完 → null（不得宣称未命中）；已见证据照实保留", async () => {
		const { harness, emitter } = harnessWithEvents();
		const abort = new AbortController();
		const session = await harness.port.acquire(ownerT(1), abort.signal);
		const pending = session.attack(entityT(), { evidenceMs: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		abort.abort();
		const missed = await pending;
		expect(missed.hit).toBeNull();
		expect(missed.dead).toBeNull();
		await session.close();

		const seen = new AbortController();
		const session2 = await harness.port.acquire(ownerT(2), seen.signal);
		const pending2 = session2.attack(entityT(), { evidenceMs: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		hurtOf(emitter, ID);
		seen.abort();
		const partial = await pending2;
		expect(partial.hit).toBe(true);
		expect(partial.dead).toBeNull();
		await session2.close();
	});

	test("awaitEvidence 不派发攻击，只开证据窗口", async () => {
		const { harness, emitter, attacks } = harnessWithEvents();
		const session = await harness.port.acquire(ownerT(1), new AbortController().signal);
		const pending = session.awaitEvidence(entityT(), { evidenceMs: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		deadOf(emitter, ID);
		const outcome = await pending;
		expect(outcome).toEqual({ hit: true, dead: true });
		expect(attacks()).toBe(0);
	});
});
