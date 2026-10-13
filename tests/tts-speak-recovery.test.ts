import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsBridgeClient } from "../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";
import { createTtsTool } from "../.uina/extensions/tts/tool.js";
import { createVoiceTool } from "../.uina/extensions/voice/tool.js";
import { VoiceSession } from "../.uina/extensions/voice/session.js";
import activate from "../.uina/extensions/tts/index.js";
import type { ExtensionAPI } from "../src/extensions/runner.js";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const epochs = new Map<string, string>();
	const accepted = new Map<string, string>();
	const requests: { trace_id: string; text: string; epoch?: string }[] = [];
	const state = { reachable: true, loseReply: false, reject: false, failReset: false };
	const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		if (!state.reachable) throw new Error("ECONNREFUSED");
		const path = new URL(url).pathname;
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (new URL(url).port === "18140")
			return reply({ service: "realtime-subtitles", version: 1, process: { ready: true, pid: 123 } });
		if (path === "/v1/tts/events") return new Response("", { headers: { "Content-Type": "text/event-stream" } });
		if (path === "/health") return reply({ service_ready: true, bridge_ready: true, voice_protocol_version: 2 });
		if (path === "/v1/tts/turn-end") return reply({ status: "accepted" });
		if (path === "/openapi.json")
			return reply({
				paths: Object.fromEntries(
					["speak", "reconnect", "reset", "test", "restart"].map((name) => [`/v1/tts/${name}`, {}]),
				),
			});
		if (path === "/v1/tts/reconnect") {
			const epoch = epochs.get(body.session_id) ?? `epoch-${epochs.size}`;
			epochs.set(body.session_id, epoch);
			return reply({ status: "reconnected", session_id: body.session_id, epoch });
		}
		if (path === "/v1/tts/reset") {
			if (state.failReset) return reply({ status: "failed", reason: "expected_epoch mismatch", epoch: "other" });
			const epoch = `reset-${epochs.size}`;
			epochs.set(body.session_id, epoch);
			return reply({ status: "reset", session_id: body.session_id, epoch });
		}
		if (path === "/v1/tts/cancel-trace")
			return reply({ status: "cancelled", playback_stopped: true, cancelled_task_count: 1 });
		if (path === "/v1/tts/subtitle-state") return reply({ segments: [] });
		if (path === "/v1/tts/speak") {
			requests.push(body);
			const epoch = epochs.get(body.session_id) ?? `epoch-${epochs.size}`;
			epochs.set(body.session_id, epoch);
			if (state.reject || (body.epoch && body.epoch !== epoch)) return reply({ detail: "epoch invalid" }, 409);
			if (accepted.has(body.segment_id) && accepted.get(body.segment_id) !== body.text)
				return reply({ detail: "task_id conflict" }, 409);
			accepted.set(body.segment_id, body.text);
			if (state.loseReply) {
				state.loseReply = false;
				throw new Error("reply connection reset after admission");
			}
			return reply({ status: "accepted", task_id: body.segment_id, epoch, generation_id: 1 }, 202);
		}
		throw new Error(`Unexpected endpoint: ${path}`);
	});
	const driver = new TtsVoiceOutputDriver(new TtsBridgeClient("http://tts.invalid"));
	const session = new VoiceSession({
		hasService: (name: string) => name === "voice_driver:speak",
		callService: async (_name: string, input: { text: string; invocationId?: string; replace: boolean }) =>
			driver.speak(input.text, input.invocationId, input.replace),
	} as unknown as ExtensionAPI);
	const voice = createVoiceTool(session);
	return { driver, voice, state, requests, accepted };
}

