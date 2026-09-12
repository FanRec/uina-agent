import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionPathResolutionOptions {
	/** 是否强制使用纯内存会话（不写入磁盘） */
	noSession?: boolean;
	/** 当前工作区目录，默认为 process.cwd() */
	cwd?: string;
}

/**
 * 解析会话持久化路径。
 *
 * 规则（数字生命单一主体连续记忆）：
 * 1. 若开启 noSession，返回 undefined（使用内存 Store）；
 * 2. 若配置了环境变量 UINA_SESSION_PATH，优先使用显式指定路径；
 * 3. 若当前工作目录下已存在 data/session.jsonl（Uina 源码工程开发态），沿用该路径以保障本地开发基线；
 * 4. 否则（全局运行时），统一落盘至全局单主会话 ~/.uina/session.jsonl，真正做到跨目录记忆连续。
 */
export function resolveSessionPath(options: SessionPathResolutionOptions = {}): string | undefined {
	if (options.noSession) {
		return undefined;
	}

	const envPath = process.env.UINA_SESSION_PATH?.trim();
	if (envPath) {
		return envPath;
	}

	const cwd = options.cwd ?? process.cwd();

	// 兼容现状：如果当前工作目录下存在 data/session.jsonl，优先继续使用它
	const localDataFile = join(cwd, "data", "session.jsonl");
	if (existsSync(localDataFile)) {
		return localDataFile;
	}

	// 全局单一主体：跨目录统一落盘至 ~/.uina/session.jsonl
	const home = process.env.UINA_HOME ?? homedir();
	const uinaDir = join(home, ".uina");
	mkdirSync(uinaDir, { recursive: true });

	return join(uinaDir, "session.jsonl");
}
