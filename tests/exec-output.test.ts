import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OutputCollector } from "../src/extensions/runtime-tools/exec-command/output.js";
import { startBackgroundCommand } from "../src/extensions/runtime-tools/exec-command/index.js";

describe("shell output lifecycle", () => {
	it.each([51199, 51201])("preserves original bytes across spill and UTF-8 boundaries (%i)", async (prefixLength) => {
		const collector = new OutputCollector();
		const chinese = Buffer.from("中");
		const chunks = [Buffer.alloc(prefixLength, 97), chinese.subarray(0, 1), chinese.subarray(1), Buffer.from([0xff, 0xe4])];
		for (const chunk of chunks) collector.push(chunk);
		await collector.close();
		const snapshot = collector.snapshot();
		try {
			expect(snapshot.truncated).toBe(true);
			expect(await readFile(snapshot.fullOutputPath!)).toEqual(Buffer.concat(chunks));
			expect(snapshot.content).toContain("中");
		} finally { await unlink(snapshot.fullOutputPath!); }
	});

	it("survives an async spill failure and rejects close even after the error was emitted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "uina-spill-error-"));
		const module = new URL("../src/extensions/runtime-tools/exec-command/output.ts", import.meta.url).href;
		try {
			const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { OutputCollector } from ${JSON.stringify(module)};
process.env.TMP = process.env.TEMP = process.env.TMPDIR = ${JSON.stringify(join(dir, "missing"))};
const output = new OutputCollector();
output.push(Buffer.alloc(60000, 97));
await new Promise(resolve => setTimeout(resolve, 50));
await assert.rejects(output.close(), /ENOENT/);
console.log('failure surfaced');
`], { windowsHide: true, timeout: 10000 });
			expect(stdout).toContain("failure surfaced");
		} finally { await rm(dir, { recursive: true, force: true }); }
	});

	it("stops the shell before settling a background observation failure", async () => {
		const startedAt = Date.now();
		const handle = startBackgroundCommand(
			process.platform === "win32" ? "Write-Output probe; Start-Sleep -Seconds 20" : "echo probe; sleep 20",
			{ id: "probe", signal: new AbortController().signal, update() {}, observe() { throw new Error("observer failed"); } },
		);
		const result = await handle.done;
		expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining("observer failed") });
		expect(Date.now() - startedAt).toBeLessThan(10000);
	});
});
