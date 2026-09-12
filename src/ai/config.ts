/**
 * 配置读取：~/.uina/auth.json（镜像 pi 的 ~/.pi/agent/auth.json 形态）。
 * 结构：{ default, providers: { <name>: { baseUrl, apiKey, model } } }
 * apiKey 可被环境变量 UINA_API_KEY_<NAME大写> 覆盖（避免敏感信息写盘）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GeminiThinkingFormat, ThinkingLevel, ThinkingWireFormat } from "../core/types.js";

export type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

export interface ProviderConfig {
 imageInput?: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	modelContextWindow?: number;
	maxContextWindow?: number;
	maxRetries?: number;
	/** Anthropic 的 /messages 必须显式给出 max_tokens；Uina 不发明这个输出上限。 */
	maxOutputTokens?: number;
	/** Gemini models that explicitly require function-call ids on the wire. Unknown stays omitted. */
	geminiToolCallIds?: boolean;
	/** Gemini thinking 的 wire 控制方式。声明 thinkingLevels 时必须显式给出，绝不按模型名推断。 */
	geminiThinkingFormat?: GeminiThinkingFormat;
	/** thinking 档位 → 数值预算的显式映射（Anthropic budget_tokens / Gemini thinkingBudget）。 */
	thinkingBudgets?: Partial<Record<ThinkingLevel, number>>;
	type?: ProviderKind;
	thinkingFormat?: ThinkingWireFormat;
	thinkingLevels?: readonly ThinkingLevel[];
	includeThinking?: boolean;
}

/**
 * 依据协议与配置推导上下文投影是否携带思考历史。
 * openai-compatible 仅 deepseek 携带；anthropic 与 gemini 声明 thinking 时携带。
 */
export function protocolCarriesThinking(
	kind: ProviderKind,
	thinkingFormat?: ThinkingWireFormat,
	levels?: readonly ThinkingLevel[],
): boolean {
	if (kind === "openai-compatible") {
		return thinkingFormat === "deepseek";
	}
	return Boolean(levels?.some((level) => level !== "off"));
}

/**
 * 显式配置是 thinking 能力的唯一来源。
 *
 * 这里刻意不做任何模型名匹配：曾经存在一张按模型名索引的档位表，它把猜测当成事实，
 * 又会静默收窄甚至抹掉用户显式声明的档位。未知保持未知，由 UI 显示为未知
 * （ui-host 的「当前模型未声明思考档位」分支），而不是补造默认值。
 */
export function configuredThinkingLevels(conf: ProviderConfig): readonly ThinkingLevel[] | undefined {
	return conf.thinkingLevels?.length ? [...conf.thinkingLevels] : undefined;
}

const GEMINI_LEVEL_ENCODABLE: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/**
 * 拒绝一切会让 Uina 把猜测写成事实的配置组合。
 * 在真实 Provider 创建时调用，因此错误发生在启动阶段，且指名 provider 与缺失字段。
 */
