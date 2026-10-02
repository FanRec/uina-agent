/**
 * CRAP 存量债务 C3：suggestions.listPathCandidates（路径模式文件发现）与
 * input-line.hitTest（点击→光标索引映射）的覆盖补齐（两者此前 comp≥8 且 0% 覆盖）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputLine } from "../src/ui/components/editor/input-line.js";
import { listPathCandidates } from "../src/ui/components/editor/suggestions.js";

describe("listPathCandidates 路径模式文件发现", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "path-candidates-"));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "src", "components"));
		mkdirSync(join(root, "node_modules"));
		mkdirSync(join(root, "tmp"));
		writeFileSync(join(root, "readme.md"), "x");
		writeFileSync(join(root, "notes.txt"), "x");
		writeFileSync(join(root, "src", "index.ts"), "x");
		writeFileSync(join(root, "src", "utils.ts"), "x");
		writeFileSync(join(root, "src", "components", "panel.ts"), "x");
		writeFileSync(join(root, "tmp", "scratch.txt"), "x");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("空 query 列出根目录直接子项，跳过 SKIP 目录", () => {
		const items = listPathCandidates(root, "");
		const names = items.map((i) => i.name);
		expect(names).toContain("readme.md");
		expect(names).toContain("notes.txt");
		expect(names).toContain("src");
		expect(names).not.toContain("node_modules");
		expect(names).not.toContain("tmp"); // tmp 也在 SKIP 集内
	});

	it("目录后缀穿梭：@src/ 列出 src 子项，路径带目录前缀", () => {
		const items = listPathCandidates(root, "src/");
		expect(items.map((i) => i.path)).toContain("src/index.ts");
		expect(items.map((i) => i.path)).toContain("src/components/");
		// nameQuery 为空时不去重排序门槛
		expect(items.length).toBeGreaterThan(0);
	});

	it("目录前缀 + 名字过滤：@src/in 命中 index.ts", () => {
		const items = listPathCandidates(root, "src/in");
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ path: "src/index.ts", kind: "file" });
	});

	it("目录里的 SKIP 项在目录前缀明确指向时可被发现", () => {
		const items = listPathCandidates(root, "tmp/");
		expect(items.map((i) => i.name)).toContain("scratch.txt");
	});

	it("点号开头的 nameQuery 放行 SKIP 项过滤逻辑", () => {
		// nameQuery ".gi" 以 . 开头 → SKIP 集合放行判定路径
		const items = listPathCandidates(root, "src/.gi");
		expect(items).toEqual([]);
	});

	it("不存在的目录返回空数组而不抛错", () => {
		expect(listPathCandidates(root, "no-such-dir/")).toEqual([]);
	});

	it("bare 目录别名（. 与 ..）可解析", () => {
		// "." → 根目录自身
		const items = listPathCandidates(root, ".");
		expect(items.map((i) => i.name)).toContain("src");
		// ".." 相对 root 的父目录（tmpdir）——只要不炸且返回数组
		const parent = listPathCandidates(root, "..");
		expect(Array.isArray(parent)).toBe(true);
	});

	it("topK 限制返回数量", () => {
		const items = listPathCandidates(root, "", 2);
		expect(items.length).toBeLessThanOrEqual(2);
	});
});

describe("InputLine.hitTest 点击→光标索引", () => {
	it("空文本行：任意点击返回 0", () => {
		const line = new InputLine();
		line.setText("");
		expect(line.hitTest(0, 5)).toBe(0);
	});

	it("单行文本：点击列映射到最近字符边界，超出末尾落到文本长度", () => {
		const line = new InputLine();
		line.setText("hello world");
		// 顶部行之外没有更多行
		expect(line.hitTest(10, 5)).toBeUndefined();
		// 末尾之后点击：落在文本末尾（跨过最后一个字符）
		const end = line.hitTest(0, 100);
		expect(end).toBe("hello world".length);
		// 左端点击：落在起始边界 0
		expect(line.hitTest(0, 0)).toBe(0);
		// 中部点击：落在点击列附近的字符边界
		const mid = line.hitTest(0, 7)!;
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan("hello world".length);
	});

	it("多行文本：第二行点击映射到第二行内的字符索引", () => {
		const line = new InputLine();
		line.setText("ab\ncd");
		const secondRow = line.hitTest(1, 0)!;
		expect(secondRow).toBeGreaterThanOrEqual(3);
		// 第一行末尾之后的列落在行首（不会跨行）
		const firstRowEnd = line.hitTest(0, 100)!;
		expect(firstRowEnd).toBeLessThanOrEqual(2);
	});
});
