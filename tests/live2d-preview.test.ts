import { describe, expect, it } from "vitest";
import { compileCatalog, type CatalogSource } from "../.uina/worlds/live2d/authoring/catalog.js";
import { keys, motion, offset } from "../.uina/worlds/live2d/authoring/index.js";
import { refactorRig } from "./live2d-refactor-fixture.js";
import { buildOfflinePreviewSnapshot, parsePreviewArguments } from "../scripts/mo-preview.mjs";

describe("Live2D author preview", () => {
	it("parses once, fixed-count repeat, offline sample, and catalog-list modes", () => {
		expect(parsePreviewArguments(["--seed", "42", "--once", "nod"])).toEqual({
			mode: "once",
			names: ["nod"],
			seed: 42,
		});
		expect(parsePreviewArguments(["--repeat", "3", "--seed", "7", "nod"])).toMatchObject({
			mode: "repeat",
			names: ["nod"],
			repeatCount: 3,
			seed: 7,
		});
		expect(parsePreviewArguments(["--sample", "nod", "25.5"])).toMatchObject({
			mode: "sample",
			names: ["nod"],
			actionMs: 25.5,
		});
		expect(parsePreviewArguments(["--list"])).toMatchObject({ mode: "list", names: [] });
	});

	it("rejects ambiguous modes, unsafe seeds, non-finite times, and invalid repeat counts", () => {
		expect(() => parsePreviewArguments(["--once", "--sample", "nod", "1"])).toThrow(/模式/);
		expect(() => parsePreviewArguments(["--seed", "4294967296", "nod"])).toThrow(/seed/);
		expect(() => parsePreviewArguments(["--repeat", "0", "nod"])).toThrow(/次数/);
		expect(() => parsePreviewArguments(["--sample", "nod", "Infinity"])).toThrow(/actionMs/);
	});

	it("offline sample uses seeded authoring and production Director without VTS side effects", () => {
		const rig = refactorRig();
		const body = motion(100, {
			"head.yaw": offset(
				keys([
					[0, 0],
					[100, 10],
				]),
			),
		});
		const source: CatalogSource = {
			motions: {
				probe: {
					description: "offline probe",
					motion: (rng) => ({
						...body(rng),
						speed: 2,
						spatial: [{ at: 40, effects: { tint: { r: 200, g: 210, b: 220 } } }],
					}),
				},
			},
		};
		const catalog = compileCatalog(rig.modelID, source, rig);

		const first = buildOfflinePreviewSnapshot(rig, catalog, "probe", 42, 50);
		const repeat = buildOfflinePreviewSnapshot(rig, catalog, "probe", 42, 50);
		expect(first).toEqual(repeat);
		expect(first).toMatchObject({
			mode: "offline-sample",
			seed: 42,
			action: "probe",
			requestedActionMs: 50,
			actionMs: 50,
			plan: {
				durationMs: 100,
				speed: 2,
				wallDurationMs: 50,
				spatial: [{ atMs: 40, effects: { tint: { r: 200, g: 210, b: 220 } } }],
			},
			actionTargets: [{ axis: "head.yaw", requested: 5, value: 5, clamped: false }],
			composition: {
				authoredTargets: [expect.objectContaining({ axis: "head.yaw", targetValue: 5 })],
				composedFrame: expect.objectContaining({ "head.yaw": expect.any(Number) }),
				contributions: [expect.objectContaining({ axes: ["head.yaw"] })],
			},
		});
	});

	it("reports an exact authored target and a bounded composition sample at the action endpoint", () => {
		const rig = refactorRig();
		const catalog = compileCatalog(
			rig.modelID,
			{
				motions: {
					probe: {
						description: "endpoint probe",
						motion: motion(100, {
							"head.yaw": offset(
								keys([
									[0, 0],
									[100, 10],
								]),
							),
						}),
					},
				},
			},
			rig,
		);
		const sample = buildOfflinePreviewSnapshot(rig, catalog, "probe", 9, 100);
		expect(sample.actionMs).toBe(100);
		expect(sample.actionTargets[0]?.requested).toBe(10);
		expect(sample.directorActionMs).toBeLessThan(100);
		expect(sample.composition?.authoredTargets[0]?.targetValue).toBeCloseTo(10, 3);
	});
});
