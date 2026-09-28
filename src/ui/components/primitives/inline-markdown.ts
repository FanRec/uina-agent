/**
 * 行内 Markdown 轻量语法高亮渲染器（针对终端 ANSI 输出）。
 * 支持行内代码、粗体、下划线、超链接等基础样式。
 */

import { C } from "../../core/utils.js";

/**
 * 格式化行内 Markdown 元素为带 ANSI 样式的终端字符串。
 */
export function formatInlineMarkdown(text: string): string {
	if (!text) return "";
	let out = text;

	// 行内代码 `code` -> 青色高亮
	out = out.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);

	// 粗体 **bold** -> 纯白加粗
	out = out.replace(/\*\*([^*]+)\*\*/g, `${C.bold}${C.white}$1${C.reset}`);

	// 链接格式简化 [title](url) -> 蓝色下划线
	out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.blue}${C.underline}$1${C.reset} ${C.gray}($2)${C.reset}`);

	return out;
}
