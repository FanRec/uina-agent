/**
 * 主体 System 资源选择（S1 System 文件化）：唯一覆盖源、编译与版本哈希。
 *
 * 选择规则（单文件覆盖，不隐式叠加多个 System 文件）：
 * 1. Host 显式文本（嵌入方完整覆盖主体 System；资源刷新不覆盖这个值）；
 * 2. Profile `profiles/<subjectId>/system.md` 存在；
 * 3. 工作区 `.uina/system.md` 存在；
 * 4. 内置 `src/agent/prompts/system.md`（发布包随附后备资源，dist 运行读 dist 副本）。
 *
 * 上一级文件不存在则继续向下选择；已存在却不可读、非法 UTF-8 或编译为空必须报错，
 * 不静默退到下一级。System 文件以自身所选目录为资源根（引用只能落在该目录内），
 * 编译复用扩展 Prompt 文件机制（include 展开、循环/越界/大小限制、来源哈希）。
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinSystemResource } from "../agent/context.js";
import { compilePromptFile } from "../extensions/prompt-compiler.js";

export interface SystemSelectionInput {
	/** 组合根工作目录；工作区 System 位于 <cwd>/.uina/system.md。 */
	readonly cwd: string;
	/** Host 显式 System 文本（最高优先级；undefined = 未显式指定）。 */
	readonly explicitText?: string;
	/** 主体 Profile 数据根（提供时才考虑 profiles/<subjectId>/system.md）。 */
	readonly profileRoot?: string;
	/** 主体 ID（来源展示用）。 */
	readonly subjectId?: string;
}

/** 主体 System 段的一次选择结果（尚未拼接 Runtime Protocol 段的最终正文）。 */
export interface ResolvedSystemSubject {
	/** 主体段正文（编译后，LF、无 BOM、首尾 trim）。 */
	readonly text: string;
	/** 来源标签：host-explicit / profile:<id> / workspace / builtin。 */
	readonly source: string;
	/** 文件编译入口（相对资源根）；host-explicit 无。 */
	readonly entry?: string;
	/** 编译实际读取的文件；host-explicit 无。 */
	readonly sources?: readonly string[];
}

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readWorkspaceOrProfileFile(path: string, label: string): Promise<string> {
	// 显式读取而非 compilePromptFile 的存在性判断：需要区分"不存在（向下回退）"与
	// "存在但损坏（必须报错）"两种事实。读取与解码失败都带路径定位。
	const bytes = await readFile(path).catch((error: unknown) => {
		throw new Error(`${label}存在但不可读（${path}）: ${error instanceof Error ? error.message : String(error)}`);
	});
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(
			`${label}不是有效的 UTF-8 编码（${path}）: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const normalized = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!normalized) throw new Error(`${label}为空（${path}）：System 文件不能是空正文，请填写或删除该文件。`);
	return normalized;
}

/**
 * 解析当前主体 System 段。启动时配置错误直接抛出（附操作指引）；
 * 资源刷新遇到相同错误由调用方决定保留旧版本。
 */
export async function resolveSystemSubject(input: SystemSelectionInput): Promise<ResolvedSystemSubject> {
	if (input.explicitText !== undefined) {
		const text = input.explicitText.trim();
		if (!text) throw new Error("Host 显式 systemPrompt 不能是空白正文。");
		return { text, source: "host-explicit" };
	}
	if (input.profileRoot !== undefined) {
		const path = join(input.profileRoot, "system.md");
		if (existsSync(path)) {
			const text = await readWorkspaceOrProfileFile(path, `主体 System 文件（profile ${input.subjectId ?? "未知"}）`);
			return {
				text,
				source: `profile:${input.subjectId ?? "unknown"}`,
				entry: "system.md",
				sources: ["system.md"],
			};
		}
	}
	const workspacePath = join(input.cwd, ".uina", "system.md");
	if (existsSync(workspacePath)) {
		const text = await readWorkspaceOrProfileFile(workspacePath, "工作区 System 文件");
		return { text, source: "workspace", entry: "system.md", sources: ["system.md"] };
	}
	// 内置默认：发布包随附资源；缺失（构建/复制不完整）必须显式失败，不静默生成空正文。
	const builtin = builtinSystemResource();
	const text = await compilePromptFile(builtin.entry, builtin.root)
		.then((compiled) => compiled.text)
		.catch((error: unknown) => {
			throw new Error(`内置默认 System 资源不可用: ${error instanceof Error ? error.message : String(error)}`);
		});
	// 编译走 include 机制；无引用时结果与直读一致。defaultSystemPrompt() 供裸 Subject
	// 兼容回退，两条读取路径必须指向同一文件。
	return { text, source: "builtin", entry: builtin.entry, sources: [builtin.entry] };
}

/** 默认事件帧投影启用时的最终 role=system 组合（Host 唯一装配入口）：
 * 主体 System 段在前，Runtime Protocol 段在后；自定义 projection 不附加协议段。 */
export function composeSystemText(subjectText: string, protocolSection?: string): string {
	return protocolSection ? `${subjectText}\n\n${protocolSection}` : subjectText;
}

/**
 * 已发布资源集合的内容哈希：System 最终正文 + 现役文件式 Guidance 身份/哈希 + Skill Catalog。
 * System 正文不变而 Guidance/Skill 变化时 revision 仍推进；全部无变化时不推进。
 */
export function computeResourceRevision(
	systemFinalText: string,
	guidance: readonly { key: string; hash?: string; text?: string }[],
	skillCatalogHash: string,
): string {
	const guidanceDigest = [...guidance]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((entry) => `${entry.key}:${entry.hash ?? hashText(entry.text ?? "")}`)
		.join("|");
	return hashText(
		JSON.stringify({ system: hashText(systemFinalText), guidance: guidanceDigest, skills: skillCatalogHash }),
	);
}
