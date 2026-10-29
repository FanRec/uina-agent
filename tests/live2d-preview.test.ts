import { describe, expect, it, vi } from "vitest";
import { type CatalogSource, compileCatalog } from "../.uina/worlds/live2d/authoring/catalog.js";
import { keys, motion, offset } from "../.uina/worlds/live2d/authoring/index.js";
import { loadCatalog } from "../.uina/worlds/live2d/models/mo/catalog.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import {
	buildOfflinePreviewSnapshot,
	mixedScenarioSchedule,
	parsePreviewArguments,
	runPerformanceScenario,
} from "../scripts/mo-preview.mjs";
import { refactorRig } from "./live2d-refactor-fixture.js";

describe("Live2D author preview", () => {
	it("runs the complete mixed scene without clamps and exercises actual in-flight cancellation", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runPerformanceScenario(rig, loadCatalog(MO_MODEL_ID, rig)!, "mixed", 42, true);
			const rows = output.mock.calls.map(([line]) => String(line));
			const frames = rows.filter((s) => s.startsWith("[场景帧]")).map((s) => JSON.parse(s.slice(s.indexOf("{"))));
			expect(frames.length).toBeGreaterThan(100);
			expect(frames.flatMap((f) => f.clampHits)).toEqual([]);
			expect(rows.some((s) => s.includes("nod CANCELLED: turn_aborted"))).toBe(true);
			expect(rows.some((s) => s.includes("closed_eyes OK"))).toBe(true);
		} finally {
			output.mockRestore();
		}
	});
	it("interrupts an in-flight gesture and includes explicit expression changes", () => {
		const events = mixedScenarioSchedule();
		expect(events.find((e) => e.type === "motion")?.atMs).toBe(8000);
		expect(events.find((e) => e.type === "interrupt")?.atMs).toBe(8700);
		expect(events.filter((e) => e.type === "expression").map((e) => e.name)).toEqual([
			"closed_eyes",
			"neutral_expression",
		]);
	});
	it("parses reproducible performance scenarios and rejects invalid combinations", () => {
		expect(parsePreviewArguments(["--scenario", "speech", "--offline"])).toMatchObject({
			mode: "scenario",
			names: ["speech"],
			seed: 42,
			offline: true,
		});
		expect(() => parsePreviewArguments(["--scenario", "unknown"])).toThrow(/场景/);
		expect(() => parsePreviewArguments(["--offline", "--once", "nod"])).toThrow(/scenario/);
	});
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

	it("supports background idle and thinking offline sample preview", () => {
		const rig = refactorRig();
		const catalog = compileCatalog(
			rig.modelID,
			{
				background: {
					idle: motion(500, {
						"head.yaw": offset(
							keys([
								[0, 0],
								[500, 2],
							]),
						),
					}),
					thinking: motion(300, {
						"head.yaw": offset(
							keys([
								[0, 0],
								[300, 4],
							]),
						),
					}),
				},
			},
			rig,
		);

		const idleSample = buildOfflinePreviewSnapshot(rig, catalog, "idle", 1, 250);
		expect(idleSample.action).toBe("idle");
		expect(idleSample.plan.durationMs).toBe(500);
		expect(idleSample.actionTargets[0]?.axis).toBe("head.yaw");
		expect(idleSample.actionTargets[0]?.requested).toBeCloseTo(1, 1);

		const thinkingSample = buildOfflinePreviewSnapshot(rig, catalog, "thinking", 1, 150);
		expect(thinkingSample.action).toBe("thinking");
		expect(thinkingSample.plan.durationMs).toBe(300);
		expect(thinkingSample.actionTargets[0]?.axis).toBe("head.yaw");
		expect(thinkingSample.actionTargets[0]?.requested).toBeCloseTo(2, 1);
	});
});
