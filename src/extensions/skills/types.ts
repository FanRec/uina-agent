/**
 * Skill 领域类型（Skill 机制）：快照是不可变代次，全部解析、冲突处理与
 * Catalog 文本都从同一代快照派生；实际内容身份以 `revision` 判别。
 *
 * Skill 是可复用的程序性知识（SKILL.md + 附属文件），不是执行实例：
 * 不增加权限、不自动执行脚本、不持有任务状态。
 */

/** 一个只读 Skill 来源：Host 装配，Loader 不读取 Profile/Extension 内部对象。 */
export interface SkillSource {
	/** 来源身份标签（装配方命名，如 workspace / profile:alice / ext:foo）。 */
	ownerId: string;
	/** 扫描根目录。 */
	directory: string;
	/** 优先级：数值越小越优先（先声明者优先胜出同名）。 */
	priority: number;
}

/** 一代快照内的单个 Skill 条目（modelInvocable || userInvocable 才进入集合）。 */
export interface SkillEntry {
	/** 来源身份 + 规范化真实路径。 */
	id: string;
	name: string;
	description: string;
	/** Skill 目录真实路径（相对引用与资源读取的根）。 */
	root: string;
	/** SKILL.md 真实路径。 */
	file: string;
	sourceId: string;
	/** 已读取 SKILL.md 的哈希：实际内容身份。 */
	revision: string;
	/** 去 Frontmatter 的正文；发现时缓存（Loader 已为此读取过文件）。 */
	body: string;
	modelInvocable: boolean;
	userInvocable: boolean;
	argumentHint?: string;
	/** `arguments` 声明的位置参数名（$name 替换用）。 */
	argumentNames?: readonly string[];
	whenToUse?: string;
	license?: string;
	compatibility?: string;
	metadata?: Readonly<Record<string, string>>;
	/** 仅保留与诊断，不参与工具授权。 */
	allowedTools?: string;
}

/** 单项解析/冲突/来源问题：不影响其他有效项发布。 */
export interface SkillDiagnostic {
	severity: "error" | "warning";
	code: string;
	message: string;
	path?: string;
}

export interface SkillSnapshot {
	/** 内存代次计数（capability 内递增）；内容身份看 revision。 */
	generation: number;
	entries: readonly SkillEntry[];
	diagnostics: readonly SkillDiagnostic[];
}
