import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/extensions/index.js";
import { McpCatalog } from "../.uina/extensions/mcp/catalog.js";
import { createMcpProxyTool } from "../.uina/extensions/mcp/proxy-tool.js";
import { McpServerManager } from "../.uina/extensions/mcp/server-manager.js";
import { FakeMcpServer } from "./mcp-helpers.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const roots: string[] = [];
let manager: McpServerManager | undefined;

afterEach(async () => {
	await manager?.dispose();
	manager = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	delete process.env.UINA_HOME;
});

describe("screen MCP synthetic protocol roundtrip", () => {
	it("preserves partial observation text, PNG bytes, and structured facts", async () => {
		const home = mkdtempSync(join(tmpdir(), "uina-screen-roundtrip-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "uina-screen-roundtrip-cwd-"));
		roots.push(home, cwd);
		process.env.UINA_HOME = home;
		mkdirSync(join(home, ".uina"), { recursive: true });
		writeFileSync(join(home, ".uina", "mcp.json"), JSON.stringify({ mcpServers: { screen: { command: "fixture" } } }));

		const fake = new FakeMcpServer();
		fake.tools = [
			{ name: "ListTargets", description: "List displays without operating the desktop.", inputSchema: { type: "object" } },
			{ name: "Screenshot", description: "Capture a fast image without operating the desktop.", inputSchema: { type: "object" } },
			{ name: "Snapshot", description: "Inspect image and accessible semantics; page is not DOM.", inputSchema: { type: "object" } },
		];
		fake.callResult = {
			content: [
				{ type: "text", text: "Observation: PARTIAL\nSemantics: UNAVAILABLE" },
				{ type: "image", data: png, mimeType: "image/png" },
			],
			structuredContent: {
				kind: "snapshot", status: "partial", image: { status: "ok", source: "fixture" },
				semantics: { status: "unavailable", errors: [{ code: "semantic_unavailable" }] },
			},
		};
		const catalog = new McpCatalog(join(home, "mcp-catalog.json"));
		manager = new McpServerManager({
			catalog,
			version: "0.1.0",
			onError: () => undefined,
			createTransport: () => ({ transport: fake.clientTransport, kind: "in-memory" }),
		});
		const api = { cwd, reportError: () => undefined, ui: { hasUI: () => false, confirm: async () => true } } as unknown as ExtensionAPI;
		const tool = createMcpProxyTool({ api, catalog, manager, tmpDir: join(home, "mcp-out") });

		const listed = (await tool.run({ action: "list", server: "screen" })) as any;
		expect(listed.status).toBe("succeeded");
		const called = (await tool.run({ action: "call", tool: "screen.Snapshot", args: {} })) as any;
		expect(called.status).toBe("succeeded");
		expect(called.result).toContain("Observation: PARTIAL");
		expect(called.images?.[0].data).toBe(png);
		expect(called.details?.structuredContent?.semantics?.status).toBe("unavailable");
	});
});
