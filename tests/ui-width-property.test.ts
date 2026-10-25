/**
 * 宽度/折行的性质测试：用「独立预言机」对拍 scanCells 系实现。
 *
 * 为什么必须独立于 tests/harness/environment/vt-screen.ts：VtScreen 直接复用源码的
 * graphemeSegmenter/graphemeWidth 做逐格模型，两边一起改错时所有 VtScreen 类测试
 * 会结构性失明。这里的预言机在测试内自建 Intl.Segmenter + 手写宽度表，不 import
 * 源码的 graphemeWidth / isFullWidth / walkGraphemes。
 *
 * 覆盖两件事：
 * 1. visibleWidth 与「Segmenter 逐簇累加」在任何随机串上等宽（快路径误判会在这里现形）；
 * 2. truncateToWidth / wrapTextWithAnsi 绝不切开簇，且折行重组后内容无损。
 */
import { describe, expect, it } from "vitest";
import { scanCells, stripAnsi, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/ui/core/utils.js";

// ── 独立预言机（不 import 源码的宽度实现） ─────────────────────────────────

const ORACLE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function oracleIsWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x2fa1f) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		cp === 0x26a1 ||
		cp === 0x2728 ||
		cp === 0x2705 ||
		cp === 0x274c ||
		cp === 0x2b50 ||
		cp === 0x2b55 ||
		cp === 0x23f3 ||
		cp === 0x231b
	);
}

function oracleIsZeroWidthMark(cp: number): boolean {
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

function oracleSegmentWidth(segment: string): number {
	const first = segment.codePointAt(0);
	if (first === undefined) return 0;
	if (first === 0x09) return 1; // tab 的列宽由制表位展开，预言机按源码口径记 1
	if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
	if (oracleIsZeroWidthMark(first) && segment.length <= 2) return 0;
	if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
	for (const ch of segment) {
		const cp = ch.codePointAt(0)!;
		if (cp === 0x200d || cp === 0xfe0f) return 2;
	}
	return oracleIsWide(first) ? 2 : 1;
}

/** ESC 处控制序列的结束下标（CSI/OSC/APC），与源码 scanAnsiEnd 独立实现。 */
function oracleAnsiEnd(text: string, start: number): number {
	const introducer = text[start + 1];
	if (introducer === "[") {
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i++);
			if (code >= 0x40 && code <= 0x7e) return i;
		}
		return start;
	}
	if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^" || introducer === "X") {
		let i = start + 2;
		while (i < text.length) {
			if (text[i] === "\x07") return i + 1;
			if (text[i] === "\x1b" && text[i + 1] === "\\") return i + 2;
			i++;
		}
		return start;
	}
	return start;
}

function oracleWidth(text: string): number {
	let w = 0;
	let i = 0;
	const iterator = ORACLE_SEGMENTER.segment(text)[Symbol.iterator]();
	let pending = iterator.next();
	while (i < text.length) {
		if (text[i] === "\x1b") {
			const end = oracleAnsiEnd(text, i);
			i = end === i ? i + 1 : end;
			continue;
		}
		while (!pending.done && pending.value.index + pending.value.segment.length <= i) pending = iterator.next();
		const seg = pending.done ? undefined : pending.value;
		// 与源码同口径：从当前位置切到所在簇的末尾（簇可能起于更早的 ANSI 末字符）
		const piece = seg && seg.index <= i ? text.slice(i, seg.index + seg.segment.length) : text[i]!;
		w += piece === "\t" ? 8 - (w % 8) : oracleSegmentWidth(piece);
		i += piece.length;
	}
	return w;
}

// ── 随机串生成（确定性 LCG，失败可用种子复现） ─────────────────────────────

const PIECES = [
	"a",
	"Z",
	"9",
	" ",
	"~",
	"中",
	"文",
	"，",
	"。",
	"ｆ",
	"Ａ",
	"かな",
	"カナ",
	"한글",
	"ᄀ",
	"ᅡ",
	"가",
	"é",
	"ü",
	"ß",
	"Ω",
	"ж",
	"𠀀",
	"👍",
	"👍🏽",
	"👨‍👩‍👧",
	"❤️",
	"⌨",
	"🇨🇳",
	"🇯🇵",
	"é",
	"́",
	"\t",
	"\r",
	"\n",
	"\x1b[31m",
	"\x1b[0m",
	"\x1b[38;2;1;2;3m",
];

