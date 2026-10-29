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
	// 工具圆点指示色
	toolDotExec: "\x1b[38;2;127;174;153m", // #7FAE99 鼠尾草绿
	toolDotRead: "\x1b[38;2;130;184;199m", // #82B8C7 青蓝
	toolDotWrite: "\x1b[38;2;179;160;212m", // #B3A0D4 浅紫
	toolDotWeb: "\x1b[38;2;125;161;222m", // #7DA1DE 雾蓝
	// 容器与卡片背景色 (TrueColor Background)
	toolCardBackground: "\x1b[48;2;36;43;58m", // #242B3A 卡片底色
	toolCardBackgroundDim: "\x1b[48;2;28;35;48m", // #1C2330 深层卡片底色
	selectionBg: "\x1b[48;2;59;74;102m", // #3B4A66 选区高亮色
	// 清晰高亮与卡片背景
	glowWhite: "\x1b[38;2;255;255;255m",
};

/** 剥离所有 ANSI 转义控制码 */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "");
}

/**
 * Unicode EastAsianWidth Wide/Fullwidth 区间表（Unicode 15 实用子集，按区间升序）。
 * 旧实现对 0x1F300–0x1FAFF 整段按宽字符处理、又漏掉 ⌚☔⚽ 等 BMP 符号；
 * 这里改为精确区间，emoji 区段之外的符号不再虚占 2 列。
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x231a, 0x231b], // ⌚⌛
	[0x2329, 0x232a], // 〈〉斜角括号（宽形）
	[0x23e9, 0x23ec], // ⏩⏪⏫⏬
	[0x23f0, 0x23f0], // ⏰
	[0x23f3, 0x23f3], // ⏳
	[0x25fd, 0x25fe], // ◽◾
	[0x2614, 0x2615], // ☔☕
	[0x2648, 0x2653], // 黄道十二宫
	[0x267f, 0x267f], // ♿
	[0x2693, 0x2693], // ⚓
	[0x26a1, 0x26a1], // ⚡
	[0x26aa, 0x26ab], // ⚪⚫
	[0x26bd, 0x26be], // ⚽⚾
	[0x26c4, 0x26c5], // ⛄⛅
	[0x26ce, 0x26ce], // ♊
	[0x26d4, 0x26d4], // ⛔
	[0x26ea, 0x26ea], // ⛪
	[0x26f2, 0x26f3], // ⛲⛳
	[0x26f5, 0x26f5], // ⛵
	[0x26fa, 0x26fa], // ⛺
	[0x26fd, 0x26fd], // ⛽
	[0x2705, 0x2705], // ✅
	[0x270a, 0x270b], // ✊✋
	[0x2728, 0x2728], // ✨
	[0x274c, 0x274c], // ❌
	[0x274e, 0x274e], // ❎
	[0x2753, 0x2755], // ❓❔❕
	[0x2757, 0x2757], // ❗
	[0x2795, 0x2797], // ➕➖➗
	[0x27b0, 0x27b0], // ➰
	[0x27bf, 0x27bf], // ➿
	[0x2b1b, 0x2b1c], // ⬛⬜
	[0x2b50, 0x2b50], // ⭐
	[0x2b55, 0x2b55], // ⭕
	[0x2e80, 0x2e99], // CJK 部首
	[0x2e9b, 0x2ef3],
	[0x2f00, 0x2fd5], // 康熙部首
	[0x3000, 0x303e], // CJK 标点（含全角空格）
	[0x3041, 0x3096], // 平假名
	[0x3099, 0x30ff], // 浊点/片假名
	[0x3105, 0x312f], // 注音
	[0x3131, 0x318e], // 谚文兼容字母
	[0x3190, 0x31e3], // CJK 附录
	[0x31f0, 0x321e], // 假名兼容/带圈 CJK
	[0x3220, 0x3247],
	[0x3250, 0x4dbf], // 带圈表意 → 汉字扩展 A
	[0x4e00, 0xa48c], // 汉字基本区 → 彝文
	[0xa490, 0xa4c6], // 彝文兼容
	[0xa960, 0xa97c], // 谚文扩展 A
	[0xac00, 0xd7a3], // 谚文音节
	[0xf900, 0xfaff], // CJK 兼容表意
	[0xfe10, 0xfe19], // 竖排形式
	[0xfe30, 0xfe52], // CJK 兼容形式
	[0xfe54, 0xfe66],
	[0xfe68, 0xfe6b],
	[0xff01, 0xff60], // 全角形式
	[0xffe0, 0xffe6], // 全角符号
	[0x16fe0, 0x16fe4], // 川续/女书（宽段）
	[0x16ff0, 0x16ff1],
	[0x17000, 0x187f7], // 西夏文
	[0x18800, 0x18cd5],
	[0x18d00, 0x18d08],
	[0x1aff0, 0x1aff3], // 假名扩展
	[0x1aff5, 0x1affb],
	[0x1affd, 0x1affe],
	[0x1b000, 0x1b122], // 假名补充/注音扩展
	[0x1b150, 0x1b152],
	[0x1b164, 0x1b167],
	[0x1b170, 0x1b2fb],
	[0x1f004, 0x1f004], // 🀄
	[0x1f0cf, 0x1f0cf], // 🂡
	[0x1f18e, 0x1f18e], // 🆎
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f202],
	[0x1f210, 0x1f23b],
	[0x1f240, 0x1f248],
	[0x1f250, 0x1f251],
	[0x1f260, 0x1f265],
	[0x1f300, 0x1f320],
	[0x1f32d, 0x1f335],
	[0x1f337, 0x1f37c],
	[0x1f37e, 0x1f393],
	[0x1f3a0, 0x1f3ca],
	[0x1f3cf, 0x1f3d3],
	[0x1f3e0, 0x1f3f0],
	[0x1f3f4, 0x1f3f4],
	[0x1f3f8, 0x1f43e],
	[0x1f440, 0x1f440], // 👀
	[0x1f442, 0x1f4fc],
	[0x1f4ff, 0x1f53d],
	[0x1f54b, 0x1f54e],
	[0x1f550, 0x1f567],
	[0x1f57a, 0x1f57a],
	[0x1f595, 0x1f596],
	[0x1f5a4, 0x1f5a4],
	[0x1f5fb, 0x1f64f],
	[0x1f680, 0x1f6c5],
	[0x1f6cc, 0x1f6cc],
	[0x1f6d0, 0x1f6d2],
	[0x1f6d5, 0x1f6d7],
	[0x1f6dc, 0x1f6df],
	[0x1f6eb, 0x1f6ec],
	[0x1f6f4, 0x1f6fc],
	[0x1f7e0, 0x1f7eb],
	[0x1f7f0, 0x1f7f0],
	[0x1f90c, 0x1f945],
	[0x1f947, 0x1f9ff],
	[0x1fa70, 0x1fa7c],
	[0x1fa80, 0x1fa88],
	[0x1fa90, 0x1fabd],
	[0x1fabf, 0x1fac5],
	[0x1face, 0x1fadb],
	[0x1fae0, 0x1fae8],
	[0x1faf0, 0x1faf8],
	[0x20000, 0x2fffd], // CJK 扩展 B–F
	[0x30000, 0x3fffd], // CJK 扩展 G+
];

function isWideCodePoint(cp: number): boolean {
	let low = 0;
	let high = WIDE_RANGES.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const [start, end] = WIDE_RANGES[mid]!;
		if (cp < start) high = mid - 1;
		else if (cp > end) low = mid + 1;
		else return true;
	}
	return false;
}

/**
 * 判断 Unicode 码点是否为 East Asian Wide/Fullwidth（占 2 列）。
 * 判据是上面的 EAW 区间表；emoji 的 ZWJ/变体选择符组合由 graphemeWidth 按簇处理。
 */
