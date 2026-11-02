import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClientFactNotice, ClientFactView } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import type { CurrentReader, DigestPushOptions } from "../../.uina/worlds/minecraft/world/digest.js";
import { DIGEST_INTERVAL_MS, startDigestPush } from "../../.uina/worlds/minecraft/world/digest.js";

/**
 * G6 节流 digest 推送：前缘节流、内容哈希去重、reset 放行、段落降级。
 * facts 与读取器都用最小替身——digest 只消费 sample/subscribe 与 reader.read 的返回值。
 */

interface Rig {
	emitted: { observedAt: string; payload: JsonValue }[];
	change(): void;
	reset(): void;
	failSample(value: boolean): void;
	setWorld(value: Record<string, unknown>): void;
	failSelf(value: boolean): void;
	push(): ReturnType<typeof startDigestPush>;
}

function rig(): Rig {
	const listeners = new Set<(notice: ClientFactNotice) => void>();
	const emitted: Rig["emitted"] = [];
	const state = { failSample: false, failSelf: false };
	const worldValue: Record<string, unknown> = { timeOfDay: "day", dayCount: 3, weather: "clear", biome: "plains" };
	const reader = (value: unknown, unknown: string[] = []): CurrentReader => ({
		kind: "current",
		read: () => ({ value, observedAt: "t", source: "server", coverage: "complete", unknown, evidence: [] }),
	});
	const readers: DigestPushOptions["readers"] = {
		self: {
			kind: "current",
			read: () => {
				if (state.failSelf) throw new Error("boom");
				return {
					value: {
						place: { dimension: "overworld", position: { x: 10.4, y: 64.2, z: -3.7 } },
						health: 20,
						food: 20,
						onGround: true,
						held: { name: "oak_log", count: 8 },
					},
					observedAt: "t",
					source: "server",
					coverage: "complete",
					unknown: [],
					evidence: [],
				};
			},
		},
		inventory: reader({ revision: 4, counts: { oak_log: 8 }, usedSlots: 1, freeSlots: 35 }),
		world: {
			kind: "current",
			read: () => ({
				value: { ...worldValue },
				observedAt: "t",
				source: "server",
				coverage: "complete",
				unknown: [],
				evidence: [],
			}),
		},
	};
	const facts = {
		subscribe: (listener: (notice: ClientFactNotice) => void) => {
			listeners.add(listener);
			return { stamp: {}, evidenceThrough: {}, acknowledge: () => {}, close: () => listeners.delete(listener) };
		},
		sample: <T>(read: (view: ClientFactView) => T) => {
			if (state.failSample) throw Object.assign(new Error("not attached"), { code: "WRONG_STATE" });
			return { value: read({} as ClientFactView), stamp: {}, scope: {}, evidenceThrough: {} };
		},
	} as unknown as DigestPushOptions["facts"];
	const notify = (notice: Record<string, unknown>): void => {
		for (const listener of [...listeners]) listener(notice as unknown as ClientFactNotice);
	};
	return {
		emitted,
		change: () => notify({ kind: "changed" }),
		reset: () => notify({ kind: "reset", reason: "connection_changed" }),
		failSample: (value) => {
			state.failSample = value;
		},
		setWorld: (value) => {
			Object.assign(worldValue, value);
		},
		failSelf: (value) => {
			state.failSelf = value;
		},
		push: () => startDigestPush({ facts, readers, emit: (digest) => emitted.push(digest) }),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("digest push", () => {
	test("first change emits immediately with the three sections and integer position", () => {
		vi.useFakeTimers();
		const r = rig();
		const push = r.push();
		r.change();
		expect(r.emitted).toHaveLength(1);
		const payload = r.emitted[0]!.payload as Record<string, any>;
		expect(payload.kind).toBe("digest");
		expect(payload.self.dimension).toBe("overworld");
		expect(payload.self.position).toEqual({ x: 10, y: 64, z: -4 });
		expect(payload.self.held).toEqual({ name: "oak_log", count: 8 });
		expect(payload.inventory).toEqual({ revision: 4, counts: { oak_log: 8 }, usedSlots: 1, freeSlots: 35 });
		expect(payload.world).toEqual({ timeOfDay: "day", dayCount: 3, weather: "clear", biome: "plains" });
		expect(payload.unknown).toBeUndefined();
		push.close();
	});

	test("identical content never repeats; changes inside the window coalesce into one emit", () => {
		vi.useFakeTimers();
		const r = rig();
		const push = r.push();
		r.change();
		vi.advanceTimersByTime(5_000);
		r.change();
		r.setWorld({ timeOfDay: "night" });
		r.change();
		vi.advanceTimersByTime(4_000);
		expect(r.emitted).toHaveLength(1);
		vi.advanceTimersByTime(1_000);
		expect(r.emitted).toHaveLength(2);
		expect((r.emitted[1]!.payload as Record<string, any>).world.timeOfDay).toBe("night");
		push.close();
	});

	test("a facts reset re-allows the same content after the interval", () => {
		vi.useFakeTimers();
		const r = rig();
		const push = r.push();
		r.change();
		vi.advanceTimersByTime(DIGEST_INTERVAL_MS);
		r.reset();
		r.change();
		expect(r.emitted).toHaveLength(2);
		push.close();
	});

	test("a section reader failure degrades only that section", () => {
		vi.useFakeTimers();
		const r = rig();
		r.failSelf(true);
		const push = r.push();
		r.change();
		const payload = r.emitted[0]!.payload as Record<string, any>;
		expect(payload.self).toBeNull();
		expect(payload.inventory).not.toBeNull();
		expect(payload.unknown).toEqual(["self: boom"]);
		push.close();
	});

	test("sampling without an attached client emits nothing; recovery re-emits on the next change", () => {
		vi.useFakeTimers();
		const r = rig();
		const push = r.push();
		r.failSample(true);
		r.change();
		expect(r.emitted).toHaveLength(0);
		r.failSample(false);
		r.change();
		expect(r.emitted).toHaveLength(1);
		push.close();
	});

	test("close stops emission and detaches the subscription", () => {
		vi.useFakeTimers();
		const r = rig();
		const push = r.push();
		push.close();
		r.change();
		vi.advanceTimersByTime(DIGEST_INTERVAL_MS * 2);
		expect(r.emitted).toHaveLength(0);
	});
});
