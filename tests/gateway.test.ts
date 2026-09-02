/**
 * gateway 单测：用本地假 HTTP 服务喂 OpenAI 格式 SSE，验证流式解析正确。
 * 覆盖：文本分片顺序、tool_call 分片拼接（arguments/name 跨块）、finish_reason 收口。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import type { StreamDelta } from "../src/core/types.js";

const servers: Server[] = [];
afterEach(() => {
	servers.splice(0).forEach((s) => s.close());
});

/** 起一个假 OpenAI 端点，返回给定 SSE body */
function fakeEndpoint(body: string): string {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(body);
	});
	servers.push(server);
	server.listen(0);
	const port = (server.address() as AddressInfo).port;
	return `http://127.0.0.1:${port}/v1`;
}

async function collect(baseUrl: string): Promise<StreamDelta[]> {
	const provider = createOpenAIProvider({
		baseUrl,
		apiKey: "test",
		model: "m",
	});
	const out: StreamDelta[] = [];
	await provider.stream({ messages: [{ role: "user", content: "hi" }] }, (d) =>
		out.push(d),
	);
	return out;
}

/** 起一个假端点，捕获请求体供断言（验证发送方向 wire 形状） */
async function captureReq(messages: unknown[]): Promise<unknown> {
	let captured: unknown;
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			try {
				captured = JSON.parse(raw);
			} catch (e) {
				captured = { parseError: (e as Error).message, raw };
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end("data: [DONE]\n\n");
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	const provider = createOpenAIProvider({
		baseUrl: base,
		apiKey: "test",
		model: "m",
	});
	await provider.stream({ messages: messages as never }, () => {});
	await new Promise((r) => setTimeout(r, 20));
	return captured;
}

describe("gateway SSE 解析", () => {
	it("文本分片按序输出，finish 收口", async () => {
		const base = fakeEndpoint(
			[
				`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, index: 0 }] })}`,
				``,
				`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" }, index: 0 }] })}`,
				``,
				`data: ${JSON.stringify({ choices: [{ delta: { content: "世界" }, index: 0 }] })}`,
				``,
				`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] })}`,
				`data: [DONE]`,
			].join("\n"),
		);
		const out = await collect(base);
		const texts = out
			.filter((d) => d.kind === "text")
			.map((d) => (d as any).text);
		expect(texts).toEqual(["你好", "世界"]);
		expect(out.some((d) => d.kind === "finish")).toBe(true);
	});

	it("tool_call 跨分片拼接 arguments 与 name", async () => {
		const base = fakeEndpoint(
			[
				`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "get_", arguments: '{"a":' } }] }, index: 0 }] })}`,
				``,
				`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "time", arguments: "1}" } }] }, index: 0 }] })}`,
				``,
				`data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }] })}`,
				`data: [DONE]`,
			].join("\n"),
		);
		const out = await collect(base);
		const calls = out.filter((d) => d.kind === "tool_call");
		expect(calls.length).toBe(1);
		const call = calls[0];
		if (call.kind !== "tool_call") throw new Error("unreachable");
		expect(call.call.name).toBe("get_time");
		let parsedArgs: unknown;
		try {
			parsedArgs = JSON.parse(call.call.args);
		} catch (e) {
			throw new Error(
				`arguments 不是合法 JSON: ${call.call.args} (${(e as Error).message})`,
			);
		}
		expect(parsedArgs).toEqual({ a: 1 });
		expect(out.some((d) => d.kind === "finish")).toBe(true);
	});

	it("发送方向：assistant.tool_calls 转成协议形状（type/function/字符串 arguments）", async () => {
		const body = await captureReq([
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "t1", name: "run_shell", args: { command: "echo x" } },
				],
			},
			{
				role: "tool",
				tool_call_id: "t1",
				content: '{"stdout":"x"}',
			},
		]);
		const b = body as {
			messages: {
				role: string;
				tool_calls?: {
					type?: string;
					function?: { name?: string; arguments?: unknown };
				}[];
			}[];
		};
		const asst = b.messages.find((m) => m.role === "assistant");
		expect(asst?.tool_calls?.[0]).toEqual({
			id: "t1",
			type: "function",
			function: { name: "run_shell", arguments: '{"command":"echo x"}' },
		});
		// non-assistant 消息原样透传
		expect(b.messages[0]).toEqual({ role: "system", content: "sys" });
	});

	it("HTTP 非 2xx 抛错", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("boom");
		});
		servers.push(server);
		server.listen(0);
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		await expect(collect(base)).rejects.toThrow(/HTTP 500/);
	});
});
