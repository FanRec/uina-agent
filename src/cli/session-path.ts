import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface SessionPathResolutionOptions {
	/** 是否强制使用纯内存会话（不写入磁盘） */
	noSession?: boolean;
	/** 当前工作区目录，默认为 process.cwd() */
	cwd?: string;
}

/**
 * 解析会话持久化路径。
 *
 * 规则（兼顾第一性原则、工作区隔离与现有基线兼容）：
 * 1. 若开启 noSession，返回 undefined（使用内存 Store）；
 * 2. 若配置了环境变量 UINA_SESSION_PATH，优先使用显式指定路径；
 * 3. 若当前工作目录下已存在 data/session.jsonl（Uina 源码工程开发态），沿用该路径以保障本地开发基线；
 * 4. 否则（全局在外部项目运行时），存放在 ~/.uina/sessions/<workspace-slug>.jsonl，绝不污染用户项目目录。
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

	// 全局多租户隔离：计算安全且具备可读性的 workspace slug
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	const rawBase = basename(cwd).replace(/[^a-zA-Z0-9_\-\.]/g, "_") || "workspace";
	const filename = `${rawBase}-${hash}.jsonl`;

	const home = process.env.UINA_HOME ?? homedir();
	const sessionsDir = join(home, ".uina", "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	return join(sessionsDir, filename);
}
