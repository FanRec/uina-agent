import { randomInt } from "node:crypto";

export type RandomPurpose = "selection" | "performance" | "autonomic";

const MAX_SEED = 0xffff_ffff;
const UINT32_RANGE = 0x1_0000_0000;

function validateSeed(seed: number): void {
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED)
		throw new Error(`seed 必须是 uint32 整数: ${String(seed)}`);
}

/** Securely choose a root seed. All subsequent authoring streams are deterministic. */
export function createRootSeed(): number {
	return randomInt(0, UINT32_RANGE);
}

/** Mulberry32 stream with explicit uint32 seed; returns values in [0, 1). */
export function createSeededRandom(seed: number): () => number {
	validateSeed(seed);
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
	};
}

function deriveSeed(seed: number, purpose: RandomPurpose, actionName: string, playIndex: number): number {
	validateSeed(seed);
	if (purpose !== "selection" && purpose !== "performance" && purpose !== "autonomic")
		throw new Error(`未知 RNG purpose: ${String(purpose)}`);
	if (typeof actionName !== "string" || actionName.length === 0) throw new Error("actionName 必须是非空字符串");
	if (!Number.isSafeInteger(playIndex) || playIndex < 0)
		throw new Error(`playIndex 必须是非负安全整数: ${String(playIndex)}`);
	let hash = (0x811c9dc5 ^ seed) >>> 0;
	for (const character of `${purpose}\u0000${actionName}\u0000${playIndex}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x7feb352d) >>> 0;
	hash ^= hash >>> 15;
	hash = Math.imul(hash, 0x846ca68b) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/** Derive an independent stream from root seed, purpose, stable action name, and zero-based play index. */
export function deriveRandom(
	seed: number,
	purpose: RandomPurpose,
	actionName: string,
	playIndex: number,
): () => number {
	return createSeededRandom(deriveSeed(seed, purpose, actionName, playIndex));
}
