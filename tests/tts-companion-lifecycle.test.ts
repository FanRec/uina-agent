import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/extensions/runner.js";
const mocks = vi.hoisted(() => ({ bridge: vi.fn(), subtitle: vi.fn() }));
vi.mock("../.uina/extensions/tts/companion.js", () => ({ ensureCompanion: mocks.bridge }));
vi.mock("../.uina/extensions/tts/subtitle-companion.js", () => ({ ensureSubtitleService: mocks.subtitle }));
import activate from "../.uina/extensions/tts/index.js";

function api(controller = new AbortController()): ExtensionAPI {
  return {
    signal: controller.signal,
    registerService: vi.fn(), shared: vi.fn(), reportError: vi.fn(),
    on: vi.fn(), onHook: vi.fn(),
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
    vi.mocked(pi.registerService).mockImplementation(() => { throw new Error("registration failed"); });
    await expect(activate(pi)).rejects.toThrow("registration failed");
    expect(bridgeStop).toHaveBeenCalledOnce();
    expect(subtitleStop).toHaveBeenCalledOnce();
  });

  it("still stops subtitles when bridge cleanup fails", async () => {
    const subtitleStop = vi.fn(async () => {});
    mocks.bridge.mockResolvedValue({ stop: async () => { throw new Error("bridge stop failed"); } });
    mocks.subtitle.mockResolvedValue({ stop: subtitleStop });
    const cleanup = await activate(api());
    expect(typeof cleanup).toBe("function");
    await expect((cleanup as () => Promise<void>)()).rejects.toThrow();
    expect(subtitleStop).toHaveBeenCalledOnce();
  });
});
