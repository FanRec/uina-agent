/**
 * 终端字符与 ANSI 控制码工具函数（移植自 pi-tui utils 并做零外部依赖纯净实现）。
 */

import { spawn } from "node:child_process";

// ANSI Escape Code 正则（覆盖 CSI, OSC, APC 序列，包含以 \x07 或 \x1b\\ 结尾的 APC 序列如 CURSOR_MARKER）
export const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const ANSI_REGEX =
	// eslint-disable-next-line no-control-regex
	/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g;

/** 颜色常数定义（RGB / 16色） */
export const C = {
	// 基础控制
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	underline: "\x1b[4m",
	// 基础 16 色
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	// dsh-TUI Gentle Mist Blue (雾蓝) 工业级调色板 (TrueColor RGB)
	text: "\x1b[38;2;232;230;224m", // #E8E6E0 温暖奶白（正文）
	inverseText: "\x1b[38;2;34;38;46m", // #22262E 深灰炭黑
	claude: "\x1b[38;2;125;161;222m", // #7DA1DE 品牌雾蓝
	promptBorder: "\x1b[38;2;85;96;111m", // #55606F 静止输入框柔和边框
	promptBorderShimmer: "\x1b[38;2;125;161;222m", // #7DA1DE 输入框高亮/焦点
	inactive: "\x1b[38;2;141;149;166m", // #8D95A6 雾灰蓝（次级/弱化文本，绝不黑屏）
	inactiveShimmer: "\x1b[38;2;170;178;194m", // #AAB2C2 略浅灰蓝
	subtle: "\x1b[38;2;94;102;115m", // #5E6673 适度弱化的边框/刻度蓝灰
	suggestion: "\x1b[38;2;171;194;236m", // #ABC2EC 冰蓝选区/高亮提示
	success: "\x1b[38;2;130;184;157m", // #82B89D 柔和浅绿
	error: "\x1b[38;2;218;138;147m", // #DA8A93 柔和粉红
	warning: "\x1b[38;2;216;178;112m", // #D8B270 柔和暖琥珀
	briefLabelYou: "\x1b[38;2;255;223;128m", // #FFDF80 用户输入提示暖金
	briefLabelClaude: "\x1b[38;2;125;161;222m", // #7DA1DE 助手标签雾蓝
	// 工具圆点指示色
	toolDotExec: "\x1b[38;2;127;174;153m", // #7FAE99 鼠尾草绿
	toolDotRead: "\x1b[38;2;130;184;199m", // #82B8C7 青蓝
	toolDotWrite: "\x1b[38;2;179;160;212m", // #B3A0D4 浅紫
	toolDotWeb: "\x1b[38;2;125;161;222m", // #7DA1DE 雾蓝
	toolDotTask: "\x1b[38;2;209;148;174m", // #D194AE 玫瑰粉
	// 容器与卡片背景色 (TrueColor Background)
	toolCardBackground: "\x1b[48;2;36;43;58m", // #242B3A 卡片底色
	toolCardBackgroundDim: "\x1b[48;2;28;35;48m", // #1C2330 深层卡片底色
	selectionBg: "\x1b[48;2;59;74;102m", // #3B4A66 选区高亮色
	// 经典兼容器
	iceBlue: "\x1b[38;2;171;194;236m", // 映射到 suggestion 冰蓝
	brandBlue: "\x1b[38;2;125;161;222m", // 映射到 claude 雾蓝
	glowWhite: "\x1b[38;2;255;255;255m",
	darkBg: "\x1b[48;2;36;43;58m",
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

/** 组合记号 / 变体选择符 / ZWJ：簇内零宽修饰符。 */
function isZeroWidthMark(cp: number): boolean {
	return (
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20ff) ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0xfe20 && cp <= 0xfe2f) ||
		(cp >= 0xe0100 && cp <= 0xe01ef) ||
		cp === 0x200d
	);
}

