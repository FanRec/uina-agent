import { describe, expect, it } from "vitest";
import {
	createRootSeed,
	createSeededRandom,
	deriveRandom,
	type RandomPurpose,
} from "../.uina/worlds/live2d/authoring/random.js";

const take = (rng: () => number, count: number): number[] => Array.from({ length: count }, () => rng());

describe("Live2D deterministic random streams", () => {
	it("creates a uint32 root seed and bounded seeded samples", () => {
		const seed = createRootSeed();
		expect(Number.isSafeInteger(seed)).toBe(true);
		expect(seed).toBeGreaterThanOrEqual(0);
		expect(seed).toBeLessThanOrEqual(0xffff_ffff);
		const values = take(createSeededRandom(0), 1000);
		expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
	});

	it("replays the same seed, purpose, action name, and play index", () => {
		const first = deriveRandom(42, "performance", "double_take", 3);
		const replay = deriveRandom(42, "performance", "double_take", 3);
		expect(take(first, 12)).toEqual(take(replay, 12));
	});

	it("keeps selection, other actions, and autonomic draws independent of author draw count", () => {
		const selectionExpected = take(deriveRandom(123, "selection", "nod", 4), 5);
		const otherActionExpected = take(deriveRandom(123, "performance", "shake", 7), 5);
		const autonomicExpected = take(deriveRandom(123, "autonomic", "world", 0), 5);
		const noisyAuthor = deriveRandom(123, "performance", "nod", 4);
		take(noisyAuthor, 500);
		expect(take(deriveRandom(123, "selection", "nod", 4), 5)).toEqual(selectionExpected);
		expect(take(deriveRandom(123, "performance", "shake", 7), 5)).toEqual(otherActionExpected);
		expect(take(deriveRandom(123, "autonomic", "world", 0), 5)).toEqual(autonomicExpected);
	});

	it("derives distinct streams for distinct purposes, actions, and play indices", () => {
		const keys: readonly [RandomPurpose, string, number][] = [
			["selection", "nod", 0],
			["performance", "nod", 0],
			["performance", "shake", 0],
			["performance", "nod", 1],
		];
		const sequences = keys.map(([purpose, actionName, playIndex]) =>
			take(deriveRandom(44, purpose, actionName, playIndex), 4),
		);
		expect(new Set(sequences.map((sequence) => sequence.join(","))).size).toBe(sequences.length);
	});

	it("rejects invalid seeds, purposes, action names, and play indices", () => {
		for (const seed of [-1, 1.5, Number.NaN, 0x1_0000_0000]) expect(() => createSeededRandom(seed)).toThrow(/seed/);
		expect(() => deriveRandom(1, "other" as RandomPurpose, "nod", 0)).toThrow(/purpose/);
		expect(() => deriveRandom(1, "selection", "", 0)).toThrow(/actionName/);
		expect(() => deriveRandom(1, "selection", "nod", -1)).toThrow(/playIndex/);
		expect(() => deriveRandom(1, "selection", "nod", 0.5)).toThrow(/playIndex/);
	});
});
