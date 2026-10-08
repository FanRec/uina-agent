import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeploymentGrants } from "./grants.js";
import { parseDeploymentGrants } from "./grants.js";

/**
 * QQ World 部署配置。token 不落配置文件明文是首选：accessToken 留空时读
 * UINA_QQ_ACCESS_TOKEN 环境变量；两处都没有则启动失败。秘密不进入模型 schema、
 * 工具结果或普通日志。
 */

export interface QqConnectionConfig {
	readonly url: string;
	readonly role: "Universal";
	readonly accessToken: string;
	readonly requestTimeoutMs: number;
	readonly reconnect: { readonly retries: number; readonly minDelayMs: number; readonly maxDelayMs: number };
}

export interface QqWorldConfig {
	readonly connection: QqConnectionConfig;
	/** 绑定账号（QQ 号）；一个 World 绑定一个明确账号，登录身份不符阻止平台写入。 */
	readonly selfId: string;
	readonly grants: DeploymentGrants;
	/** 呈现选项（可缺省）：时区仅影响渲染，事实一律 UTC。 */
	readonly display?: { readonly timezone?: string; readonly batchBudgetChars?: number };
	/** 缺省允许 workspace cwd 与 worldDataDir；空数组明确禁用本地文件发送。 */
	readonly media?: { readonly allowedRoots: readonly string[] };
}

export interface ConfigLoadResult {
	readonly ok: true;
	readonly config: QqWorldConfig;
	readonly configDir: string;
}
export interface ConfigLoadError {
	readonly ok: false;
	readonly error: string;
}

interface RawConfig {
	connection?: Partial<QqConnectionConfig>;
	selfId?: unknown;
	deployment?: unknown;
	display?: unknown;
	media?: unknown;
}

export function loadQqWorldConfig(configPath?: string): ConfigLoadResult | ConfigLoadError {
	const here = dirname(fileURLToPath(import.meta.url));
	const path = resolve(configPath ?? join(here, "..", "config.json"));
	if (!existsSync(path)) {
		return { ok: false, error: `QQ World 配置不存在: ${path}` };
	}
	let raw: RawConfig;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
	} catch (error) {
		return {
			ok: false,
			error: `QQ World 配置不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const conn = raw.connection ?? {};
	const url = typeof conn.url === "string" && conn.url.length > 0 ? conn.url : "";
	if (!url) return { ok: false, error: "connection.url 缺失（OneBot v11 正向 WebSocket 端点）" };
	const role = conn.role === undefined || conn.role === "Universal" ? ("Universal" as const) : null;
	if (!role) return { ok: false, error: `connection.role 只支持 Universal，收到 ${JSON.stringify(conn.role)}` };
	const accessToken =
		process.env.UINA_QQ_ACCESS_TOKEN || (typeof conn.accessToken === "string" ? conn.accessToken : "");
	if (!accessToken) {
		return {
			ok: false,
			error: "访问令牌缺失：请在 config.json connection.accessToken 或环境变量 UINA_QQ_ACCESS_TOKEN 提供",
		};
	}
	const requestTimeoutMs =
		typeof conn.requestTimeoutMs === "number" && conn.requestTimeoutMs > 0 ? conn.requestTimeoutMs : 10000;
	const rawReconnect = conn.reconnect ?? { retries: 0, minDelayMs: 1000, maxDelayMs: 30000 };
	const reconnect = {
		retries: typeof rawReconnect.retries === "number" && rawReconnect.retries >= 0 ? rawReconnect.retries : 0,
		minDelayMs:
			typeof rawReconnect.minDelayMs === "number" && rawReconnect.minDelayMs > 0 ? rawReconnect.minDelayMs : 1000,
		maxDelayMs:
			typeof rawReconnect.maxDelayMs === "number" && rawReconnect.maxDelayMs > 0 ? rawReconnect.maxDelayMs : 30000,
	};

	let selfId: string | null = null;
	if (typeof raw.selfId === "number" && Number.isInteger(raw.selfId) && raw.selfId > 0) {
		selfId = String(raw.selfId);
	} else if (typeof raw.selfId === "string" && /^\d+$/.test(raw.selfId) && raw.selfId !== "0") {
		selfId = raw.selfId;
	}
	if (!selfId) {
		return { ok: false, error: "selfId 缺失或非法：QQ World 必须绑定一个明确账号（正整数 QQ 号）" };
	}

	if (raw.deployment === undefined) {
		return { ok: false, error: "deployment.grants 缺失：缺 deployment.grants 声明是启动失败（空数组合法）" };
	}
	const grants = parseDeploymentGrants(raw.deployment);
	if (!grants.ok) return { ok: false, error: `deployment 配置非法: ${grants.error}` };

	const rawDisplay = isObjectLike(raw.display) ? raw.display : undefined;
	let media: QqWorldConfig["media"];
	if (raw.media !== undefined) {
		if (
			!isObjectLike(raw.media) ||
			!Array.isArray(raw.media.allowedRoots) ||
			!raw.media.allowedRoots.every((root: unknown) => typeof root === "string" && isAbsolute(root))
		) {
			return { ok: false, error: "media.allowedRoots 必须是绝对路径数组（空数组合法）" };
		}
		media = { allowedRoots: raw.media.allowedRoots as string[] };
	}
	const display = rawDisplay
		? {
				timezone: typeof rawDisplay.timezone === "string" && rawDisplay.timezone ? rawDisplay.timezone : undefined,
				batchBudgetChars:
					typeof rawDisplay.batchBudgetChars === "number" && rawDisplay.batchBudgetChars > 0
						? rawDisplay.batchBudgetChars
						: undefined,
			}
		: undefined;

	return {
		ok: true,
		config: {
			connection: { url, role, accessToken, requestTimeoutMs, reconnect },
			selfId,
			grants: grants.grants,
			...(display ? { display } : {}),
			...(media ? { media } : {}),
		},
		configDir: dirname(path),
	};
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
