import { describe, expect, it, vi } from "vitest";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";
import { createVoiceTool } from "../.uina/extensions/voice/tool.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";

describe("TTS maintenance contract", () => {
  it("reports inspect evidence without claiming health", async () => {
    const driver = { inspect: vi.fn().mockResolvedValue({ status: "observed", reachable: true, health: { service_ready: true } }) };
    const result = await createTtsTool(driver as never).run({ action: "inspect" });
    expect(result.status).toBe("succeeded");
    expect(result.result).toContain("尚未由此证明模型可合成");
  });

  it("does not fake restart ownership", async () => {
    const driver = {};
    const result = await createTtsTool(driver as never).run({ action: "recover", operation: "restart", target: "vendor" });
    expect(result.status).toBe("not_started");
    expect(result.result).toContain("不能把端口或 PID 当作可重启所有权");
  });

  it("voice separates speak from preference management", async () => {
    const pi = {
      hasService: vi.fn((name: string) => name === "voice_driver:snapshot"),
      callService: vi.fn(async (name: string) => name === "voice_driver:snapshot" ? { online: true, muted: false, submittedSegments: 0, spokenSegments: 0, pendingSegments: 0, currentSegmentIndex: null } : undefined),
    };
    const result = await createVoiceTool(new VoiceSession(pi as never)).run({ action: "manage", operation: "set_text_reading", enabled: false });
    expect(result.status).toBe("failed");
    expect(result.result).toContain("发声驱动未挂载");
  });
});