function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1103515245 + 12345) >>> 0;
		return state / 0x100000000;
	};
}

function randomTexts(count: number): string[] {
	const next = makeLcg(20261025);
	const texts: string[] = [];
	for (let i = 0; i < count; i++) {
		const pieces = 1 + Math.floor(next() * 24);
		let text = "";
		for (let p = 0; p < pieces; p++) text += PIECES[Math.floor(next() * PIECES.length)]!;
		texts.push(text);
	}
	return texts;
}

const SAMPLES = randomTexts(2000);
const NO_ESC_SAMPLES = SAMPLES.filter((text) => !text.includes("\x1b"));

// ── 断言 ─────────────────────────────────────────────────────────────────

describe("scanCells 系宽度实现 vs Segmenter 预言机", () => {
	it("visibleWidth 与逐簇累加在 2000 条随机串上等宽", () => {
		const mismatches: Array<{ text: string; actual: number; expected: number }> = [];
		for (const text of SAMPLES) {
			const actual = visibleWidth(text);
			const expected = oracleWidth(text);
			if (actual !== expected) mismatches.push({ text, actual, expected });
		}
		expect(mismatches).toEqual([]);
	});

	it("scanCells 报告的区间连续且不越过串尾", () => {
		for (const text of SAMPLES.slice(0, 400)) {
			let cursor = 0;
			scanCells(text, (start, end, width) => {
				expect(start).toBe(cursor);
				expect(end).toBeGreaterThan(start);
				expect(end).toBeLessThanOrEqual(text.length);
				expect(Number.isInteger(width)).toBe(true);
				cursor = end;
			});
			expect(cursor).toBe(text.length);
		}
	});

	it("truncateToWidth 不超宽且不切开簇（截断点落在簇边界）", () => {
		for (const text of NO_ESC_SAMPLES) {
			for (const maxWidth of [1, 2, 3, 5, 8, 13, 21]) {
				const result = truncateToWidth(text, maxWidth);
				expect(visibleWidth(result)).toBeLessThanOrEqual(maxWidth);
				if (result.endsWith("…")) {
					const kept = result.slice(0, -1);
					// 截断内容必须是原串某个簇边界上的前缀
					const boundaries = new Set<number>([0]);
					let cursor = 0;
					scanCells(stripAnsi(text), (_s, end) => {
						boundaries.add(end);
						cursor = end;
					});
					boundaries.add(cursor);
					const cleanKept = stripAnsi(kept);
					expect(boundaries.has(cleanKept.length)).toBe(true);
					expect(stripAnsi(text).startsWith(cleanKept)).toBe(true);
				}
			}
		}
	});

	it("wrapTextWithAnsi 折行重组后内容无损", () => {
		for (const text of NO_ESC_SAMPLES) {
			for (const maxWidth of [2, 4, 8, 16, 32]) {
				const lines = wrapTextWithAnsi(text, maxWidth);
				// 折行按 \n 切行，重组时 \n 不会回填（与旧实现一致），故对拍时剥掉
				expect(stripAnsi(lines.join(""))).toBe(stripAnsi(text).replace(/\n/g, ""));
				if (text.includes("\t")) continue; // 制表位展开可越过 maxWidth（既有语义，见 ui-frame expandTabs）
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(maxWidth, 2));
				}
			}
		}
	});

	it("字面量回归：复杂簇宽度与制表位不因快路径漂移", () => {
		expect(visibleWidth("👍🏽")).toBe(2);
		expect(visibleWidth("👨‍👩‍👧")).toBe(2);
		expect(visibleWidth("🇨🇳")).toBe(2);
		expect(visibleWidth("é")).toBe(1);
		expect(visibleWidth("́")).toBe(0);
		expect(visibleWidth("\t")).toBe(8);
		expect(visibleWidth("ab\t")).toBe(8);
		expect(visibleWidth("12345678\t")).toBe(16);
		expect(visibleWidth("中文\t")).toBe(8); // 4 列 + 制表位 8 的余 4
		expect(visibleWidth("가")).toBe(2); // Jamo 序列 = 1 簇 2 列（必须走 Segmenter 路径）
		expect(visibleWidth("𠀀")).toBe(2); // CJK 扩展 B（简单路径的 astral 分支）
	});
});
