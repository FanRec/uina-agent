/**
 * SKILL.md 解析（Agent Skills 规范）：规范输出、适度宽容输入。
 *
 * 必需 name + description；标准可选 license / compatibility / metadata /
 * allowed-tools。Uina 扩展字段：disable-model-invocation、user-invocable、
 * argument-hint、when_to_use、arguments。布尔字段只接收真正的 YAML 布尔值。
 *
 * 会改变执行位置、权限或副作用的扩展能力（context: fork、agent、model、
 * effort、background: true、hooks、disallowed-tools、动态注入 !`command`）
 * 不实现：出现即整项跳过并报告不兼容，不谎称支持。
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { SkillDiagnostic } from "./types.js";

/** name 规则：小写字母/数字/短横线，1–64，不以短横线开头/结尾，无相邻短横线。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;
/** 动态命令注入语法（Claude Code）；明确使用者标记不兼容，不冒充已执行内容。 */
const DYNAMIC_INJECTION = /!\s*`[^`]*`/;

export interface ParsedSkill {
	name: string;
	description: string;
	body: string;
	revision: string;
	modelInvocable: boolean;
	userInvocable: boolean;
	argumentHint?: string;
	argumentNames?: readonly string[];
	whenToUse?: string;
	license?: string;
	compatibility?: string;
	metadata?: Readonly<Record<string, string>>;
	allowedTools?: string;
}

export interface ParseOutcome {
	/** 解析成功时非空；null = 该项整体跳过（诊断在 diagnostics 里）。 */
	skill: ParsedSkill | null;
	diagnostics: SkillDiagnostic[];
}

export function skillRevision(rawFileContent: string): string {
	return createHash("sha256").update(rawFileContent, "utf8").digest("hex");
}

interface FrontmatterSplit {
	frontmatter: string;
	body: string;
}

/** 提取 YAML Frontmatter：容忍 UTF-8 BOM 与 CRLF；无合法定界符返回 null。 */
function splitFrontmatter(raw: string): FrontmatterSplit | null {
	const text = raw.replace(/^\uFEFF/, "");
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if ((lines[0] ?? "").trim() !== "---") return null;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]!.trim() === "---" || lines[index]!.trim() === "...") {
			return {
				frontmatter: lines.slice(1, index).join("\n"),
				body: lines
					.slice(index + 1)
					.join("\n")
					.replace(/^\n+/, ""),
			};
		}
	}
	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 布尔扩展字段只认真布尔值；字符串 "false" 不是 false。 */
function strictBoolean(
	source: Record<string, unknown>,
	key: string,
	diagnostics: SkillDiagnostic[],
	path: string,
): boolean | undefined {
	const value = source[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		diagnostics.push({
			severity: "warning",
			code: "invalid-field",
			message: `字段 ${key} 必须是 YAML 布尔值，已忽略（收到 ${JSON.stringify(value)}）`,
			path,
		});
		return undefined;
	}
	return value;
}

function optionalString(
	source: Record<string, unknown>,
	key: string,
	diagnostics: SkillDiagnostic[],
	path: string,
): string | undefined {
	const value = source[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		diagnostics.push({
			severity: "warning",
			code: "invalid-field",
			message: `字段 ${key} 必须是非空字符串，已忽略`,
			path,
		});
		return undefined;
	}
	return value;
}

/**
 * 解析一个 SKILL.md。任何导致不可引用的问题（无合法名称、缺描述、非法 YAML、
 * 要求未支持的执行语义）都返回 null 并给出诊断；可选字段问题只忽略该字段。
 */
export function parseSkillFile(raw: string, directoryName: string, path: string): ParseOutcome {
	const diagnostics: SkillDiagnostic[] = [];
	const split = splitFrontmatter(raw);
	if (!split) {
		return {
			skill: null,
			diagnostics: [
				{ severity: "error", code: "missing-frontmatter", message: "缺少 YAML Frontmatter（首行必须是 ---）", path },
			],
		};
	}

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(split.frontmatter);
	} catch (error) {
		return {
			skill: null,
			diagnostics: [
				{ severity: "error", code: "invalid-yaml", message: `Frontmatter YAML 无法解析: ${String(error)}`, path },
			],
		};
	}
	if (!isPlainObject(frontmatter)) {
		return {
			skill: null,
			diagnostics: [{ severity: "error", code: "invalid-yaml", message: "Frontmatter 必须是键值映射", path }],
		};
	}

	// ── 不兼容的执行型字段：整项跳过，绝不冒充支持 ─────────────────────────
	let incompatible = false;
	const markIncompatible = (key: string, value: unknown, reason: string): void => {
		incompatible = true;
		diagnostics.push({
			severity: "error",
			code: "incompatible-frontmatter",
			message: `不支持的执行型字段 ${key}: ${JSON.stringify(value)} —— ${reason}`,
			path,
		});
	};
	if (frontmatter.context !== undefined && frontmatter.context !== null)
		markIncompatible("context", frontmatter.context, "不实现 context: fork 等执行位置语义");
	if (frontmatter.agent !== undefined && frontmatter.agent !== null)
		markIncompatible("agent", frontmatter.agent, "不实现子 Agent 指定");
	if (frontmatter.model !== undefined && frontmatter.model !== null)
		markIncompatible("model", frontmatter.model, "不实现模型指定");
	if (frontmatter.effort !== undefined && frontmatter.effort !== null)
		markIncompatible("effort", frontmatter.effort, "不实现推理档位指定");
	if (frontmatter.background === true) markIncompatible("background", true, "不实现后台执行");
	if (frontmatter.hooks !== undefined && frontmatter.hooks !== null)
		markIncompatible("hooks", frontmatter.hooks, "不实现 hooks");
	if (frontmatter["disallowed-tools"] !== undefined && frontmatter["disallowed-tools"] !== null)
		markIncompatible("disallowed-tools", frontmatter["disallowed-tools"], "不实现工具权限削减");
	if (DYNAMIC_INJECTION.test(split.body)) markIncompatible("!`command`", "（正文）", "动态命令注入不执行");

	if (incompatible) return { skill: null, diagnostics };

	// ── name：Frontmatter 合法名优先；缺失时目录名兼容回退（警告） ──────────
	const rawName = frontmatter.name;
	let name: string | undefined;
	if (rawName !== undefined && rawName !== null) {
		if (
			typeof rawName !== "string" ||
			rawName.length < 1 ||
			rawName.length > MAX_NAME_LENGTH ||
			!NAME_PATTERN.test(rawName)
		) {
			diagnostics.push({
				severity: "error",
				code: "invalid-name",
				message: `name 必须匹配小写字母/数字/短横线规则且长度 1–${MAX_NAME_LENGTH}（收到 ${JSON.stringify(rawName)}）`,
				path,
			});
			return { skill: null, diagnostics };
		}
		if (rawName !== directoryName) {
			diagnostics.push({
				severity: "warning",
				code: "name-directory-mismatch",
				message: `name（${rawName}）与父目录名（${directoryName}）不一致，使用 Frontmatter 中的名称`,
				path,
			});
		}
		name = rawName;
	} else if (NAME_PATTERN.test(directoryName) && directoryName.length <= MAX_NAME_LENGTH) {
		diagnostics.push({
			severity: "warning",
			code: "name-fallback",
			message: `缺少 name，使用目录名 ${directoryName} 作为兼容回退`,
			path,
		});
		name = directoryName;
	} else {
		diagnostics.push({
			severity: "error",
			code: "missing-name",
			message: "缺少 name 且目录名不是合法 Skill 名称",
			path,
		});
		return { skill: null, diagnostics };
	}

	// ── description：必需 ────────────────────────────────────────────────
	const rawDescription = frontmatter.description;
	if (typeof rawDescription !== "string" || !rawDescription.trim()) {
		diagnostics.push({ severity: "error", code: "missing-description", message: "缺少非空 description", path });
		return { skill: null, diagnostics };
	}
	if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push({
			severity: "error",
			code: "invalid-description",
			message: `description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`,
			path,
		});
		return { skill: null, diagnostics };
	}

	// ── 可选字段：类型不合法忽略该字段并诊断，不阻断其他 Skill ─────────────
	const compatibility = optionalString(frontmatter, "compatibility", diagnostics, path);
	if (compatibility !== undefined && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
		diagnostics.push({
			severity: "warning",
			code: "invalid-field",
			message: `compatibility 超过 ${MAX_COMPATIBILITY_LENGTH} 字符，已忽略`,
			path,
		});
	}
	const finalCompatibility =
		compatibility !== undefined && compatibility.length <= MAX_COMPATIBILITY_LENGTH ? compatibility : undefined;

	const rawMetadata = frontmatter.metadata;
	let metadata: Record<string, string> | undefined;
	if (rawMetadata !== undefined && rawMetadata !== null) {
		if (isPlainObject(rawMetadata) && Object.values(rawMetadata).every((value) => typeof value === "string")) {
			metadata = { ...(rawMetadata as Record<string, string>) };
		} else {
			diagnostics.push({
				severity: "warning",
				code: "invalid-field",
				message: "metadata 必须是字符串键值映射，已忽略",
				path,
			});
		}
	}

	const rawAllowedTools = frontmatter["allowed-tools"];
	let allowedTools: string | undefined;
	if (rawAllowedTools !== undefined && rawAllowedTools !== null) {
		if (typeof rawAllowedTools === "string") allowedTools = rawAllowedTools;
		else if (Array.isArray(rawAllowedTools) && rawAllowedTools.every((item) => typeof item === "string"))
			allowedTools = (rawAllowedTools as string[]).join(", ");
		else
			diagnostics.push({
				severity: "warning",
				code: "invalid-field",
				message: "allowed-tools 必须是字符串或字符串数组，已忽略",
				path,
			});
	}

	const rawArguments = frontmatter.arguments;
	let argumentNames: string[] | undefined;
	if (rawArguments !== undefined && rawArguments !== null) {
		if (
			Array.isArray(rawArguments) &&
			rawArguments.length > 0 &&
			rawArguments.every((item) => typeof item === "string" && item.trim())
		)
			argumentNames = (rawArguments as string[]).map((item) => item.trim());
		else
			diagnostics.push({
				severity: "warning",
				code: "invalid-field",
				message: "arguments 必须是非空字符串数组，已忽略",
				path,
			});
	}

	const argumentHint = optionalString(frontmatter, "argument-hint", diagnostics, path);
	const whenToUse = optionalString(frontmatter, "when_to_use", diagnostics, path);
	const license = optionalString(frontmatter, "license", diagnostics, path);

	const disableModelInvocation = strictBoolean(frontmatter, "disable-model-invocation", diagnostics, path);
	const userInvocable = strictBoolean(frontmatter, "user-invocable", diagnostics, path) ?? true;
	const modelInvocable = (disableModelInvocation ?? false) !== true;
	if (!modelInvocable && !userInvocable) {
		diagnostics.push({
			severity: "warning",
			code: "not-invocable",
			message: "disable-model-invocation 与 user-invocable: false 同时为真，该项不进入可调用集合",
			path,
		});
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description: rawDescription,
			body: split.body,
			revision: skillRevision(raw),
			modelInvocable,
			userInvocable,
			...(argumentHint !== undefined ? { argumentHint } : {}),
			...(argumentNames !== undefined ? { argumentNames } : {}),
			...(whenToUse !== undefined ? { whenToUse } : {}),
			...(license !== undefined ? { license } : {}),
			...(finalCompatibility !== undefined ? { compatibility: finalCompatibility } : {}),
			...(metadata !== undefined ? { metadata } : {}),
			...(allowedTools !== undefined ? { allowedTools } : {}),
		},
		diagnostics,
	};
}
