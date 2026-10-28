import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SoundboardConfig } from "./types.js";

const DEFAULT_VOLUME = 80;
const DEFAULT_SOUNDS_DIR = "./sounds";

/**
 * 读本世界的 config.json。
 *
 * 文件不存在 → 全部用默认值（合法）。
 * 文件存在但写坏 → 抛出：调用方把异常转成一条指名文件的失败结果，
 * 而不是静默回退到默认值（静默回退会让写错的配置看起来生效了）。
 */
export function loadSoundboardWorldConfig(): SoundboardConfig {
	const configDir = dirname(fileURLToPath(import.meta.url));
	const configPath = join(configDir, "config.json");
	const file: Partial<SoundboardConfig> = existsSync(configPath)
		? (JSON.parse(readFileSync(configPath, "utf8")) as Partial<SoundboardConfig>)
		: {};

	return {
		soundsDir: resolve(configDir, file.soundsDir ?? DEFAULT_SOUNDS_DIR),
		defaultVolume: file.defaultVolume ?? DEFAULT_VOLUME,
		mpvPath: file.mpvPath,
		soundOverrides: file.soundOverrides ?? {},
	};
}
