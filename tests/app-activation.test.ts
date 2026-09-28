import { describe, expect, it, vi } from "vitest";
import { AppActivation } from "../src/extensions/app-framework/app-activation.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import type { AppRuntime } from "../src/extensions/app-framework/types.js";
import type { Tool } from "../src/tools/broker.js";

describe("AppActivation", () => {
	it("owns tool and exposed resource cleanup", async () => {
		const tools = new Map<string, Tool>();
		const exposedChanges: number[] = [];
		const registerTool = vi.fn((tool: Tool) => { tools.set(tool.def.function.name, tool); return () => tools.delete(tool.def.function.name); });
		const pi = { registerTool, on: vi.fn(), cwd: "." } as unknown as ExtensionAPI;
		let disposeExpose: (() => void) | undefined;
		const runtime: AppRuntime = { definition: { name: "demo", description: "demo", onStart: (ctx) => { disposeExpose = ctx.expose?.("endpoint", { alive: true }); }, actions: { ping: { description: "ping", run: () => "pong" } } }, enabled: false, surfaceTier: "hidden", lastActiveTurn: 0 };
		const activation = new AppActivation(runtime.definition, {
			pi,
			runtime,
			setTier: (tier) => { runtime.surfaceTier = tier; },
			notifyExposed: () => exposedChanges.push(1),
		});
		await activation.start();
		expect(tools.has("demo")).toBe(true);
		expect(activation.scope.active).toBe(true);
		expect(activation.exposed.has("endpoint")).toBe(true);
		await activation.stop();
		expect(tools.has("demo")).toBe(false);
		expect(activation.scope.active).toBe(false);
		expect(activation.exposed.size).toBe(0);
		expect(exposedChanges.length).toBeGreaterThanOrEqual(1);
		disposeExpose?.();
	});
});
