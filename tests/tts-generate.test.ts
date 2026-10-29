import { once } from "node:events";
import * as files from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsBridgeClient } from "../.uina/extensions/tts/client.js";
import { createTtsGenerateTool } from "../.uina/extensions/tts/generate.js";
import { handleQqCall, type QqAppDeps } from "../.uina/worlds/qq/src/app.js";
import { AttentionModel } from "../.uina/worlds/qq/src/attention.js";
import { ControlStore } from "../.uina/worlds/qq/src/control-store.js";
import { ConversationLocks } from "../.uina/worlds/qq/src/conversation-lock.js";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { MediaStaging } from "../.uina/worlds/qq/src/media.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { pcmWav as wav } from "./fixtures/pcm-wav.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

describe("tts_generate file contract", () => {
	let cwd: string;
	beforeEach(async () => {
		await mkdir(resolve("uina/tmp"), { recursive: true });
		cwd = await mkdtemp(resolve("uina/tmp/tts-test-"));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("preserves the exact text and publishes reusable unique files with a small visible result", async () => {
		const generate = vi.fn(async (_text: string, _timeout: number, _signal?: AbortSignal) => wav());
		const tool = createTtsGenerateTool({ cwd, client: { generate }, timeoutMs: 1000 });
		const text = "  你好\n（这一句也要读）🙂  ";
		const first = await tool.run({ text });
		const second = await tool.run({ text });
		expect(first.status).toBe("succeeded");
		const result = JSON.parse(first.result);
		expect(Object.keys(result)).toEqual(["resource", "durationMs"]);
		expect(result.durationMs).toBe(10);
		expect(result.resource.kind).toBe("file");
		expect(result.resource.path.startsWith(join(cwd, "uina", "tmp"))).toBe(true);
		expect(await readFile(result.resource.path)).toEqual(wav());
		expect(JSON.parse(second.result).resource.path).not.toBe(result.resource.path);
		expect(generate.mock.calls[0][0]).toBe(text);
		expect((await readdir(join(cwd, "uina", "tmp"))).every((name) => name.endsWith(".wav"))).toBe(true);
	});

	it.each([Buffer.from("not audio"), wav().subarray(0, 80), Buffer.alloc(44)])(
		"rejects corrupt or incomplete WAV",
		async (bytes) => {
			const tool = createTtsGenerateTool({ cwd, client: { generate: async () => bytes } });
			const result = await tool.run({ text: "hello" });
			expect(result.status).toBe("failed");
			expect(result.result).toContain("WAV");
			expect(result.result).not.toContain('"resource"');
		},
	);

	it.each([0, 8, 12, 36])("rejects high-bit corruption of a WAV chunk identifier at byte %i", async (offset) => {
		const bytes = wav();
		bytes[offset] |= 0x80;
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => bytes } });
		const result = await tool.run({ text: "hello" });
		expect(result.status).toBe("failed");
		expect(await readdir(cwd)).toEqual([]);
	});

	it("keeps file-system diagnostics out of the model-visible failure", async () => {
		vi.spyOn(files, "open").mockRejectedValue(
			new Error("EACCES: secret-file\npretend metadata", { cause: "disk detail" }),
		);
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		const result = await tool.run({ text: "hello" });
		expect(result.status).toBe("failed");
		expect(result.result).toContain("写入");
		expect(result.result).not.toContain("secret-file");
		expect(JSON.stringify(result.details)).toContain("secret-file");
	});

	it("cancels before starting without calling the bridge", async () => {
		const generate = vi.fn();
		const tool = createTtsGenerateTool({ cwd, client: { generate } });
		const controller = new AbortController();
		controller.abort();
		expect((await tool.run({ text: "hello" }, controller.signal)).status).toBe("cancelled");
		expect(generate).not.toHaveBeenCalled();
	});

	it("drops late audio after cancellation and honours extension disposal", async () => {
		const lifetime = new AbortController();
		const tool = createTtsGenerateTool({
			cwd,
			signal: lifetime.signal,
			client: {
				generate: async () => {
					lifetime.abort();
					return wav();
				},
			},
		});
		expect((await tool.run({ text: "hello" })).status).toBe("cancelled");
		expect(await readdir(cwd)).toEqual([]);
	});

	it("times out even if a dependency ignores abort", async () => {
		const tool = createTtsGenerateTool({ cwd, timeoutMs: 15, client: { generate: async () => new Promise(() => {}) } });
		const result = await tool.run({ text: "hello" });
		expect(result.status).toBe("failed");
		expect(result.result).toContain("超时");
	});

	it("keeps the input surface to nonempty text", () => {
		const broker = new ToolBroker();
		broker.register(createTtsGenerateTool({ cwd, client: { generate: async () => wav() } }));
		expect(broker.prepare("tts_generate", { text: "hello" }).error).toBeUndefined();
		for (const args of [{}, { text: "" }, { text: 1 }, { text: "hello", output: "elsewhere.wav" }]) {
			expect(broker.prepare("tts_generate", args).error).toBeDefined();
		}
	});

	it.each([0, NaN, Infinity, 2 ** 31])(
		"rejects unsupported timer values instead of silently timing out at 1ms",
		(timeoutMs) => {
			expect(() => createTtsGenerateTool({ cwd, timeoutMs, client: { generate: async () => wav() } })).toThrow();
		},
	);

	it("removes its partial file when interrupted before publication", async () => {
		const controller = new AbortController();
		const actualOpen = files.open;
		vi.spyOn(files, "open").mockImplementation(async (...args) => {
			const handle = await actualOpen(...args);
			const write = handle.writeFile.bind(handle);
			vi.spyOn(handle, "writeFile").mockImplementation(async (...data) => {
				await write(...data);
				controller.abort();
			});
			return handle;
		});
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		expect((await tool.run({ text: "hello" }, controller.signal)).status).toBe("cancelled");
		expect(await readdir(join(cwd, "uina", "tmp"))).toEqual([]);
	});

	it("reports the published file even if cancellation arrives at publication", async () => {
		const controller = new AbortController();
		const actualLink = files.link;
		vi.spyOn(files, "link").mockImplementation(async (...args) => {
			await actualLink(...args);
			controller.abort();
		});
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		const result = await tool.run({ text: "hello" }, controller.signal);
		expect(result.status).toBe("succeeded");
		expect(await readFile(JSON.parse(result.result).resource.path)).toEqual(wav());
		expect((await readdir(join(cwd, "uina", "tmp"))).length).toBe(1);
	});

	it("preserves an existing publication target and cleans only its own temporary file", async () => {
		const actualLink = files.link;
		vi.spyOn(files, "link").mockImplementation(async (...args) => {
			await files.writeFile(args[1], "existing owner", { flag: "wx" });
			await actualLink(...args);
		});
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		expect((await tool.run({ text: "hello" })).status).toBe("failed");
		const names = await readdir(join(cwd, "uina", "tmp"));
		expect(names).toHaveLength(1);
		expect(await readFile(join(cwd, "uina", "tmp", names[0]), "utf8")).toBe("existing owner");
	});

	it("keeps a definite publication failure when cancellation arrives during cleanup", async () => {
		const controller = new AbortController();
		const actualRm = files.rm;
		vi.spyOn(files, "link").mockRejectedValue(new Error("EACCES at publication"));
		vi.spyOn(files, "rm").mockImplementation(async (...args) => {
			await actualRm(...args);
			controller.abort();
		});
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		const result = await tool.run({ text: "hello" }, controller.signal);
		expect(result.status).toBe("failed");
		expect(result.result).toContain("写入");
		expect(JSON.stringify(result.details)).toContain("EACCES");
	});

	it("reports successful publication and keeps cleanup failures in diagnostics", async () => {
		const actualRm = files.rm;
		vi.spyOn(files, "rm").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith(".part")) throw new Error("cleanup denied");
			await actualRm(...args);
		});
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		const result = await tool.run({ text: "hello" });
		expect(result.status).toBe("succeeded");
		expect(await readFile(JSON.parse(result.result).resource.path)).toEqual(wav());
		expect(JSON.stringify(result.details)).toContain("cleanup denied");
		expect(result.result).not.toContain("cleanup denied");
	});

	it("loads a callable tool through an actual activation scope and disposes it without deleting exports", async () => {
		const broker = new ToolBroker();
		const runner = new ExtensionRunner({ cwd, tools: broker });
		await runner.activateBuiltin("tts-generation", (pi) => {
			pi.registerTool(
				createTtsGenerateTool({ cwd: pi.cwd, signal: pi.signal, client: { generate: async () => wav() } }),
			);
		});
		expect(broker.has("tts_generate")).toBe(true);
		const result = await broker.execute(broker.prepare("tts_generate", { text: "hello" }));
		expect(result.status).toBe("succeeded");
		await runner.dispose();
		expect(broker.has("tts_generate")).toBe(false);
		expect(await readFile(JSON.parse(result.result).resource.path)).toEqual(wav());
	});

	it("composes its ordinary file resource with the existing QQ audio staging and wire contract", async () => {
		const tool = createTtsGenerateTool({ cwd, client: { generate: async () => wav() } });
		const generated = await tool.run({ text: "hello" });
		const { resource } = JSON.parse(generated.result);
		const ops = new OperationLog({ dataDir: cwd, selfId: "10001" });
		ops.recover();
		const journal = new FactsJournal({ dataDir: cwd, selfId: "10001" });
		journal.recover();
		const control = new ControlStore({ dataDir: cwd, selfId: "10001" });
		control.load();
		const call = vi.fn(async (action: string, params: Record<string, unknown> = {}) => {
			expect(action).toBe("send_private_msg");
			const segments = params.message as { type: string; data: { file: string } }[];
			expect(segments[0].type).toBe("record");
			const staged = fileURLToPath(segments[0].data.file);
			expect(staged).not.toBe(resource.path);
			expect(await readFile(staged)).toEqual(wav());
			return { status: "ok" as const, data: { message_id: 90 } };
		});
		const deps: QqAppDeps = {
			selfId: "10001",
			grants: { grants: ["observation", "messaging"] },
			ops,
			journal,
			control,
			attention: new AttentionModel(),
			locks: new ConversationLocks(),
			media: { allowedRoots: [cwd], staging: new MediaStaging({ stagingDir: join(cwd, "staging"), ops }) },
			transport: {
				start: async () => ({ selfId: 10001 }),
				stop: async () => {},
				onEvent: () => () => {},
				onRaw: () => () => {},
				onStatus: () => () => {},
				call,
			},
		};
		const result = await handleQqCall(deps, "send", {
			conversationRef: "p20002",
			content: [{ type: "audio", resource }],
		});
		expect(result.status).toBe("succeeded");
		expect(call).toHaveBeenCalledOnce();
		expect(await readFile(resource.path)).toEqual(wav());
	});
});

