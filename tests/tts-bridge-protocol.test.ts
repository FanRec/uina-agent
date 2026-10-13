import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TtsSpeakError } from "../.uina/extensions/tts/client.js";
import { TtsBridgeClient } from "../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";

let processHandle: ChildProcess;
let url: string;
let logs = "";
beforeAll(async () => {
	processHandle = spawn(process.env.UINA_TEST_PYTHON ?? "python", ["-B", "tests/fixtures/tts-contract-bridge.py"], {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	url = await new Promise<string>((resolve, reject) => {
		let output = "";
		processHandle.once("error", reject);
		processHandle.stderr?.on("data", (chunk) => {
			logs += String(chunk);
		});
		processHandle.stdout?.on("data", (chunk) => {
			output += String(chunk);
			const found = output.match(/\{"port":\s*(\d+)\}/);
			if (found) resolve("http://127.0.0.1:" + found[1]);
		});
		processHandle.once("exit", (code) => reject(new Error("Bridge fixture exited " + code + ": " + logs)));
	});
	for (let attempts = 0; attempts < 100; attempts++) {
		try {
			if ((await fetch(url + "/health")).ok) return;
		} catch {
			/* server binding */
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Fixture did not become ready: " + logs);
}, 10000);
afterAll(async () => {
	if (!processHandle || processHandle.exitCode !== null) return;
	processHandle.kill();
	await new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
});

async function completed(ids: string[]) {
	for (let attempts = 0; attempts < 200; attempts++) {
		const state = (await (await fetch(url + "/test-state")).json()) as {
			played: string[];
			tasks: Array<{ id: string; state: string; trace: string }>;
		};
		if (ids.every((id) => state.tasks.some((task) => task.id === id && task.state === "completed"))) return state;
		if (ids.some((id) => state.tasks.some((task) => task.id === id && task.state === "failed")))
			throw new Error(JSON.stringify(state));
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Playback did not settle: " + logs);
}

describe("real TS to Python Voice protocol", () => {
	it("reset cancels only its own session and cancelled sources reject late admissions", async () => {
		const client = new TtsBridgeClient(url);
		const own = new TtsVoiceOutputDriver(client);
		const other = new TtsVoiceOutputDriver(client);
		const old = await own.speak("old session");
		const kept = await other.speak("other session");
		const stopped = await own.interrupt();
		expect(["interrupted", "no_op"]).toContain(stopped.outcome);
		const epoch = (await client.reconnect(own.sessionId)).epoch as string;
		await expect(
			client.speak({
				session_id: own.sessionId,
				epoch,
				trace_id: old.task_id!.slice(0, -2),
				segment_id: old.task_id!.slice(0, -2) + ":2",
				index: 2,
				text: "late cancelled admission",
			}),
		).rejects.toMatchObject({ kind: "rejected", status: 409 });
		expect(await own.recover("reset")).toMatchObject({ status: "succeeded" });
		await completed([kept.task_id!]);
		await own.dispose();
		await other.dispose();
	});
	it("a failed source closes its later segment without preventing an independent source from playing", async () => {
		const client = new TtsBridgeClient(url);
		const driver = new TtsVoiceOutputDriver(client);
		driver.beginSource("failing-body");
		const failed = await driver.submitSegment("vendor failure");
		const later = await driver.submitSegment("never play this following segment");
		await driver.endSource();
		const independent = await driver.speak("independent after failure");
		const state = await completed([independent.task_id!]);
		expect(state.tasks.find((task) => task.id === failed.task_id)?.state).toBe("failed");
		if (later.task_id) expect(state.tasks.find((task) => task.id === later.task_id)?.state).not.toBe("completed");
		await driver.probe();
		expect(driver.snapshot().pendingSegments).toBe(0);
		await driver.dispose();
	});
	it("reconciles a lost admission reply without replaying or leaving the source open", async () => {
		const client = new TtsBridgeClient(url);
		const submit = client.speak.bind(client);
		let lose = true;
		client.speak = async (...args) => {
			const result = await submit(...args);
			if (lose) {
				lose = false;
				throw new TtsSpeakError("reply lost after admission", "unknown");
			}
			return result;
		};
		const driver = new TtsVoiceOutputDriver(client);
		driver.beginSource("body");
		const first = await driver.submitSegment("original body");
		expect(first.status).toBe("uncertain");
		await driver.endSource();
		await completed([first.task_id!]);
		expect(await driver.recover()).toMatchObject({ status: "succeeded", stoppedOldWork: false });
		const next = await driver.speak("new speech");
		const result = await completed([next.task_id!]);
		expect(result.tasks.filter((task) => task.id === first.task_id)).toHaveLength(1);
	});
	it("plays independent sources in order and plays a replacement with index one", async () => {
		const client = new TtsBridgeClient(url);
		expect((await client.compatibility()).compatible).toBe(true);
		const driver = new TtsVoiceOutputDriver(client);
		const first = await driver.speak("slow first");
		const second = await driver.speak("second");
		const state = await completed([first.task_id!, second.task_id!]);
		expect(state.played.indexOf(first.task_id!.slice(0, -2))).toBeLessThan(
			state.played.indexOf(second.task_id!.slice(0, -2)),
		);
		const replacement = await driver.speak("replacement", "replace", true);
		expect(replacement.status).toBe("accepted");
		expect(replacement.task_id).toMatch(/:1$/);
		await completed([replacement.task_id!]);
	});
	it("tests the configured streaming path and preserves mute", async () => {
		const driver = new TtsVoiceOutputDriver(new TtsBridgeClient(url));
		expect(await driver.test("playback")).toMatchObject({
			status: "succeeded",
			path: "streaming",
			playback_completed: true,
		});
		await driver.setMuted(true);
		expect(await driver.test("playback")).toMatchObject({ status: "not_started" });
		expect(driver.isMuted).toBe(true);
		expect(await driver.test("synthesis")).toMatchObject({
			status: "succeeded",
			path: "streaming",
			playback_started: false,
		});
	});
});
