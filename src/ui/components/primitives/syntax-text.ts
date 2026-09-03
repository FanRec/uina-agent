/**
 * 轻量代码语法高亮组件（复刻 dsh-TUI cli-highlight 语法高亮机制）。
 */

import * as cliHighlightModule from "cli-highlight";

// 兼容 ESM 与 CommonJS 双导出形态
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyCli = cliHighlightModule as any;
const hlFn: ((code: string, options?: { language?: string; ignoreIllegals?: boolean }) => string) | undefined =
	anyCli.highlight ?? anyCli.default?.highlight;
const supportsLangFn: ((lang: string) => boolean) | undefined =
	anyCli.supportsLanguage ?? anyCli.default?.supportsLanguage;

/** 常见语言名称规范化映射 */
const LANGUAGE_ALIASES: Record<string, string> = {
	ts: "typescript",
	js: "javascript",
	py: "python",
	sh: "bash",
	zsh: "bash",
	shell: "bash",
	yml: "yaml",
	md: "markdown",
	rs: "rust",
	rb: "ruby",
	golang: "go",
	cs: "csharp",
	docker: "dockerfile",
};

/**
 * 规范化语言标识
 */
export function normalizeLanguage(lang?: string): string | undefined {
	if (!lang) return undefined;
	const lower = lang.trim().toLowerCase();
	return LANGUAGE_ALIASES[lower] ?? lower;
}

/**
 * 对单段代码进行终端 ANSI SGR 彩色高亮着色
 */
export function highlightCode(code: string, language?: string): string {
	if (!code) return "";
	const lang = normalizeLanguage(language);

	if (!hlFn) {
		return code;
	}

	try {
		if (lang && supportsLangFn && supportsLangFn(lang)) {
			return hlFn(code, { language: lang, ignoreIllegals: true });
		}
		// 未指定语言或语言不在库中时，尝试无参数安全推断或返回原文本
		return hlFn(code, { ignoreIllegals: true });
	} catch {
		return code;
	}
}

/**
 * 对代码逐行进行语法高亮
 */
export function highlightLines(code: string, language?: string): string[] {
	const highlighted = highlightCode(code, language);
	return highlighted.split(/\r\n|\r|\n/);
}