describe("generation HTTP boundary", () => {
	let server: Server | undefined;
	afterEach(async () => {
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((done) => server!.close(() => done()));
		}
	});
	it("waits for the complete audio response, sends only generation data and passes a deadline", async () => {
		let request: unknown;
		server = createServer(async (req, res) => {
			expect(req.url).toBe("/v1/tts/generate");
			let body = "";
			for await (const chunk of req) body += chunk;
			request = JSON.parse(body);
			res.writeHead(200, { "Content-Type": "audio/wav" });
			res.write(wav().subarray(0, 80));
			setTimeout(() => res.end(wav().subarray(80)), 10);
		}).listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as { port: number };
		const client = new TtsBridgeClient(`http://127.0.0.1:${address.port}`);
		expect(Buffer.from(await client.generate("你好\nhello", 1000))).toEqual(wav());
		expect(request).toEqual({ text: "你好\nhello", timeout_ms: 1000 });
	});

	it.each([404, 502, 504])(
		"provides a short actionable error for HTTP %i and keeps raw diagnostics out of the message",
		async (status) => {
			server = createServer((_req, res) => {
				res.writeHead(status);
				res.end("backend stack trace and private reference path");
			}).listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as { port: number };
			const client = new TtsBridgeClient(`http://127.0.0.1:${port}`);
			try {
				await client.generate("hello", 1000);
				throw new Error("expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).not.toContain("private reference");
				expect((error as Error).message).toContain(status === 404 ? "重启" : status === 504 ? "超时" : "502");
				expect((error as Error).cause).toContain("backend stack trace");
			}
		},
	);

	it.each([
		[503, "reference audio is unavailable", "参考音频"],
		[503, "bridge is stopping", "停止"],
		[502, "vendor returned invalid or incomplete WAV", "WAV"],
	])("reports the known cause of HTTP %i without asking the model to guess", async (status, detail, expected) => {
		server = createServer((_req, res) => {
			res.writeHead(status as number, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ detail }));
		}).listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as { port: number };
		const client = new TtsBridgeClient(`http://127.0.0.1:${port}`);
		await expect(client.generate("hello", 1000)).rejects.toThrow(expected as string);
	});
});
