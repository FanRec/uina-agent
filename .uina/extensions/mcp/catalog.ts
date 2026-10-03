/** 咨询性持久工具目录（Advisory Persistent Catalog）：
 * 保存最近一次认知到的 MCP 能力快照；stale 仍可发现但如实标记；unconfigured 条目不可见。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { catalogRecordPath, type McpConfigSnapshot } from "./config.js";

const CATALOG_VERSION = 1;

export interface CatalogTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	/** server 自报、未经验证；仅作执行后审计元数据（D11）。 */
	annotations?: Record<string, unknown>;
}

export interface CatalogEntry {
	serverFingerprint: string;
	/** 能力发生变化但尚未成功重新校准；仍保留旧快照供诊断。 */
	stale?: boolean;
	cacheScope?: "public" | "private";
	fetchedAt: number;
	/** 仅当 tools/list 显式返回 _meta.ttlMs 时记录；缺省无时间老化（对齐 Pi maxAgeMs = 0）。 */
	expiresAt?: number;
	tools: CatalogTool[];
}

/** 模型可见三态 + 内部 unconfigured（不可见）。 */
export type EntryStatus =
	| { kind: "unconfigured" }
	| { kind: "stale"; reason: "配置已变更" | "已过期" | "能力已变更" }
	| { kind: "fresh" };

export class McpCatalog {
	private readonly servers = new Map<string, CatalogEntry>();

	constructor(private readonly path: string = catalogRecordPath()) {
		if (!existsSync(path)) return;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; servers?: unknown };
			if (parsed.version !== CATALOG_VERSION || typeof parsed.servers !== "object" || parsed.servers === null) return;
			for (const [name, entry] of Object.entries(parsed.servers as Record<string, unknown>)) {
				const valid = this.validEntry(entry);
				if (valid) this.servers.set(name, valid);
			}
		} catch {
			// 目录损坏不阻断：advisory cache 回到空态重建。
		}
	}

	private validEntry(value: unknown): CatalogEntry | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const entry = value as Partial<CatalogEntry>;
		if (typeof entry.serverFingerprint !== "string") return undefined;
		if (typeof entry.fetchedAt !== "number") return undefined;
		if (!Array.isArray(entry.tools)) return undefined;
		const tools = entry.tools.filter(
			(tool): tool is CatalogTool =>
				typeof tool === "object" && tool !== null && typeof (tool as CatalogTool).name === "string",
		);
		return {
			serverFingerprint: entry.serverFingerprint,
			...(entry.stale === true ? { stale: true } : {}),
			...(entry.cacheScope === "public" || entry.cacheScope === "private" ? { cacheScope: entry.cacheScope } : {}),
			fetchedAt: entry.fetchedAt,
			...(typeof entry.expiresAt === "number" ? { expiresAt: entry.expiresAt } : {}),
			tools,
		};
	}

	get(serverName: string): CatalogEntry | undefined {
		return this.servers.get(serverName);
	}

	entries(): Array<[string, CatalogEntry]> {
		return [...this.servers.entries()];
	}

	get size(): number {
		return this.servers.size;
	}

	/** 原子替换单 server 条目并持久化；顺带清理 unconfigured 条目。 */
	commit(serverName: string, entry: CatalogEntry, configuredNames?: ReadonlySet<string>): void {
		this.servers.set(serverName, entry);
		this.persist(configuredNames);
	}

	/** 标记能力快照失效但保留旧工具，供下一次调用走前置校准。 */
	markStale(serverName: string, configuredNames?: ReadonlySet<string>): void {
		const entry = this.servers.get(serverName);
		if (!entry || entry.stale) return;
		this.servers.set(serverName, { ...entry, stale: true });
		this.persist(configuredNames);
	}

	/** temp 文件 + 原子 rename，绝不出现半个目录。 */
	persist(configuredNames?: ReadonlySet<string>): void {
		const next: Record<string, CatalogEntry> = {};
		for (const [name, entry] of this.servers) {
			if (configuredNames && !configuredNames.has(name)) continue;
			next[name] = entry;
		}
		this.servers.clear();
		for (const [name, entry] of Object.entries(next)) this.servers.set(name, entry);
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: CATALOG_VERSION, servers: next }, null, 2)}\n`, "utf-8");
		renameSync(temporary, this.path);
	}
}

/** 统一状态判定（先准入、再指纹、再 TTL）。invalid server 由调用方提前分派，不进此处。 */
export function classifyEntry(entry: CatalogEntry, snapshot: McpConfigSnapshot, serverName: string): EntryStatus {
	const resolved = snapshot.servers.get(serverName);
	if (!resolved || resolved.kind === "invalid") return { kind: "unconfigured" };
	if (entry.stale) return { kind: "stale", reason: "能力已变更" };
	if (entry.serverFingerprint !== resolved.config.fingerprint) return { kind: "stale", reason: "配置已变更" };
	if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) return { kind: "stale", reason: "已过期" };
	return { kind: "fresh" };
}

export function fullName(serverName: string, toolName: string): string {
	return `${serverName}.${toolName}`;
}
