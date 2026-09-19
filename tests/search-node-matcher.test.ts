// 批次 3（ui-crap-debt-plan）：node 引擎的纯内核钉住——模式→正则构建与逐行匹配。
// buildLineMatcher / matchLines 从 grepWithNode 拆出（此前整体 0% 覆盖）。
import { describe, expect, it } from "vitest";
import { buildLineMatcher, matchLines, type SearchMatch } from "../src/extensions/workspace-tools/search-core.js";

describe("buildLineMatcher", () => {
	it("literal 模式转义元字符：'a.b' 只命中字面量", () => {
		const re = buildLineMatcher("a.b", true, false);
		expect(re.test("a.b")).toBe(true);
		expect(re.test("axb")).toBe(false);
	});

	it("非 literal：'a.b' 作为正则命中 'axb'", () => {
		const re = buildLineMatcher("a.b", false, false);
		expect(re.test("axb")).toBe(true);
	});

	it("ignoreCase 传入 i 标志", () => {
		expect(buildLineMatcher("abc", true, true).test("ABC")).toBe(true);
		expect(buildLineMatcher("abc", true, false).test("ABC")).toBe(false);
	});

	it("非法正则抛带指引的错误", () => {
		expect(() => buildLineMatcher("([", false, false)).toThrow(/search：pattern 不是合法正则/);
	});
});

describe("matchLines", () => {
	const collect = (): SearchMatch[] => [];

	it("逐行匹配：1 基行号、剥 \\r、保留原始行文本", () => {
		const matches = collect();
		const hit = matchLines("no\r\nyes here\r\nno", buildLineMatcher("yes", true, false), "f.ts", matches, 100);
		expect(hit).toBe(false);
		expect(matches).toEqual([{ file: "f.ts", line: 2, text: "yes here" }]);
	});

	it("达上限立即返回 true，且不再继续行", () => {
		const matches = collect();
		const hit = matchLines("a\na\na", buildLineMatcher("a", true, false), "f", matches, 2);
		expect(hit).toBe(true);
		expect(matches).toHaveLength(2);
	});

	it("无命中返回 false 且 matches 不变", () => {
		const matches = collect();
		expect(matchLines("x\ny", buildLineMatcher("zzz", true, false), "f", matches, 10)).toBe(false);
		expect(matches).toHaveLength(0);
	});
});
