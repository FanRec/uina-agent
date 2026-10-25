import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildCapabilities } from "../../.uina/worlds/minecraft/capabilities/index.js";
import type { ClientFactsPort } from "../../.uina/worlds/minecraft/contracts/client-facts.js";
import type { ExactRef, JsonValue } from "../../.uina/worlds/minecraft/contracts/values.js";
import { MinecraftWorld } from "../../.uina/worlds/minecraft/world/index.js";

const capabilities = buildCapabilities({
	knowledge: () => null,
	gotoDirector: {} as never,
	runtime: () => {
		throw new Error("unused runtime");
	},
});

describe("query descriptor validation at the World boundary", () => {
	test("rejects malformed current/static/history input before sampling or storage", async () => {
		let samples = 0;
		const stamp = { source: "facts:test", epoch: "ep:test", sequence: 0, connection: null, incarnation: null };
		const facts = {
			sample: () => {
				samples++;
				throw new Error("invalid input reached current sampling");
			},
			subscribe: () => ({ stamp, evidenceThrough: { stream: "evs:test", sequence: 0 }, acknowledge() {}, close() {} }),
		} as ClientFactsPort;
		const dir = mkdtempSync(join(tmpdir(), "uina-query-validation-"));
		const world = new MinecraftWorld({
			facts,
			readers: capabilities.readers,
			validators: capabilities.validators,
			queries: capabilities.queries,
			dbPath: join(dir, "history.db"),
			binding: { binding: "b", world: "w", worldRevision: "r" },
			namespace: "query-validation",
		});
		try {
			for (const [ref, input] of [
				["self@1", { extra: true }],
				["block@1", {}],
				["block@1", { at: { x: 0.4, y: 64, z: 0 } }],
				["blocks@1", { name: "stone", radius: 500 }],
				["item@1", {}],
				["item@1", { name: "stone", extra: true }],
				["events@1", { kinds: [] }],
				["events@1", { limit: 201 }],
				["events@1", { cursor: "x", after: "y" }],
				["container.last@1", { at: { x: 0.2, y: 64, z: 0 } }],
				["container.last@1", { at: { x: 0, y: 64, z: 0 }, extra: true }],
			] as [ExactRef, JsonValue][]) {
				await expect(world.read({ ref, input })).rejects.toMatchObject({
					code: "INVALID_INPUT",
					source: "input",
					dispatch: "not_sent",
				});
			}
			expect(samples).toBe(0);
		} finally {
			await world.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("normalizes null to an empty query", () => {
		const validators = capabilities.validators;
		expect(validators.get("self@1")!(null)).toEqual({});
		expect(validators.get("events@1")!(null)).toEqual({});
		expect(() => validators.get("item@1")!(null)).toThrowError();
	});

	test("missing schema validation fails during assembly, before subscribing or opening history", () => {
		expect(
			() =>
				new MinecraftWorld({
					facts: {
						subscribe() {
							throw new Error("must fail before subscribing");
						},
					} as unknown as ClientFactsPort,
					readers: capabilities.readers,
					validators: new Map(),
					queries: capabilities.queries,
					dbPath: "unused.db",
					binding: { binding: "b", world: "w", worldRevision: "r" },
					namespace: "missing-validator",
				}),
		).toThrow(/query validator is missing/);
	});
});