export function isFullWidth(cp: number): boolean {
	return isWideCodePoint(cp);
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

/**
 * 单个 code point 的可视列宽（供逐 code point 的调用方使用）。
 * 与 graphemeWidth 同一口径：tab 的真实列宽由 scanCells/visibleWidth 按 8 列制表位
 * 展开（CELL_TAB），逐字符调用方不应遇到未展开的 tab。
 */
export function charWidth(char: string): number {
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

/** scanCells 对 ANSI 序列报告的宽度。 */
export const CELL_ANSI = -1;
/** scanCells 对水平制表符报告的宽度；真实列宽由调用方按 8 列制表位展开。 */
export const CELL_TAB = -2;

/**
 * 逐个「可见单元」扫描字符串：ANSI 序列报告 CELL_ANSI，制表符报告 CELL_TAB，
 * 其余按 grapheme 簇报告 [start, end) 与可见列宽（0/1/2）。返回 false 可提前停止。
 *
 * 为什么不再产出字符串片段：旧实现每个簇一次 `text.slice()`，45 KB 流式段落
 * 单次折行产生 2.9 万次分配、耗时 11 ms（实测）。只报告下标区间、由调用方按区间
 * 一次 slice 后，同一输入降到 0.24 ms。
 *
 * 簇边界的保证方式：纯文本段若只含"不可能黏连"的码点，按码点逐个报告——这些区段
 * 按 Unicode 定义不含 Extend/ZWJ/RI/Prepend/Jamo/变体选择符，码点即簇；其余段回落
 * Intl.Segmenter。判据是白名单，漏判只会走慢路径，不会算错宽度。
 */
export function scanCells(text: string, visit: (start: number, end: number, width: number) => boolean | void): void {
	if (!text) return;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const esc = text.indexOf("\x1b", i);
		const runEnd = esc === -1 ? n : esc;
		if (runEnd > i) {
			if (!scanRun(text, i, runEnd, visit)) return;
			i = runEnd;
			continue;
		}
		const ansiEnd = scanAnsiEnd(text, i);
		if (ansiEnd === i) {
			// 孤立 ESC：0 宽；丢弃与否由调用方按字符语义决定
			if (visit(i, i + 1, 0) === false) return;
			i += 1;
			continue;
		}
		if (visit(i, ansiEnd, CELL_ANSI) === false) return;
		i = ansiEnd;
	}
}

/** 单码点是否为「不与其他码点黏连」的简单字符（白名单）。 */
function isSimpleCodePoint(cp: number): boolean {
	if (cp === 0x09) return true; // tab：列宽由调用方展开
	if (cp <= 0x7e) return cp >= 0x20; // ASCII 可打印
	if (cp >= 0x7f && cp <= 0x9f) return false; // C1 控制符
	if (cp <= 0x2ff) return cp >= 0xa0; // Latin-1 补充 ~ 国际音标 / 希腊 / 西里尔
	// 0x300-0x1FFF 不进白名单：这一段散布大量组合记号与黏连文字（希腊气符、西里尔
	// 重音、阿拉伯/印度/泰文元音附标、蒙古文变体选择符），宁可走 Segmenter。
	if (cp >= 0x2000 && cp <= 0x206f) {
		// 通用标点只放行可见子域；ZWNJ/ZWJ(200C-F)、行/段分隔、双向控制、隐形算符排除
		return (cp <= 0x200a || (cp >= 0x2010 && cp <= 0x2027) || (cp >= 0x2030 && cp <= 0x205e)) && cp !== 0x2028;
	}
	if (cp >= 0x20d0 && cp <= 0x20ff) return false; // 符号组合记号
	if (cp >= 0x2100 && cp <= 0x2bff) return true; // 字母记号 / 箭头 / 数学 / 技术制图 / 制表符图形 / 几何图形 / 杂项符号 / 丁巴特
	if (cp === 0x3099 || cp === 0x309a) return false; // 假名浊点（组合记号）
	if (cp >= 0x2e80 && cp <= 0xa4cf) return true; // CJK 部首 / 标点 / 假名 / 注音 / 统一表意 / 彝
	if (cp >= 0xac00 && cp <= 0xd7a3) return true; // Hangul 音节
	if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK 兼容表意
	if (cp >= 0xfe10 && cp <= 0xfe19) return true; // 竖排形式
	if (cp >= 0xfe30 && cp <= 0xfe6f) return true; // CJK 兼容形式
	if (cp >= 0xff00 && cp <= 0xff60) return true; // 全角形式
	if (cp >= 0xffe0 && cp <= 0xffe6) return true; // 全角符号
	if (cp >= 0x20000 && cp <= 0x2fa1f) return true; // CJK 扩展 B~F
	return false;
}

/** BMP 码元的列宽（不处理代理对）。 */
function cellWidth(code: number): number {
	if (code === 0x09) return CELL_TAB;
	if (code < 0x20) return 0;
	return isFullWidth(code) ? 2 : 1;
}

/** 扫描 [start, end) 这段无 ESC 的文本：简单串按码点，复杂串回落 Segmenter。 */
function scanRun(
	text: string,
	start: number,
	end: number,
	visit: (start: number, end: number, width: number) => boolean | void,
): boolean {
	let simple = true;
	for (let i = start; i < end; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = text.charCodeAt(i + 1);
			if (i + 1 >= end || low < 0xdc00 || low > 0xdfff) {
				simple = false;
				break;
			}
			if (!isSimpleCodePoint((code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000)) {
				simple = false;
				break;
			}
			i++;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			simple = false;
			break;
		}
		if (!isSimpleCodePoint(code)) {
			simple = false;
			break;
		}
	}

	if (simple) {
		for (let i = start; i < end; ) {
			const code = text.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const cp = (code - 0xd800) * 0x400 + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000;
				if (visit(i, i + 2, isFullWidth(cp) ? 2 : 1) === false) return false;
				i += 2;
				continue;
			}
			if (visit(i, i + 1, cellWidth(code)) === false) return false;
			i += 1;
		}
		return true;
	}

	const sub = text.slice(start, end);
	const iterator = graphemeSegmenter.segment(sub)[Symbol.iterator]();
	for (let step = iterator.next(); !step.done; step = iterator.next()) {
		const segment = step.value.segment;
		const width = segment === "\t" ? CELL_TAB : graphemeWidth(segment);
		if (visit(start + step.value.index, start + step.value.index + segment.length, width) === false) return false;
	}
	return true;
}

