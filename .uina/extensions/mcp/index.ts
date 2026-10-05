/** MCP 扩展装配入口：临时目录创建 → catalog/manager 构造 → 代理工具注册；
 * teardown 时回收连接与临时目录（防孤儿文件）。 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionTeardown } from "../../../src/extensions/index.js";
import { McpCatalog } from "./catalog.js";
import { resolveMcpConfig, type ResolvedServerConfig } from "./config.js";
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

	// 仅自动启动全局配置中显式 autoStart 的 server：全局配置已获信任，
	// 项目配置仍保留 UI 信任门并按需启动，避免启动阶段绕过安全确认。
	const warmup = (async () => {
		try {
			const snapshot = resolveMcpConfig(api.cwd);
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
