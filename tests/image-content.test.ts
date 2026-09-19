import { createServer, type Server } from "node:http";
import { describe, expect, test, afterEach } from "./harness/index.js";
import { canEditQueuedDraft } from "../src/cli/draft.js";
import { UinaHost } from "../src/host/host.js";
import { createProviderAndModel, anthropicMessages, geminiRequest } from "../src/ai/providers.js";
import { toWireMessages } from "../src/ai/gateway.js";
import { assertImageInput, type ImageContent } from "../src/core/content.js";
import type { ChatMsg, ModelRequest } from "../src/core/types.js";
import { NO_RUNTIME_HOOKS } from "../src/runtime/noop.js";
import { openJsonlSession } from "../src/session/jsonl-store.js";
import { projectAgentHistory } from "../src/session/recovery.js";
import { convertToLlm } from "../src/agent/context.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { IsolatedEnv, mockModel, UinaTestHarness, SubjectHarness } from "./harness/index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const image: ImageContent = { type: "image", mimeType: "image/png", data: png, alt: "one pixel" };

function request(messages: ChatMsg[]): ModelRequest {
	return { messages, providerHooks: NO_RUNTIME_HOOKS.provider };
}

describe("Image Content & Multimodal Tools", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
		}
	});

	test("encodes images in all adapters while retaining tool result identity", () => {
		const messages: ChatMsg[] = [
			{ role: "user", content: "question", images: [image] },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "a", name: "read_image", args: {} },
					{ id: "b", name: "read_image", args: {} },
				],
			},
			{ role: "tool", tool_call_id: "a", content: "first", images: [image], status: "succeeded" },
			{ role: "tool", tool_call_id: "b", content: "second", images: [image], status: "succeeded" },
		];
		const wire = toWireMessages(messages) as Array<{ role: string; content: unknown }>;
		expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
		expect(JSON.stringify(wire)).toContain("data:image/png;base64," + png);
		const anthropic = JSON.stringify(anthropicMessages(request(messages)));
		expect(anthropic).toContain('"media_type":"image/png"');
		expect(anthropic).toContain('"tool_use_id":"a"');
		expect(anthropic).toContain(png);
		const gemini = JSON.stringify(geminiRequest(request(messages), true));
		expect(gemini).toContain('"inlineData"');
		expect(gemini).toContain('"mimeType":"image/png"');
		expect(gemini).toContain(png);
	});

	test("attempts unknown image capability, rejects explicit unsupported and invalid attachments", () => {
		const req = request([{ role: "user", content: "see", images: [image] }]);
		expect(() => assertImageInput(mockModel(), req)).not.toThrow();
		expect(() => assertImageInput(mockModel({ imageInput: false }), req)).toThrow("不支持");
		expect(() => assertImageInput(mockModel({ imageInput: true }), req)).not.toThrow();
		expect(() =>
			assertImageInput(
				mockModel({ imageInput: true }),
				request([{ role: "user", content: "bad", images: [{ ...image, data: "not-base64" }] }]),
			),
		).toThrow("无效");
	});

	test("reads an actual image through the default built-in extension with unknown model capability, sends it on the wire, persists and restores it", async ({ env }) => {
		await env.writeFile("pixel.png", Buffer.from(png, "base64"));
		const bodies: Array<Record<string, unknown>> = [];
		const server = createServer(async (req, res) => {
			let raw = "";
			for await (const chunk of req) raw += chunk.toString();
			bodies.push(JSON.parse(raw));
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (bodies.length === 1) {
				res.write(
					"data: " +
						JSON.stringify({
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "picture",
												type: "function",
												function: { name: "read_image", arguments: '{"path":"pixel.png"}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						}) +
						"\n\n",
				);
				res.write(
					"data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\n\n",
				);
			} else {
				res.write(
					"data: " +
						JSON.stringify({ choices: [{ index: 0, delta: { content: "received image" }, finish_reason: "stop" }] }) +
						"\n\n",
				);
			}
			res.end("data: [DONE]\n\n");
		});
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const address = server.address() as { port: number };
		const { provider, model } = createProviderAndModel("fixture", {
			model: "fixture",
			apiKey: "fixture",
			baseUrl: "http://127.0.0.1:" + address.port,
			modelContextWindow: 100000,
		});

		const host = await UinaHost.create({
			cwd: env.cwd,
			sessionPath: env.sessionPath,
			model,
			provider,
		});
		try {
			const done: unknown[] = [];
			host.subscribe((event) => {
				if (event.type === "tool_result") done.push(event);
			});
			await host.start();
			await host.submitText("read the image");
			expect(bodies).toHaveLength(2);
			expect(JSON.stringify(bodies[1])).toContain("data:image/png;base64," + png);
			expect(done).toMatchObject([
				{ status: "succeeded", images: [{ data: png }], details: { bytes: Buffer.from(png, "base64").length } },
			]);
		} finally {
			await host.dispose();
		}

		const opened = await openJsonlSession(env.sessionPath);
		const history = projectAgentHistory(opened.snapshot.entries);
		const restored = convertToLlm(history);
		expect(restored.find((m) => m.role === "tool")?.images?.[0].data).toBe(png);
		expect(JSON.stringify(toWireMessages(restored))).toContain(png);
		const transcript = new TranscriptContainer();
		transcript.loadSession(opened.snapshot.entries);
		expect(transcript.render(80).join("")).toContain("image/png");
		expect(transcript.render(80).join("")).not.toContain(png);
		await opened.store.close();
	});

	test("persists extension-authored and queued image input without changing bytes or source", async ({ env }) => {
		const { store } = await openJsonlSession(env.sessionPath);
		await store.appendCustomMessage({ customType: "vision", content: "scene", images: [image] });
		const input = {
			id: "input",
			order: 1,
			mode: "followUp" as const,
			text: "look",
			source: { kind: "runtime" as const, type: "camera" },
			images: [image],
		};
		await store.appendEvent("queue_enqueued", { ...input });
		await store.close();

		const queued = await openJsonlSession(env.sessionPath);
		expect(queued.snapshot.queued[0].images).toEqual([image]);
		await queued.store.appendInput(input);
		await queued.store.close();

		const restored = await openJsonlSession(env.sessionPath);
		const messages = convertToLlm(projectAgentHistory(restored.snapshot.entries));
		expect(messages.map((m) => m.images?.[0].data)).toEqual([png, png]);
		expect(messages[1].content).toContain("camera");
		await restored.store.close();
	});

	test("resumes queued image events with their original identity and keeps them out of a text-only draft", async ({ env }) => {
		const { store } = await openJsonlSession(env.sessionPath);
		const input = {
			id: "original-camera-input",
			order: 1,
			mode: "followUp" as const,
			text: "scene",
			source: { kind: "runtime" as const, type: "camera" },
			images: [image],
		};
		await store.appendEvent("queue_enqueued", { ...input });
		const harness = SubjectHarness.create({
			model: mockModel({ imageInput: true }),
			store,
			stream: async (_model, req, emit) => {
				expect(
					req.messages.some((message) => message.images?.[0].data === png && message.content.includes("camera")),
				).toBe(true);
				emit({ kind: "text", text: "observed" });
				emit({ kind: "finish", reason: "stop" });
			},
		});
		harness.subject.seedQueue([input]);
		expect(canEditQueuedDraft(harness.subject.queuedSnapshot())).toBe(false);
		expect(canEditQueuedDraft([{ source: { kind: "user" } }])).toBe(true);
		await harness.subject.resumePending();
		expect(harness.subject.queuedSnapshot()).toEqual([]);
		expect(harness.subject.historySnapshot()[0]).toMatchObject({ id: input.id, role: "custom", images: [image] });
		await store.close();

		const reopened = await openJsonlSession(env.sessionPath);
		expect(reopened.snapshot.entries[0]).toMatchObject({ kind: "input", input });
		await reopened.store.close();
	});

	test("default filesystem tools read ranges, preserve full text and identify image bytes independently of filename", async ({ uina, env }) => {
		expect((await uina.callTool("write_file", { path: "notes.txt", text: "one\ntwo\nthree\n" })).status).toBe("succeeded");
		expect((await uina.callTool("read_file", { path: "notes.txt" })).result).toBe("one\ntwo\nthree"); // 结尾换行不产生幽灵空行
		expect(String((await uina.callTool("read_file", { path: "notes.txt", offset: 2, limit: 1 })).result)).toContain("two");
		expect((await uina.callTool("read_file", { path: "notes.txt", offset: 0 })).status).not.toBe("succeeded");
		expect((await uina.callTool("read_file", { path: "absent" })).status).toBe("failed");
		await env.writeFile("image.bin", Buffer.from(png, "base64"));
		expect((await uina.callTool("read_image", { path: "image.bin" })).images?.[0].mimeType).toBe("image/png");
		await env.writeFile("fake.png", "not an image");
		expect((await uina.callTool("read_image", { path: "fake.png" })).status).toBe("failed");
	});

	test("host assembly can disable filesystem tools", async () => {
		const env = await IsolatedEnv.create({ prefix: "uina-no-files-" });
		const harness = await UinaTestHarness.create({
			env,
			hostOptions: { workspaceTools: false },
		});
		try {
			expect((await harness.callTool("read_file", { path: "absent" })).status).not.toBe("succeeded");
		} finally {
			await harness.dispose();
		}
	});
});
