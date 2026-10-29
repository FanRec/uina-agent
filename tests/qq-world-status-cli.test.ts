import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FactsJournal } from "../.uina/worlds/qq/src/facts-journal.js";
import { OperationLog } from "../.uina/worlds/qq/src/operation-log.js";

it("qq-status reads profile root, actual unknowns and incomplete/legacy files without changing bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "uina-qq-cli-"));
	const worldDir = join(dir, "world");
	mkdirSync(worldDir);
	writeFileSync(
		join(worldDir, "config.json"),
		JSON.stringify({
			selfId: "10001",
			connection: { url: "ws://127.0.0.1:1", accessToken: "fixture" },
			deployment: { grants: ["observation"] },
		}),
	);
	const profileRoot = join(dir, "profile");
	const dataRoot = join(profileRoot, "world-data", "qq");
	const dataDir = join(dataRoot, "v2", "10001");
	const journal = new FactsJournal({ dataDir, selfId: "10001" });
	journal.recover();
	const ops = new OperationLog({ dataDir, selfId: "10001" });
	ops.recover();
	ops.commitIntent({
		ref: "o1",
		identity: "world:qq/speak",
		action: "world:qq/speak",
		outcome: "unknown",
		target: "g30003",
		startedAt: "2026-10-11T00:00:00Z",
		echo: "10001/o1",
	});
	writeFileSync(
		join(dataDir, "qq-control.json"),
		JSON.stringify({
			version: 2,
			selfId: "10001",
			revision: 1,
			accountOverride: { mode: "silent" },
			conversationOverrides: {},
			initializationBaseline: {},
			followUps: {},
		}),
	);
	appendFileSync(join(dataDir, "qq-facts.jsonl"), '{"kind":"partial');
	appendFileSync(join(dataDir, "qq-operations.jsonl"), '{"kind":"partial');
	const before = new Map(readdirSync(dataDir).map((name) => [name, readFileSync(join(dataDir, name))]));
	try {
		for (const args of [
			["--profile-root", profileRoot],
			["--data-root", dataRoot],
		]) {
			const text = execFileSync(process.execPath, ["--import", "tsx", "scripts/qq-status.mts", worldDir, ...args], {
				cwd: process.cwd(),
				encoding: "utf8",
				timeout: 15000,
			});
			expect(text).toContain("unknown 操作数=1");
			expect(text).toContain("关注=[unknown]");
			expect(text).toContain("忽略未完成尾行=2");
			expect(readdirSync(dataDir).sort()).toEqual([...before.keys()].sort());
			for (const [name, bytes] of before) expect(readFileSync(join(dataDir, name))).toEqual(bytes);
		}
		const missing = join(dir, "missing");
		execFileSync(process.execPath, ["--import", "tsx", "scripts/qq-status.mts", worldDir, "--data-root", missing], {
			cwd: process.cwd(),
			timeout: 15000,
		});
		expect(existsSync(missing)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
