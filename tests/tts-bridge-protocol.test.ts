import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TtsBridgeClient, TtsSpeakError } from "../.uina/extensions/tts/client.js";
import { TtsVoiceOutputDriver } from "../.uina/extensions/tts/driver-impl.js";

/**
 * Python 解释器发现顺序：UINA_TEST_PYTHON（显式覆盖，CI/异机用）→ 仓库约定 venv
 * `.venv-tts`（存在才用，本机零配置）→ PATH 上的 python。
 * 依赖清单与引导命令见 tests/fixtures/tts-contract-bridge.requirements.txt。
 */
function bridgePython(): string {
	if (process.env.UINA_TEST_PYTHON) return process.env.UINA_TEST_PYTHON;
	const venvPython = resolve(process.platform === "win32" ? ".venv-tts/Scripts/python.exe" : ".venv-tts/bin/python");
	if (existsSync(venvPython)) return venvPython;
	return "python";
}

let processHandle: ChildProcess;
let url: string;
let logs = "";
beforeAll(async () => {
	processHandle = spawn(bridgePython(), ["-B", "tests/fixtures/tts-contract-bridge.py"], {
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
		processHandle.once("exit", (code) => {
			// 缺包是环境问题，不是契约回归：把可操作的出口直接写进错误里。
			const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(logs);
			reject(
				new Error(
					`Bridge fixture exited ${code}: ${logs}` +
						(missing == null
							? ""
							: `\n\nset UINA_TEST_PYTHON to a Python with the TTS bridge dependencies (missing: ${missing[1]}), ` +
								`or bootstrap the bundled venv: uv venv .venv-tts && uv pip install -p .venv-tts/Scripts/python.exe -r tests/fixtures/tts-contract-bridge.requirements.txt`),
				),
			);
		});
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
	// 先走 fixture 的优雅停机（POST /test-shutdown → uvicorn 正常退出 →
	// TemporaryDirectory 清理钩子执行）；Windows 上直接 kill 会泄漏
	// uina-tts-protocol-* 临时目录。超时再硬杀兜底。
	try {
		await fetch(url + "/test-shutdown", { method: "POST", signal: AbortSignal.timeout(2000) });
	} catch {
		/* 进程已退出或端口不可达 */
	}
	await Promise.race([
		new Promise<void>((resolve) => processHandle.once("exit", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 3000)),
	]);
	if (processHandle.exitCode === null) processHandle.kill();
	await new Promise<void>((resolve) => {
		if (processHandle.exitCode !== null) return resolve();
		processHandle.once("exit", () => resolve());
	});
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

/** speak 的整句提交在输出表达体系后由 Speech 承担：此处等价于
 * beginSource → submitSegment → endSource 的最小编排。 */
async function speakWhole(driver: TtsVoiceOutputDriver, text: string): Promise<{ task_id?: string; status: string }> {
	const trace = driver.beginSource();
	const admitted = await driver.submitSegment(text, undefined, undefined, trace);
	await driver.endSource(trace);
	return admitted;
}

describe("real TS to Python Voice protocol", () => {
	it("reset cancels only its own session and cancelled sources reject late admissions", async () => {
		const client = new TtsBridgeClient(url);
		const own = new TtsVoiceOutputDriver(client);
		const other = new TtsVoiceOutputDriver(client);
		const old = await speakWhole(own, "old session");
		const kept = await speakWhole(other, "other session");
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
		const independent = await speakWhole(driver, "independent after failure");
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
		const next = await speakWhole(driver, "new speech");
		const result = await completed([next.task_id!]);
		expect(result.tasks.filter((task) => task.id === first.task_id)).toHaveLength(1);
	});
	it("plays independent sources in order and plays a replacement with index one", async () => {
		const client = new TtsBridgeClient(url);
		expect((await client.compatibility()).compatible).toBe(true);
		const driver = new TtsVoiceOutputDriver(client);
		const first = await speakWhole(driver, "slow first");
		const second = await speakWhole(driver, "second");
		const state = await completed([first.task_id!, second.task_id!]);
		expect(state.played.indexOf(first.task_id!.slice(0, -2))).toBeLessThan(
			state.played.indexOf(second.task_id!.slice(0, -2)),
		);
		// replace 的旧合同：停止确认后才受理新来源，片段序号从 1 重新开始。
		await driver.interrupt();
		const replacement = await speakWhole(driver, "replacement");
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
