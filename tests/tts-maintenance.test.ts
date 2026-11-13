import { describe, expect, it, vi } from "vitest";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";

describe("TTS maintenance contract", () => {
	it("reports inspect evidence without claiming health", async () => {
		const driver = {
			inspect: vi.fn().mockResolvedValue({ status: "observed", reachable: true, health: { service_ready: true } }),
		};
		const result = await createTtsTool(driver as never).run({ action: "inspect" });
		expect(result.status).toBe("succeeded");
		expect(result.result).toContain("接口可达不代表能发声");
	});

	it("does not fake restart ownership when the bridge refuses an external vendor", async () => {
		const driver = new TtsVoiceOutputDriver({
			restartVendor: vi.fn().mockResolvedValue({
				status: "not_started",
				target: "vendor",
				ownership: "external",
				reason: "Vendor 不是当前 Bridge 明确拥有的进程",
			}),
		} as never);
		const result = await createTtsTool(driver).run({ action: "recover", operation: "restart", target: "vendor" });
		expect(result.status).toBe("not_started");
		expect(result.result).toContain("Vendor 不是当前 Bridge 明确拥有的进程");
	});

	it("tts 工具描述不承诺自动朗读，也不把受理当播放", async () => {
		const client = {
			health: vi.fn().mockResolvedValue({ service_ready: true }),
			compatibility: vi.fn().mockResolvedValue({ reachable: true, compatible: true, missingPaths: [] }),
		};
		const driver = new TtsVoiceOutputDriver(client as never);
		const result = await createTtsTool(driver).run({ action: "inspect" });
		expect(result.status).toBe("succeeded");
		expect(result.result).not.toContain("正文朗读");
		expect(result.result).not.toContain("自动读出");
	});
});
