/** MCP 扩展装配入口：临时目录创建 → catalog/manager 构造 → 代理工具注册；
 * teardown 时回收连接与临时目录（防孤儿文件）。 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionTeardown } from "../../../src/extensions/index.js";
import { McpCatalog } from "./catalog.js";
import { resolveMcpConfig, type McpConfigSnapshot, type ResolvedServerConfig } from "./config.js";
import { createMcpProxyTool } from "./proxy-tool.js";
import { McpServerManager } from "./server-manager.js";

/** 同进程多次 reload 防碰撞序号（配合 pid 保证目录唯一）。 */
let activationSeq = 0;

export default function activateMcp(api: ExtensionAPI): ExtensionTeardown {
	const seq = ++activationSeq;
	const tmpDir = join(tmpdir(), `uina-mcp-${process.pid}-${seq}`);
	mkdirSync(tmpDir, { recursive: true });

	const catalog = new McpCatalog();
	const manager = new McpServerManager({
		catalog,
		version: "0.1.0",
		onError: (message) => api.reportError(new Error(message)),
		configuredNames: () => {
			try {
				return new Set(resolveMcpConfig(api.cwd).servers.keys());
			} catch {
				// 配置暂时不可解析时保留咨询性目录，避免错误读盘触发清空。
				return undefined;
			}
		},
	});

	api.registerTool(createMcpProxyTool({ api, catalog, manager, tmpDir }));
	let snapshot: McpConfigSnapshot | undefined;
	try {
		snapshot = resolveMcpConfig(api.cwd);
	} catch (error) {
		api.reportError(error instanceof Error ? error : new Error(String(error)));
	}
	// 信息注入体系：全局已配置服务的名称与用途注册为简短 capability（替代旧 System
	// 追加索引）。read() 与 Proxy Tool 同一套只读 resolveMcpConfig() 按次解析，不启动
	// 服务、不刷新目录、不改信任状态；"已配置"不等于"已在线/已发现工具"，调用步骤由
	// Proxy 工具自身承载，这里不重复。项目级未信任配置不进常驻目录（信任门归 Proxy）。
	if (snapshot && buildCapabilityIndex(snapshot)) {
		api.provideContext({
			id: "capability",
			kind: "capability",
			read: () => {
				let current: McpConfigSnapshot;
				try {
					current = resolveMcpConfig(api.cwd);
				} catch {
					// 配置暂时不可解析：如实返回 null（不保留旧成功值），Proxy 的 status 可查。
					return null;
				}
				const text = buildCapabilityIndex(current);
				if (!text) return null;
				return { text, source: { type: "mcp.config", origin: "internal" } };
			},
		});
	}

	// 仅自动启动全局配置中显式 autoStart 的 server：全局配置已获信任，
	// 项目配置仍保留 UI 信任门并按需启动，避免启动阶段绕过安全确认。
	const warmup = (async () => {
		if (!snapshot) return;
		try {
			const servers = [...snapshot.servers.values()]
				.filter(
					(entry): entry is { kind: "valid"; config: ResolvedServerConfig } =>
						entry.kind === "valid" &&
						entry.config.source === "global" &&
						entry.config.definition.autoStart === true,
				)
				.map((entry) => entry.config);
			await manager.warmConfigured(servers, snapshot.idleTimeoutMs, snapshot.startupTimeoutMs);
		} catch (error) {
			api.reportError(error instanceof Error ? error : new Error(String(error)));
		}
	})();

	return async () => {
		// 先封锁并关闭 manager，让退出/重载可以打断仍在握手的 warm-up。
		const disposal = manager.dispose();
		await Promise.allSettled([warmup, disposal]);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// 临时目录回收尽力而为；不阻断扩展卸载。
		}
	};
}

/** 全局已配置服务的简短 capability 正文：与旧 System 索引同一授权范围（仅全局有效配置），
 * 不扩大到项目级未信任配置；"已配置不等于已在线"。 */
function buildCapabilityIndex(snapshot: McpConfigSnapshot): string | undefined {
	const services = [...snapshot.servers.entries()].filter(
		(entry): entry is [string, { kind: "valid"; config: ResolvedServerConfig }] =>
			entry[1].kind === "valid" && entry[1].config.source === "global",
	);
	if (services.length === 0) return undefined;
	const rows = services.map(([name]) => {
		const purposes = snapshot.mcpPurposes;
		const purpose = purposes && Object.hasOwn(purposes, name) ? purposes[name]!.replace(/\s+/g, " ").trim() : undefined;
		return `- ${name}：${purpose || "用途未说明，可通过 MCP 工具探索。"}`;
	});
	return [
		"以下 MCP 服务已配置（已配置不等于已在线或已发现工具；查询、连接与按需启动经 MCP 工具进行）：",
		...rows,
	].join("\n");
}
