import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQqWorldConfig } from "../.uina/worlds/qq/src/config.js";
import { parseDeploymentGrants } from "../.uina/worlds/qq/src/grants.js";
import { requiredGrants } from "../.uina/worlds/qq/src/grants-vocabulary.js";
import { QQ_ACTION_SCHEMAS, QQ_TOOL_DESCRIPTION, QQ_TOOL_NAME } from "../.uina/worlds/qq/src/tool-schema.js";
import type { WorldDef } from "../src/extensions/world-framework/types.js";
import { createWorldTool } from "../src/extensions/world-framework/world-tool.js";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "qq-world-interaction-examples.json");
const TOOLDEF_PATH = join(import.meta.dirname, "..", ".uina", "worlds", "qq", "tool.json");

interface Fixture {
	validCalls: { id: string; arguments: Record<string, unknown> }[];
	invalidCalls: { id: string; arguments: Record<string, unknown> }[];
	deploymentCases: { valid: unknown[]; invalid: unknown[] };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const toolDef = JSON.parse(readFileSync(TOOLDEF_PATH, "utf8")) as {
	function: { name: string; description: string; parameters: unknown };
};

/** 与 world-framework 相同的 stub 动作集：run 只回执成功，用于隔离校验层。 */
function stubWorldDef(): WorldDef {
	const actions: WorldDef["actions"] = {};
	for (const [name, schema] of Object.entries(QQ_ACTION_SCHEMAS)) {
		actions[name] = {
			description: schema.description,
			parameters: structuredClone(schema.parameters) as Record<string, unknown>,
			run: () => ({ result: "stub-ok", status: "succeeded" as const }),
		};
	}
	return { name: QQ_TOOL_NAME, description: QQ_TOOL_DESCRIPTION, actions };
}

function runTool(args: Record<string, unknown>) {
	const tool = createWorldTool(stubWorldDef(), { getRuntime: () => ({ definition: stubWorldDef(), enabled: true }) });
	return tool.run(args, undefined);
}

describe("qq world: ToolDef 形状等价", () => {
	it("createWorldTool 生成的工具 schema 与 ToolDef 真源一致", () => {
		const tool = createWorldTool(stubWorldDef(), { getRuntime: () => ({ definition: stubWorldDef(), enabled: true }) });
		expect(tool.def.function.name).toBe(toolDef.function.name);
		expect(tool.def.function.description).toBe(toolDef.function.description);
		expect(tool.def.function.parameters).toEqual(toolDef.function.parameters);
	});
});

describe("qq world: validCalls 全部通过校验并执行", () => {
	for (const call of fixture.validCalls) {
		it(call.id, async () => {
			const result = await runTool(call.arguments);
			expect(result.status, JSON.stringify(result.result)).toBe("succeeded");
			expect(result.result).toBe("stub-ok");
		});
	}
});

describe("qq world: invalidCalls 全部被拒绝", () => {
	for (const call of fixture.invalidCalls) {
		it(call.id, async () => {
			const result = await runTool(call.arguments);
			expect(result.status, call.id).toBe("failed");
			expect(String(result.result)).toMatch(/参数错误|未知操作/);
		});
	}
});

describe("qq world: deployment grants 校验", () => {
	it("valid 用例通过", () => {
		for (const raw of fixture.deploymentCases.valid) {
			const parsed = parseDeploymentGrants(raw);
			expect(parsed.ok, JSON.stringify(raw)).toBe(true);
		}
	});
	it("invalid 用例全部拒绝", () => {
		for (const raw of fixture.deploymentCases.invalid) {
			const parsed = parseDeploymentGrants(raw);
			expect(parsed.ok, JSON.stringify(raw)).toBe(false);
		}
	});
	it("缺 deployment 对象按启动失败拒绝", () => {
		expect(parseDeploymentGrants(undefined).ok).toBe(false);
		expect(parseDeploymentGrants(null).ok).toBe(false);
	});
});

describe("qq world: grant 映射", () => {
	it("退役 action 全部返回 null（unknown 路径由 app 层拒绝）", () => {
		expect(requiredGrants("observe", { scope: "overview" })).toEqual([]);
		expect(requiredGrants("speak", {})).toEqual([]);
		expect(requiredGrants("gesture", {})).toEqual([]);
		expect(requiredGrants("attention", {})).toEqual([]);
		expect(requiredGrants("follow_up", {})).toEqual([]);
		expect(requiredGrants("account", { operation: "mark_read" })).toEqual([]);
	});
	it("消费积木：本地消费不需要 grant，push 写入与平台展开需要对应授权", () => {
		expect(requiredGrants("inbox", {})).toEqual(["observation"]);
		expect(requiredGrants("inbox", { focus: [] })).toEqual(["observation"]);
		expect(requiredGrants("inbox", { push: { target: "account", mode: "off" } })).toEqual([
			"observation",
			"attention.manage",
		]);
		expect(requiredGrants("read", { conversationRef: "p1" })).toEqual([]);
		expect(requiredGrants("read", { conversationRef: "p1", includeMedia: true })).toEqual(["observation"]);
		expect(requiredGrants("skip", { conversationRef: "p1" })).toEqual([]);
		expect(requiredGrants("browse", { conversationRef: "p1", direction: "latest" })).toEqual([]);
		expect(requiredGrants("browse", { messageRefs: ["m1"] })).toEqual(["observation"]);
		expect(requiredGrants("browse", { contentTarget: { messageRef: "m1" } })).toEqual(["observation"]);
	});
	it("行动积木：复用旧链路的 grant 语义", () => {
		expect(requiredGrants("send", {})).toEqual(["messaging"]);
		expect(requiredGrants("interact", { action: "poke" })).toEqual(["interaction"]);
		expect(requiredGrants("interact", { action: "react" })).toEqual(["interaction"]);
		expect(requiredGrants("interact", { action: "retract" })).toEqual(["messages.retract"]);
		expect(requiredGrants("remind", {})).toEqual([]);
		expect(requiredGrants("remind", { action: "list" })).toEqual([]);
		expect(requiredGrants("remind", { action: "create", targetRef: "p1" })).toEqual(["follow_up.manage"]);
		expect(requiredGrants("remind", { action: "resolve", remindRef: "f1" })).toEqual(["follow_up.manage"]);
		expect(requiredGrants("requests", {})).toEqual(["observation"]);
		expect(requiredGrants("requests", { action: "list" })).toEqual(["observation"]);
		expect(requiredGrants("requests", { action: "respond", requestRef: "r1" })).toEqual(["requests.respond"]);
		expect(requiredGrants("profile", {})).toEqual(["observation"]);
		expect(requiredGrants("profile", { action: "get" })).toEqual(["observation"]);
		expect(requiredGrants("profile", { action: "set_card", conversationRef: "g1" })).toEqual(["profile.modify"]);
		expect(requiredGrants("profile", { action: "set_avatar", avatarPath: "x" })).toEqual(["profile.modify"]);
	});
});

describe("qq world: 配置加载", () => {
	const dir = join(tmpdir(), `uina-qq-config-test-${process.pid}`);
	beforeEach(() => mkdirSync(dir, { recursive: true }));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function writeConfig(raw: unknown): string {
		const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(path, JSON.stringify(raw));
		return path;
	}
	const baseConn = { url: "ws://127.0.0.1:3001", accessToken: "tok" };
	const full = { connection: baseConn, selfId: 10001, deployment: { grants: ["observation"] } };

	it("完整配置通过", () => {
		const loaded = loadQqWorldConfig(writeConfig(full));
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.config.selfId).toBe("10001");
			expect(loaded.config.connection.role).toBe("Universal");
		}
	});
	it("缺 deployment.grants 是启动失败；空数组合法", () => {
		const missing = loadQqWorldConfig(writeConfig({ connection: baseConn, selfId: 10001 }));
		expect(missing.ok).toBe(false);
		const empty = loadQqWorldConfig(writeConfig({ ...full, deployment: { grants: [] } }));
		expect(empty.ok).toBe(true);
	});
	it("未知 grant 名与重复项拒绝", () => {
		expect(loadQqWorldConfig(writeConfig({ ...full, deployment: { grants: ["*"] } })).ok).toBe(false);
		expect(loadQqWorldConfig(writeConfig({ ...full, deployment: { grants: ["messaging", "messaging"] } })).ok).toBe(
			false,
		);
	});
	it("selfId 缺失/非正整数失败", () => {
		expect(loadQqWorldConfig(writeConfig({ connection: baseConn, deployment: { grants: [] } })).ok).toBe(false);
		expect(loadQqWorldConfig(writeConfig({ ...full, selfId: 0 })).ok).toBe(false);
	});
	it("环境变量令牌覆盖配置文件", () => {
		const prev = process.env.UINA_QQ_ACCESS_TOKEN;
		process.env.UINA_QQ_ACCESS_TOKEN = "env-token";
		try {
			const loaded = loadQqWorldConfig(writeConfig({ ...full, connection: { url: baseConn.url } }));
			expect(loaded.ok).toBe(true);
			if (loaded.ok) expect(loaded.config.connection.accessToken).toBe("env-token");
		} finally {
			if (prev === undefined) delete process.env.UINA_QQ_ACCESS_TOKEN;
			else process.env.UINA_QQ_ACCESS_TOKEN = prev;
		}
	});
	it("无任何令牌来源失败", () => {
		const prev = process.env.UINA_QQ_ACCESS_TOKEN;
		delete process.env.UINA_QQ_ACCESS_TOKEN;
		try {
			const loaded = loadQqWorldConfig(writeConfig({ ...full, connection: { url: baseConn.url } }));
			expect(loaded.ok).toBe(false);
		} finally {
			if (prev !== undefined) process.env.UINA_QQ_ACCESS_TOKEN = prev;
		}
	});
});