export function assertProviderFacts(conf: ProviderConfig): void {
	if (conf.imageInput !== undefined && typeof conf.imageInput !== "boolean") throw new Error("imageInput 必须是 boolean");
	const levels = conf.thinkingLevels;
	const kind: ProviderKind = conf.type ?? "openai-compatible";

	if (kind === "anthropic" && conf.maxOutputTokens === undefined) {
		throw new Error(
			`provider ${conf.model} 使用 Anthropic 协议：/messages 必须显式给出 max_tokens，请在配置中提供 maxOutputTokens；Uina 不发明输出上限`,
		);
	}
	if (!levels?.length) return;
	const encodesThinking = levels.some(level => level !== "off");

	if (kind === "anthropic" || (kind === "gemini" && conf.geminiThinkingFormat === "budget")) {
		const missing = levels.filter(level => level !== "off" && conf.thinkingBudgets?.[level] === undefined);
		if (missing.length > 0) {
			throw new Error(
				`provider ${conf.model} 的 thinkingBudgets 缺少档位 ${missing.join("/")}；这些数值直接写进 wire，Uina 不发明 thinking 预算`,
			);
		}
	}

	if (kind !== "gemini" || !encodesThinking) return;
	if (conf.geminiThinkingFormat === undefined) {
		throw new Error(
			`provider ${conf.model} 声明了 thinkingLevels 但缺少 geminiThinkingFormat（"budget" 或 "level"）；Uina 不根据模型名猜测 wire 控制`,
		);
	}
	if (conf.geminiThinkingFormat === "level") {
		const unencodable = levels.filter(level => level !== "off" && !GEMINI_LEVEL_ENCODABLE.includes(level));
		if (unencodable.length > 0) {
			throw new Error(
				`provider ${conf.model} 的 geminiThinkingFormat: "level" 无法编码档位 ${unencodable.join("/")}；请改用 "budget" 或修正 thinkingLevels`,
			);
		}
	}
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
			if (provider.maxOutputTokens !== undefined && (typeof provider.maxOutputTokens !== "number" || !Number.isSafeInteger(provider.maxOutputTokens) || provider.maxOutputTokens <= 0)) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 maxOutputTokens 无效`);
			}
			if (provider.thinkingBudgets !== undefined) {
				if (typeof provider.thinkingBudgets !== "object" || provider.thinkingBudgets === null || Array.isArray(provider.thinkingBudgets)) {
					throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingBudgets 必须是对象`);
				}
				for (const [level, budget] of Object.entries(provider.thinkingBudgets as Record<string, unknown>)) {
					if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level) || typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0) {
						throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingBudgets.${level} 无效`);
					}
				}
			}
			if (provider.type !== undefined && provider.type !== "openai-compatible" && provider.type !== "anthropic" && provider.type !== "gemini") {
				throw new Error(`配置 ${path} 的 provider ${name} 的 type 无效`);
			}
			if (provider.thinkingFormat !== undefined && !["openai", "deepseek", "qwen"].includes(provider.thinkingFormat as string)) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingFormat 无效`);
			}
			if (provider.imageInput !== undefined && typeof provider.imageInput !== "boolean") throw new Error(`配置 ${path} 的 provider ${name} 的 imageInput 必须是 boolean`);
			if (provider.thinkingLevels !== undefined && (!Array.isArray(provider.thinkingLevels) || provider.thinkingLevels.some((level) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level as string)))) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 thinkingLevels 无效`);
			}
			if (provider.geminiThinkingFormat !== undefined && !["budget", "level"].includes(String(provider.geminiThinkingFormat))) {
				throw new Error(`配置 ${path} 的 provider ${name} 的 geminiThinkingFormat 无效`);
			}
			providers[name] = {
				...(provider.geminiThinkingFormat === undefined ? {} : { geminiThinkingFormat: provider.geminiThinkingFormat as GeminiThinkingFormat }),
				apiKey: provider.apiKey ?? "",
				model: provider.model,
				...(provider.modelContextWindow === undefined ? {} : { modelContextWindow: provider.modelContextWindow as number }),
				...(provider.maxContextWindow === undefined ? {} : { maxContextWindow: provider.maxContextWindow as number }),
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
				...(provider.geminiToolCallIds === undefined ? {} : { geminiToolCallIds: provider.geminiToolCallIds as boolean }),
				...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens as number }),
				...(provider.thinkingBudgets === undefined ? {} : { thinkingBudgets: provider.thinkingBudgets as Partial<Record<ThinkingLevel, number>> }),
				baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : defaultBaseUrl(providerType),
				type: providerType,
				...(provider.thinkingFormat === undefined ? {} : { thinkingFormat: provider.thinkingFormat as ThinkingWireFormat }),
				...(provider.thinkingLevels === undefined ? {} : { thinkingLevels: provider.thinkingLevels as ThinkingLevel[] }),
				...(provider.imageInput === undefined ? {} : { imageInput: provider.imageInput as boolean }),
				...(provider.includeThinking === undefined ? {} : { includeThinking: Boolean(provider.includeThinking) }),
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
