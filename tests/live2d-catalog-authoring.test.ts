import { describe, expect, it } from "vitest";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { motion } from "../.uina/worlds/live2d/authoring/action.js";
import { type CatalogSource, compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { absolute, keys, timeline } from "../.uina/worlds/live2d/authoring/curves.js";

const MODEL_ID = "catalog-action-fixture";
const RIG = {
	version: 3,
	modelID: MODEL_ID,
	controls: { "head.yaw": { min: -12, max: 12, neutral: 0 } },
	bindings: {},
	external: { blink: "vts", breath: "vts" },
} as unknown as ModelRig;

describe("Catalog ActionAuthoring", () => {
	it("validates but does not replace the authoring factory with a compiled clip", () => {
		let bakeCalls = 0;
		let randomDraws = 0;
		const action = (rng: () => number) => {
			bakeCalls++;
			const value = rng();
			randomDraws++;
			return {
				timeline: timeline(100),
				channels: { "head.yaw": absolute(() => value) },
			};
		};
		const source: CatalogSource = { motions: { greeting: { description: "greeting", motion: action } } };
		const catalog = compileCatalog(MODEL_ID, source, RIG);
		expect(bakeCalls).toBe(1);
		expect(randomDraws).toBe(1);
		expect(catalog.resolve("motion", "greeting")?.entry.definition).toBe(action);
		expect(catalog.list("motion")).toHaveLength(1);
	});

	it("uses the ActionPlan spatial events for binding-time validation", () => {
		const source: CatalogSource = {
			motions: {
				invalid: {
					description: "invalid",
					motion: () => ({
						timeline: timeline(100),
						channels: { "head.yaw": absolute((t) => t / 100) },
						spatial: [{ at: 100, effects: { tint: { r: 255, g: 255, b: 255 } } }],
					}),
				},
			},
		};
		expect(() => compileCatalog(MODEL_ID, source, RIG)).toThrow(/marker/);
	});

	it("keeps variant authoring factories and validates each during catalog compilation", () => {
		let calls = 0;
		const author = () => {
			calls++;
			return motion(100, {
				"head.yaw": absolute(
					keys([
						[0, 0],
						[100, 1],
					]),
				),
			})(() => 0.5);
		};
		const source: CatalogSource = {
			motions: { nod: { description: "nod", motion: author, variants: [author] } },
		};
		const catalog = compileCatalog(MODEL_ID, source, RIG);
		expect(calls).toBe(2);
		expect(catalog.resolve("motion", "nod")?.entry.variants).toEqual([author]);
	});
});
