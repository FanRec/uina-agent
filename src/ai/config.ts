/**
 * 配置读取：~/.uina/auth.json（镜像 pi 的 ~/.pi/agent/auth.json 形态）。
 * 结构：{ default, providers: { <name>: { baseUrl, apiKey, model } } }
 * apiKey 可被环境变量 UINA_API_KEY_<NAME大写> 覆盖（避免敏感信息写盘）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	contextWindow?: number;
	maxRetries?: number;
}

export interface UinaConfig {
	default: string;
	providers: Record<string, ProviderConfig>;
}

/** 配置目录：UINA_HOME 环境变量可覆盖（测试用），默认 ~/.uina */
export function configPath(): string {
	const home = process.env.UINA_HOME ?? homedir();
	return join(home, ".uina", "auth.json");
}

export function loadConfig(): UinaConfig {
	const p = configPath();
	if (!existsSync(p)) {
		throw new Error(`找不到配置 ${p}，请按仓库 README 创建 ~/.uina/auth.json`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		throw new Error(`配置文件 ${p} 不是合法 JSON：${(e as Error).message}`);
	}
	const raw = validateConfig(parsed, p);
	for (const [name, prov] of Object.entries(raw.providers)) {
		const envKey = process.env[`UINA_API_KEY_${name.toUpperCase()}`];
		if (envKey !== undefined) prov.apiKey = envKey;
	}
	return raw;
}

function validateConfig(value: unknown, path: string): UinaConfig {
	if (!value || typeof value !== "object") {
		throw new Error(`配置 ${path} 顶层必须是对象`);
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.default !== "string" || !raw.default.trim()) {
		throw new Error(`配置 ${path} 缺少非空 default`);
	}
	if (!raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) {
		throw new Error(`配置 ${path} 的 providers 必须是对象`);
	}
	const providers: Record<string, ProviderConfig> = {};
	for (const [name, value] of Object.entries(raw.providers as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`配置 ${path} 的 provider ${name} 必须是对象`);
		}
		const provider = value as Record<string, unknown>;
		if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
			throw new Error(`配置 ${path} 的 provider ${name} 缺少 baseUrl`);
		}
		if (typeof provider.model !== "string" || !provider.model.trim()) {
			throw new Error(`配置 ${path} 的 provider ${name} 缺少 model`);
		}
		if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
			throw new Error(`配置 ${path} 的 provider ${name} 的 apiKey 必须是字符串`);
		}
		if (
			provider.contextWindow !== undefined &&
			(typeof provider.contextWindow !== "number" || !Number.isFinite(provider.contextWindow) || provider.contextWindow <= 0)
			) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 contextWindow 无效`);
			}
			if (provider.maxRetries !== undefined &&
				(typeof provider.maxRetries !== "number" || !Number.isSafeInteger(provider.maxRetries) || provider.maxRetries < 0)) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 maxRetries 无效`);
			}
		providers[name] = {
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey ?? "",
			model: provider.model,
				...(provider.contextWindow === undefined
					? {}
					: { contextWindow: provider.contextWindow }),
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
		};
	}
	if (!providers[raw.default]) {
		throw new Error(`配置 ${path} 缺少 default 对应的 provider: ${raw.default}`);
	}
	return { default: raw.default, providers };
}

export function activeProvider(
	cfg: UinaConfig,
): ProviderConfig & { name: string } {
	const prov = cfg.providers[cfg.default];
	if (!prov.apiKey) {
		throw new Error(
			`provider "${cfg.default}" 缺少 apiKey` +
				`（请在 ${configPath()} 填写，或用环境变量 UINA_API_KEY_${cfg.default.toUpperCase()} 提供）`,
		);
	}
	return { name: cfg.default, ...prov };
}
