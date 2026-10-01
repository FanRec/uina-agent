import { describe, expect, it, vi } from "vitest";
import { StreamParser } from "../.uina/extensions/tts/stream-parser.js";
import { summarizeProgress } from "../.uina/extensions/tts/delivery.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";
import { TtsSpeakError } from "../.uina/extensions/tts/client.js";

describe("TTS delivery hardening", () => {
  it("reassembles a split closing think tag at every boundary", () => {
    const input = "<think>hidden</think>visible。";
    for (let cut = 1; cut < input.length; cut++) {
      const parser = new StreamParser();
      const output = [
        ...parser.feed(input.slice(0, cut)),
        ...parser.feed(input.slice(cut)),
        ...parser.flush(),
      ];
      expect(output, `split at ${cut}`).toEqual(["visible。"]);
    }
  });

  it("uses revealed progress from the current speaking segment only", () => {
    const facts = summarizeProgress(
      {
        trace_id: "trace",
        is_speaking: true,
        current_speaking: { index: 2, text: "second" },
        completed_segments: [{ index: 1, text: "first" }],
        segments: [
          { segment_index: 1, revealed_count: 99, playback_completed: true },
          { segment_index: 2, revealed_count: 3, playback_started: true, playback_completed: false },
        ],
      },
      2,
      new Map([[1, "first"], [2, "second"]]),
    );
    expect(facts.currentSegmentIndex).toBe(2);
    expect(facts.committedCharEnd).toBe(3);
  });

  it("checks expected playback ownership instead of the active text turn", async () => {
    const client = {
      speak: vi.fn().mockResolvedValue({ status: "accepted" }),
      cancelTrace: vi.fn().mockResolvedValue({ status: "cancelled", playback_stopped: true, cancelled_task_count: 1 }),
      getSubtitleState: vi.fn().mockResolvedValue({ trace_id: "turn_1", segments: [] }),
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const driver = new TtsVoiceOutputDriver(client as never);
    const first = driver.startTurn(1);
    await driver.submitSegment("第一句。");
    const second = driver.startTurn(2);

    await expect(driver.interrupt(second)).resolves.toMatchObject({ outcome: "no_op" });
    await expect(driver.interrupt(first)).resolves.toMatchObject({ outcome: "interrupted" });
    expect(client.cancelTrace).toHaveBeenCalledWith(first, "immediate");
  });

  it("uses grapheme clusters and clamps unsafe sentence limits", () => {
    const parser = new StreamParser({ maxSentenceChars: 5 });
    const unit = "e\u0301";
    const output = parser.feed(unit.repeat(11));
    expect(output[0]).toBe(unit.repeat(5));
    expect(parser.flush()[0]).toBe(unit.repeat(6));
  });

  it("hard-splits an unpunctuated stream at a safe boundary", () => {
    const parser = new StreamParser({ maxSentenceChars: 10 });
    const output = parser.feed("一二三四五六七八九十 后续");

    expect(output).toEqual(["一二三四五六七八九十"]);
    expect(parser.flush()).toEqual(["后续"]);
  });

  it("poisons a source after an unknown submit and does not let later segments bypass the gap", async () => {
    const client = {
      speak: vi.fn()
        .mockResolvedValueOnce({ status: "accepted" })
        .mockRejectedValueOnce(new TtsSpeakError("timeout", "unknown")),
      cancelTrace: vi.fn(),
      getSubtitleState: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const driver = new TtsVoiceOutputDriver(client as never);
    driver.startTurn(1);
    await expect(driver.submitSegment("第一句。" )).resolves.toMatchObject({ status: "accepted" });
    await expect(driver.submitSegment("第二句。" )).resolves.toMatchObject({ status: "uncertain" });
    await expect(driver.submitSegment("第三句。" )).resolves.toMatchObject({ status: "unknown" });
    expect(client.speak).toHaveBeenCalledTimes(2);
  });

  it("does not relabel unknown Bridge ownership as external during restart", async () => {
    const driver = new TtsVoiceOutputDriver({ isHealthy: vi.fn().mockResolvedValue(false) } as never);

    await expect(driver.recover("restart", "inv-restart", "bridge")).resolves.toMatchObject({
      status: "not_started",
      ownership: "unknown",
    });
  });

  it("reconnects after an owned Bridge restart and uses the new epoch before speaking", async () => {
    const client = {
      speak: vi.fn().mockResolvedValue({ status: "accepted", task_id: "t1" }),
      reconnect: vi.fn().mockResolvedValue({ status: "reconnected", epoch: "epoch-new" }),
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const driver = new TtsVoiceOutputDriver(client as never);
    driver.setRestartBridge(vi.fn().mockResolvedValue({ status: "succeeded", ownership: "owned", ready: true }));

    await expect(driver.recover("restart", "inv-restart", "bridge")).resolves.toMatchObject({ status: "succeeded" });
    await expect(driver.speak("重启后发声", "inv-speak", false)).resolves.toMatchObject({ status: "accepted" });

    expect(client.reconnect).toHaveBeenCalledWith("uina-default");
    expect(client.speak).toHaveBeenCalledWith(expect.objectContaining({ epoch: "epoch-new" }));
  });

  it("checks speak idempotency before replace so a retry cannot interrupt newer audio", async () => {
    const client = {
      speak: vi.fn().mockResolvedValue({ status: "accepted", task_id: "t1" }),
      cancelTrace: vi.fn().mockResolvedValue({ status: "cancelled", playback_stopped: true }),
      getSubtitleState: vi.fn().mockResolvedValue({ trace_id: "trace", segments: [] }),
      isHealthy: vi.fn().mockResolvedValue(true),
    };
    const driver = new TtsVoiceOutputDriver(client as never);

    await expect(driver.speak("第一句", "inv-1", false)).resolves.toMatchObject({ status: "accepted" });
    await expect(driver.speak("第一句", "inv-1", true)).resolves.toMatchObject({ status: "accepted" });

    expect(client.speak).toHaveBeenCalledTimes(1);
    expect(client.cancelTrace).not.toHaveBeenCalled();
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
    const driver = new TtsVoiceOutputDriver(client as never);

    await expect(driver.setMuted(false)).resolves.toMatchObject({
      success: false,
      isOnline: false,
      reason: expect.stringContaining("协议不兼容"),
    });
  });

  it("does not run playback verification while muted", async () => {
    const client = {
      speak: vi.fn(), cancelTrace: vi.fn(), getSubtitleState: vi.fn(),
      isHealthy: vi.fn().mockResolvedValue(true),
      test: vi.fn(),
    };
    const driver = new TtsVoiceOutputDriver(client as never);
    await driver.setMuted(true);
    await expect(driver.test("playback")).resolves.toMatchObject({ status: "not_started" });
    expect(client.test).not.toHaveBeenCalled();
  });

});
