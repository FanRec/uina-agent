import { describe, expect, it, vi } from "vitest";
import { bodyInputName } from "../.uina/worlds/live2d/adapter/body-inputs.js";
import type { ModelProfile } from "../.uina/worlds/live2d/adapter/profile.js";
import { MotionDirector } from "../.uina/worlds/live2d/director/director.js";
import { compileAction, motion, keys, offset, absolute } from "../.uina/worlds/live2d/authoring/index.js";
import { createLive2DApp } from "../.uina/worlds/live2d/index.js";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import type { ModelRig } from "../.uina/worlds/live2d/adapter/rig.js";
import { VTSInputSetupError } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import type { ActionContext, ServiceCompanionContext } from "../src/extensions/world-framework/types.js";

const BODY_AXES = ["torso.yaw", "torso.pitch", "torso.roll"] as const;
const bodyNames = (modelID: string) => ({
	yaw: bodyInputName(modelID, "torso.yaw"),
	pitch: bodyInputName(modelID, "torso.pitch"),
	roll: bodyInputName(modelID, "torso.roll"),
});

describe("Live2D 躯干通道", () => {
	it("MO rig 将身体参数改成独立逻辑轴，并使用按模型隔离的输入名", async () => {
		const rig = await loadRig(MO_MODEL_ID);
		if (!rig) throw new Error("MO rig 未加载");
		const names = bodyNames(MO_MODEL_ID);
		expect(names).toEqual(bodyNames(MO_MODEL_ID));
		expect(new Set(Object.values(names)).size).toBe(3);
		expect(names.yaw).not.toBe(bodyInputName("another-model", "torso.yaw"));
		for (const name of Object.values(names)) expect(name).toMatch(/^[A-Za-z0-9]{4,32}$/);
		for (const axis of BODY_AXES) expect(rig.controls[axis]).toBeDefined();
		for (const [axis, parameter, name] of [
			["torso.yaw", "ParamBodyAngleX", names.yaw],
			["torso.pitch", "ParamBodyAngleY", names.pitch],
			["torso.roll", "ParamBodyAngleZ", names.roll],
		] as const) {
			expect(rig.bindings[axis]?.[0]).toMatchObject({ parameter, input: name, followers: [] });
		}
		expect(rig.bindings["head.yaw"]?.[0]?.followers).not.toContain("ParamBodyAngleX");
		expect(rig.bindings["head.pitch"]?.[0]?.followers).not.toContain("ParamBodyAngleY");
		expect(rig.bindings["head.roll"]?.[0]?.followers).not.toContain("ParamBodyAngleZ");
		expect(Object.keys(rig.controls).some((axis) => axis.startsWith("arm."))).toBe(false);
	});

	it("头部是躯干默认底动；动作可叠加偏移、独立覆盖，前景结束后恢复跟随", async () => {
		const rig = (await loadRig(MO_MODEL_ID)) as ModelRig;
		const director = new MotionDirector(rig.controls);
		const stepFor = (durationMs: number) => {
			for (let elapsed = 0; elapsed < durationMs; elapsed += 20) director.step(20);
		};
		const headOnly = compileAction(
			motion(4000, {
				"head.yaw": absolute(
					keys([
						[0, 5],
						[4000, 5],
					]),
				),
			}),
			rig.controls,
		);
		director.play(headOnly, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false, loop: true });
		stepFor(1400);
		expect(director.currentFrame["torso.yaw"]).toBeCloseTo(director.currentFrame["head.yaw"]!, 1);

		const pairClip = compileAction(
			motion(1200, {
				"head.yaw": absolute(
					keys([
						[0, -3],
						[1200, -3],
					]),
				),
				"torso.yaw": offset(
					keys([
						[0, 2],
						[1200, 2],
					]),
				),
			}),
			rig.controls,
		);
		director.play(pairClip, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false });
		stepFor(500);
		expect(director.currentFrame["torso.yaw"]! - director.currentFrame["head.yaw"]!).toBeCloseTo(2, 0);

		const bodyOnly = compileAction(
			motion(1200, {
				"torso.yaw": absolute(
					keys([
						[0, -7],
						[1200, -7],
					]),
				),
			}),
			rig.controls,
		);
		director.play(bodyOnly, { category: "voluntary", fadeInMs: 0, fadeOutMs: 0, atomic: false });
		stepFor(500);
		expect(director.currentFrame["torso.yaw"]!).toBeLessThan(director.currentFrame["head.yaw"]! - 1.5);
		expect(director.currentFrame["head.yaw"]).toBeCloseTo(-3, 0);
		stepFor(2000);
		expect(director.currentFrame["torso.yaw"]).toBeCloseTo(director.currentFrame["head.yaw"]!, 1);
	});

	it("prepare_body 可重复准备三项输入；detail 如实区分缺输入、错映射与就绪", async () => {
		const rig = (await loadRig(MO_MODEL_ID)) as ModelRig;
		const names = bodyNames(MO_MODEL_ID);
		const profile: ModelProfile = {
			modelID: MO_MODEL_ID,
			modelName: "MO",
			mappings: [],
			physicsOutputs: [],
			inputs: [],
			parameterRanges: {
				ParamBodyAngleX: { min: -10, max: 10, defaultValue: 0 },
				ParamBodyAngleY: { min: -10, max: 10, defaultValue: 0 },
				ParamBodyAngleZ: { min: -10, max: 10, defaultValue: 0 },
			},
		};
		const ensureInput = vi.fn(async (input: { name: string; min: number; max: number; defaultValue: number }) => {
			profile.inputs = [
				...(profile.inputs ?? []).filter((existing) => existing.name !== input.name),
				{ ...input, custom: true, addedBy: "Uina Live2D VTS" },
			];
		});
		const fakeClient = {
			isConnected: () => true,
			getModelProfile: () => profile,
			setConnectionChangeListener: () => {},
			connect: () => {},
			disconnect: () => {},
			injectParameters: () => {},
			ensureInput,
		} as unknown as VTSClient;
		const runtime = new Live2DRuntime({ rig, client: fakeClient });
		const app = createLive2DApp({ instance: runtime });
		await app.onStart!({ signal: new AbortController().signal } as ServiceCompanionContext);
		try {
			const context = { signal: new AbortController().signal } as ActionContext;
			const prepare = () => app.actions.prepare_body!.run({}, context) as Promise<{ status: string; result: string }>;
			const first = await prepare();
			const second = await prepare();
			expect(first.status).toBe("succeeded");
			expect(second.status).toBe("succeeded");
			expect(ensureInput).toHaveBeenCalledTimes(6);
			expect(ensureInput.mock.calls.slice(0, 3).map(([input]) => input.name)).toEqual([
				names.yaw,
				names.pitch,
				names.roll,
			]);
			expect(first.result).toContain("ParamBodyAngleX");

			const statusDetail = (await app.actions.status!.run({ detail: true }, context)) as { result: string };
			expect(JSON.parse(statusDetail.result).bodyMapping.ready).toBe(false);
			let detail = JSON.parse(await runtime.diagnose()) as {
				bodyMapping: { ready: boolean; axes: Record<string, { status: string }> };
			};
			expect(detail.bodyMapping.ready).toBe(false);
			expect(detail.bodyMapping.axes["torso.yaw"]?.status).toBe("unmapped");

			profile.inputs = profile.inputs!.filter((input) => input.name !== names.pitch);
			detail = JSON.parse(await runtime.diagnose());
			expect(detail.bodyMapping.axes["torso.pitch"]?.status).toBe("missing_input");

			profile.inputs = [
				{ name: names.yaw, min: -12, max: 12, defaultValue: 0, custom: true },
				{ name: names.pitch, min: -10, max: 10, defaultValue: 0, custom: true },
				{ name: names.roll, min: -10, max: 10, defaultValue: 0, custom: true },
			];
			profile.inputs = [{ ...profile.inputs[0]!, max: 10 }, profile.inputs[1]!, profile.inputs[2]!];
			detail = JSON.parse(await runtime.diagnose());
			expect(detail.bodyMapping.axes["torso.yaw"]?.status).toBe("input_range_mismatch");
			profile.inputs = [
				{ name: names.yaw, min: -12, max: 12, defaultValue: 0, custom: true },
				{ name: names.pitch, min: -10, max: 10, defaultValue: 0, custom: true },
				{ name: names.roll, min: -10, max: 10, defaultValue: 0, custom: true },
			];
			profile.mappings = [
				{ input: names.yaw, output: "ParamAngleX", inputMin: -12, inputMax: 12, outputMin: -30, outputMax: 30 },
			];
			detail = JSON.parse(await runtime.diagnose());
			expect(detail.bodyMapping.axes["torso.yaw"]?.status).toBe("wrong_output");

			profile.mappings = [
				{ input: names.yaw, output: "ParamBodyAngleX", inputMin: -12, inputMax: 12, outputMin: -10, outputMax: 10 },
				{ input: names.pitch, output: "ParamBodyAngleY", inputMin: -10, inputMax: 10, outputMin: -10, outputMax: 10 },
				{ input: names.roll, output: "ParamBodyAngleZ", inputMin: -10, inputMax: 10, outputMin: -10, outputMax: 10 },
			];
			detail = JSON.parse(await runtime.diagnose());
			expect(detail.bodyMapping.ready).toBe(true);
			expect(Object.values(detail.bodyMapping.axes).every((axis) => axis.status === "ready")).toBe(true);

			const cancellation = new AbortController();
			const ensureOnce = ensureInput.getMockImplementation()!;
			ensureInput.mockImplementationOnce(async (input) => {
				await ensureOnce(input);
				cancellation.abort();
			});
			const cancelled = (await app.actions.prepare_body!.run({}, { signal: cancellation.signal } as ActionContext)) as {
				status: string;
				details: Record<string, unknown>;
			};
			expect(cancelled.status).toBe("cancelled");
			expect(cancelled.details).toMatchObject({ effectStatus: "applied", confirmedInputs: [{ axis: "torso.yaw" }] });

			const cancelDuringLastInput = new AbortController();
			ensureInput.mockImplementation(async (input) => {
				await ensureOnce(input);
				if (input.name === names.roll) cancelDuringLastInput.abort();
			});
			const cancelledAtEnd = (await app.actions.prepare_body!.run({}, {
				signal: cancelDuringLastInput.signal,
			} as ActionContext)) as { status: string; details: Record<string, unknown> };
			expect(cancelledAtEnd.status).toBe("cancelled");
			expect(cancelledAtEnd.details).toMatchObject({
				effectStatus: "applied",
				confirmedInputs: [{ axis: "torso.yaw" }, { axis: "torso.pitch" }, { axis: "torso.roll" }],
			});

			const ensureNormally = ensureInput.getMockImplementation()!;
			ensureInput.mockImplementationOnce(ensureNormally);
			ensureInput.mockImplementationOnce(async () => {
				throw new VTSInputSetupError("input_conflict", "failed", "name already belongs to another input");
			});
			const conflict = (await app.actions.prepare_body!.run({}, context)) as {
				status: string;
				details: Record<string, unknown>;
			};
			expect(conflict.status).toBe("failed");
			expect(conflict.details).toMatchObject({
				reason: "input_conflict",
				effectStatus: "applied",
				confirmedInputs: [{ axis: "torso.yaw" }],
			});
		} finally {
			await runtime.stop();
		}
	});
});
