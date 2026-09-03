import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI session recovery", () => {
	it("preserves ordered custom messages in the provider request from the real entry point", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-cli-session-"));
		roots.push(root);
		const home = join(root, "home");
		const cwd = join(root, "work");
		await mkdir(join(home, ".uina"), { recursive: true });
		await mkdir(join(cwd, "data"), { recursive: true });

		const requests: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
		const server = createServer((request, response) => {
			if (request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"data":[{"id":"audit-model"}]}');
				return;
			}
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				requests.push(JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> });
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end([
					'data: {"choices":[{"delta":{"content":"SESSION_ORDER_OK"}}]}',
					'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
					"data: [DONE]",
					"",
				].join("\n\n"));
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("测试 Provider 地址不可用");

		await writeFile(join(home, ".uina", "auth.json"), JSON.stringify({
			default: "audit",
			thinkingLevel: "off",
			providers: {
				audit: {
					type: "openai-compatible",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "local-test",
					model: "audit-model",
					modelContextWindow: 4096,
					thinkingLevels: ["off"],
				},
			},
		}), "utf8");

		const timestamp = new Date(0).toISOString();
		await writeFile(join(cwd, "data", "session.jsonl"), [
			JSON.stringify({ kind: "header", version: 2, id: "session", cwd, createdAt: timestamp }),
			JSON.stringify({ kind: "message", id: "1", seq: 1, timestamp, message: { role: "user", content: "ORDER_A" } }),
			JSON.stringify({ kind: "custom_message", id: "2", seq: 2, timestamp, customType: "probe", content: "ORDER_C" }),
			JSON.stringify({ kind: "message", id: "3", seq: 3, timestamp, message: { role: "assistant", content: "ORDER_B" } }),
			"",
		].join("\n"), "utf8");

		const child = spawn(
			process.execPath,
			[join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "main.ts")],
			{
				cwd,
				env: { ...process.env, UINA_HOME: home, UINA_ONESHOT_MSG: "ORDER_NEXT" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("SESSION_ORDER_OK");
		const orderedContent = requests[0]?.messages?.map((message) => message.content).filter((value): value is string => value !== undefined);
		expect(orderedContent).toEqual([
			expect.any(String),
			"ORDER_A",
			"ORDER_C",
			"ORDER_B",
			"ORDER_NEXT",
		]);
	});

	it("activates builtin runtime tools before a real one-shot tool loop", async () => {
		const root = await mkdtemp(join(tmpdir(), "uina-cli-tools-"));
		roots.push(root);
		const home = join(root, "home");
		const cwd = join(root, "work");
		await mkdir(join(home, ".uina"), { recursive: true });
		await mkdir(cwd, { recursive: true });

		let chatRequests = 0;
		const server = createServer((request, response) => {
			if (request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"data":[{"id":"audit-model"}]}');
				return;
			}
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			chatRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const events = chatRequests === 1
				? [
						'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"get_time","arguments":"{}"}}]}}]}',
						'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
						"data: [DONE]",
					]
				: [
						'data: {"choices":[{"delta":{"content":"RUNTIME_SCOPE_OK"}}]}',
						'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
						"data: [DONE]",
					];
			response.end(`${events.join("\n\n")}\n\n`);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("测试 Provider 地址不可用");

		await writeFile(join(home, ".uina", "auth.json"), JSON.stringify({
			default: "audit",
			thinkingLevel: "off",
			providers: {
				audit: {
					type: "openai-compatible",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "local-test",
					model: "audit-model",
					modelContextWindow: 4096,
					thinkingLevels: ["off"],
				},
			},
		}), "utf8");

		const child = spawn(
			process.execPath,
			[join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "main.ts")],
			{
				cwd,
				env: { ...process.env, UINA_HOME: home, UINA_ONESHOT_MSG: "调用时间工具" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

		expect(exitCode, stderr).toBe(0);
		expect(chatRequests).toBe(2);
		expect(stdout).toContain("RUNTIME_SCOPE_OK");
	});
});
