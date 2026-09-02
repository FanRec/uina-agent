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