/** 返回 ESC 处控制序列的结束下标（不含）；不构成合法序列时返回 start。 */
function scanAnsiEnd(text: string, start: number): number {
	const introducer = text.charCodeAt(start + 1);
	if (introducer === 0x5b) {
		// CSI：参数字节 0x30-0x3F，中间字节 0x20-0x2F，终止字节 0x40-0x7E
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i++);
			if (code >= 0x40 && code <= 0x7e) return i;
		}
		return start;
	}
	if (introducer === 0x5d || introducer === 0x5f || introducer === 0x50 || introducer === 0x5e || introducer === 0x58) {
		// OSC / APC / DCS / PM / SOS：BEL 或 ST(ESC \) 终结
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code === 0x07) return i + 1;
			if (code === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2;
			i++;
		}
		return start;
	}
	return start;
}

/**
 * 丢弃"非法的裸控制字符"：只保留合法 ANSI 序列、可见字符与制表符。
 *
 * 为什么必须有这一步：帧行里一个孤立的 ESC 会让终端把**后面的字节**当成转义序列的一部分
 * 吞掉 —— 下一条 `CUP`（行定位）和 `SGR`（底色）随之失效，表现为内容错位、残留、高亮缺格。
 * 真机来源实例：工具结果是 JSON 字符串，`sanitizeRenderText` 作用在 JSON **文本**上时
 * `\u001b` 只是普通字符，`JSON.parse` 之后才变成真 ESC，随后只清了 `\r`，ESC 就进了帧。
 */
