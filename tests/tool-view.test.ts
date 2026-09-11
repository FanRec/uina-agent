import { describe, expect, it } from "vitest";
import { ToolBroker, type Tool, type ToolExecutionContext } from "../src/tools/broker.js";

function makeTool(
	name: string,
	runImpl?: (args: Record<string, unknown>, signal?: AbortSignal, context?: ToolExecutionContext) => Promise<string>,
	executionMode: "parallel" | "sequential" = "parallel",
): Tool {
	return {
		def: {
			type: "function",
			function: {
				name,
				description: `Tool ${name}`,
				parameters: {
					type: "object",
					properties: {
						arg: { type: "string" },
					},
					additionalProperties: false,
				},
			},
		},
		executionMode,
		run: async (args, signal, context) => {
			if (runImpl) {
				return { result: await runImpl(args, signal, context), status: "succeeded" };
			}
			return { result: `${name}:${String(args.arg ?? "")}`, status: "succeeded" };
		},
	};
}

describe("ScopedToolView", () => {
	it("delegates read and execution to parent broker without duplicating registrations", async () => {
		const root = new ToolBroker({ ownerId: "root" });
		root.register(makeTool("echo"));

		const view = root.createScopedView({ ownerId: "child-1" });

		expect(view.has("echo")).toBe(true);
		expect(view.names()).toEqual(["echo"]);
		expect(view.defs()).toHaveLength(1);
		expect(view.defs()[0].function.name).toBe("echo");

		// ScopedToolView is strictly read-only
		expect((view as unknown as Record<string, unknown>).register).toBeUndefined();
		expect((view as unknown as Record<string, unknown>).remove).toBeUndefined();
		expect((view as unknown as Record<string, unknown>).copyTo).toBeUndefined();

		const res = await view.run("echo", { arg: "hello" });
		expect(res).toBe("echo:hello");
	});

	it("dynamically reflects tools added to parent after view creation", async () => {
		const root = new ToolBroker();
		const view = root.createScopedView();

		expect(view.has("dynamic_tool")).toBe(false);
		expect(view.names()).toEqual([]);

		root.register(makeTool("dynamic_tool"));

		expect(view.has("dynamic_tool")).toBe(true);
		expect(view.names()).toEqual(["dynamic_tool"]);
		expect(view.defs()).toHaveLength(1);

		const res = await view.run("dynamic_tool", { arg: "works" });
		expect(res).toBe("dynamic_tool:works");
	});

	it("immediately reflects tool unregistration and rejects old prepared calls", async () => {
		const root = new ToolBroker();
		root.register(makeTool("transient_tool"));

		const view = root.createScopedView();

		// Prepare call while tool is still available
		const prepared = view.prepare("transient_tool", { arg: "valid" });
		expect(prepared.error).toBeUndefined();
		expect(prepared.tool).toBeDefined();

		// Unregister tool from parent
		root.remove("transient_tool");

		// Querying view shows it is gone
		expect(view.has("transient_tool")).toBe(false);
		expect(view.names()).not.toContain("transient_tool");

		// New prepare returns tool unavailable
		const prepAfter = view.prepare("transient_tool", { arg: "valid" });
		expect(prepAfter.error).toContain("已被卸载或不存在");

		// Executing with previously prepared call is explicitly rejected
		const execRes = await view.execute(prepared);
		expect(execRes.status).toBe("not_started");
		expect(execRes.result).toContain("工具不可用: transient_tool 已被卸载或不存在");
	});

	it("executes the updated tool implementation when parent replaces a tool", async () => {
		const root = new ToolBroker();
		root.register(makeTool("versioned", async () => "v1"));

		const view = root.createScopedView();
		expect(await view.run("versioned", {})).toBe("v1");

		// Replace with v2
		root.remove("versioned");
		root.register(makeTool("versioned", async () => "v2"));

		expect(await view.run("versioned", {})).toBe("v2");
	});

	it("passes scoped ownerId in execution context without altering tool definition", async () => {
		const root = new ToolBroker({ ownerId: "root" });
		let recordedOwnerId: string | undefined;

		root.register(
			makeTool("auth_check", async (_args, _sig, ctx) => {
				recordedOwnerId = ctx?.ownerId;
				return `owner:${ctx?.ownerId}`;
			}),
		);

		const childView = root.createScopedView({ ownerId: "subagent-99" });

		// Run through child view
		const childRes = await childView.run("auth_check", {});
		expect(childRes).toBe("owner:subagent-99");
		expect(recordedOwnerId).toBe("subagent-99");

		// Run through root broker directly preserves root ownerId
		const rootRes = await root.run("auth_check", {});
		expect(rootRes).toBe("owner:root");
		expect(recordedOwnerId).toBe("root");
	});

	it("enforces include and exclude filters dynamically", async () => {
		const root = new ToolBroker();
		root.register(makeTool("allowed_1"));
		root.register(makeTool("allowed_2"));
		root.register(makeTool("forbidden"));

		// Exclude filter
		const excludedView = root.createScopedView({ exclude: ["forbidden"] });
		expect(excludedView.has("allowed_1")).toBe(true);
		expect(excludedView.has("allowed_2")).toBe(true);
		expect(excludedView.has("forbidden")).toBe(false);
		expect(excludedView.names().sort()).toEqual(["allowed_1", "allowed_2"]);

		// Include filter
		const includedView = root.createScopedView({ include: ["allowed_1"] });
		expect(includedView.has("allowed_1")).toBe(true);
		expect(includedView.has("allowed_2")).toBe(false);
		expect(includedView.names()).toEqual(["allowed_1"]);

		// Prepare on excluded tool reports clear policy reason
		const prepExcluded = excludedView.prepare("forbidden", {});
		expect(prepExcluded.error).toContain("已被当前作用域策略排除");

		const execExcluded = await excludedView.execute({ name: "forbidden", args: {} });
		expect(execExcluded.status).toBe("not_started");
		expect(execExcluded.result).toContain("已被当前作用域策略排除");

		// Prepare on not included tool reports whitelist reason
		const prepNotIncluded = includedView.prepare("allowed_2", {});
		expect(prepNotIncluded.error).toContain("未包含在当前作用域允许名单中");

		const execNotIncluded = await includedView.execute({ name: "allowed_2", args: {} });
		expect(execNotIncluded.status).toBe("not_started");
		expect(execNotIncluded.result).toContain("未包含在当前作用域允许名单中");
	});

	it("shares parent Ajv schema validation without compiling duplicates", () => {
		const root = new ToolBroker();
		root.register(makeTool("strict_tool"));

		const view = root.createScopedView();

		// Invalid parameter type (arg must be string)
		const invalidPrep = view.prepare("strict_tool", { arg: 12345 });
		expect(invalidPrep.error).toBeDefined();
		expect(invalidPrep.error).toContain("参数校验失败");

		// Valid parameter
		const validPrep = view.prepare("strict_tool", { arg: "ok" });
		expect(validPrep.error).toBeUndefined();
	});

	it("executes through executePipeline seamlessly with hooks and observers", async () => {
		const root = new ToolBroker({ ownerId: "root" });
		root.register(makeTool("pipeline_echo"));

		const view = root.createScopedView({ ownerId: "pipeline-subagent" });
		const trace: string[] = [];

		const outcome = await view.executePipeline(
			{ callId: "pipe-1", name: "pipeline_echo", args: { arg: "pipe-val" } },
			{
				hooks: {
					beforeCall: async (input) => {
						trace.push(`before:${input.callId}`);
						return {};
					},
					transformResult: async (input) => {
						trace.push(`transform:${input.result}`);
						return { result: `TRANSFORMED(${input.result})` };
					},
				},
				observers: {
					onStart: (call) => {
						trace.push(`start:${call.callId}`);
					},
					onDone: (res) => {
						trace.push(`done:${res.result}`);
					},
				},
			},
		);

		expect(trace).toEqual([
			"before:pipe-1",
			"start:pipe-1",
			"transform:pipeline_echo:pipe-val",
			"done:TRANSFORMED(pipeline_echo:pipe-val)",
		]);
		expect(outcome.result).toBe("TRANSFORMED(pipeline_echo:pipe-val)");
		expect(outcome.status).toBe("succeeded");
	});

	it("delegates executionMode correctly", () => {
		const root = new ToolBroker();
		root.register(makeTool("parallel_tool", undefined, "parallel"));
		root.register(makeTool("seq_tool", undefined, "sequential"));

		const view = root.createScopedView();

		expect(view.getExecutionMode("parallel_tool")).toBe("parallel");
		expect(view.getExecutionMode("seq_tool")).toBe("sequential");
		expect(view.getExecutionMode("unknown")).toBe("parallel");
	});
});
