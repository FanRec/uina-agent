/** Model-facing snapshot. The underlying fact and Program read contract stay intact. */
function fields(value: Record<string, unknown>, keys: readonly string[]) {
	return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function observationView(params: Record<string, unknown>, fact: unknown): unknown {
	if (params.detail === "full" || !record(fact)) return fact;
	const { selector, input } = params;
	if (selector !== "self@1" && selector !== "world@1" && selector !== "inventory@1") return fact;
	if (selector === "inventory@1" && record(input) && (input.since !== undefined || input.matching !== undefined))
		return fact;
	let value = fact.value;
	if (record(value)) {
		if (selector === "self@1") {
			const place = record(value.place) ? fields(value.place, ["dimension", "position"]) : value.place;
			value = {
				place,
				...fields(value, ["health", "maxHealth", "food", "onGround", "oxygen", "inWater", "inLava", "look"]),
				...(Array.isArray(value.effects) && value.effects.length ? { effects: value.effects } : {}),
			};
		} else if (selector === "world@1") {
			value = fields(value, ["dimension", "timeOfDay", "dayCount", "weather", "biome", "difficulty", "gameMode"]);
		} else {
			value = fields(value, ["counts", "freeSlots", "revision"]);
		}
	}
	const source = fact.source;
	return {
		value,
		...(fact.coverage !== "complete" ? { coverage: fact.coverage } : {}),
		...(Array.isArray(fact.unknown) && fact.unknown.length ? { unknown: fact.unknown } : {}),
		...(source && source !== "server" ? { source, observedAt: fact.observedAt } : {}),
	};
}
