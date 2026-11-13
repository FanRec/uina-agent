import { describe, expect, it, vi } from "vitest";
import { TtsSpeakError } from "../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";

describe("TTS delivery hardening", () => {
	it("checks expected playback ownership instead of the active text turn", async () => {
		const client = {
			speak: vi.fn().mockResolvedValue({ status: "accepted" }),
			cancelTrace: vi.fn().mockResolvedValue({ status: "cancelled", playback_stopped: true, cancelled_task_count: 1 }),
			getSubtitleState: vi.fn().mockResolvedValue({ trace_id: "turn_1", segments: [] }),
			isHealthy: vi.fn().mockResolvedValue(true),
		};
		const driver = new TtsVoiceOutputDriver({
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			...client,
		} as never);
		const first = driver.beginSource();
		await driver.submitSegment("第一句。");
		const second = driver.beginSource();

		await expect(driver.interrupt(second)).resolves.toMatchObject({ outcome: "no_op" });
		await expect(driver.interrupt(first)).resolves.toMatchObject({ outcome: "interrupted" });
		expect(client.cancelTrace).toHaveBeenCalledWith(first, "immediate", driver.sessionId, "epoch-new");
	});

	it("poisons a source after an unknown submit and does not let later segments bypass the gap", async () => {
		const client = {
			speak: vi
				.fn()
				.mockResolvedValueOnce({ status: "accepted" })
				.mockRejectedValueOnce(new TtsSpeakError("timeout", "unknown")),
			cancelTrace: vi.fn(),
			getSubtitleState: vi.fn(),
			isHealthy: vi.fn().mockResolvedValue(true),
		};
		const driver = new TtsVoiceOutputDriver({
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			...client,
		} as never);
		driver.beginSource();
		await expect(driver.submitSegment("第一句。")).resolves.toMatchObject({ status: "accepted" });
		await expect(driver.submitSegment("第二句。")).resolves.toMatchObject({ status: "uncertain" });
		await expect(driver.submitSegment("第三句。")).resolves.toMatchObject({ status: "unknown" });
		expect(client.speak).toHaveBeenCalledTimes(2);
	});

	it("keeps a deterministic rejection scoped to its source instead of poisoning the whole session (§8.4)", async () => {
		const client = {
			speak: vi
				.fn()
				.mockResolvedValueOnce({ status: "accepted" })
				.mockResolvedValueOnce({ status: "rejected" })
				.mockResolvedValue({ status: "accepted" }),
			cancelTrace: vi.fn(),
			getSubtitleState: vi.fn(),
			isHealthy: vi.fn().mockResolvedValue(true),
		};
		const driver = new TtsVoiceOutputDriver({
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			...client,
		} as never);
		driver.beginSource();
		await expect(driver.submitSegment("第一句。")).resolves.toMatchObject({ status: "accepted" });
		await expect(driver.submitSegment("第二句。")).resolves.toMatchObject({ status: "rejected" });
		// 同一来源的后续句子不再朗读
		await expect(driver.submitSegment("第三句。")).resolves.toMatchObject({ status: "rejected" });
		// 新来源（新 turn）不被旧来源的确定性失败扩大化
		driver.beginSource();
		await expect(driver.submitSegment("新来源第一句。")).resolves.toMatchObject({ status: "accepted" });
		expect(client.speak).toHaveBeenCalledTimes(3);
	});

	it("does not relabel unknown Bridge ownership as external during restart", async () => {
		const driver = new TtsVoiceOutputDriver({ isHealthy: vi.fn().mockResolvedValue(false) } as never);

		await expect(driver.recover("restart", "inv-restart", "bridge")).resolves.toMatchObject({
			status: "not_started",
		});
	});

	it("reconnects after an owned Bridge restart and uses the new epoch before submitting", async () => {
		const client = {
			speak: vi.fn().mockResolvedValue({ status: "accepted", task_id: "t1" }),
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			compatibility: vi.fn().mockResolvedValue({ compatible: true }),
			reset: vi.fn().mockResolvedValue({ status: "reset", epoch: "epoch-new" }),
			turnEnd: vi.fn().mockResolvedValue({ status: "ended" }),
			getSubtitleState: vi.fn().mockResolvedValue(null),
			isHealthy: vi.fn().mockResolvedValue(true),
		};
		const driver = new TtsVoiceOutputDriver(client as never);
		driver.beginSource();
		driver.setRestartBridge(vi.fn().mockResolvedValue({ status: "succeeded", ownership: "owned", ready: true }));

		await expect(driver.recover("restart", "inv-restart", "bridge")).resolves.toMatchObject({ status: "succeeded" });
		const trace = driver.beginSource();
		await expect(driver.submitSegment("重启后发声", undefined, undefined, trace)).resolves.toMatchObject({
			status: "accepted",
		});

		expect(client.reconnect).toHaveBeenCalledWith(driver.sessionId, expect.any(AbortSignal));
		expect(client.speak).toHaveBeenCalledWith(expect.objectContaining({ epoch: "epoch-new" }));
	});

	it("distinguishes a reachable legacy bridge from a disconnected bridge when unmuting", async () => {
		const client = {
			isHealthy: vi.fn().mockResolvedValue(false),
			compatibility: vi.fn().mockResolvedValue({
				reachable: true,
				compatible: false,
				missingPaths: ["/v1/tts/reset"],
				reason: "缺少协议路径：/v1/tts/reset",
			}),
		};
		const driver = new TtsVoiceOutputDriver({
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			...client,
		} as never);

		await expect(driver.setMuted(false)).resolves.toMatchObject({
			success: false,
			isOnline: false,
			reason: expect.stringContaining("缺少协议路径"),
		});
	});

	it("does not run playback verification while muted", async () => {
		const client = {
			speak: vi.fn(),
			cancelTrace: vi.fn(),
			getSubtitleState: vi.fn(),
			isHealthy: vi.fn().mockResolvedValue(true),
			test: vi.fn(),
		};
		const driver = new TtsVoiceOutputDriver({
			reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
			...client,
		} as never);
		await driver.setMuted(true);
		await expect(driver.test("playback")).resolves.toMatchObject({ status: "not_started" });
		expect(client.test).not.toHaveBeenCalled();
	});
});