describe("speak recovery through the HTTP client and Voice tool", () => {
	it("gives each independent speak a source starting at one in the same control session", async () => {
		const { driver, requests } = setup();
		driver.startTurn(1);
		await driver.speak("first");
		await driver.speak("replacement", undefined, true);
		expect(requests[0].trace_id).not.toBe(requests[1].trace_id);
		expect(requests.map((r) => (r as unknown as { index: number }).index)).toEqual([1, 1]);
		expect((requests[0] as unknown as { session_id: string }).session_id).toBe(
			(requests[1] as unknown as { session_id: string }).session_id,
		);
	});

	it("prose acknowledgement loss keeps connection state and allows confirmed replacement through the registered service", async () => {
		const { state, requests } = setup();
		const services = new Map<string, (input?: unknown) => Promise<unknown>>();
		const handlers = new Map<string, (event: unknown) => Promise<void>>();
		const pi = {
			cwd: process.cwd(),
			signal: new AbortController().signal,
			registerTool: () => {},
			registerService: (name: string, handler: (input?: unknown) => Promise<unknown>) => services.set(name, handler),
			on: (name: string, handler: (event: unknown) => Promise<void>) => handlers.set(name, handler),
			hasService: (name: string) => services.has(name),
			callService: (name: string, input?: unknown) =>
				(services.get(name)! as Function)(input, { signal: new AbortController().signal }),
			reportError: () => {},
		} as unknown as ExtensionAPI;
		const stop = await activate(pi);
		try {
			await handlers.get("turn_start")!({ turnNumber: 1 });
			state.loseReply = true;
			await handlers.get("output_update")!({ streamId: "body", channel: "content", text: "Hello!" });
			await handlers.get("output_update")!({
				streamId: "body",
				channel: "content",
				text: "Closed source must stay silent!",
			});
			await handlers.get("output_end")!({ streamId: "body", channel: "content" });
			expect(requests.map((request) => request.text)).toEqual(["Hello!"]);
			expect(await services.get("voice_driver:snapshot")!()).toMatchObject({ online: true, unknownSegments: 1 });
			const voice = createVoiceTool(new VoiceSession(pi));
			expect((await voice.run({ action: "speak", text: "Replacement.", replace: true })).status).toBe("succeeded");
			expect(requests.map((request) => request.text)).toEqual(["Hello!", "Replacement."]);
		} finally {
			if (stop) await stop();
		}
	});

	it("rechecks a stale offline flag before admitting new speech", async () => {
		const { driver, voice, accepted } = setup();
		driver.startTurn(1);
		driver.setOnline(false);
		expect((await voice.run({ action: "speak", text: "new speech" })).status).toBe("succeeded");
		expect([...accepted.values()]).toEqual(["new speech"]);
	});

	it("replace confirms stopping an unknown delivery before admitting the new line", async () => {
		const { driver, voice, state, requests } = setup();
		driver.startTurn(1);
		state.loseReply = true;
		const unknown = await driver.submitSegment("already admitted prose");
		expect(unknown.status).toBe("uncertain");
		expect(unknown.reason).toContain("reply connection reset after admission");
		driver.setOnline(false);
		expect((await voice.run({ action: "speak", text: "replacement", replace: true })).status).toBe("succeeded");
		expect(requests.map((request) => request.text)).toEqual(["already admitted prose", "replacement"]);
	});

	it("keeps the unknown barrier when speak does not request replacement", async () => {
		const { driver, voice, state, requests } = setup();
		driver.startTurn(1);
		state.loseReply = true;
		await driver.submitSegment("already admitted prose");
		driver.setOnline(false);
		const result = await voice.run({ action: "speak", text: "must not bypass" });
		expect(result.status).toBe("unknown");
		expect(result.result).toContain("缺口");
		expect(requests).toHaveLength(1);
	});

	it("reports not_started when the offline probe cannot reach the Bridge", async () => {
		const { driver, voice, state, requests } = setup();
		driver.setOnline(false);
		state.reachable = false;
		const result = await voice.run({ action: "speak", text: "not sent" });
		expect(result.status).toBe("not_started");
		expect(result.result).not.toContain("已提交");
		expect(requests).toHaveLength(0);
	});

	it.each(["reconnect", "reset"] as const)(
		"does not send the previous trace epoch after %s and a new turn",
		async (operation) => {
			const { driver, voice, accepted } = setup();
			driver.startTurn(1);
			await driver.recover(operation);
			driver.startTurn(2);
			expect((await voice.run({ action: "speak", text: "new turn" })).status).toBe("succeeded");
			expect([...accepted.values()]).toEqual(["new turn"]);
		},
	);

	it("does not reuse an admitted segment identity after a failed reset", async () => {
		const { driver, voice, state, accepted } = setup();
		driver.startTurn(1);
		await driver.speak("first");
		state.failReset = true;
		expect((await driver.recover("reset")).status).toBe("failed");
		expect((await voice.run({ action: "speak", text: "second" })).status).toBe("succeeded");
		expect([...accepted.values()]).toEqual(["first", "second"]);
	});

	it("returns the actual HTTP rejection in the model-visible result", async () => {
		const { voice, state } = setup();
		state.reject = true;
		const result = await voice.run({ action: "speak", text: "rejected" });
		expect(result.status).toBe("failed");
		expect(result.result).toContain("HTTP 409");
		expect(result.result).toContain("epoch invalid");
	});

	it("renders a failed reset as failure with its reason", async () => {
		const { driver, state } = setup();
		state.failReset = true;
		driver.startTurn(1);
		state.loseReply = true;
		await driver.submitSegment("uncertain");
		const result = await createTtsTool(driver).run({ action: "recover" });
		expect(result.status).toBe("failed");
		expect(result.result).toContain("expected_epoch mismatch");
		expect(result.result).not.toContain("已执行");
	});
});