/** 单个 code point 的可视列宽（供逐 code point 的调用方使用）。 */
export function charWidth(char: string): number {
	if (char === "\t") return 2;
	const cp = char.codePointAt(0);
	if (!cp || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	return isFullWidth(cp) ? 2 : 1;
}

/**
 * 单个 grapheme 簇的可视列宽。组合字符算 1 列（不是 2 列），ZWJ 序列、
 * 变体选择符 16 与 astral pictograph 算 2 列。
 */
export function graphemeWidth(segment: string): number {
	const first = segment.codePointAt(0);
	if (first === undefined) return 0;
	if (first === 0x09) return 1; // tab 由调用方按 8 列制表位展开
	if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
	if (isZeroWidthMark(first) && segment.length <= 2) return 0;
	// Regional indicator pairs (flags) are one cluster rendered as two columns.
	if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
	for (const ch of segment) {
		const cp = ch.codePointAt(0);
		if (cp === 0x200d || cp === 0xfe0f) return 2;
	}
	return isFullWidth(first) ? 2 : 1;
}

/**
 * 以 ANSI 控制码 + grapheme 簇为单位遍历字符串。这是所有宽度计算的唯一迭代器，
 * 保证 visibleWidth / truncateToWidth / wrapTextWithAnsi 永远不会切开一个簇。
 * 返回 false 可提前停止。
 */
export function walkGraphemes(text: string, visit: (segment: string, isAnsi: boolean) => boolean | void): void {
	if (!text) return;
	const segments = Array.from(graphemeSegmenter.segment(text));
	let si = 0;
	let i = 0;
	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			if (visit(ansi.code, true) === false) return;
			i += ansi.length;
			continue;
		}
		while (si < segments.length && segments[si]!.index + segments[si]!.segment.length <= i) si++;
		const seg = segments[si];
		const piece = seg && seg.index <= i ? text.slice(i, seg.index + seg.segment.length) : text[i]!;
		if (visit(piece, false) === false) return;
		i += piece.length;
	}
}

/**
 * 丢弃"非法的裸控制字符"：只保留合法 ANSI 序列、可见字符与制表符。
 *
 * 为什么必须有这一步：帧行里一个孤立的 ESC 会让终端把**后面的字节**当成转义序列的一部分
 * 吞掉 —— 下一条 `CUP`（行定位）和 `SGR`（底色）随之失效，表现为内容错位、残留、高亮缺格。
 * 真机来源实例：工具结果是 JSON 字符串，`sanitizeRenderText` 作用在 JSON **文本**上时
 * `\u001b` 只是普通字符，`JSON.parse` 之后才变成真 ESC，随后只清了 `\r`，ESC 就进了帧。
 */
export function dropStrayControls(text: string): string {
	if (!text) return "";
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			out += ansi.code;
			i += ansi.length;
			continue;
		}
		const code = text.charCodeAt(i);
		// 制表符交给 expandTabs、回车交给 resolveCarriageReturns；
		// 其余 C0/DEL/C1 一律丢弃（含孤立 ESC：它会让终端吞掉后续定位/底色序列）
		if (code === 0x09 || code === 0x0d) {
			out += text[i];
		} else if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			out += text[i];
		}
		i++;
	}
	return out;
}

/**
 * 回车（CR）语义落地：终端遇到 `\r` 会把光标移回行首，其后的字符**覆盖**该行开头。
 * 帧行里绝不允许出现裸 `\r`：被覆盖的格子不会被涂色、行尾格子则永远没人涂
 *（真机表现为"两段内容重叠" + 底色缺口）。这里按终端语义先算完：后段覆盖前段，
 * 超出部分保留前段尾巴（`"abc\rde"` → `"dec"`，与真机逐格一致）。
 */
export function resolveCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text
		.split("\n")
		.map((line) => {
			if (!line.includes("\r")) return line;
			let out = "";
			for (const seg of line.split("\r")) {
				out = out.length > seg.length ? seg + out.slice(seg.length) : seg;
			}
			return out;
		})
		.join("\n");
}

/**
 * 行进入帧之前的唯一规范化入口：先丢弃孤立控制符，再落地 CR 覆盖语义，最后展开制表符
 *（制表位依赖 CR 之后的内容，顺序不能反）。所有把行交给终端的地方都必须走这里。
 */
export function normalizeFrameLine(line: string): string {
	return expandTabs(resolveCarriageReturns(dropStrayControls(line)));
}

/** tab 展开到下一个 8 列制表位。 */
function tabAdvance(currentColumn: number): number {
	return 8 - (currentColumn % 8);
}

/** 计算包含 ANSI 控制码与多字节中文的字符串真实显示列宽 */
export function visibleWidth(str: string): number {
	if (!str) return 0;
	let w = 0;
	walkGraphemes(str, (segment, isAnsi) => {
		if (isAnsi) return;
		w += segment === "\t" ? tabAdvance(w) : graphemeWidth(segment);
	});
	return w;
}

/**
 * 把制表符展开成空格（8 列制表位，与 visibleWidth 同一模型；ANSI 序列原样保留）。
 *
 * 终端里的 HT 只移动光标、**不涂色**：被它跳过的格子会保留上一帧的内容、或露出默认底色。
 * 实测后果有两个（同一根因）：
 *   1. 卡片底色中间出现空洞（跳过的格子没被涂上卡片底色）；
 *   2. 上一帧的旧文本残留在新行里，看起来像两段内容"重叠"。
 * 所以帧行在写入终端前必须先展开制表符，保证"写出去的每个格子都被我们涂过"。
 */
