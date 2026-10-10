import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileModelAdapter, type ModelAdapterDefinition } from "../.uina/worlds/live2d/model-adapter.js";
import {
	hashContent,
	loadModelProfile,
	profileFilesUnchanged,
	type ModelProfile,
} from "../.uina/worlds/live2d/model-profile.js";
import {
	applyPreparation,
	planModelPreparation,
	restorePreparation,
} from "../.uina/worlds/live2d/model-preparation.js";
import { compileMotion, motion, pose, sequence, parallel, track, sampleMotion } from "../.uina/worlds/live2d/motion.js";
import { MotionDirector } from "../.uina/worlds/live2d/motion-director.js";
import { independentModelFixture } from "./live2d-model-fixture.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const definition: ModelAdapterDefinition = {
	version: 1,
	axes: {
		"head.yaw": [
			{
				parameter: "OddHead",
				points: [
					[-30, -2],
					[0, 1],
					[30, 4],
				],
			},
		],
	},
};
const simple = (): ModelProfile => ({
	modelID: "fixture",
	modelName: "fixture",
	physicsOutputs: [],
	parameterRanges: { OddHead: { min: -2, max: 4, defaultValue: 1 } },
	inputs: [{ name: "HeadDrive", min: -1, max: 1, defaultValue: 0 }],
	mappings: [{ input: "HeadDrive", output: "OddHead", inputMin: -1, inputMax: 1, outputMin: -2, outputMax: 4 }],
});

describe("model adaptation through actual logical-frame interface", () => {
	it("arbitrary output IDs, asymmetric neutral and reversed bindings work without naming conventions", () => {
		const p = simple();
		p.mappings = [{ ...p.mappings[0]!, outputMin: 4, outputMax: -2 }];
		const program = compileModelAdapter(p, definition);
		expect(program.capabilities["head.yaw"]).toMatchObject({ available: true, calibration: "authored" });
		expect(program.encode({ "head.yaw": 15 }).values).toEqual([{ id: "HeadDrive", value: -0.5, weight: 1 }]);
		expect(program.encode({}).values[0]!.value).toBe(0);
		expect(() => program.encode({ "head.yaw": NaN })).toThrow("非有限");
	});
	it("does not grant capability from a parameter name, absent input, constant mapping, auto source or duplicate binding", () => {
		for (const mutate of [
			(p: ModelProfile) => {
				p.inputs = [];
			},
			(p: ModelProfile) => {
				p.parameterRanges = {};
			},
			(p: ModelProfile) => {
				p.mappings = [{ ...p.mappings[0]!, outputMax: -2 }];
			},
			(p: ModelProfile) => {
				p.mappings = [{ ...p.mappings[0]!, useBreathing: true }];
			},
			(p: ModelProfile) => {
				p.mappings = [...p.mappings, { ...p.mappings[0]!, input: "Microphone" }];
			},
		]) {
			const p = simple();
			mutate(p);
			const program = compileModelAdapter(p, definition);
			expect(program.capabilities["head.yaw"].available).toBe(false);
			expect(program.encode({ "head.yaw": 10 }).values).toEqual([]);
			expect(program.admit(compileMotion(pose(100, { "head.yaw": 10 }))).ok).toBe(false);
		}
	});
	it("reports shared inputs including unrecognized fanout, and never silently chooses head over torso", () => {
		const p = simple();
		p.mappings = [...p.mappings, { ...p.mappings[0]!, output: "DecorativeOutput" }];
		expect(compileModelAdapter(p, definition).capabilities["head.yaw"].reasons.join()).toContain("共用 HeadDrive");
		const allowed: ModelAdapterDefinition = {
			version: 1,
			axes: { "head.yaw": [{ ...definition.axes["head.yaw"]![0]!, allowFanout: true }] },
		};
		expect(compileModelAdapter(p, allowed).capabilities["head.yaw"].mode).toBe("coupled");
		expect(compileModelAdapter(p, allowed).controlGroups[0]).toEqual(expect.arrayContaining(["head", "torso", "gaze"]));
		p.parameterRanges = { ...p.parameterRanges, DecorativeOutput: { min: -2, max: 4, defaultValue: 1 } };
		allowed.axes["torso.yaw"] = [{ parameter: "DecorativeOutput", allowFanout: true }];
		const program = compileModelAdapter(p, allowed);
		expect(program.capabilities["head.yaw"].available).toBe(false);
		expect(program.capabilities["torso.yaw"].available).toBe(false);
	});
	it("rejects physics and active expressions as owners even when inputs are correctly bound", () => {
		const p = simple();
		p.physicsOutputs = ["OddHead"];
		expect(compileModelAdapter(p, definition).capabilities["head.yaw"].reasons).toContain("OddHead: 物理输出拥有");
		p.physicsOutputs = [];
		p.sources = [{ file: "add.exp3.json", kind: "expression", parameters: ["OddHead"] }];
		p.activeExpressions = ["add.exp3.json"];
		expect(compileModelAdapter(p, definition).capabilities["head.yaw"].available).toBe(false);
	});
	it("optional axis projection preserves sequence entry indices, duration and retained samples", () => {
		const p = independentModelFixture();
		p.adapterDefinition!.axes["face.blush"] = [];
		const optional = {
			...track("face.blush", [
				[0, 0],
				[100, 0.8],
			]),
			optional: true,
		};
		const compiled = compileMotion(
			sequence(
				parallel(motion(100, optional), pose(100, { "head.yaw": 15 })),
				parallel(motion(100, optional), pose(100, { "head.yaw": -10 })),
			),
		);
		const result = compileModelAdapter(p).admit(compiled);
		expect(result.ok).toBe(true);
		expect(result.omittedAxes).toEqual(["face.blush"]);
		expect(result.motion.durationMs).toBe(200);
		for (const time of [0, 50, 100, 140, 200])
			expect(sampleMotion(result.motion, time)["head.yaw"]).toBe(sampleMotion(compiled, time)["head.yaw"]);
		expect(compileModelAdapter(p).admit(compileMotion(pose(100, { "face.blush": 0.8 }))).ok).toBe(false);
	});
	it("control resources make linked logical channels conflict and atomic preemption cancels the whole lease", async () => {
		const d = new MotionDirector();
		d.setControlGroups([["head", "torso"]]);
		const head = await d.claim(["head", "gaze"], { atomic: true, priority: 30 });
		expect(head.channels).toContain("torso");
		await expect(d.claim(["torso"], { priority: 20 })).rejects.toThrow("locked");
		const replacement = await d.claim(["torso"], { priority: 50 });
		expect(head.signal.aborted).toBe(true);
		replacement.release();
	});
	it("supports one axis expressed by several separately bound parameters", () => {
		const p = simple();
		p.mappings = [...p.mappings, { ...p.mappings[0]!, input: "SecondDrive", output: "OddSecond" }];
		p.inputs = [...p.inputs!, { name: "SecondDrive", min: -1, max: 1, defaultValue: 0 }];
		p.parameterRanges = { ...p.parameterRanges, OddSecond: p.parameterRanges!.OddHead! };
		const program = compileModelAdapter(p, {
			version: 1,
			axes: {
				"head.yaw": [
					...definition.axes["head.yaw"]!,
					{
						parameter: "OddSecond",
						points: [
							[-30, 4],
							[0, 1],
							[30, -2],
						],
					},
				],
			},
		});
		expect(program.encode({ "head.yaw": 30 }).values.map((v) => v.value)).toEqual([1, -1]);
	});
});

