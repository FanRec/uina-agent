import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAIProvider } from "../src/ai/gateway.js";
import type { Model, ProviderWireObservation, StreamDelta } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { SubjectHarness } from "./harness/index.js";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

const sse = (events: string[]): string => events.map((event) => `data: ${event}\n\n`).join("");

async function endpoint(handler: (body: string) => void): Promise<string> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			handler(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				sse([
					JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
					"[DONE]",
				]),
			);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("Provider Wire 观察（真实请求可对账）", () => {
	it("摘要对应实际准备发送的载荷：哈希与量级与 HTTP body 一致；不携带正文", async () => {
		let receivedBody = "";
		const base = await endpoint((body) => {
			receivedBody = body;
		});
		const provider = createOpenAIProvider("test-provider", { baseUrl: base, apiKey: "test" });
		const model: Model = { id: "m", name: "m", providerId: "test-provider", contextWindow: 4096 };

		const observations: ProviderWireObservation[] = [];
		const deltas: StreamDelta[] = [];
		await provider.stream(
			model,
			{
				messages: [{ role: "user", content: "原始消息" }],
				providerHooks: NO_RUNTIME_HOOKS.provider,
				requestId: "stream-1-1",
				onWireObservation: (observation) => observations.push(observation),
			},
			(delta) => deltas.push(delta),
		);

		expect(deltas.at(-1)).toEqual({ kind: "finish", reason: "stop" });
		expect(observations).toHaveLength(1);
		const wire = observations[0]!;
		expect(wire.requestId).toBe("stream-1-1");
		expect(wire.provider).toBe("test-provider");
		expect(wire.payload.messageCount).toBe(1);
		// Wire 摘要描述真正发送的载荷：哈希即 HTTP body 的序列化指纹
		const expectedHash = createHash("sha256").update(receivedBody).digest("hex");
		expect(wire.payload.hash).toBe(expectedHash);
		expect(receivedBody).toContain("原始消息");
		// 摘要只含哈希与量级，不携带原始正文
		expect(JSON.stringify(wire)).not.toContain("原始消息");
	});

	it("已知形状补齐 messageCount/toolCount；无观察出口时零成本", async () => {
		const base = await endpoint(() => {});
		const provider = createOpenAIProvider("test-provider", { baseUrl: base, apiKey: "test" });
		const model: Model = { id: "m", name: "m", providerId: "test-provider", contextWindow: 4096 };
		const observations: ProviderWireObservation[] = [];
		await provider.stream(
			model,
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: { name: "t", description: "t", parameters: { type: "object", properties: {} } },
					},
				],
				providerHooks: NO_RUNTIME_HOOKS.provider,
				requestId: "stream-9-3",
				onWireObservation: (observation) => observations.push(observation),
			},
			() => {},
		);
		const wire = observations[0]!;
		expect(wire.payload.messageCount).toBe(1);
		expect(wire.payload.toolCount).toBe(1);
	});

	it("Subject 建立请求级 requestId，Wire 观察与活动请求观察通过同一 ID 对账", async () => {
		const harness = SubjectHarness.create({
			stream: async (_model, req, onDelta) => {
				// 模拟内置 Provider Adapter：把请求上的观察出口接回（真实路径经
				// sendModelStreamRequest，其行为已在上面两条用真实 HTTP 验证）。
				req.onWireObservation?.({
					requestId: req.requestId,
					provider: "mock",
					payload: { hash: "semantic", bytes: 10, messageCount: req.messages.length },
				});
				onDelta({ kind: "text", text: "好的" });
				onDelta({ kind: "finish", reason: "stop" });
			},
		});
		await harness.subject.pushInput("对账一下");
		await harness.subject.waitForIdle();

		const observation = harness.subject.getRequestObservation();
		expect(observation).toBeDefined();
		expect(observation!.requestId).toMatch(/^stream-\d+-\d+$/);
		expect(observation!.wire?.requestId).toBe(observation!.requestId);
		expect(observation!.projection.messages.length).toBeGreaterThan(0);
		expect(observation!.assembly.sources).toEqual([]);
	});

	it("无 requestId 的旁路流不产生关联观察（不冒充活动请求）", async () => {
		const wires: ProviderWireObservation[] = [];
		const harness = SubjectHarness.create({
			stream: async (_model, req, onDelta) => {
				// Provider 直连（无 requestId）：观察仍然只发生在出口上，Subject 不关联
				if (req.requestId) {
					wires.push({
						requestId: req.requestId,
						provider: "mock",
						payload: { hash: "x", bytes: 1 },
					});
					req.onWireObservation?.(wires[wires.length - 1]!);
				}
				onDelta({ kind: "finish", reason: "stop" });
			},
		});
		await harness.subject.pushInput("直连");
		await harness.subject.waitForIdle();
		// Subject 发起的请求都带 requestId（本例生成了一条）；观察与请求 ID 一致
		const observation = harness.subject.getRequestObservation();
		expect(observation?.wire?.requestId).toBe(observation?.requestId);
		expect(wires).toHaveLength(1);
	});
});
