import { describe, expect, it, vi } from "vitest";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";
import { createVoiceTool } from "../.uina/extensions/voice/tool.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";

describe("TTS maintenance contract", () => {
  it("reports inspect evidence without claiming health", async () => {
    const driver = { inspect: vi.fn().mockResolvedValue({ status: "observed", reachable: true, health: { service_ready: true } }) };
    const result = await createTtsTool(driver as never).run({ action: "inspect" });
    expect(result.status).toBe("succeeded");
    expect(result.result).toContain("尚未由此证明模型可合成");
  });

  it("does not fake restart ownership when the bridge refuses an external vendor", async () => {
    const driver = new TtsVoiceOutputDriver({
      restartVendor: vi.fn().mockResolvedValue({
        status: "not_started", target: "vendor", ownership: "external",
        reason: "Vendor 不是当前 Bridge 明确拥有的进程",
      }),
    } as never);
    const result = await createTtsTool(driver).run({ action: "recover", operation: "restart", target: "vendor" });
    expect(result.status).toBe("not_started");
    expect(result.result).toContain("Vendor 不是当前 Bridge 明确拥有的进程");
  });

  it("voice separates speak from preference management", async () => {
    const pi = {
      hasService: vi.fn((name: string) => name === "voice_driver:snapshot"),
      callService: vi.fn(async (name: string) => name === "voice_driver:snapshot" ? { online: true, muted: false, submittedSegments: 0, spokenSegments: 0, pendingSegments: 0, currentSegmentIndex: null } : undefined),
    };
    // 偏好归 Voice 所有：驱动未挂载也完成偏好转换，物理结果另行说明（§6.2）。
    const result = await createVoiceTool(new VoiceSession(pi as never)).run({ action: "manage", operation: "set_text_reading", enabled: false });
    expect(result.status).toBe("succeeded");
    expect(result.result).toContain("正文自动朗读已关闭");
    expect(result.result).toContain("发声驱动未挂载");
  });
});