async function diskFixture() {
	const root = await mkdtemp(join(tmpdir(), "uina-adapter-fixture-"));
	roots.push(root);
	const dir = join(root, "avatar");
	await mkdir(dir);
	const row = {
		Input: "HeadDrive",
		OutputLive2D: "OddHead",
		InputRangeLower: -1,
		InputRangeUpper: 1,
		OutputRangeLower: -2,
		OutputRangeUpper: 4,
		UseBreathing: false,
		UseBlinking: false,
		ClampInput: true,
		ClampOutput: true,
		Smoothing: 10,
		UnknownFlag: "preserve",
	};
	const config = {
		ModelID: "fixture",
		Name: "fixture",
		FileReferences: { Model: "m.model3.json" },
		PhysicsSettings: { Use: true },
		ParameterSettings: [
			row,
			{ ...row, Input: "", OutputLive2D: "Breathing", UseBreathing: true },
			{ ...row, OutputLive2D: "Constant", OutputRangeUpper: -2 },
		],
		FutureSetting: { opaque: 42 },
	};
	const physics = {
		Version: 3,
		Meta: {
			PhysicsSettingCount: 2,
			TotalInputCount: 2,
			TotalOutputCount: 3,
			VertexCount: 4,
			PhysicsDictionary: [
				{ Id: "conflict", Name: "mixed" },
				{ Id: "hair", Name: "hair" },
			],
		},
		PhysicsSettings: [
			{
				Id: "conflict",
				Input: [{ Source: { Id: "OddHead" }, Weight: 100 }],
				Output: [
					{ Destination: { Id: "OddHead" }, Weight: 100, Scale: 5 },
					{ Destination: { Id: "Cloth" }, Weight: 100, Scale: 2 },
				],
				Vertices: [{}, {}],
				FutureField: true,
			},
			{
				Id: "hair",
				Input: [{ Source: { Id: "OddHead" }, Weight: 100 }],
				Output: [{ Destination: { Id: "Hair" }, Weight: 100, Scale: 2 }],
				Vertices: [{}, {}],
			},
		],
	};
	await writeFile(join(dir, "m.vtube.json"), JSON.stringify(config));
	await writeFile(
		join(dir, "m.model3.json"),
		JSON.stringify({ FileReferences: { Physics: "m.physics3.json", Moc: "m.moc3" } }),
	);
	await writeFile(join(dir, "m.moc3"), "immutable model binary fixture");
	await writeFile(join(dir, "m.physics3.json"), JSON.stringify(physics));
	const profile = await loadModelProfile("fixture", root);
	profile.parameterRanges = simple().parameterRanges;
	profile.inputs = simple().inputs;
	return { root, dir, profile, config, physics };
}

