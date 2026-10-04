import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpCatalog } from "../.uina/extensions/mcp/catalog.js";
import { createMcpProxyTool } from "../.uina/extensions/mcp/proxy-tool.js";
import { McpServerManager } from "../.uina/extensions/mcp/server-manager.js";
import type { ExtensionAPI } from "../src/extensions/index.js";

type Sample = { scenario: string; phase: "warm" | "cold"; status: string; durationMs: number; pngBytes?: number; error?: string };
type Args = Record<string, string | number | boolean | undefined>;

function args(): Args {
	const out: Args = {};
	for (let i = 2; i < process.argv.length; i++) {
		const token = process.argv[i]!;
		if (!token.startsWith("--")) {
			if (out["_command"] === undefined) out["_command"] = token;
			continue;
		}
		const key = token.slice(2);
		const value = process.argv[i + 1];
		if (value === undefined || value.startsWith("--")) out[key] = true;
		else out[key] = value;
	}
	return out;
}

function percentile(values: number[], q: number): number {
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * q) - 1))]!;
}

function summarize(samples: Sample[]): Record<string, unknown> {
	const scenarios: Record<string, Record<string, unknown>> = {};
	for (const scenario of new Set(samples.map((sample) => sample.scenario))) {
		const phases: Record<string, unknown> = {};
		for (const phase of ["warm", "cold"] as const) {
			const rows = samples.filter((sample) => sample.scenario === scenario && sample.phase === phase);
			if (rows.length === 0) continue;
			const successes = rows.filter((row) => row.status === "succeeded").map((row) => row.durationMs);
			phases[phase] = {
				samples: rows.length,
				failures: rows.length - successes.length,
				failureRate: (rows.length - successes.length) / rows.length,
				p50Ms: successes.length ? percentile(successes, 0.5) : null,
				p95Ms: successes.length ? percentile(successes, 0.95) : null,
			};
		}
		scenarios[scenario] = phases;
	}
	return { scenarios, sampleCount: samples.length, samples };
}

async function runScenario(python: string, scenario: string, phase: "warm" | "cold", count: number, maxDimension: string): Promise<Sample[]> {
	const root = mkdtempSync(join(tmpdir(), "uina-screen-measure-"));
	const previousHome = process.env.UINA_HOME;
	const previousCwd = process.cwd();
	const samples: Sample[] = [];
	try {
		process.env.UINA_HOME = root;
		const homeConfig = join(root, ".uina");
		mkdirSync(homeConfig, { recursive: true });
		writeFileSync(join(homeConfig, "mcp.json"), JSON.stringify({ mcpServers: { screen: { command: python, args: ["-m", "uina_screen_mcp"] } } }));
		const make = () => {
			const catalog = new McpCatalog(join(root, "mcp-catalog.json"));
			const manager = new McpServerManager({ catalog, version: "0.1.0", onError: () => undefined });
			const api = { cwd: previousCwd, reportError: () => undefined, ui: { hasUI: () => false, confirm: async () => true } } as unknown as ExtensionAPI;
			return { manager, tool: createMcpProxyTool({ api, catalog, manager, tmpDir: join(root, "out") }) };
		};
		let active = make();
		for (let index = 0; index < count; index++) {
			if (phase === "cold" && index > 0) {
				await active.manager.dispose();
				active = make();
			}
			const started = performance.now();
			try {
				await active.tool.run({ action: "list", server: "screen" });
				const result = await active.tool.run({ action: "call", tool: "screen.Screenshot", args: { maxDimension } }) as { status: string; images?: Array<{ data?: string }>; result?: string };
				samples.push({ scenario, phase, status: result.status, durationMs: performance.now() - started, pngBytes: result.images?.[0]?.data ? Buffer.from(result.images[0].data, "base64").length : 0, ...(result.status !== "succeeded" ? { error: result.result } : {}) });
			} catch (error) {
				samples.push({ scenario, phase, status: "failed", durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
			}
		}
		await active.manager.dispose();
	} finally {
		if (previousHome === undefined) delete process.env.UINA_HOME;
		else process.env.UINA_HOME = previousHome;
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	}
	return samples;
}

async function main(): Promise<void> {
	const parsed = args();
	const command = parsed["_command"] === "gate" || parsed["gate"] ? "gate" : "probe";
	if (command === "gate") {
		const report = JSON.parse(readFileSync(String(parsed["report"]), "utf-8")) as { scenarios?: Record<string, Record<string, { p50Ms: number | null; p95Ms: number | null; failureRate: number }> > };
		const criteria = JSON.parse(readFileSync(String(parsed["criteria"]), "utf-8")) as { approvedAt?: string; approvedBy?: string; environment?: unknown; defaultMaxDimension?: number; samples?: unknown; scenarios?: Record<string, Record<string, { p50Ms: number; p95Ms: number; maxFailureRate: number }>> };
		const errors: string[] = [];
		for (const key of ["approvedAt", "approvedBy", "environment", "defaultMaxDimension", "samples"]) if (!criteria[key as keyof typeof criteria]) errors.push(`missing criteria: ${key}`);
		for (const [scenario, phases] of Object.entries(criteria.scenarios ?? {})) for (const [phase, gate] of Object.entries(phases)) {
			const actual = report.scenarios?.[scenario]?.[phase];
			if (!actual || actual.p50Ms === null || actual.p95Ms === null) errors.push(`missing samples: ${scenario}/${phase}`);
			else {
				if (actual.p50Ms > gate.p50Ms) errors.push(`p50 exceeded: ${scenario}/${phase}`);
				if (actual.p95Ms > gate.p95Ms) errors.push(`p95 exceeded: ${scenario}/${phase}`);
				if (actual.failureRate > gate.maxFailureRate) errors.push(`failure rate exceeded: ${scenario}/${phase}`);
			}
		}
		const result = { passed: errors.length === 0, errors };
		console.log(JSON.stringify(result, null, 2));
		if (parsed["output"]) writeFileSync(String(parsed["output"]), JSON.stringify(result, null, 2) + "\n");
		if (errors.length) process.exitCode = 1;
		return;
	}
	const python = String(parsed["python"] ?? resolve(".uina/mcp-servers/screen-mcp/.venv/Scripts/python.exe"));
	const scenario = String(parsed["scenario"] ?? "desktop");
	const maxDimension = String(parsed["max-dimension"] ?? "1920");
	const samples = [
		...(await runScenario(python, scenario, "warm", Number(parsed["warm-samples"] ?? 30), maxDimension)),
		...(await runScenario(python, scenario, "cold", Number(parsed["cold-samples"] ?? 10), maxDimension)),
	];
	const report = summarize(samples);
	console.log(JSON.stringify(report, null, 2));
	if (parsed["output"]) writeFileSync(String(parsed["output"]), JSON.stringify(report, null, 2) + "\n");
}

await main();
