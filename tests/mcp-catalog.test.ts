import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CatalogEntry, classifyEntry, fullName, McpCatalog } from "../.uina/extensions/mcp/catalog.js";
import { definitionFingerprint, type McpConfigSnapshot, type ResolvedServer } from "../.uina/extensions/mcp/config.js";

let dir: string;
let catalogPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "uina-mcp-catalog-"));
	catalogPath = join(dir, "mcp-catalog.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const TOOL = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } };

function entry(fingerprint: string, tools = [TOOL], extra: Partial<CatalogEntry> = {}): CatalogEntry {
	return { serverFingerprint: fingerprint, fetchedAt: Date.now(), tools, ...extra };
}

function snapshotWith(servers: Record<string, ResolvedServer>, idleTimeoutMs = 600_000): McpConfigSnapshot {
	return { servers: new Map(Object.entries(servers)), idleTimeoutMs };
}

function validServer(fingerprint: string): ResolvedServer {
	return {
		kind: "valid",
		config: {
			name: "srv",
			definition: { command: "unused" },
			source: "global",
			sourcePath: "test://mcp.json",
			fingerprint,
		},
	};
}

describe("加载与持久化", () => {
	it("无文件时为空目录", () => {
		const catalog = new McpCatalog(catalogPath);
		expect(catalog.size).toBe(0);
		expect(catalog.get("srv")).toBeUndefined();
	});

	it("commit 原子替换并落盘，新实例可恢复", () => {
		const fingerprint = definitionFingerprint({ command: "a" });
		const catalog = new McpCatalog(catalogPath);
		catalog.commit("srv", entry(fingerprint));
		expect(catalog.get("srv")?.serverFingerprint).toBe(fingerprint);

		const reloaded = new McpCatalog(catalogPath);
		expect(reloaded.get("srv")?.tools).toHaveLength(1);
		expect(reloaded.get("srv")?.tools[0]?.name).toBe("echo");
	});

	it("persist 按 configuredNames 清理 unconfigured 条目（内存与文件同步）", () => {
		const catalog = new McpCatalog(catalogPath);
		catalog.commit("kept", entry("fp-kept"));
		catalog.commit("ghost", entry("fp-ghost"));
		catalog.persist(new Set(["kept"]));
		expect(catalog.get("ghost")).toBeUndefined();
		expect(catalog.get("kept")).toBeDefined();

		const reloaded = new McpCatalog(catalogPath);
		expect(reloaded.get("ghost")).toBeUndefined();
		expect(reloaded.get("kept")).toBeDefined();
	});

	it("损坏文件容忍回空态", () => {
		writeFileSync(catalogPath, "{ not json");
		const catalog = new McpCatalog(catalogPath);
		expect(catalog.size).toBe(0);
	});

	it("结构不合法的条目与工具被过滤", () => {
		writeFileSync(
			catalogPath,
			JSON.stringify({
				version: 1,
				servers: {
					good: { serverFingerprint: "fp", fetchedAt: 1, tools: [{ name: "ok" }, { nope: true }, "junk"] },
					bad: { serverFingerprint: "fp" },
				},
			}),
		);
		const catalog = new McpCatalog(catalogPath);
		expect(catalog.get("good")?.tools).toEqual([{ name: "ok" }]);
		expect(catalog.get("bad")).toBeUndefined();
	});

	it("版本不匹配的持久化文件被拒绝", () => {
		writeFileSync(catalogPath, JSON.stringify({ version: 999, servers: { srv: entry("fp") } }));
		expect(new McpCatalog(catalogPath).size).toBe(0);
	});
});

describe("classifyEntry 状态判定", () => {
	it("未配置或 invalid server 一律 unconfigured", () => {
		const snapshot = snapshotWith({});
		expect(classifyEntry(entry("fp"), snapshot, "srv")).toEqual({ kind: "unconfigured" });
		const invalidSnapshot = snapshotWith({
			srv: { kind: "invalid", name: "srv", source: "global", sourcePath: "p", error: "bad" },
		});
		expect(classifyEntry(entry("fp"), invalidSnapshot, "srv")).toEqual({ kind: "unconfigured" });
	});

	it("指纹不匹配 → stale（配置已变更）", () => {
		const snapshot = snapshotWith({ srv: validServer("fp-new") });
		expect(classifyEntry(entry("fp-old"), snapshot, "srv")).toEqual({ kind: "stale", reason: "配置已变更" });
	});

	it("TTL 过期 → stale（已过期）；未过期 → fresh", () => {
		const fingerprint = "fp";
		const snapshot = snapshotWith({ srv: validServer(fingerprint) });
		expect(classifyEntry(entry(fingerprint, [TOOL], { expiresAt: Date.now() - 1 }), snapshot, "srv")).toEqual({
			kind: "stale",
			reason: "已过期",
		});
		expect(classifyEntry(entry(fingerprint, [TOOL], { expiresAt: Date.now() + 60_000 }), snapshot, "srv")).toEqual({
			kind: "fresh",
		});
		expect(classifyEntry(entry(fingerprint), snapshot, "srv")).toEqual({ kind: "fresh" });
	});
});

describe("fullName", () => {
	it("serverName.toolName", () => {
		expect(fullName("srv", "echo")).toBe("srv.echo");
	});
});

describe("持久化文件格式", () => {
	it("temp + rename 后文件内容为 versioned 快照", () => {
		const catalog = new McpCatalog(catalogPath);
		catalog.commit("srv", entry("fp"));
		const raw = JSON.parse(readFileSync(catalogPath, "utf-8")) as {
			version: number;
			servers: Record<string, CatalogEntry>;
		};
		expect(raw.version).toBe(1);
		expect(raw.servers.srv.serverFingerprint).toBe("fp");
	});
});