describe("model facts and recoverable preparation", () => {
	it("preserves auto sources and constant rows, hashes model assets, rejects duplicate identities", async () => {
		const f = await diskFixture();
		expect(f.profile.mappings).toHaveLength(3);
		expect(f.profile.mappings[1]).toMatchObject({ input: "", useBreathing: true });
		expect(f.profile.physicsGroups?.[0]!.outputs).toHaveLength(2);
		expect(await profileFilesUnchanged(f.profile)).toBe(true);
		await writeFile(join(f.dir, "m.moc3"), "changed");
		expect(await profileFilesUnchanged(f.profile)).toBe(false);
		await mkdir(join(f.root, "duplicate"));
		await writeFile(join(f.root, "duplicate", "d.vtube.json"), JSON.stringify(f.config));
		await expect(loadModelProfile("fixture", f.root)).rejects.toThrow("ID 重复");
	});
	it("changes only selected outputs, preserves unknown fields and other physics, restores bytes exactly", async () => {
		const f = await diskFixture();
		const original = await readFile(join(f.dir, "m.vtube.json"));
		const plan = await planModelPreparation(f.profile, definition);
		expect(plan.inputs).toEqual([{ name: "UinaHeadYaw", min: -1, max: 1, defaultValue: 0 }]);
		const config = JSON.parse(plan.patches.find((p) => p.path.endsWith("vtube.json"))!.content);
		expect(config.FutureSetting).toEqual({ opaque: 42 });
		expect(config.ParameterSettings.at(-1).UnknownFlag).toBe("preserve");
		const physics = JSON.parse(plan.patches.find((p) => p.path.endsWith("physics3.json"))!.content);
		expect(physics.PhysicsSettings[0].Output.map((o: any) => o.Destination.Id)).toEqual(["Cloth"]);
		expect(physics.PhysicsSettings[1]).toEqual(f.physics.PhysicsSettings[1]);
		expect(physics.Meta.TotalOutputCount).toBe(2);
		const manifest = await applyPreparation(plan, join(f.root, "backup"), async () => {});
		const after = await loadModelProfile("fixture", f.root);
		after.parameterRanges = simple().parameterRanges;
		after.inputs = [{ name: "UinaHeadYaw", min: -1, max: 1, defaultValue: 0 }];
		expect(compileModelAdapter(after, plan.definition).capabilities["head.yaw"].available).toBe(true);
		expect((await planModelPreparation(after, plan.definition)).patches).toEqual([]);
		await restorePreparation(manifest, async () => {});
		expect(await readFile(join(f.dir, "m.vtube.json"))).toEqual(original);
		expect(hashContent(await readFile(join(f.dir, "m.moc3")))).toBe(
			f.profile.files?.find((f) => f.path.endsWith("moc3"))!.hash,
		);
	});
	it("rejects stale preparation and refuses restoration over later edits", async () => {
		const f = await diskFixture();
		const plan = await planModelPreparation(f.profile, definition);
		const manifest = await applyPreparation(plan, join(f.root, "backup"), async () => {});
		await expect(applyPreparation(plan, join(f.root, "backup2"), async () => {})).rejects.toThrow("补丁冲突");
		await writeFile(join(f.dir, "m.vtube.json"), "later edit");
		await expect(restorePreparation(manifest, async () => {})).rejects.toThrow("后续修改");
	});
	it("rolls back completed replacements if the offline guard fails mid-application", async () => {
		const f = await diskFixture();
		const plan = await planModelPreparation(f.profile, definition);
		let calls = 0;
		await expect(
			applyPreparation(plan, join(f.root, "backup"), async () => {
				if (++calls === 3) throw new Error("started");
			}),
		).rejects.toThrow("started");
		expect(await profileFilesUnchanged(f.profile)).toBe(true);
	});
	it("refuses unknown ranges, source collisions and guessed schema", async () => {
		const f = await diskFixture();
		f.profile.parameterRanges = undefined;
		await expect(planModelPreparation(f.profile, definition)).rejects.toThrow("范围尚未核验");
		f.profile.parameterRanges = simple().parameterRanges;
		f.profile.sources = [{ file: "x.exp3.json", kind: "expression", parameters: ["OddHead"] }];
		await expect(planModelPreparation(f.profile, definition)).rejects.toThrow("表情会写入");
	});
});