/**
 * 裸 C0（除 tab/CR/**ESC**）/DEL/C1：进入帧会吞掉后续定位与底色序列，一律丢弃。
 * ESC 不算裸控制符——它是合法 ANSI 序列的引导符，工具卡每行都带 SGR。
 */
const STRAY_CONTROLS = /[\u0000-\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/;

export function dropStrayControls(text: string): string {
	if (!text) return "";
	// 绝大多数行本来就没有裸控制符：一次原生扫描即可短路，不进逐单元扫描器。
	// 含 ESC 的行还要求每个 ESC 都是良构序列——孤立/未终结的 ESC 会吞掉后续字节，
	// 必须进慢路径丢弃。
	if (!STRAY_CONTROLS.test(text) && allEscapesWellFormed(text)) return text;
	let out = "";
	let last = 0;
	scanCells(text, (start, end, width) => {
		if (width === CELL_ANSI) return;
		const code = text.charCodeAt(start);
		// 制表符交给 expandTabs、回车交给 resolveCarriageReturns；
		// 其余 C0/DEL/C1 一律丢弃（含孤立 ESC：它会让终端吞掉后续定位/底色序列）
		if (code === 0x09 || code === 0x0d) return;
		if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) return;
		out += text.slice(last, start);
		last = end;
	});
	return out + text.slice(last);
}

