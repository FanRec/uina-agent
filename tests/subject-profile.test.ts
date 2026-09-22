/**
 * SubjectProfile：主体身份、路径解析与独占锁（认知扩展阶段 A / M1+M2）。
 *
 * 核心不变量：
 * 1. subjectId ↔ 目录绑定不可变；路径解析抗目录穿越；
 * 2. 每个数据根恰好一个活动写入进程（wx 排他锁 + ownerToken/PID）；
 * 3. 无 --profile 时，全部现有路径解析行为逐字节不变（对照测试锁定）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveProfile,
	releaseProfileLock,
	type SubjectProfile,
} from "../src/host/profile.js";
import { resolveSessionPath } from "../src/cli/session-path.js";
import { UinaHost } from "../src/host/host.js";
import { Scenario } from "./harness/provider/scenario.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "uina-profile-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

const validProfileJson = JSON.stringify({
	subjectId: "alice",
	displayName: "Alice",
});

const writeProfileDir = async (id: string, json: string, persona?: string): Promise<string> => {
	const dir = join(root, "profiles", id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "profile.json"), json, "utf8");
	if (persona !== undefined) await writeFile(join(dir, "persona.md"), persona, "utf8");
	return dir;
};

describe("resolveProfile：无 profile 时的行为不变", () => {
	it("profileArg 缺省返回 undefined（启动方不进入 profile 路径）", () => {
		expect(resolveProfile({ profileArg: undefined, cwd: root })).toBeUndefined();
		expect(resolveProfile({ profileArg: "", cwd: root })).toBeUndefined();
	});

	it("无 profile 时 resolveSessionPath 行为与历史一致（对照锁定）", () => {
		// 现有规则的 cwd/data/session.jsonl 分支不受 profile 引入影响。
		const dir = join(root, "plain");
		const localData = join(dir, "data");
		mkdirSync(localData, { recursive: true });
		// resolveSessionPath 的 cwd/data 分支要求该文件已存在。
		writeFileSync(join(localData, "session.jsonl"), "");
		expect(resolveSessionPath({ cwd: dir })).toBe(join(localData, "session.jsonl"));
	});
});

describe("resolveProfile：合法解析与目录契约", () => {
	it("合法 profile：目录自动创建、字段正确、persona 读取", async () => {
		await writeProfileDir("alice", validProfileJson, "# Alice 的底色");
		const profile = resolveProfile({ profileArg: "alice", cwd: root })!;

		expect(profile).toBeDefined();
		expect(profile.identity.subjectId).toBe("alice");
		expect(profile.identity.displayName).toBe("Alice");
		expect(profile.personaText).toBe("# Alice 的底色");
		expect(profile.sessions.journalPath).toBe(join(root, "profiles", "alice", "sessions", "session.jsonl"));
		expect(profile.resources.memoryRoot).toBe(join(root, "profiles", "alice", "memory"));
		expect(profile.resources.stateRoot).toBe(join(root, "profiles", "alice", "state"));
		expect(existsSync(profile.resources.memoryRoot)).toBe(true);
		expect(existsSync(profile.resources.stateRoot)).toBe(true);
		expect(existsSync(join(root, "profiles", "alice", "sessions"))).toBe(true);
	});

	it("persona.md 缺省时 personaText 为空字符串而非报错", async () => {
		await writeProfileDir("bob", JSON.stringify({ subjectId: "bob" }));
		const profile = resolveProfile({ profileArg: "bob", cwd: root })!;
		expect(profile.personaText).toBe("");
	});

	it("subjectId 与目录名不匹配 → 拒绝", async () => {
		await writeProfileDir("alice", JSON.stringify({ subjectId: "mallory" }));
		expect(() => resolveProfile({ profileArg: "alice", cwd: root })).toThrow(/subjectId/);
	});

	it("目录穿越 → 拒绝", () => {
		expect(() => resolveProfile({ profileArg: "../escape", cwd: root })).toThrow();
		expect(() => resolveProfile({ profileArg: "a/b/../c", cwd: root })).toThrow();
	});

	it("非法字符 → 拒绝", () => {
		expect(() => resolveProfile({ profileArg: "a b", cwd: root })).toThrow();
		expect(() => resolveProfile({ profileArg: "a:b", cwd: root })).toThrow();
		expect(() => resolveProfile({ profileArg: "..", cwd: root })).toThrow();
	});

	it("profile.json 缺失或非法 JSON → 明确报错", async () => {
		await mkdir(join(root, "profiles", "empty"), { recursive: true });
		expect(() => resolveProfile({ profileArg: "empty", cwd: root })).toThrow(/profile\.json/);

		await writeProfileDir("broken", "{ not json");
		expect(() => resolveProfile({ profileArg: "broken", cwd: root })).toThrow(/profile\.json/);
	});
});

describe("排他锁：一个数据根一个活动写入进程", () => {
	it("首次解析获得锁；锁文件存在且记录 ownerToken/PID", async () => {
		await writeProfileDir("alice", validProfileJson);
		const profile = resolveProfile({ profileArg: "alice", cwd: root })!;
		const lockPath = join(profile.resources.stateRoot, "host.lock");
		expect(existsSync(lockPath)).toBe(true);
		const raw = JSON.parse(await readFile(lockPath, "utf8")) as { ownerToken: string; pid: number };
		expect(typeof raw.ownerToken).toBe("string");
		expect(raw.ownerToken.length).toBeGreaterThan(0);
		expect(typeof raw.pid).toBe("number");
	});

	it("未释放时二次解析 → 明确报错且包含锁路径（不自动偷锁）", async () => {
		await writeProfileDir("alice", validProfileJson);
		resolveProfile({ profileArg: "alice", cwd: root })!;
		expect(() => resolveProfile({ profileArg: "alice", cwd: root })).toThrow(/host\.lock/);
	});

	it("releaseProfileLock 释放后可重新解析", async () => {
		await writeProfileDir("alice", validProfileJson);
		const profile: SubjectProfile = resolveProfile({ profileArg: "alice", cwd: root })!;
		await releaseProfileLock(profile);
		const again = resolveProfile({ profileArg: "alice", cwd: root })!;
		expect(again.identity.subjectId).toBe("alice");
	});

	it("不同 subjectId 的锁互不干扰", async () => {
		await writeProfileDir("alice", validProfileJson);
		await writeProfileDir("bob", JSON.stringify({ subjectId: "bob" }));
		const a = resolveProfile({ profileArg: "alice", cwd: root })!;
		const b = resolveProfile({ profileArg: "bob", cwd: root })!;
		expect(a.resources.stateRoot).not.toBe(b.resources.stateRoot);
		expect(a.sessions.journalPath).not.toBe(b.sessions.journalPath);
		expect(a.resources.memoryRoot).not.toBe(b.resources.memoryRoot);
		await releaseProfileLock(a);
		await releaseProfileLock(b);
	});
});

describe("Host 装配：双 profile 隔离（集成）", () => {
	it("A/B 同 cwd 同时持有 Host：sessionPath 全不同；无 profile 时路径不变", async () => {
		await writeProfileDir("alice", validProfileJson);
		await writeProfileDir("bob", JSON.stringify({ subjectId: "bob" }));
		const a = resolveProfile({ profileArg: "alice", cwd: root })!;
		const b = resolveProfile({ profileArg: "bob", cwd: root })!;

		const scenario = new Scenario({ id: "mock", name: "mock" });
		scenario.fallback(() => [{ kind: "text", text: "ok" }, { kind: "finish", reason: "stop" }]);

		const hostA = await UinaHost.create({ cwd: root, sessionPath: a.sessions.journalPath, profile: a, model: scenario.model, stream: scenario.stream, workspaceTools: false });
		try {
			const hostB = await UinaHost.create({ cwd: root, sessionPath: b.sessions.journalPath, profile: b, model: scenario.model, stream: scenario.stream, workspaceTools: false });
			try {
				// 双 Host 同时存活：各自 journal 路径不同，状态根不同。
				expect(a.sessions.journalPath).not.toBe(b.sessions.journalPath);
				expect(a.resources.stateRoot).not.toBe(b.resources.stateRoot);
			} finally {
				await hostB.dispose();
			}
		} finally {
			await hostA.dispose();
		}
		await releaseProfileLock(a);
		await releaseProfileLock(b);
	});
});
