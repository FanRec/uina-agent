import activateTts from "../.uina/extensions/tts/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";
import { createCueOutputOwnership } from "../.uina/extensions/embodiment/playback-cues.js";
import { describe, expect, it, vi } from "vitest";
import { StreamParser } from "../.uina/extensions/tts/stream-parser.js";
import { PlaybackCueDelivery } from "../.uina/extensions/tts/cue-delivery.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";
import { TtsBridgeClient } from "../.uina/extensions/tts/client.js";

describe("speech cue positioning and playback delivery", () => {
	it("keeps output ownership consistent across extension handler ordering and changes in voice health", () => {
		let healthy = true;
		const owner = createCueOutputOwnership(() => healthy);
		const current = {};
		expect(owner.ownsOutput(current)).toBe(true);
		healthy = false;
		expect(owner.ownsOutput(current)).toBe(true);
		const next = {};
		expect(owner.ownsOutput(next)).toBe(false);
		healthy = true;
		expect(owner.ownsOutput(next)).toBe(false);
		expect(owner.ownsOutput({})).toBe(true);
	});

	it("keeps cross-chunk tags at the correct cleaned grapheme offset and never speaks attributes", () => {
		const p = new StreamParser({ maxSentenceChars: 80 });
		expect(p.feedSegments("**你**好<cu")).toEqual([]);
		const segments = p.feedSegments("e id='smile' target='live2d'/>世界。下一句<cue id='nod'/>");
		expect(segments[0]!.text).toBe("你好世界。");
		expect(segments[0]!.cues).toMatchObject([{ id: "smile", target: "live2d", offset: 2 }]);
		const tail = p.flushSegments();
		expect(tail.segments).toMatchObject([{ text: "下一句", cues: [{ id: "nod", offset: 3 }] }]);
	});
	it("ignores cue tags in thinking, code and non-spoken parentheses and resets pending cues after interruption", () => {
		const p = new StreamParser();
		const segments = p.feedSegments(
			"<think><cue id='thinking'/></think>```<cue id='code'/>```（<cue id='paren'/>）<cue id='visible'/>你好。",
		);
		expect(segments).toMatchObject([{ text: "你好。", cues: [{ id: "visible", offset: 0 }] }]);
		p.feedSegments("<cue id='old'/>旧");
		p.reset();
		expect(p.feedSegments("新。")).toEqual([{ text: "新。", cues: [] }]);
	});
	it("distributes cues to the proper hard-split sentences and returns tail-only tags separately", () => {
		const p = new StreamParser({ maxSentenceChars: 5 });
		const segments = p.feedSegments("一二三四五<cue id='a'/>六七八九十十一十二。<cue id='tail'/>");
		const matching = segments.find((s) => s.cues.some((c) => c.id === "a"));
		expect(matching?.text).toBe("一二三四五");
		expect(matching?.cues[0]?.offset).toBe(5);
		expect(p.flushSegments().trailingCues).toMatchObject([{ id: "tail" }]);
	});
	it("passes structured cue metadata through the actual voice-driver submission", async () => {
		const client = new TtsBridgeClient("http://fixture");
		const speak = vi.spyOn(client, "speak").mockResolvedValue({ status: "accepted", task_id: "task" });
		const driver = new TtsVoiceOutputDriver(client);
		driver.startTurn(1);
		await driver.submitSegment("你好。", undefined, { cues: [{ id: "nod", offset: 0 }] });
		expect(speak).toHaveBeenCalledWith(
			expect.objectContaining({ text: "你好。", metadata: { cues: [{ id: "nod", offset: 0 }] } }),
		);
	});
	it("requires playback, deduplicates replay, discards late interrupted events and dispatches tail cues only after completion", () => {
		const dispatch = vi.fn();
		const delivery = new PlaybackCueDelivery(dispatch);
		delivery.begin("trace");
		const event = {
			trace_id: "trace",
			task_id: "task",
			segment_index: 1,
			detail: { playback_started: false, cues: [{ id: "nod", index: 0 }] },
		};
		delivery.receive(event);
		expect(dispatch).not.toHaveBeenCalled();
		event.detail.playback_started = true;
		delivery.receive(event);
		delivery.receive(event);
		expect(dispatch).toHaveBeenCalledTimes(1);
		delivery.addTrailing("trace", 2, [{ id: "tail", rawTag: "" }]);
		delivery.receive({ trace_id: "trace", segment_index: 1, detail: { playback_completed: true } });
		expect(dispatch).toHaveBeenCalledTimes(1);
		delivery.receive({ trace_id: "trace", segment_index: 2, detail: { playback_completed: true } });
		expect(dispatch).toHaveBeenCalledTimes(2);
		delivery.addTrailing("trace", 2, [{ id: "late-tail", rawTag: "" }]);
		expect(dispatch).toHaveBeenCalledTimes(3);
		delivery.cancel("trace");
		delivery.receive({
			...event,
			task_id: "new",
			detail: { playback_started: true, cues: [{ id: "stale", index: 1 }] },
		});
		delivery.addTrailing("trace", 3, [{ id: "stale-tail", rawTag: "" }]);
		expect(dispatch).toHaveBeenCalledTimes(3);
	});
});

