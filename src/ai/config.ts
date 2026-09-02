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
	let raw: UinaConfig;
	try {
		raw = JSON.parse(readFileSync(p, "utf8")) as UinaConfig;
	} catch (e) {
		throw new Error(`配置文件 ${p} 不是合法 JSON：${(e as Error).message}`);
	}
	if (!raw.default || !raw.providers?.[raw.default]) {
		throw new Error(`配置 ${p} 缺少 default 或对应 providers 条目`);
	}
	for (const [name, prov] of Object.entries(raw.providers)) {
		const envKey = process.env[`UINA_API_KEY_${name.toUpperCase()}`];
		if (envKey) prov.apiKey = envKey;
	}
	return raw;
}

export function activeProvider(
	cfg: UinaConfig,
): ProviderConfig & { name: string } {
	return { name: cfg.default, ...cfg.providers[cfg.default] };
}
