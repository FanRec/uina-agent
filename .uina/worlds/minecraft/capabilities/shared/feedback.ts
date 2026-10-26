/** Bind current query readers once; every frame samples one synchronous facts view. */
import type { BuiltCapabilities } from "../index.js";
import type { ClientFactsPort } from "../../contracts/client-facts.js";
import type { PrepareFeedback } from "../../contracts/body.js";
import type { Fact, JsonValue } from "../../contracts/values.js";
import { callFailure } from "../../contracts/values.js";

export function prepareFeedback(capabilities: BuiltCapabilities, facts: ClientFactsPort): PrepareFeedback {
	const fail = (message: string): never => {
		throw callFailure({
			code: "SENSOR_UNAVAILABLE",
			message,
			source: "world",
			dispatch: "not_sent",
			effects: [],
			recoverable: true,
		});
	};
	return (sensors) => {
		if (!sensors || typeof sensors !== "object" || Array.isArray(sensors)) fail("sensors must be a query map");
		const bound = Object.entries(sensors).map(([key, query]) => {
			if (!query || typeof query.ref !== "string") return fail(`invalid sensor ${key}`);
			const descriptor = capabilities.queries.find((q) => q.ref === query.ref);
			const reader = capabilities.readers.get(query.ref);
			if (!descriptor?.feedback || reader?.kind !== "current") return fail(`${query.ref} is not a feedback sensor`);
			const input = capabilities.validators.get(query.ref)!(query.input ?? {});
			return { key, read: reader.read, input };
		});
		return () =>
			facts.sample((view) => {
				const self = view.self();
				if (!self.value) return fail("self has not become observable");
				const values: Record<string, Fact<JsonValue>> = {};
				for (const { key, read, input } of bound) values[key] = read(view, input) as Fact<JsonValue>;
				return { self: { ...self, value: self.value }, sensors: values };
			}).value;
	};
}
