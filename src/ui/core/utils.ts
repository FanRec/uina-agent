/**
 * 终端字符与 ANSI 控制码工具函数（移植自 pi-tui utils 并做零外部依赖纯净实现）。
 */

// ANSI Escape Code 正则（覆盖 CSI, OSC, APC 序列，包含以 \x07 或 \x1b\\ 结尾的 APC 序列如 CURSOR_MARKER）
export const ANSI_REGEX =
	// eslint-disable-next-line no-control-regex
	/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g;

/** 颜色常数定义（RGB / 16色） */
export const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	// 基础颜色
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	// dsh 标志性配色（TrueColor）
	iceBlue: "\x1b[38;2;125;190;255m",
	brandBlue: "\x1b[38;2;75;111;255m",
	glowWhite: "\x1b[38;2;255;255;255m",
	darkBg: "\x1b[48;2;30;34;42m",
};

/** 剥离所有 ANSI 转义控制码 */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "");
}

/**
 * 判断 Unicode 码点是否为 East Asian Wide (全角/占2列) 或 Emoji
 * 覆盖 CJK 汉字、日文假名、韩文字母、全角标点及常见 Emoji。
 */
export function isFullWidth(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals, Kangxi, CJK Ideographs, Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
		(cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x2fa1f) || // CJK Extension
		(cp >= 0x1f300 && cp <= 0x1faff) || // Emojis & Pictographs
		cp === 0x26a1 || // ⚡ (高压闪电符号，现代终端与系统字体占用 2 物理列宽)
		cp === 0x2728 || // ✨
		cp === 0x2705 || // ✅
		cp === 0x274c || // ❌
		cp === 0x2b50 || // ⭐
		cp === 0x2b55 || // ⭕
		cp === 0x23f3 || // ⏳
		cp === 0x231b    // ⌛
	);
}

/** 单字符（或 grapheme）的可视列宽 */
export function charWidth(char: string): number {
	if (char === "\t") return 2;
	const cp = char.codePointAt(0);
	if (!cp || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	return isFullWidth(cp) ? 2 : 1;
}

/** 计算包含 ANSI 控制码与多字节中文的字符串真实显示列宽 */
export function visibleWidth(str: string): number {
	if (!str) return 0;
	const clean = stripAnsi(str);
	let w = 0;
	for (const char of clean) {
		w += charWidth(char);
	}
	return w;
}

/**
 * 从指定位置提取完整的 ANSI 控制码（用于流式扫描）
 */
export function extractAnsiCode(
	text: string,
	index: number,
): { code: string; length: number } | null {
	if (text[index] !== "\x1b") return null;
	const match = text.slice(index).match(/^(?:\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))/);
	if (match && match[0]) {
		return { code: match[0], length: match[0].length };
	}
	return null;
}

/**
 * ANSI 安全的字符截断：
 * 绝不在 ANSI 序列中间截断，超出宽度时在末尾附加 ellipsis 并补充 reset 样式。
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis = "…",
): string {
	if (maxWidth <= 0) return "";
	const totalWidth = visibleWidth(text);
	if (totalWidth <= maxWidth) return text;

	const ellipsisW = visibleWidth(ellipsis);
	const targetWidth = Math.max(0, maxWidth - ellipsisW);

	let curWidth = 0;
	let result = "";
	let i = 0;

	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			result += ansi.code;
			i += ansi.length;
			continue;
		}

		const char = text[i];
		const w = charWidth(char);
		if (curWidth + w > targetWidth) {
			break;
		}

		result += char;
		curWidth += w;
		i++;
	}

	return `${result}${C.reset}${ellipsis}`;
}

/**
 * 带 ANSI 样式继承的文本折行：
 * 将 text 按 maxWidth 折成多行，上一行的 ANSI 样式自动延续到下一行。
 */
export function wrapTextWithAnsi(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const lines = text.split("\n");
	const output: string[] = [];

	let currentStyle = "";

	for (const rawLine of lines) {
		if (visibleWidth(rawLine) <= maxWidth) {
			output.push(`${currentStyle}${rawLine}`);
			// 扫描这行有没有产生新的 style
			const matches = rawLine.match(/\x1b\[[0-9;]*m/g);
			if (matches) {
				for (const m of matches) {
					if (m === "\x1b[0m") currentStyle = "";
					else currentStyle += m;
				}
			}
			continue;
		}

		let curLine = currentStyle;
		let curWidth = 0;
		let i = 0;

		while (i < rawLine.length) {
			const ansi = extractAnsiCode(rawLine, i);
			if (ansi) {
				curLine += ansi.code;
				if (ansi.code === "\x1b[0m") currentStyle = "";
				else if (ansi.code.endsWith("m")) currentStyle += ansi.code;
				i += ansi.length;
				continue;
			}

			const char = rawLine[i];
			const w = charWidth(char);

			if (curWidth + w > maxWidth) {
				output.push(`${curLine}${C.reset}`);
				curLine = `${currentStyle}${char}`;
				curWidth = w;
			} else {
				curLine += char;
				curWidth += w;
			}
			i++;
		}

		if (curLine) {
			output.push(curLine);
		}
	}

	return output;
}

/**
 * 响应式内容盒宽度（全局统一调用点）
 *
 * 根据终端 innerW 分级计算内容盒的最佳宽度，在宽屏下充分利用横向空间，
 * 在窄屏下维持最小可读宽度，消除右侧大面积留白。
 *
 * 布局分级：
 *   innerW <  94  → max(36, innerW - 4)         最窄，贴边留 2
 *   innerW <  130 → max(56, innerW - 6)          中等宽度，原有体验
 *   innerW <  170 → max(80, innerW - 8)          宽屏，利用更多空间
 *   innerW >= 170 → max(100, innerW - 12)        超宽屏，留适当呼吸边距
 *
 * @param innerW  可用内宽（已减去 margin 后的列数）
 * @param slack   额外的左右安全边距（默认 4，可按调用场景调整）
 */
export function getContentBoxWidth(innerW: number, slack = 4): number {
	if (innerW < 94) return Math.max(36, innerW - slack);
	if (innerW < 130) return Math.max(56, innerW - slack);
	if (innerW < 170) return Math.max(80, innerW - Math.max(slack, 8));
	return Math.max(100, innerW - Math.max(slack, 12));
}
