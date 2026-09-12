import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { Subject } from "../src/agent/loop.js";
import { ToolBroker } from "../src/tools/broker.js";
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
import { mockModel } from "./helpers/mock-provider.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=";
const image: ImageContent = { type: "image", mimeType: "image/png", data: png, alt: "one pixel" };
const directories: string[] = [];
const servers: Server[] = [];
const hosts: UinaHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
	}
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function request(messages: ChatMsg[]): ModelRequest {
	return { messages, providerHooks: NO_RUNTIME_HOOKS.provider };
}

it("encodes images in all adapters while retaining tool result identity", () => {
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

it("attempts unknown image capability, rejects explicit unsupported and invalid attachments", () => {
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

it("reads an actual image through the default built-in extension with unknown model capability, sends it on the wire, persists and restores it", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "uina-image-"));
	directories.push(cwd);
	await writeFile(join(cwd, "pixel.png"), Buffer.from(png, "base64"));
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
		} else
			res.write(
				"data: " +
					JSON.stringify({ choices: [{ index: 0, delta: { content: "received image" }, finish_reason: "stop" }] }) +
					"\n\n",
			);
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
	const file = join(cwd, "session.jsonl");
	const host = await UinaHost.create({
		cwd,
		sessionPath: file,
		model,
		provider,
	});
	hosts.push(host);
	const done: unknown[] = [];
	host.subscribe((event) => {
		if (event.type === "tool_done") done.push(event);
	});
	await host.start();
	await host.submitText("read the image");
	expect(bodies).toHaveLength(2);
	expect(JSON.stringify(bodies[1])).toContain("data:image/png;base64," + png);
	expect(done).toMatchObject([
		{ status: "succeeded", images: [{ data: png }], details: { bytes: Buffer.from(png, "base64").length } },
	]);
	await host.dispose();
	const opened = await openJsonlSession(file);
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

it("persists extension-authored and queued image input without changing bytes or source", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "uina-image-input-"));
	directories.push(cwd);
	const file = join(cwd, "session.jsonl");
	const { store } = await openJsonlSession(file);
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
	const queued = await openJsonlSession(file);
	expect(queued.snapshot.queued[0].images).toEqual([image]);
	await queued.store.appendInput(input);
	await queued.store.close();
	const restored = await openJsonlSession(file);
	const messages = convertToLlm(projectAgentHistory(restored.snapshot.entries));
	expect(messages.map((m) => m.images?.[0].data)).toEqual([png, png]);
	expect(messages[1].content).toContain("camera");
	await restored.store.close();
});

it("resumes queued image events with their original identity and keeps them out of a text-only draft", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "uina-image-resume-"));
	directories.push(cwd);
	const file = join(cwd, "session.jsonl");
	const { store } = await openJsonlSession(file);
	const input = {
		id: "original-camera-input",
		order: 1,
		mode: "followUp" as const,
		text: "scene",
		source: { kind: "runtime" as const, type: "camera" },
		images: [image],
	};
	await store.appendEvent("queue_enqueued", { ...input });
	const subject = new Subject(
		mockModel({ imageInput: true }),
		async (_model, req, emit) => {
			expect(
				req.messages.some((message) => message.images?.[0].data === png && message.content.includes("camera")),
			).toBe(true);
			emit({ kind: "text", text: "observed" });
			emit({ kind: "finish", reason: "stop" });
		},
		new ToolBroker(),
		{ store },
	);
	subject.seedQueue([input]);
	expect(canEditQueuedDraft(subject.queuedSnapshot())).toBe(false);
	expect(canEditQueuedDraft([{ source: { kind: "user" } }])).toBe(true);
	await subject.resumePending();
	expect(subject.queuedSnapshot()).toEqual([]);
	expect(subject.historySnapshot()[0]).toMatchObject({ id: input.id, role: "custom", images: [image] });
	await store.close();
	const reopened = await openJsonlSession(file);
	expect(reopened.snapshot.entries[0]).toMatchObject({ kind: "input", input });
	await reopened.store.close();
});


it("default filesystem tools read ranges, preserve full text and identify image bytes independently of filename", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "uina-files-")); directories.push(cwd);
 const host = await UinaHost.create({ cwd, model: mockModel() }); hosts.push(host); await host.start();
 expect((await host.runToolDirect("write_file", {path:"notes.txt", text:"one\ntwo\nthree\n"})).status).toBe("succeeded");
 expect((await host.runToolDirect("read_file", {path:"notes.txt"})).result).toBe("one\ntwo\nthree\n");
 expect((await host.runToolDirect("read_file", {path:"notes.txt",offset:2,limit:1})).result).toBe("two");
 expect((await host.runToolDirect("read_file", {path:"notes.txt",offset:0})).status).not.toBe("succeeded");
 expect((await host.runToolDirect("read_file", {path:"absent"})).status).toBe("failed");
 await writeFile(join(cwd,"image.bin"),Buffer.from(png,"base64"));
 expect((await host.runToolDirect("read_image", {path:"image.bin"})).images?.[0].mimeType).toBe("image/png");
 await writeFile(join(cwd,"fake.png"),"not an image");
 expect((await host.runToolDirect("read_image", {path:"fake.png"})).status).toBe("failed");
});

it("host assembly can disable filesystem tools", async () => {
 const cwd = await mkdtemp(join(tmpdir(), "uina-no-files-")); directories.push(cwd);
 const host = await UinaHost.create({cwd,model:mockModel(),workspaceTools:false}); hosts.push(host); await host.start();
 expect((await host.runToolDirect("read_file",{path:"absent"})).status).not.toBe("succeeded");
});
