/**
 * 配置读取：~/.uina/auth.json（镜像 pi 的 ~/.pi/agent/auth.json 形态）。
 * 结构：{ default, providers: { <name>: { baseUrl, apiKey, model } } }
 * apiKey 可被环境变量 UINA_API_KEY_<NAME大写> 覆盖（避免敏感信息写盘）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "../core/types.js";

export type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

export interface ProviderConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	modelContextWindow?: number;
	maxContextWindow?: number;
	maxRetries?: number;
	/** Gemini models that explicitly require function-call ids on the wire. Unknown stays omitted. */
	geminiToolCallIds?: boolean;
	type?: ProviderKind;
	thinkingFormat?: "openai" | "deepseek" | "qwen";
	thinkingLevels?: readonly ThinkingLevel[];
}

export function configuredThinkingLevels(conf: ProviderConfig): readonly ThinkingLevel[] | undefined {
	return conf.thinkingLevels?.length ? conf.thinkingLevels : undefined;
}

export interface UinaConfig {
	default: string;
	thinkingLevel?: ThinkingLevel;
	providers: Record<string, ProviderConfig>;
}

export function effectiveContextWindow(conf: ProviderConfig): number {
	if (!conf.modelContextWindow) throw new Error(`模型 ${conf.model} 缺少 modelContextWindow；Uina 不会猜测真实上下文上限`);
	return Math.min(conf.modelContextWindow, conf.maxContextWindow ?? conf.modelContextWindow);
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
			const providerType = (provider.type as ProviderKind | undefined) ?? "openai-compatible";
			if (provider.baseUrl !== undefined && (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim())) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 baseUrl 无效`);
			}
			if (providerType === "openai-compatible" && provider.baseUrl === undefined) {
				throw new Error(`配置 ${path} 的 provider ${name} 缺少 baseUrl`);
			}
		if (typeof provider.model !== "string" || !provider.model.trim()) {
			throw new Error(`配置 ${path} 的 provider ${name} 缺少 model`);
		}
		if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
			throw new Error(`配置 ${path} 的 provider ${name} 的 apiKey 必须是字符串`);
		}
		if (provider.contextWindow !== undefined) throw new Error(`配置 ${path} 的 provider ${name} 使用了已移除的 contextWindow；请改为 modelContextWindow 和可选 maxContextWindow`);
		if (provider.modelContextWindow !== undefined && (typeof provider.modelContextWindow !== "number" || !Number.isSafeInteger(provider.modelContextWindow) || provider.modelContextWindow <= 0)) throw new Error(`配置 ${path} 的 provider ${name} 的 modelContextWindow 无效`);
		if (provider.maxContextWindow !== undefined && (!Number.isSafeInteger(provider.maxContextWindow) || (provider.maxContextWindow as number) <= 0)) throw new Error(`配置 ${path} 的 provider ${name} 的 maxContextWindow 无效`);
			if (provider.maxRetries !== undefined &&
				(typeof provider.maxRetries !== "number" || !Number.isSafeInteger(provider.maxRetries) || provider.maxRetries < 0)) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 maxRetries 无效`);
			}
			if (provider.geminiToolCallIds !== undefined && typeof provider.geminiToolCallIds !== "boolean") {
				throw new Error(`配置 ${path} 的 provider ${name} 的 geminiToolCallIds 无效`);
			}
			if (provider.type !== undefined && provider.type !== "openai-compatible" && provider.type !== "anthropic" && provider.type !== "gemini") {
				throw new Error(`配置 ${path} 的 provider ${name} 的 type 无效`);
			}
			if (provider.thinkingFormat !== undefined && !["openai", "deepseek", "qwen"].includes(provider.thinkingFormat as string)) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingFormat 无效`);
			}
			if (provider.thinkingLevels !== undefined && (!Array.isArray(provider.thinkingLevels) || provider.thinkingLevels.some((level) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level as string)))) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingLevels 无效`);
			}
		providers[name] = {
				apiKey: provider.apiKey ?? "",
			model: provider.model,
				...(provider.modelContextWindow === undefined ? {} : { modelContextWindow: provider.modelContextWindow as number }),
				...(provider.maxContextWindow === undefined ? {} : { maxContextWindow: provider.maxContextWindow as number }),
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
				...(provider.geminiToolCallIds === undefined ? {} : { geminiToolCallIds: provider.geminiToolCallIds as boolean }),
				baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : defaultBaseUrl(providerType),
				type: providerType,
				...(provider.thinkingFormat === undefined ? {} : { thinkingFormat: provider.thinkingFormat as ProviderConfig["thinkingFormat"] }),
				...(provider.thinkingLevels === undefined ? {} : { thinkingLevels: provider.thinkingLevels as ThinkingLevel[] }),
		};
	}
	if (!providers[raw.default]) {
		throw new Error(`配置 ${path} 缺少 default 对应的 provider: ${raw.default}`);
	}
	if (raw.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw.thinkingLevel as string)) {
		throw new Error(`配置 ${path} 的 thinkingLevel 无效`);
	}
	return { default: raw.default, thinkingLevel: raw.thinkingLevel as ThinkingLevel | undefined, providers };
}

function defaultBaseUrl(type: ProviderKind): string {
	if (type === "anthropic") return "https://api.anthropic.com/v1";
	if (type === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
	throw new Error("openai-compatible provider 必须配置 baseUrl");
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