function allEscapesWellFormed(text: string): boolean {
	let i = text.indexOf("\x1b");
	while (i !== -1) {
		if (scanAnsiEnd(text, i) === i) return false;
		i = text.indexOf("\x1b", i + 1);
	}
	return true;
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
			const segments = line.split("\r");
			// 终端覆盖语义：后段覆盖前段，超出部分保留前段尾巴。旧实现逐段重建
			// out（O(段数 × 行长)，进度条日志会退化）；这里从右往左一次扫描：
			// 结果 = 最后一段，再依次补上「比已覆盖边界更长」的早期段落的尾部。
			let covered = segments[segments.length - 1]!.length;
			let maxLen = covered;
			for (let i = 0; i < segments.length - 1; i++) {
				const len = segments[i]!.length;
				if (len > maxLen) maxLen = len;
			}
			if (maxLen === covered) return segments[segments.length - 1]!;
			const pieces: string[] = [segments[segments.length - 1]!];
			for (let i = segments.length - 2; i >= 0 && covered < maxLen; i--) {
				const len = segments[i]!.length;
				if (len > covered) {
					pieces.push(segments[i]!.slice(covered, len));
					covered = len;
				}
			}
			// pieces 按拥有者下标从高到低 push，恰好就是结果串从左到右的顺序
			return pieces.join("");
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

/**
 * visibleWidth 的有界记忆化：行字符串不可变 ⇒ 同串必同宽。流式期间视口行被逐帧
 * 重复测量（renderCurrentFrame 每帧对同一批行做 fitLine + 补位两次测量），
 * 以串引用为键命中缓存即可跳过整行扫描。
 *
 * 淘汰是最旧的先出（Map 插入序），命中不搬移：scanCells 之后单次重测只要几微秒，
 * 命中路径上的 delete+set 反而比重测贵（实测 0.004 ms vs 0.0005 ms）。上限 4096
 * 下，每帧几十条动态行要 ~100 帧才会挤掉一条静态行，摊销成本可忽略。
 */
const WIDTH_MEMO_LIMIT = 4096;
const widthMemo = new Map<string, number>();

/** 计算包含 ANSI 控制码与多字节中文的字符串真实显示列宽 */
export function visibleWidth(str: string): number {
	if (!str) return 0;
	const memoed = widthMemo.get(str);
	if (memoed !== undefined) return memoed;
	let w = 0;
	scanCells(str, (_start, _end, width) => {
		if (width === CELL_ANSI) return;
		w += width === CELL_TAB ? tabAdvance(w) : width;
	});
	if (widthMemo.size >= WIDTH_MEMO_LIMIT) {
		const oldest = widthMemo.keys().next().value;
		if (oldest !== undefined) widthMemo.delete(oldest);
	}
	widthMemo.set(str, w);
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
	let last = 0;
	scanCells(text, (start, end, width) => {
		if (width === CELL_ANSI) return;
		if (width === CELL_TAB) {
			const advance = tabAdvance(col);
			out += text.slice(last, start) + " ".repeat(advance);
			last = end;
			col += advance;
			return;
		}
		col += width;
	});
	return last === 0 ? text : out + text.slice(last);
}

/**
 * 从指定位置提取完整的 ANSI 控制码（线性扫描，只在命中时切一次短串）
 */
export function extractAnsiCode(text: string, index: number): { code: string; length: number } | null {
	if (text.charCodeAt(index) !== 0x1b) return null;
	const end = scanAnsiEnd(text, index);
	if (end === index) return null;
	return { code: text.slice(index, end), length: end - index };
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