describe("second review: speech boundaries", () => {
	it("consumes silent prefixes without moving their cue offsets into the next spoken sentence", () => {
		const p = new StreamParser();
		expect(p.feedSegments(">>> <cue id='nod'/>！！！你好。")).toEqual([
			{ text: "你好。", cues: [{ id: "nod", rawTag: "<cue id='nod'/>", offset: 0 }] },
		]);
		expect(p.flushSegments()).toEqual({ segments: [], trailingCues: [] });
	});
	it("uses string positions for numeric punctuation even after a surrogate-pair character", () => {
		const p = new StreamParser({ maxSentenceChars: 4 });
		expect(p.feed("𠮷的3,14。")).toEqual(["𠮷的3,14。"]);
	});
	it("each output's trailing cues retain their own audible boundary", () => {
		const dispatch = vi.fn(),
			delivery = new PlaybackCueDelivery(dispatch);
		delivery.begin("trace");
		delivery.addTrailing("trace", 1, [{ id: "first-tail", rawTag: "" }]);
		delivery.addTrailing("trace", 2, [{ id: "second-tail", rawTag: "" }]);
		delivery.receive({ trace_id: "trace", segment_index: 1, detail: { playback_completed: true } });
		expect(dispatch.mock.calls.map(([cue]) => cue.id)).toEqual(["first-tail"]);
		delivery.receive({ trace_id: "trace", segment_index: 2, detail: { playback_completed: true } });
		expect(dispatch.mock.calls.map(([cue]) => cue.id)).toEqual(["first-tail", "second-tail"]);
	});
	it("a new turn's submission count is zero while the previous turn's delivery snapshot is still pending", async () => {
		const client = new TtsBridgeClient("http://fixture");
		vi.spyOn(client, "speak").mockResolvedValue({ status: "accepted", task_id: "old-task" });
		const driver = new TtsVoiceOutputDriver(client);
		driver.startTurn(1);
		await driver.submitSegment("上一句。");
		expect(driver.currentSubmittedSegments).toBe(1);
		driver.startTurn(2);
		expect(driver.snapshot().submittedSegments).toBe(1); // still audible: do not erase it
		expect(driver.currentSubmittedSegments).toBe(0);
		await driver.submitSegment("这一句。");
		expect(driver.currentSubmittedSegments).toBe(1);
	});
});

describe("real extension event flow with a deferred bridge", () => {
	it("output_end waits for tail acceptance before turn_end can declare its final segment", async () => {
		const handlers = new Map<string, (event: unknown) => Promise<void>>();
		const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
		let acceptTail!: () => void;
		const tailReady = new Promise<void>((resolve) => {
			acceptTail = resolve;
		});
		const pi = {
			cwd: process.cwd(),
			signal: new AbortController().signal,
			registerTool: vi.fn(),
			registerService: vi.fn(),
			onHook: vi.fn(),
			reportError: vi.fn(),
			on: (name: string, handler: (event: unknown) => Promise<void>) => handlers.set(name, handler),
			share: () => () => {},
			shared: () => undefined,
		} as unknown as ExtensionAPI;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input, options) => {
			const url = String(input);
			const body = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
			calls.push({ url, body });
			if (url.endsWith("/v1/tts/events"))
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					}),
				);
			if (url.endsWith("/openapi.json"))
				return Response.json({
					paths: Object.fromEntries(
						["speak", "reconnect", "reset", "test", "restart"].map((name) => [`/v1/tts/${name}`, {}]),
					),
				});
			if (url.endsWith("/v1/tts/speak")) {
				await tailReady;
				return Response.json({ status: "accepted", task_id: "tail" }, { status: 202 });
			}
			return Response.json({ status: "ok", bridge_ready: true });
		}) as typeof fetch;
		let teardown: void | (() => Promise<void>);
		try {
			teardown = await activateTts(pi);
			await handlers.get("turn_start")!({ type: "turn_start", turnNumber: 1 });
			await handlers.get("output_update")!({ type: "output_update", channel: "content", text: "尾句<cue id='nod'/>" });
			let ended = false;
			const outputEnd = handlers.get("output_end")!({ type: "output_end", channel: "content" }).then(() => {
				ended = true;
			});
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(calls.filter((c) => c.url.endsWith("/v1/tts/speak"))).toHaveLength(1);
			expect(ended).toBe(false);
			acceptTail();
			await outputEnd;
			await handlers.get("turn_end")!({ type: "turn_end", turnNumber: 1 });
			expect(calls.find((c) => c.url.endsWith("/v1/tts/turn-end"))?.body?.last_segment_index).toBe(1);
			expect(calls.find((c) => c.url.endsWith("/v1/tts/speak"))?.body?.metadata).toMatchObject({
				cues: [{ id: "nod", offset: 2 }],
			});
		} finally {
			acceptTail();
			if (typeof teardown! === "function") await teardown();
			globalThis.fetch = originalFetch;
		}
	});
});

describe("late speech responses retain their trace identity", () => {
	it("an old rejected submission cannot roll back the next turn's accepted segment", async () => {
		const client = new TtsBridgeClient("http://fixture");
		let rejectOld!: (value: { status: string; task_id: string }) => void;
		vi.spyOn(client, "speak")
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						rejectOld = resolve;
					}),
			)
			.mockResolvedValue({ status: "accepted", task_id: "new" });
		const driver = new TtsVoiceOutputDriver(client);
		driver.startTurn(1);
		const old = driver.submitSegment("旧来源。");
		driver.startTurn(2);
		await driver.submitSegment("新来源。");
		rejectOld({ status: "rejected", task_id: "old" });
		await old;
		expect(driver.currentSubmittedSegments).toBe(1);
		expect(driver.snapshot().pendingSegments).toBe(1);
		await expect(driver.submitSegment("新来源第二句。")).resolves.toMatchObject({ status: "accepted" });
		expect(driver.currentSubmittedSegments).toBe(2);
	});
});
