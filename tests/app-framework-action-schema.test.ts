/**
 * App Action 参数校验：ActionDef.parameters（JSON Schema）是结构契约的唯一权威，
 * 在 Facade Tool 调用运行时先过 Schema，再跑可选 validate（仅跨字段/业务语义）。
 * 断言：结构不合法则 handler 不被调用；结构合法 + 语义不合法 handler 也不被调用。
 */
import { describe, expect, it, vi } from "vitest";
import { createFacadeTool } from "../src/extensions/app-framework/facade-tool.js";
import type { AppDef, AppRuntime } from "../src/extensions/app-framework/types.js";

function runtimeFor(def: AppDef): AppRuntime {
	return { definition: def, enabled: true, surfaceTier: "hidden", lastActiveTurn: 0 };
}

function facade(def: AppDef) {
	return createFacadeTool(def, {
		getRuntime: () => runtimeFor(def),
		setTier: () => {},
	});
}

describe("App Framework: Action JSON Schema 校验", () => {
	it("结构合法：handler 被调用，结果 succeeded", async () => {
		const handler = vi.fn(async () => "相加成功");
		const tool = facade({
			name: "calc",
			description: "计算",
			actions: {
				add: {
					description: "相加",
					parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
					run: handler,
				},
			},
		});

		const res = await tool.run({ action: "add", params: { a: 1, b: 2 } });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(res.result).toBe("相加成功");
		expect(res.status).toBe("succeeded");
	});

	it("结构不合法：handler 不被调用，status failed + invalid_parameters", async () => {
		const handler = vi.fn(async () => "不应执行");
		const tool = facade({
			name: "calc",
			description: "计算",
			actions: {
				add: {
					description: "相加",
					parameters: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
					run: handler,
				},
			},
		});

		const res = await tool.run({ action: "add", params: {} });
		expect(handler).not.toHaveBeenCalled();
		expect(res.status).toBe("failed");
		expect((res.details as { error?: string }).error).toBe("invalid_parameters");
	});

	it("结构合法但语义校验失败：handler 不被调用", async () => {
		const handler = vi.fn(async () => "不应执行");
		const tool = facade({
			name: "timerange",
			description: "时间段",
			actions: {
				between: {
					description: "范围",
					parameters: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
					validate: (p) =>
						(p as { start: number; end: number }).start < (p as { start: number; end: number }).end
							? { valid: true }
							: { valid: false, error: "start 必须小于 end" },
					run: handler,
				},
			},
		});

		const res = await tool.run({ action: "between", params: { start: 5, end: 2 } });
		expect(handler).not.toHaveBeenCalled();
		expect(res.status).toBe("failed");
		expect((res.details as { error?: string }).error).toBe("invalid_parameters");
	});

	it("无 parameters 的动作：跳过结构校验，直接执行 handler", async () => {
		const handler = vi.fn(async () => "自由参数");
		const tool = facade({
			name: "loose",
			description: "宽松",
			actions: {
				ping: { description: "响应", run: handler },
			},
		});

		const res = await tool.run({ action: "ping", params: { anything: 1 } });
		expect(handler).toHaveBeenCalledTimes(1);
		expect(res.status).toBe("succeeded");
	});
});