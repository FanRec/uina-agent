/**
 * 用户会话偏好持久化（~/.uina/settings.json）。
 *
 * 与 auth.json 的职责分界：auth.json 是凭据与 provider 静态配置（部署态，
 * 手工维护）；settings.json 是 UI 交互随手改写的会话态偏好（模型、思考度），
 * 每次用户切换模型/档位都会写盘，绝不与凭据文件混用。
 *
 * 结构刻意保持为平面两字段；出现第三个持久化偏好时再考虑泛化。
 * 归属：组合根（host/cli）读写，Subject 纯机制不知道它的存在。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SessionSettings {
	/** 上次会话使用的模型名（models.resolve 的入参形态）。 */
	model?: string;
	/** 上次会话的思考档位（恢复时仍要过 clampThinkingLevel 校验）。 */
	thinkingLevel?: string;
}

export function settingsDir(home = process.env.UINA_HOME ?? homedir()): string {
	return join(home, ".uina");
}

function settingsPath(home?: string): string {
	return join(settingsDir(home), "settings.json");
}

/** 读取会话偏好；文件不存在或损坏一律返回空对象 —— 偏好丢失不阻塞启动。 */
export async function loadSettings(home?: string): Promise<SessionSettings> {
	try {
		const raw = await readFile(settingsPath(home), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const { model, thinkingLevel } = parsed as Record<string, unknown>;
		return {
			model: typeof model === "string" ? model : undefined,
			thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
		};
	} catch {
		return {};
	}
}

/** 原子写（临时文件 + rename，与 jsonl-store 同一纪律）；写失败静默 —— 偏好落盘失败不值得打断回合。 */
export async function saveSettings(settings: SessionSettings, home?: string): Promise<void> {
	const path = settingsPath(home);
	const temp = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temp, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	await rename(temp, path);
}
