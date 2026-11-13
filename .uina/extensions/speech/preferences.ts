import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "../../../src/extensions/runner.js";

/**
 * 声音偏好（输出表达体系 §8.3）：沿用现有主体偏好目录与 `muted` 值，保证用户
 * 原有静音选择不丢失。旧 `readAssistantText` 字段（自动朗读普通正文）已随旧链路
 * 删除，读取时直接忽略，**不映射成静音**；新会话仅使用统一 muted 默认值。
 */
export interface SpeechPreferences {
	muted: boolean;
}

export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = { muted: false };

function canPersist(pi?: ExtensionAPI): boolean {
	return Boolean(pi && typeof pi.path === "string");
}

export function speechPreferencesPath(pi?: ExtensionAPI): string {
	const root = pi?.subject?.stateRoot ?? join(process.env.UINA_HOME ?? homedir(), ".uina");
	return join(root, "voice-preferences.json");
}

export async function loadSpeechPreferences(pi?: ExtensionAPI): Promise<SpeechPreferences> {
	if (!canPersist(pi)) return { ...DEFAULT_SPEECH_PREFERENCES };
	try {
		const parsed = JSON.parse(await readFile(speechPreferencesPath(pi), "utf8")) as Record<string, unknown>;
		return { muted: typeof parsed.muted === "boolean" ? parsed.muted : false };
	} catch {
		return { ...DEFAULT_SPEECH_PREFERENCES };
	}
}

export async function saveSpeechPreferences(pi: ExtensionAPI | undefined, preferences: SpeechPreferences): Promise<void> {
	if (!canPersist(pi)) return;
	const path = speechPreferencesPath(pi);
	const temp = `${path}.tmp`;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(temp, `${JSON.stringify(preferences, null, "\t")}\n`, "utf8");
	await rename(temp, path);
}