export function expandTabs(text: string): string {
	if (!text.includes("\t")) return text;
	let out = "";
	let col = 0;
	walkGraphemes(text, (segment, isAnsi) => {
		if (isAnsi) {
			out += segment;
			return;
		}
		if (segment === "\t") {
			const advance = tabAdvance(col);
			out += " ".repeat(advance);
			col += advance;
			return;
		}
		out += segment;
		col += graphemeWidth(segment);
	});
	return out;
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
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsisW = visibleWidth(ellipsis);
	if (maxWidth < ellipsisW) {
		return maxWidth >= 1 ? ".".repeat(maxWidth) : "";
	}
	const targetWidth = maxWidth - ellipsisW;

	let curWidth = 0;
	let result = "";
	walkGraphemes(text, (segment, isAnsi) => {
		if (isAnsi) {
			result += segment;
			return;
		}
		const w = segment === "\t" ? tabAdvance(curWidth) : graphemeWidth(segment);
		if (curWidth + w > targetWidth) return false;
		result += segment;
		curWidth += w;
	});

	return `${result}${C.reset}${ellipsis}`;
}

/**
 * 统一跨平台剪贴板复制服务：
 * 1. 首选终端原生 OSC 52 转义协议（零子进程、跨 SSH 宿主直达）；
 * 2. 本地系统原生工具轻量兜底（Windows clip.exe 确保 UTF-8，macOS pbcopy）。
 */
export function copyToClipboardUnified(text: string): void {
	if (!text) return;
	const b64 = Buffer.from(text, "utf-8").toString("base64");
	try {
		process.stdout.write(`\x1b]52;c;${b64}\x07`);
	} catch {}

	if (process.platform === "win32" && !process.env["SSH_CONNECTION"]) {
		try {
			const child = spawn("cmd.exe", ["/c", "chcp 65001 >nul && clip"], {
				stdio: ["pipe", "ignore", "ignore"],
				windowsHide: true,
			});
			child.on("error", () => {});
			child.stdin.end(Buffer.from(text, "utf-8"));
			child.unref();
		} catch {}
	} else if (process.platform === "darwin" && !process.env["SSH_CONNECTION"]) {
		try {
			const child = spawn("pbcopy", [], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.on("error", () => {});
			child.stdin.end(Buffer.from(text, "utf-8"));
			child.unref();
		} catch {}
	}
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
			const lineToPush = currentStyle ? `${currentStyle}${rawLine}` : rawLine;
			output.push(currentStyle && !lineToPush.endsWith(C.reset) ? `${lineToPush}${C.reset}` : lineToPush);
			// 扫描这行有没有产生新的 style
			const matches = rawLine.match(/\x1b\[[0-9;]*m/g);
			if (matches) {
				for (const m of matches) {
					if (m === "\x1b[0m") currentStyle = "";
					else currentStyle = m;
				}
			}
			continue;
		}

		let curLine = currentStyle;
		let curWidth = 0;

		walkGraphemes(rawLine, (segment, isAnsi) => {
			if (isAnsi) {
				curLine += segment;
				if (segment === C.reset) currentStyle = "";
				else if (segment.endsWith("m")) currentStyle = segment;
				return;
			}
			const w = segment === "\t" ? tabAdvance(curWidth) : graphemeWidth(segment);
			if (curWidth + w > maxWidth) {
				output.push(`${curLine}${C.reset}`);
				curLine = `${currentStyle}${segment}`;
				curWidth = w;
			} else {
				curLine += segment;
				curWidth += w;
			}
		});

		if (curLine) {
			output.push(currentStyle && !curLine.endsWith(C.reset) ? `${curLine}${C.reset}` : curLine);
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

export function getPrevGraphemeIndex(text: string, cursorIndex: number): number {
	if (cursorIndex <= 0) return 0;
	const segments = Array.from(graphemeSegmenter.segment(text));
	let prevIndex = 0;
	for (const seg of segments) {
		if (seg.index < cursorIndex) {
			prevIndex = seg.index;
		} else {
			break;
		}
	}
	return prevIndex;
}

export function getNextGraphemeIndex(text: string, cursorIndex: number): number {
	if (cursorIndex >= text.length) return text.length;
	const segments = Array.from(graphemeSegmenter.segment(text));
	for (const seg of segments) {
		if (seg.index > cursorIndex) {
			return seg.index;
		}
		const end = seg.index + seg.segment.length;
		if (end > cursorIndex) {
			return end;
		}
	}
	return text.length;
}
