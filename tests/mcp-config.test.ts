import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	approveProjectServer,
	canonicalProjectRoot,
	definitionFingerprint,
	describeServerForDisplay,
	getGlobalUinaDir,
	globalConfigPath,
	hasSensitiveCredentials,
	isProjectServerTrusted,
	McpConfigError,
	projectConfigPath,
	resolveMcpConfig,
	sanitizeEndpointForDisplay,
	trustRecordPath,
	urlCarriesCredentials,
	validateServerDefinition,
} from "../.uina/extensions/mcp/config.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "uina-mcp-config-"));
	// 项目 cwd 与 UINA_HOME 分离：否则 home/.uina/mcp.json 会被 projectConfigPath 优先命中。
	cwd = mkdtempSync(join(tmpdir(), "uina-mcp-config-cwd-"));
	process.env.UINA_HOME = home;
});

afterEach(() => {
	delete process.env.UINA_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function writeGlobalConfig(config: unknown): void {
	mkdirSync(join(home, ".uina"), { recursive: true });
	writeFileSync(globalConfigPath(), JSON.stringify(config));
}

function writeProjectConfig(cwd: string, config: unknown, dirName = ".uina"): void {
	mkdirSync(join(cwd, dirName), { recursive: true });
	writeFileSync(join(cwd, dirName, "mcp.json"), JSON.stringify(config));
}

describe("全局目录与 UINA_HOME", () => {
	it("UINA_HOME 作为主目录替身，.uina 由代码追加", () => {
		expect(getGlobalUinaDir()).toBe(join(home, ".uina"));
		expect(globalConfigPath()).toBe(join(home, ".uina", "mcp.json"));
		expect(trustRecordPath()).toBe(join(home, ".uina", "mcp-trust.json"));
	});
});

describe("resolveMcpConfig 两层发现", () => {
	it("两层皆空：默认 idleTimeoutMs 600000，无超时覆盖", () => {
		const snapshot = resolveMcpConfig(cwd);
		expect(snapshot.servers.size).toBe(0);
		expect(snapshot.idleTimeoutMs).toBe(600_000);
		expect(snapshot.callTimeoutMs).toBeUndefined();
		expect(snapshot.startupTimeoutMs).toBeUndefined();
	});

	it("全局 server 解析出指纹与来源", () => {
		writeGlobalConfig({ mcpServers: { srv: { command: "echo", args: ["hi"] } } });
		const snapshot = resolveMcpConfig(cwd);
		const resolved = snapshot.servers.get("srv");
		expect(resolved?.kind).toBe("valid");
		if (resolved?.kind !== "valid") return;
		expect(resolved.config.source).toBe("global");
		expect(resolved.config.fingerprint).toBe(definitionFingerprint({ command: "echo", args: ["hi"] }));
	});

	it("项目级同名 server 原子替换全局定义，绝不 deep merge", () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-proj-"));
		try {
			writeGlobalConfig({ mcpServers: { srv: { command: "a", env: { SECRET: "x" } } } });
			writeProjectConfig(cwd, { mcpServers: { srv: { command: "b" } } });
			const snapshot = resolveMcpConfig(cwd);
			const resolved = snapshot.servers.get("srv");
			expect(resolved?.kind).toBe("valid");
			if (resolved?.kind !== "valid") return;
			expect(resolved.config.definition).toEqual({ command: "b" });
			expect(resolved.config.source).toBe("project");
			expect(resolved.config.fingerprint).toBe(definitionFingerprint({ command: "b" }));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("非法定义保留遮蔽，绝不 fallback 到低优先级同名 server", () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-shadow-"));
		try {
			writeGlobalConfig({ mcpServers: { srv: { command: "good" } } });
			writeProjectConfig(cwd, { mcpServers: { srv: { command: "bad", url: "https://x" } } });
			const snapshot = resolveMcpConfig(cwd);
			const resolved = snapshot.servers.get("srv");
			expect(resolved?.kind).toBe("invalid");
			if (resolved?.kind !== "invalid") return;
			expect(resolved.error).toContain("不能同时声明");
			expect(resolved.source).toBe("project");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("解析失败整体阻断（不静默降级）", () => {
		mkdirSync(join(home, ".uina"), { recursive: true });
		writeFileSync(globalConfigPath(), "{ broken");
		expect(() => resolveMcpConfig(home)).toThrow(McpConfigError);
	});

	it("mcpServers 非对象整体阻断", () => {
		writeGlobalConfig({ mcpServers: 42 });
		expect(() => resolveMcpConfig(home)).toThrow(McpConfigError);
	});

	it("非法调优值整体阻断", () => {
		writeGlobalConfig({ idleTimeoutMs: -1 });
		expect(() => resolveMcpConfig(home)).toThrow(McpConfigError);
		writeGlobalConfig({ callTimeoutMs: "soon" });
		expect(() => resolveMcpConfig(home)).toThrow(McpConfigError);
		writeGlobalConfig({ startupTimeoutMs: 1.5 });
		expect(() => resolveMcpConfig(home)).toThrow(McpConfigError);
	});

	it("项目级调优覆盖全局", () => {
		const cwd = mkdtempSync(join(tmpdir(), "uina-mcp-tuning-"));
		try {
			writeGlobalConfig({
				mcpServers: {},
				idleTimeoutMs: 1000,
				callTimeoutMs: 5000,
				startupTimeoutMs: 3000,
			});
			writeProjectConfig(cwd, { idleTimeoutMs: 2000, callTimeoutMs: 7000 });
			const snapshot = resolveMcpConfig(cwd);
			expect(snapshot.idleTimeoutMs).toBe(2000);
			expect(snapshot.callTimeoutMs).toBe(7000);
			// 项目未声明的项保留全局值。
			expect(snapshot.startupTimeoutMs).toBe(3000);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("projectConfigPath", () => {
	it("首选 .uina/mcp.json", () => {
		writeProjectConfig(home, { mcpServers: {} });
		const found = projectConfigPath(home);
		expect(found?.exists).toBe(true);
		expect(found?.path).toBe(join(home, ".uina", "mcp.json"));
	});

	it("回退 .mcp.json", () => {
		writeFileSync(join(home, ".mcp.json"), "{}");
		const found = projectConfigPath(home);
		expect(found?.path).toBe(join(home, ".mcp.json"));
	});

	it("两层都不存在为 undefined", () => {
		expect(projectConfigPath(home)).toBeUndefined();
	});
});

describe("validateServerDefinition", () => {
	it("stdio 定义放行", () => {
		expect(
			validateServerDefinition("s", { command: "npx", args: ["-y", "srv"], inheritEnv: false, autoStart: true }),
		).toEqual({
			command: "npx",
			args: ["-y", "srv"],
			inheritEnv: false,
			autoStart: true,
		});
	});

	it("http 定义放行", () => {
		expect(validateServerDefinition("s", { url: "https://example.com/mcp", httpTransport: "sse" })).toEqual({
			url: "https://example.com/mcp",
			httpTransport: "sse",
		});
	});

	it("非法形态返回原因字符串", () => {
		expect(typeof validateServerDefinition("s", {})).toBe("string");
		expect(validateServerDefinition("s", { url: "ftp://x" })).toContain("http/https");
		expect(validateServerDefinition("s", { command: "a", url: "https://x" })).toContain("不能同时声明");
		expect(validateServerDefinition("s", { url: "https://x", args: ["x"] })).toContain("不能同时声明");
		expect(validateServerDefinition("s", { command: "a", args: [1] })).toContain("字符串数组");
		expect(validateServerDefinition("s", { command: "a", env: { K: 1 } })).toContain("字符串映射");
		expect(validateServerDefinition("s", { command: "a", autoStart: "yes" })).toContain("autoStart");
		expect(validateServerDefinition("s", { url: "https://x", headers: { K: 1 } })).toContain("字符串映射");
		expect(validateServerDefinition("s", { url: "https://x", httpTransport: "grpc" })).toContain("httpTransport");
		expect(validateServerDefinition("s", { command: "a", unknownField: 1 })).toEqual({ command: "a" });
		// 未知字段提示只出现在错误信息中。
		expect(validateServerDefinition("s", { unknownField: 1 })).toContain("未知字段");
	});
});

describe("definitionFingerprint", () => {
	it("键顺序无关、undefined 字段等价于缺省", () => {
		const left = definitionFingerprint({ command: "a", args: ["x"] });
		const right = definitionFingerprint({ args: ["x"], command: "a" } as never);
		const withUndefined = definitionFingerprint({ command: "a", args: ["x"], env: undefined });
		expect(left).toBe(right);
		expect(left).toBe(withUndefined);
	});

	it("内容变化即指纹变化", () => {
		expect(definitionFingerprint({ command: "a" })).not.toBe(definitionFingerprint({ command: "b" }));
	});
});

describe("项目信任门", () => {
	it("批准后信任同指纹，指纹或 server 变化即不信任", () => {
		const cwd = canonicalProjectRoot(home);
		expect(isProjectServerTrusted(home, "srv", "fp-1")).toBe(false);
		approveProjectServer(home, "srv", "fp-1");
		expect(isProjectServerTrusted(home, "srv", "fp-1")).toBe(true);
		expect(isProjectServerTrusted(home, "srv", "fp-2")).toBe(false);
		expect(isProjectServerTrusted(home, "other", "fp-1")).toBe(false);
		expect(cwd.length).toBeGreaterThan(0);
	});

	it("重新批准覆盖同 server 旧指纹（单条记录）", () => {
		approveProjectServer(home, "srv", "fp-1");
		approveProjectServer(home, "srv", "fp-2");
		expect(isProjectServerTrusted(home, "srv", "fp-1")).toBe(false);
		expect(isProjectServerTrusted(home, "srv", "fp-2")).toBe(true);
		const store = JSON.parse(readFileSync(trustRecordPath(), "utf-8")) as { approvals: unknown[] };
		expect(store.approvals).toHaveLength(1);
	});

	it("信任记录损坏回保守空态", () => {
		approveProjectServer(home, "srv", "fp-1");
		writeFileSync(trustRecordPath(), "{ broken");
		expect(isProjectServerTrusted(home, "srv", "fp-1")).toBe(false);
		// 空态之上可以重新批准。
		approveProjectServer(home, "srv", "fp-1");
		expect(isProjectServerTrusted(home, "srv", "fp-1")).toBe(true);
	});
});

describe("脱敏", () => {
	it("sanitizeEndpointForDisplay 屏蔽 userinfo 密码、query value 与 fragment", () => {
		expect(sanitizeEndpointForDisplay("https://user:pass@example.com/p?token=abc&x=1#frag")).toBe(
			"https://user:<redacted>@example.com/p?token=<redacted>&x=<redacted>",
		);
		expect(sanitizeEndpointForDisplay("https://example.com/p")).toBe("https://example.com/p");
		expect(sanitizeEndpointForDisplay("not a url")).toBe("<redacted>");
	});

	it("urlCarriesCredentials：userinfo 或任意 query param 即为携带凭据", () => {
		expect(urlCarriesCredentials("https://user@example.com")).toBe(true);
		expect(urlCarriesCredentials("https://example.com/p?token=abc")).toBe(true);
		expect(urlCarriesCredentials("https://example.com/p")).toBe(false);
		expect(urlCarriesCredentials("::::")).toBe(true);
	});

	it("hasSensitiveCredentials：headers 非空或 URL 带凭据", () => {
		expect(hasSensitiveCredentials({ url: "https://x", headers: { Authorization: "Bearer t" } })).toBe(true);
		expect(hasSensitiveCredentials({ url: "https://x?token=abc" })).toBe(true);
		expect(hasSensitiveCredentials({ url: "https://x" })).toBe(false);
	});

	it("describeServerForDisplay 绝不回显 env 值或未脱敏 URL", () => {
		const stdio = describeServerForDisplay({ command: "npx", args: ["-y", "srv"], env: { API_KEY: "secret" } });
		expect(stdio).toContain('"npx"');
		expect(stdio).toContain("API_KEY");
		expect(stdio).not.toContain("secret");
		const http = describeServerForDisplay({ url: "https://u:p@example.com?token=abc" });
		expect(http).toContain("<redacted>");
		expect(http).not.toContain("p@");
	});
});
