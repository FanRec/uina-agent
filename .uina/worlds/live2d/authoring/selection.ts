/** Weighted choice excluding the two most recent indices, oldest exclusion relaxed first. */
export function chooseRecent(weights: readonly number[], recent: readonly number[], random: () => number): number {
	if (!weights.length || weights.some((w) => !Number.isFinite(w) || w <= 0))
		throw new Error("Performance pool requires positive finite weights");
	let excluded = recent.slice(-2);
	let candidates = weights.map((_, index) => index).filter((index) => !excluded.includes(index));
	while (!candidates.length) {
		excluded = excluded.slice(1);
		candidates = weights.map((_, index) => index).filter((index) => !excluded.includes(index));
	}
	let draw = random() * candidates.reduce((sum, index) => sum + weights[index]!, 0);
	for (const index of candidates) {
		draw -= weights[index]!;
		if (draw < 0) return index;
	}
	return candidates[candidates.length - 1]!;
}
