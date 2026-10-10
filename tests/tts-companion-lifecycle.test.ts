import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import { ToolBroker } from "../src/tools/broker.js";
import { ExtensionRunner } from "../src/extensions/runner.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pcmWav } from "./fixtures/pcm-wav.js";
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), subtitle: vi.fn() }));
vi.mock("../.uina/extensions/tts/companion.js", () => ({ ensureCompanion: mocks.bridge }));
vi.mock("../.uina/extensions/tts/subtitle-companion.js", () => ({ ensureSubtitleService: mocks.subtitle }));
vi.mock("../.uina/extensions/voice/preferences.js", () => ({
	loadVoicePreferences: async () => ({ muted: true, readAssistantText: false }),
}));
vi.mock("../.uina/extensions/tts/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../.uina/extensions/tts/config.js")>()),
	loadConfig: () => ({
		serviceUrl: "http://test-tts",
		requestTimeoutMs: 5000,
		generationTimeoutMs: 1000,
		maxSentenceChars: 20,
	}),
}));
import activate from "../.uina/extensions/tts/index.js";

function api(controller = new AbortController()): ExtensionAPI {
	return {
		cwd: process.cwd(),
		registerTool: vi.fn(),
		signal: controller.signal,
		registerService: vi.fn(),
		share: vi.fn(() => () => {}),
		shared: vi.fn(),
		reportError: vi.fn(),
		on: vi.fn(),
		onHook: vi.fn(),
	} as unknown as ExtensionAPI;
}

describe("TTS companion lifecycle", () => {
	beforeEach(() => vi.resetAllMocks());

	it("cleans both owned processes when registration fails", async () => {
		const bridgeStop = vi.fn(async () => {});
		const subtitleStop = vi.fn(async () => {});
		mocks.bridge.mockResolvedValue({ stop: bridgeStop });
		mocks.subtitle.mockResolvedValue({ stop: subtitleStop });
		const pi = api();
		vi.mocked(pi.registerService).mockImplementation(() => {
			throw new Error("registration failed");
		});
		await expect(activate(pi)).rejects.toThrow("registration failed");
		expect(bridgeStop).toHaveBeenCalledOnce();
		expect(subtitleStop).toHaveBeenCalledOnce();
	});

	it("fails before starting companions when the required tool registration port is missing", async () => {
		const pi = api();
		Object.assign(pi, { registerTool: undefined });
		await expect(activate(pi)).rejects.toThrow();
		expect(mocks.bridge).not.toHaveBeenCalled();
		expect(mocks.subtitle).not.toHaveBeenCalled();
	});

	it("still stops subtitles when bridge cleanup fails", async () => {
		const subtitleStop = vi.fn(async () => {});
		mocks.bridge.mockResolvedValue({
			stop: async () => {
				throw new Error("bridge stop failed");
			},
		});
		mocks.subtitle.mockResolvedValue({ stop: subtitleStop });
		const cleanup = await activate(api());
		expect(typeof cleanup).toBe("function");
		await expect((cleanup as () => Promise<void>)()).rejects.toThrow();
		expect(subtitleStop).toHaveBeenCalledOnce();
	});

	it("activates the real TTS extension and exposes generation independently of playback health", async () => {
		await mkdir(resolve("uina/tmp"), { recursive: true });
		const cwd = await mkdtemp(resolve("uina/tmp/tts-activation-"));
		const bytes = pcmWav();
		const fetch = vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "audio/wav" } }));
		vi.stubGlobal("fetch", fetch);
		mocks.bridge.mockRejectedValue(new Error("player unavailable"));
		mocks.subtitle.mockRejectedValue(new Error("subtitle unavailable"));
		const broker = new ToolBroker();
		const runner = new ExtensionRunner({ cwd, tools: broker });
		try {
			await runner.activateBuiltin("tts", activate);
			expect(broker.has("tts_generate")).toBe(true);
			const result = await broker.execute(broker.prepare("tts_generate", { text: "你好" }));
			expect(result.status).toBe("succeeded");
			expect(fetch.mock.calls).toHaveLength(1);
			const path = JSON.parse(result.result).resource.path;
			await runner.dispose();
			expect(broker.has("tts_generate")).toBe(false);
			expect(await readFile(path)).toEqual(bytes);
		} finally {
			await runner.dispose();
			vi.unstubAllGlobals();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
