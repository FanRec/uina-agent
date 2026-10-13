import { describe, expect, it } from "vitest";
import { TtsSpeakError } from "../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function clientDefaults() {
	return {
		compatibility: async () => ({ compatible: true }),
		reconnect: async () => ({ status: "reconnected", epoch: "old" }),
		getSubtitleState: async () => null,
		turnEnd: async () => ({ status: "accepted" }),
		cancelTrace: async () => ({ status: "cancelled", stop_outcome: "not_playing" }),
	};
}

describe("TTS review race regressions", () => {
	it("does not replace the reset epoch with a late accepted receipt", async () => {
		const accepted = deferred<{ status: string; epoch: string; generation_id: number }>();
		const submitted = deferred<void>();
		const epochs: string[] = [];
		let currentEpoch = "old";
		const driver = new TtsVoiceOutputDriver({
			...clientDefaults(),
			reconnect: async () => ({ status: "reconnected", epoch: currentEpoch }),
			reset: async () => ({ status: "reset", epoch: (currentEpoch = "new") }),
			speak: async (payload: { epoch: string }) => {
				epochs.push(payload.epoch);
				if (epochs.length === 1) {
					submitted.resolve();
					return accepted.promise;
				}
				return payload.epoch === currentEpoch
					? { status: "accepted", epoch: currentEpoch, generation_id: 1 }
					: { status: "rejected", reason: "stale epoch" };
			},
		} as never);
		driver.beginSource();
		const first = driver.submitSegment("old speech");
		await submitted.promise;
		expect(await driver.recover("reset")).toMatchObject({ status: "succeeded" });
		accepted.resolve({ status: "accepted", epoch: "old", generation_id: 1 });
		expect(await first).toMatchObject({ status: "cancelled" });
		expect(await driver.speak("new speech")).toMatchObject({ status: "accepted" });
		expect(epochs).toEqual(["old", "new"]);
	});

	it("releases an old playback head after its second segment is rejected before admission", async () => {
		type Source = { id: string; text: string[]; next: number; end?: number; cancelled: boolean };
		const queue: Source[] = [];
		const heard: string[] = [];
		const pump = () => {
			while (queue.length) {
				const source = queue[0]!;
				if (source.cancelled || (source.end !== undefined && source.next > source.end)) {
					queue.shift();
					continue;
				}
				const text = source.text[source.next - 1];
				if (text === undefined) return;
				heard.push(text);
				source.next++;
			}
		};
		const driver = new TtsVoiceOutputDriver({
			...clientDefaults(),
			speak: async (payload: { trace_id: string; index: number; text: string }) => {
				if (payload.index === 2) throw new TtsSpeakError("HTTP 400 text must not be empty", "rejected", 400);
				let source = queue.find((entry) => entry.id === payload.trace_id);
				if (!source) {
					source = { id: payload.trace_id, text: [], next: 1, cancelled: false };
					queue.push(source);
				}
				source.text[payload.index - 1] = payload.text;
				pump();
				return { status: "accepted", epoch: "old", generation_id: 1 };
			},
			turnEnd: async (trace: string, _generation: number, lastIndex: number) => {
				const source = queue.find((entry) => entry.id === trace);
				if (source) source.end = lastIndex;
				pump();
				return { status: "accepted" };
			},
			cancelTrace: async (trace: string) => {
				const source = queue.find((entry) => entry.id === trace);
				if (source) source.cancelled = true;
				pump();
				return { status: "cancelled", stop_outcome: "not_playing" };
			},
		} as never);
		const first = driver.beginSource();
		expect(await driver.submitSegment("first")).toMatchObject({ status: "accepted" });
		expect(await driver.submitSegment(String.fromCodePoint(0x20000))).toMatchObject({ status: "rejected" });
		await driver.endSource(first);
		expect(await driver.speak("new speech")).toMatchObject({ status: "accepted" });
		expect(heard).toEqual(["first", "new speech"]);
		expect(queue.find((entry) => entry.id === first)).toBeUndefined();
	});

	it("does not start a playback test after mute completes during its compatibility handshake", async () => {
		const compatibility = deferred<{ compatible: boolean }>();
		let starts = 0;
		const driver = new TtsVoiceOutputDriver({
			...clientDefaults(),
			compatibility: () => compatibility.promise,
			test: async () => {
				starts++;
				return { status: "succeeded", playback_completed: true };
			},
		} as never);
		const test = driver.test("playback");
		expect(await driver.setMuted(true)).toMatchObject({ success: true });
		compatibility.resolve({ compatible: true });
		const result = await test;
		expect(starts).toBe(0);
		expect(["cancelled", "not_started"]).toContain(result.status);
		expect(driver.isMuted).toBe(true);
	});

	it("stops a running playback test by its own trace without resetting the session", async () => {
		const entered = deferred<void>();
		const completion = deferred<Record<string, unknown>>();
		let testTrace: string | undefined;
		let playing = false;
		const stopped: string[] = [];
		let resets = 0;
		const driver = new TtsVoiceOutputDriver({
			...clientDefaults(),
			test: async (
				_scope: string,
				_session: string,
				_timeout: number,
				_signal: AbortSignal,
				epoch?: string,
				trace?: string,
			) => {
				expect(epoch).toBe("old");
				testTrace = trace;
				playing = true;
				entered.resolve();
				return completion.promise;
			},
			cancelTrace: async (trace: string) => {
				stopped.push(trace);
				if (trace === testTrace) {
					playing = false;
					completion.resolve({ status: "cancelled", playback_completed: false });
				}
				return { status: "cancelled", playback_stopped: true, stop_outcome: "stopped" };
			},
			reset: async () => {
				resets++;
				return { status: "reset", epoch: "new" };
			},
		} as never);
		const test = driver.test("playback");
		// Bound the wait so an incorrect request identity fails without leaving work pending.
		await Promise.race([entered.promise, test]);
		const mute = await driver.setMuted(true);
		const playingAfterMute = playing;
		completion.resolve({ status: "cancelled", playback_completed: false });
		await test;
		expect(mute).toMatchObject({ success: true });
		expect(testTrace).toMatch(new RegExp(`^${driver.sessionId}:`));
		expect(stopped).toContain(testTrace);
		expect(playingAfterMute).toBe(false);
		expect(resets).toBe(0);
	});
});
