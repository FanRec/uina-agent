import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JukeboxAppConfig } from "./types.js";

/**
 * 加载点歌机配置
 * 优先级：入参覆盖 > config.json 文件配置 > 环境变量 > 默认兜底值
 */
export function loadJukeboxConfig(): JukeboxAppConfig {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(currentDir, "config.json");
  let fileConfig: Partial<JukeboxAppConfig> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw) as Partial<JukeboxAppConfig>;
    } catch {
      // 容错：若配置文件损坏或无法解析，回退至环境变量与默认值
    }
  }

  return {
    apiBaseUrl: fileConfig.apiBaseUrl ?? process.env.NETEASE_API_URL ?? "http://localhost:3000",
    apiEnhancedDir:
      fileConfig.apiEnhancedDir ??
      process.env.NETEASE_API_DIR ??
      "E:\\Uina\\ThirdParty\\api-enhanced",
    mpvPath: fileConfig.mpvPath ?? process.env.MPV_PATH,
  };
}
