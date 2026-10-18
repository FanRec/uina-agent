import { describe, expect, it } from "vitest";
import { Live2DRuntime } from "../.uina/worlds/live2d/runtime.js";
import type { VTSClient } from "../.uina/worlds/live2d/adapter/vts-client.js";
import { loadRig, MO_MODEL_ID } from "../.uina/worlds/live2d/models/rig-loader.js";
import {
	DEFAULT_TIMING,
	resolveTiming,
	timingFromEnvironment,
	type TimingProfile,
} from "../.uina/worlds/live2d/timing.js";

describe("Live2D timing profile", () => {
	it("默认值与冻结：调用方改不动生效值", () => {
		const timing = resolveTiming();
		expect(timing).toEqual(DEFAULT_TIMING);
		expect(Object.isFrozen(timing)).toBe(true);
	});

	it("覆盖值合并到默认值之上，其余保持默认", () => {
		const timing = resolveTiming({ minUsefulMoveMs: 60, settleRetries: 0 });
		expect(timing.minUsefulMoveMs).toBe(60);
		expect(timing.settleRetries).toBe(0);
		expect(timing.settleMarginMs).toBe(DEFAULT_TIMING.settleMarginMs);
	});

	it("未知参数直接失败，并列出可用参数", () => {
		expect(() => resolveTiming({ minUsefulMove: 60 } as Partial<TimingProfile>)).toThrowError(
			/未知参数 "minUsefulMove"/,
		);
		expect(() => resolveTiming({ nope: 1 } as unknown as Partial<TimingProfile>)).toThrowError(/minUsefulMoveMs/);
	});

	it("非有限数与越界值失败：容差可以调，不能调成永不确认", () => {
		expect(() => resolveTiming({ settleRetries: Number.NaN })).toThrowError(/必须是有限数字/);
		expect(() => resolveTiming({ settleRetries: Number.POSITIVE_INFINITY })).toThrowError(/必须是有限数字/);
		expect(() => resolveTiming({ minUsefulMoveMs: -1 })).toThrowError(/超出/);
		expect(() => resolveTiming({ driveIntervalMs: 0 })).toThrowError(/超出/);
		expect(() => resolveTiming({ maxEndpointResidualDeg: 90 })).toThrowError(/超出/);
	});

	it("环境变量入口：空值不覆盖，坏 JSON 与数组直接失败且带原文", () => {
		expect(timingFromEnvironment(undefined)).toEqual({});
		expect(timingFromEnvironment("   ")).toEqual({});
		expect(timingFromEnvironment('{"minUsefulMoveMs":60}')).toEqual({ minUsefulMoveMs: 60 });
		expect(() => timingFromEnvironment("{oops")).toThrowError(/UINA_LIVE2D_TIMING 不是合法 JSON/);
		expect(() => timingFromEnvironment("[1,2]")).toThrowError(/必须是对象/);
		expect(() => timingFromEnvironment('"60"')).toThrowError(/必须是对象/);
	});

	it("运行时把生效的时序参数如实报给 status(detail=true)", async () => {
		const rig = (await loadRig(MO_MODEL_ID))!;
		const client = {
			isConnected: () => false,
			getModelProfile: () => ({
				modelID: rig.modelID,
				modelName: rig.modelID,
				mappings: [],
				physicsOutputs: [],
				inputs: [],
				parameterRanges: {},
			}),
			getModelGeneration: () => 0,
			getConnectionGeneration: () => 0,
			getInjectionStats: () => ({ generation: 0 }),
			setConnectionChangeListener: () => {},
			connect: () => {},
			disconnect: () => {},
			injectParameters: () => {},
		} as unknown as VTSClient;
		const runtime = new Live2DRuntime({ rig, client, timing: { minUsefulMoveMs: 60, driveIntervalMs: 8 } });
		const detail = JSON.parse(runtime.diagnose()) as { timing: TimingProfile };
		expect(detail.timing.minUsefulMoveMs).toBe(60);
		expect(detail.timing.driveIntervalMs).toBe(8);
		expect(detail.timing.settleRetryMs).toBe(DEFAULT_TIMING.settleRetryMs);
		expect(() => new Live2DRuntime({ rig, client, timing: { minUsefulMoveMs: -5 } })).toThrowError(/超出/);
	});
});
