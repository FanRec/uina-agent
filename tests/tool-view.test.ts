import { describe, expect, it } from "vitest";
import { ToolBroker, type Tool, type ToolExecutionContext } from "../src/tools/broker.js";
import { formatToolCardLines } from "../src/ui/components/transcript/tool-view.js";

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
			// 阶段 D/M7：onDone（journal 权威）拿原始正文；改写只作用于返回值投影。
			"done:pipeline_echo:pipe-val",
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

describe("hover 行数一致性（反抖动）", () => {
	const LONG = "npx vitest run tests/ui.test.ts -t \"很长的测试名用来撑爆单行宽度让标题必然超过卡片宽度产生软换行\" 2>&1 | Select-String -Pattern \"Tests\" | Select-Object -First 3";
	const args = { command: LONG };
	const base = { name: "run_command", result: "", elapsed: 0, width: 90, status: "succeeded" as const, params: args };

	it("hover 与非 hover 行数一致，且不产生 … 截断", () => {
		const plain = formatToolCardLines(base.name, base.result, base.elapsed, base.width, base.status, base.params, { isExpanded: true });
		const hovered = formatToolCardLines(base.name, base.result, base.elapsed, base.width, base.status, base.params, { isExpanded: true, isHovered: true });
		expect(hovered.length).toBe(plain.length);
		// hover 态不应把软换行内容截成 …
		expect(hovered.some((l) => l.includes("First 3"))).toBe(true);
	});

	it("运行中 hover 同样行数一致", () => {
		const plain = formatToolCardLines(base.name, "", 0, base.width, "running", base.params, { startedAt: Date.now() - 5000 });
		const hovered = formatToolCardLines(base.name, "", 0, base.width, "running", base.params, { isHovered: true, startedAt: Date.now() - 5000 });
		expect(hovered.length).toBe(plain.length);
	});
	it("标题行满宽时 hover 仍行数恒等（指示符画在底色 padding，不撑行）", () => {
		// 回归背景：折叠态标题行可视宽度恰好顶满卡片宽时，旧实现把 ▴/▾
		// 拼进行内容 → hover 态软换行多出一行 → 视口锚定被误触发，整帧错位。
		const statusLine = `\x1b[2mTest Files\x1b[22m \x1b[31m1 failed\x1b[22m \x1b[32m42 passed\x1b[22m`;
		const result = JSON.stringify({ stdout: statusLine, code: 0 });
		// 逐渐缩短参数扫过满宽边界，确保命中「恰好 110/108/106…列」的临界样本
		const cmd = "cd E:\\Uina\\Uina; npx vitest run 2>&1 | Select-String -Pattern 'FAIL|x' | Select-Object -First 5";
		for (let cut = 0; cut <= 8; cut++) {
			const argsText = cmd.slice(0, cmd.length - cut);
			const plain = formatToolCardLines("Exec", result, 8900, 110, "succeeded", argsText, { isExpanded: false });
			const hovered = formatToolCardLines("Exec", result, 8900, 110, "succeeded", argsText, { isExpanded: false, isHovered: true });
			expect(hovered.length).toBe(plain.length);
		}
	});

	it("hover 底色逐列连续：badge 与行尾 padding 均不漏默认背景", () => {
		// 回归背景：badge 自带 SGR reset 会把底色抹掉，其后的 padding 漏成
		// 默认背景洞（用户截图：Tests 行中部一段没高亮）。锁定不变量：
		// hover 态每行从首列到末列底色状态机始终开启。
		const scanHoles = (row: string): number => {
			let bgOn = false, holes = 0;
			const re = /\x1b\[[0-9;]*m|[\s\S]/gu;
			let m: RegExpExecArray | null;
			while ((m = re.exec(row))) {
				const tok = m[0];
				if (tok.startsWith("\x1b[")) {
					if (tok === "\x1b[0m" || tok === "\x1b[m" || tok === "\x1b[49m") bgOn = false;
					else if (/^\x1b\[48/.test(tok)) bgOn = true;
					continue;
				}
				if (!bgOn) holes++;
			}
			return holes;
		};
		// 正文含内嵌 SGR（dim/红/绿 + 行尾 dim 收尾）——vitest 真实形态
		const stdout = `\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[90m (1)\x1b[39m`;
		const result = JSON.stringify({ stdout, code: 1 });
		const lines = formatToolCardLines("Exec", result, 100, 110, "succeeded", "npx vitest run", { isHovered: true });
		for (const line of lines) {
			expect(scanHoles(line)).toBe(0);
		}
	});
});

describe("工具输出的颜色与危险序列", () => {
	const renderBody = (stdout: string): string =>
		formatToolCardLines("exec_command", JSON.stringify({ code: 0, stdout }), 30, 168, "succeeded", { command: "echo x" }, {})
			.join("\n");

	it("保留 SGR 颜色：绿色的 3 passed 必须还在", () => {
		const out = renderBody("\u001b[2mTest Files\u001b[22m \u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m\u001b[90m (3)\u001b[39m\r\n");
		expect(out).toContain("\u001b[32m");
		expect(out).toContain("3 passed");
		expect(out).not.toContain("\r");
	});

	it("剥掉会驱动光标的序列与裸控制符（保留颜色、剔除危险转义）", () => {
		const out = renderBody("前\u001b[2J中\u001b[H后\u001b[K尾\u001b(B集\u001b孤");
		expect(out).toContain("前");
		expect(out).toContain("中");
		expect(out).toContain("后");
		expect(out).not.toContain("\u001b[2J");
		expect(out).not.toContain("\u001b[H");
		expect(out).not.toContain("\u001b(B");
		expect(out).not.toContain("(B");
		// 卡片自身的样式也是 SGR：因此"每个 ESC 都必须开启一个 SGR"是精确判据
		//（任何非 SGR 转义、裸 ESC、OSC/APC 都会让这个差不为 0）
		const escCount = (out.match(/\u001b/g) ?? []).length;
		const sgrCount = (out.match(/\u001b\[[0-9;]*m/g) ?? []).length;
		expect(escCount - sgrCount, "存在非 SGR 的 ESC 序列").toBe(0);
	});
});
