/**
 * SubjectProfile：主体身份、路径解析与独占锁。
 *
 * 核心不变量：
 * 1. subjectId ↔ 目录绑定不可变；路径解析抗目录穿越；
 * 2. 每个数据根恰好一个活动写入进程（wx 排他锁 + ownerToken/PID）；
 * 3. 无 --profile 时，全部现有路径解析行为逐字节不变（对照测试锁定）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionPath } from "../src/cli/session-path.js";
import { defaultSystemPrompt } from "../src/agent/context.js";
import { EVENT_FRAME_PROMPT } from "../src/extensions/event-frames/index.js";
import { UinaHost } from "../src/host/host.js";
import { releaseProfileLock, resolveProfile, type SubjectProfile } from "../src/host/profile.js";
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

describe("内置默认 System 资源（S1 A1 迁移一致性锚点）", () => {
	it("默认正文与迁移前的内联常量逐字一致（开头、章节与结尾锁定）", () => {
		const text = defaultSystemPrompt();
		expect(text.startsWith("# 初奈\n\n你是初奈（Uina）。")).toBe(true);
		for (const section of ["## 本色", "## 注意力", "## 行动与探索", "## 学习与延续", "## 相处与表达", "## 现实与关系"])
			expect(text).toContain(section);
		expect(text.endsWith("你还有尚未认识的世界。")).toBe(true);
		// 迁移不引入额外段落：Persona 层已删除，默认正文不含 persona 痕迹。
		expect(text.toLowerCase()).not.toContain("persona");
		expect(text).not.toContain(EVENT_FRAME_PROMPT);
	});
});

describe("resolveProfile：合法解析与目录契约", () => {
	it("合法 profile：目录自动创建、字段正确；不再携带 Persona 层", async () => {
		await writeProfileDir("alice", validProfileJson);
		const profile = resolveProfile({ profileArg: "alice", cwd: root })!;

		expect(profile).toBeDefined();
		expect(profile.identity.subjectId).toBe("alice");
		expect(profile.identity.displayName).toBe("Alice");
		expect(profile.sessions.journalPath).toBe(join(root, "profiles", "alice", "sessions", "session.jsonl"));
		expect(profile.resources.memoryRoot).toBe(join(root, "profiles", "alice", "memory"));
		expect(profile.resources.stateRoot).toBe(join(root, "profiles", "alice", "state"));
		expect(existsSync(profile.resources.memoryRoot)).toBe(true);
		expect(existsSync(profile.resources.stateRoot)).toBe(true);
		expect(existsSync(join(root, "profiles", "alice", "sessions"))).toBe(true);
	});

	it("旧 persona.md 非空且未迁移出 system.md → 报可操作的迁移指引，不静默丢弃", async () => {
		await writeProfileDir("alice", validProfileJson, "# Alice 的底色");
		expect(() => resolveProfile({ profileArg: "alice", cwd: root })).toThrow(/persona\.md/);
		expect(() => resolveProfile({ profileArg: "alice", cwd: root })).toThrow(/migrate-persona/);
	});

	it("persona.md 为空白时不算未迁移，正常解析", async () => {
		await writeProfileDir("bob", JSON.stringify({ subjectId: "bob" }), "   \n  ");
		const profile = resolveProfile({ profileArg: "bob", cwd: root })!;
		expect(profile.identity.subjectId).toBe("bob");
		await releaseProfileLock(profile);
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

describe("Host 装配：System 资源选择（S1 §3.1）", () => {
	const newScenario = (): Scenario => {
		const scenario = new Scenario({ id: "mock", name: "mock" });
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);
		return scenario;
	};

	it("Profile system.md 选中：正文以文件内容为来源，Event Frame 协议段在主体段之后", async () => {
		const dir = await writeProfileDir("alice", validProfileJson);
		await writeFile(join(dir, "system.md"), "# Alice 的主体 System\n自我条款：不当工具。", "utf8");
		const profile = resolveProfile({ profileArg: "alice", cwd: root })!;

		const scenario = newScenario();
		const host = await UinaHost.create({
			cwd: root,
			sessionPath: profile.sessions.journalPath,
			profile,
			model: scenario.model,
			stream: scenario.stream,
			workspaceTools: false,
		});
		try {
			await host.start();
			await host.submitText("ping", "direct");

			const systemMsg = scenario.calls[0]?.messages.find((m) => m.role === "system");
			expect(systemMsg).toBeDefined();
			const systemText = String(systemMsg?.content);
			// 主体段来自 profile 文件；默认投影的 Event Frame 协议段仍完整附加（不能被绕掉）。
			expect(systemText.startsWith("# Alice 的主体 System")).toBe(true);
			expect(systemText).toContain("不当工具");
			expect(systemText).toContain(EVENT_FRAME_PROMPT);
			expect(systemText.indexOf("# Alice 的主体 System")).toBeLessThan(systemText.indexOf(EVENT_FRAME_PROMPT));
			// 资源版本与来源随快照可查。
			expect(host.getSystemSnapshot().source).toBe("profile:alice");
		} finally {
			await host.dispose();
		}
		await releaseProfileLock(profile);
	});

	it("无 Profile system.md 时选中工作区 .uina/system.md；都不存在时使用内置默认", async () => {
		await mkdir(join(root, ".uina"), { recursive: true });
		await writeFile(join(root, ".uina", "system.md"), "# 工作区覆盖 System", "utf8");
		const scenario = newScenario();
		const host = await UinaHost.create({
			cwd: root,
			model: scenario.model,
			stream: scenario.stream,
			workspaceTools: false,
		});
		try {
			await host.start();
			await host.submitText("ping", "direct");
			const systemText = String(scenario.calls[0]?.messages.find((m) => m.role === "system")?.content);
			expect(systemText.startsWith("# 工作区覆盖 System")).toBe(true);
			expect(systemText).toContain(EVENT_FRAME_PROMPT);
			expect(host.getSystemSnapshot().source).toBe("workspace");
		} finally {
			await host.dispose();
		}
	});

	it("Host 显式 systemPrompt 只覆盖主体段，默认 Event Frame 协议说明不被删除", async () => {
		const scenario = newScenario();
		const host = await UinaHost.create({
			cwd: root,
			systemPrompt: "# 嵌入方主体段",
			model: scenario.model,
			stream: scenario.stream,
			workspaceTools: false,
		});
		try {
			await host.start();
			await host.submitText("ping", "direct");
			const systemText = String(scenario.calls[0]?.messages.find((m) => m.role === "system")?.content);
			expect(systemText.startsWith("# 嵌入方主体段")).toBe(true);
			expect(systemText).toContain(EVENT_FRAME_PROMPT);
			expect(host.getSystemSnapshot().source).toBe("host-explicit");
		} finally {
			await host.dispose();
		}
	});

	it("已存在但为空的 system.md → 启动报配置错误，不静默回退", async () => {
		const dir = await writeProfileDir("alice", validProfileJson);
		await writeFile(join(dir, "system.md"), "   \n", "utf8");
		const profile = resolveProfile({ profileArg: "alice", cwd: root })!;
		const scenario = newScenario();
		await expect(
			UinaHost.create({
				cwd: root,
				sessionPath: profile.sessions.journalPath,
				profile,
				model: scenario.model,
				stream: scenario.stream,
				workspaceTools: false,
			}),
		).rejects.toThrow(/system\.md/);
		await releaseProfileLock(profile);
	});
});

describe("Host 装配：双 profile 隔离（集成）", () => {
	it("A/B 同 cwd 同时持有 Host：sessionPath 全不同；无 profile 时路径不变", async () => {
		await writeProfileDir("alice", validProfileJson);
		await writeProfileDir("bob", JSON.stringify({ subjectId: "bob" }));
		const a = resolveProfile({ profileArg: "alice", cwd: root })!;
		const b = resolveProfile({ profileArg: "bob", cwd: root })!;

		const scenario = new Scenario({ id: "mock", name: "mock" });
		scenario.fallback(() => [
			{ kind: "text", text: "ok" },
			{ kind: "finish", reason: "stop" },
		]);

		const hostA = await UinaHost.create({
			cwd: root,
			sessionPath: a.sessions.journalPath,
			profile: a,
			model: scenario.model,
			stream: scenario.stream,
			workspaceTools: false,
		});
		try {
			const hostB = await UinaHost.create({
				cwd: root,
				sessionPath: b.sessions.journalPath,
				profile: b,
				model: scenario.model,
				stream: scenario.stream,
				workspaceTools: false,
			});
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
