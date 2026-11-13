import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpeechPreferences, saveSpeechPreferences } from "../../.uina/extensions/speech/preferences.js";
import { TtsBridgeClient, TtsSpeakError } from "../../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../../.uina/extensions/tts/driver-impl.js";

const child = spawn(
	process.env.UINA_DEVICE_PYTHON ?? "E:/Uina/ThirdParty/gpt_sovits_v2pro/runtime/python.exe",
	["-B", "tests/fixtures/tts-contract-bridge.py", "--device"],
	{ windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
let url = "";
let driver: TtsVoiceOutputDriver | undefined;
const report: Array<Record<string, unknown>> = [];
const record = (step: string, result: unknown) => {
	report.push({ step, result });
	console.log(JSON.stringify({ step, result }));
};
const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
try {
	url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Device Bridge startup timeout")), 30000);
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error("Device Bridge exited " + code + ": " + logs));
		});
		const collect = (chunk: unknown) => {
			logs += String(chunk);
			const match = logs.match(/\{"port":\s*(\d+)\}/);
			if (match) {
				clearTimeout(timer);
				resolve("http://127.0.0.1:" + match[1]);
			}
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
	});
	const client = new TtsBridgeClient(url);
	for (let attempt = 0; attempt < 100 && !(await client.health()); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await client.compatibility()).compatible, true);
	driver = new TtsVoiceOutputDriver(client);
	record("initial-health", await client.health());
	const wait = async (id: string, playing = false) => {
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			const { tasks } = (await (await fetch(url + "/test-state")).json()) as { tasks: Array<Record<string, unknown>> };
			const task = tasks.find((item) => item.id === id);
			const detail = task?.detail as Record<string, unknown> | undefined;
			if (task?.state === "completed" || (playing && (detail?.playback_started === true || task?.state === "playing")))
				return task;
			if (task?.state === "failed" || task?.state === "cancelled" || task?.state === "obsolete")
				throw new Error(JSON.stringify(task));
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("No device completion for " + id);
	};
	driver.beginSource("device-body");
	const body = await driver.submitSegment("这是正文朗读验证。");
	await driver.endSource();
	record("body", await wait(body.task_id!));
	const independentTrace = driver.beginSource("device-independent");
	const independent = await driver.submitSegment(
		"这是独立发声验证。",
		"device-independent",
		undefined,
		independentTrace,
	);
	await driver.endSource(independentTrace);
	record("independent-speak", await wait(independent.task_id!));
	const oldTrace = driver.beginSource("device-old");
	const queued = await driver.submitSegment("这句话将被替换，不应阻挡下一句话。", "device-old", undefined, oldTrace);
	await driver.endSource(oldTrace);
	// replace 的旧合同：停止确认后才受理新来源。
	await driver.interrupt();
	const replaceTrace = driver.beginSource("device-replace");
	const replaced = await driver.submitSegment("这是替换后的新话。", "device-replace", undefined, replaceTrace);
	await driver.endSource(replaceTrace);
	record("replace", { old: queued, replacement: await wait(replaced.task_id!) });
	const longTrace = driver.beginSource("device-interrupt");
	const long = await driver.submitSegment(
		"这段话用于验证停止播放。声音开始后就会停止，不应继续读完后面的内容。",
		"device-interrupt",
		undefined,
		longTrace,
	);
	await driver.endSource(longTrace);
	await wait(long.task_id!, true);
	record("interrupt", await driver.interrupt());
	const mutedTrace = driver.beginSource("device-mute");
	const mutedWork = await driver.submitSegment(
		"这段声音将被静音取消，后续内容不会重播。",
		"device-mute",
		undefined,
		mutedTrace,
	);
	await driver.endSource(mutedTrace);
	record("mute", { work: mutedWork, stop: await driver.setMuted(true), test: await driver.test("playback") });
	const root = await mkdtemp(join(tmpdir(), "uina-voice-device-"));
	const preferencesApi = { path: join(root, "extension.ts"), subject: { stateRoot: root } } as never;
	await saveSpeechPreferences(preferencesApi, { muted: true });
	const restored = loadSpeechPreferences(preferencesApi);
	const reloaded = new TtsVoiceOutputDriver(client);
	await reloaded.setMuted((await restored).muted);
	const mutedTrace2 = reloaded.beginSource("reload-muted");
	record("reload-muted", await reloaded.submitSegment("不应播放的静音验证。", undefined, undefined, mutedTrace2));
	await reloaded.dispose();
	record("unmute", await driver.setMuted(false));
	record("streaming-playback-test", await driver.test("playback"));
	const actualSpeak = client.speak.bind(client);
	let lose = true;
	client.speak = async (...args) => {
		const receipt = await actualSpeak(...args);
		if (lose) {
			lose = false;
			throw new TtsSpeakError("controlled lost admission reply", "unknown");
		}
		return receipt;
	};
	const lostTrace = driver.beginSource("device-lost-reply");
	const uncertain = await driver.submitSegment(
		"这是故障恢复前的唯一一遍台词。",
		"device-lost-reply",
		undefined,
		lostTrace,
	);
	await driver.endSource(lostTrace);
	await wait(uncertain.task_id!);
	record("controlled-recovery", { admission: uncertain, recovery: await driver.recover() });
	const afterTrace = driver.beginSource("device-after-recover");
	const after = await driver.submitSegment("恢复后可以继续说话。", "device-after-recover", undefined, afterTrace);
	await driver.endSource(afterTrace);
	record("after-recovery", await wait(after.task_id!));
	await driver.probe();
	record("final-local-state", driver.snapshot());
} catch (error) {
	record("failed", String(error));
	process.exitCode = 1;
} finally {
	try {
		await driver?.dispose();
	} catch (error) {
		record("cleanup-unknown", String(error));
		process.exitCode = 1;
	}
	if (url) await fetch(url + "/test-shutdown", { method: "POST" }).catch(() => undefined);
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
	if (child.exitCode === null) {
		child.kill();
		await exited;
	}
	const path = join(tmpdir(), "uina-tts-device-verification.json");
	await writeFile(
		path,
		JSON.stringify({ observedAtUtc: new Date().toISOString(), humanHearing: "unverified", report, logs }, null, 2),
		"utf8",
	);
	console.log("Device evidence: " + path);
}
