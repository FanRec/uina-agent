import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SoundboardWorldConfig } from "./types.js";

/**
 * 加载音效库配置
 * 优先级：显式入参 > config.json > 环境变量 > 默认值
 */
export function loadSoundboardWorldConfig(customDir?: string): SoundboardWorldConfig {
  const currentDir = customDir ?? dirname(fileURLToPath(import.meta.url));
  const configPath = join(currentDir, "config.json");
  let fileConfig: Partial<SoundboardWorldConfig> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw) as Partial<SoundboardWorldConfig>;
    } catch {
      // 容错回退
    }
  }

  const rawSoundsDir = fileConfig.soundsDir ?? process.env.SOUNDBOARD_DIR ?? "./sounds";
  const soundsDir = resolve(currentDir, rawSoundsDir);

  return {
    soundsDir,
    defaultVolume: fileConfig.defaultVolume ?? 80,
    mpvPath: fileConfig.mpvPath ?? process.env.MPV_PATH,
    soundOverrides: fileConfig.soundOverrides ?? {},
  };
}
