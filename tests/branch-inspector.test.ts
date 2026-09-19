import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { listAllSessionNodes, listSessionBranches, listSessionNodes, readSessionBranch, readSessionNode } from "../src/session/navigation.js";
import { BranchInspectorOverlay } from "../src/ui/components/overlays/branch-inspector.js";
import { CustomMessageComponent } from "../src/ui/components/transcript/cards.js";
import { Key, matchesKey } from "../src/ui/core/keys.js";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";

// matchesKey only matches keys with an explicit branch; anything else degrades to a literal
// string compare against the escape sequence, so a missing branch silently disables the key.
describe("Alt+H binding", () => {
	it("matches every terminal encoding of Alt+H", () => {
		const encodings = ["\x1bh", "\x1bH", "\x1b\x1bh", "\x1b\x1bH", "\x1b[104;3u", "\x1b[72;3u", "\x1b[27;3;104~", "\x1b[1;3h", "\x1b[1;3H"];
		expect(encodings.filter((data) => matchesKey(data, Key.alt("h")))).toEqual(encodings);
	});

	it("does not fire on other keys", () => {
		expect(["\x1bx", "h", "\x1b", "\x1b[A", "\x1bh\n"].some((data) => matchesKey(data, Key.alt("h")))).toBe(false);
	});
});

async function seedInspectorStore(): Promise<MemorySessionStore> {
	const store = new MemorySessionStore();
	for (let i = 0; i < 40; i++) {
		await store.appendMessage({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `第 ${i} 条会话消息内容 hello world ${"超长中文内容".repeat(i % 4)}`,
		});
	}
	const targetId = store.readRecords()[30]!.id;
	await store.appendMessage({ role: "assistant", content: "被放弃的分支回复\n第二行：一段很长的中英混合描述，用于验证详情栏换行不会溢出边框" });
	await store.appendRewind({
		id: "rewind-node",
		requestId: "q1",
		targetId,
		fromId: store.readRecords().at(-1)!.id,
		source: "model",
		reason: "验证覆盖层布局宽度收敛与换行行为",
		note: "经验摘要：先测量再落盘，避免提交无法使用的上下文。",
	});
	return store;
}

function accessFor(store: MemorySessionStore) {
	return {
		list: (options?: Parameters<typeof listSessionNodes>[1]) => listSessionNodes(store.state, options),
		listBranches: () => listSessionBranches(store.state),
		readBranch: (id: string) => readSessionBranch(store.state, id),
		read: (id: string) => readSessionNode(store.state, id),
		requestRewind: async () => ({ requestId: "x", status: "committed" as const }),
	};
}

/**
 * The host font, not Uina, decides whether an East Asian Ambiguous glyph occupies one cell or
 * two. A Latin console font that supplies box drawing while CJK text falls back to a CJK font
 * renders ● ○ ◆ ◧ ▸ ⟲ ❯ ← → ↑ ↓ · two cells wide, while visibleWidth measures one. This model
 * is the only way to see the reported "left rule straight, middle and right zigzag": every
 * string-level assertion below measures with the same width rule that can be wrong, so padding
 * looks perfect to all of them.
 */
const HOST_AMBIGUOUS_WIDE = new Set(Array.from("●○◆◇◧▸⟲❯←→↑↓·…—"));

function hostGlyphWidth(char: string): number {
	const cp = char.codePointAt(0)!;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (cp >= 0x2e80 && cp <= 0xa4cf) return 2;
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
	if (cp >= 0xff00 && cp <= 0xff60) return 2;
	if (cp >= 0x1f300) return 2;
	return HOST_AMBIGUOUS_WIDE.has(char) ? 2 : 1;
}

/** Replays one rendered row through the host font, honouring CHA column moves. */
function hostFrameColumns(line: string): number[] {
	const columns: number[] = [];
	let column = 1;
	for (let index = 0; index < line.length; ) {
		if (line[index] === "\x1b") {
			const escape = line.slice(index).match(/^\x1b\[([0-9;]*)([A-Za-z])/);
			if (escape) {
				if (escape[2] === "G") column = Number(escape[1]);
				index += escape[0].length;
				continue;
			}
			index++;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index)!);
		if ("│┼┴├┤╭╮╰╯".includes(char)) columns.push(column);
		column += hostGlyphWidth(char);
		index += char.length;
	}
	return columns;
}

describe("BranchInspectorOverlay geometry", () => {
	// A row wider than its declared box is wrapped by the terminal, which drags the
	// bottom-pinned input box up into the middle of the panel. Every row must fit.
	it("emits every row at exactly the declared width across terminal sizes and focus modes", async () => {
		const store = await seedInspectorStore();
		const access = accessFor(store);
		const mismatches: string[] = [];
		for (const terminalWidth of [240, 160, 120, 100, 90, 80, 70, 60, 50, 44]) {
			for (const browsingDetail of [false, true]) {
				const view = new BranchInspectorOverlay(access);
				if (browsingDetail) {
					view.handleInput("\t");
					for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");
				}
				const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
				view.render(terminalWidth).forEach((line, index) => {
					const width = visibleWidth(stripAnsi(line));
					if (width !== boxWidth) mismatches.push(`tw=${terminalWidth} detail=${browsingDetail} row=${index} w=${width} expected=${boxWidth}`);
				});
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("lands the right border on one column for every row, including the footer", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		// The footer carries a longer hint once the detail pane has more rows than the list
		// shows. A hint that is truncated — or shorter than its cell — must not pull the
		// closing border in, which is what made the right edge look serrated.
		view.handleInput("\t");
		for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");

		for (const terminalWidth of [160, 120, 100, 80, 60]) {
			const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
			const rightEdges = view.render(terminalWidth).map((line) => visibleWidth(stripAnsi(line)));
			expect({ terminalWidth, rightEdges: [...new Set(rightEdges)] }).toEqual({ terminalWidth, rightEdges: [boxWidth] });
		}
	});

	// The bottom border has to read as a line: dashes on both sides of the inline hint, and the
	// pane divider terminating into it. Padding the hint out with blanks left the left half of
	// the frame with no bottom edge, and a full-height "│" crossed the line at that column.
	it("draws the bottom border as one continuous line", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		view.handleInput("\t");
		for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");

		const problems: string[] = [];
		for (const terminalWidth of [160, 120, 100, 80, 60, 54]) {
			const footer = stripAnsi(view.render(terminalWidth).at(-1)!);
			if (!/^ {2}╰─ .+ ─+┴─+╯$/.test(footer)) {
				problems.push(`tw=${terminalWidth} footer=${JSON.stringify(footer)}`);
			}
		}
		expect(problems).toEqual([]);
	});

	// Comparing only total row width is not enough: a separator whose cross sits one column
	// off still produces a full-width row, but the middle vertical line visibly zigzags.
	it("aligns the left, middle and right vertical lines on one column each", async () => {
		const store = await seedInspectorStore();
		const mismatches: string[] = [];
		for (const terminalWidth of [160, 120, 100, 80, 74, 60]) {
			for (const focusDetail of [false, true]) {
				const view = new BranchInspectorOverlay(accessFor(store));
				if (focusDetail) {
					view.handleInput("\t");
					for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");
				}
				const lines = view.render(terminalWidth).map((line) => stripAnsi(line));
				const left = new Set<number>();
				const right = new Set<number>();
				// The frame columns carry the separator: "│" in a body row and "┼" in the rule
				// beneath the column labels. A "│" inside user text (e.g. "↑/↓") is not a column.
				const middle = new Set<number>();
				for (const line of lines) {
					const marks: { glyph: string; column: number }[] = [];
					for (let index = 0; index < line.length; index++) {
						const glyph = line[index]!;
						if ("│┼┴├┤╭╮╰╯".includes(glyph)) marks.push({ glyph, column: visibleWidth(line.slice(0, index)) });
					}
					if (marks.length === 0) continue;
					left.add(marks[0]!.column);
					right.add(marks[marks.length - 1]!.column);
					const separator = marks.find((mark) => mark.glyph === "┼" || mark.glyph === "┴");
					if (separator) middle.add(separator.column);
					// The rule under the column labels plus the body rows share one separator column.
					const bodyMiddle = marks.filter((mark) => mark.glyph === "│");
					if (bodyMiddle.length === 3) middle.add(bodyMiddle[1]!.column);
				}
				// Both the rule's cross and the body separators must sit on one shared column.
				if (left.size !== 1 || right.size !== 1 || middle.size !== 1) {
					mismatches.push(
						`tw=${terminalWidth} detail=${focusDetail} left=${[...left]} mid=${[...middle]} right=${[...right]}`,
					);
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	// Column position alone is not enough: a border glyph emitted without its colour code
	// inherits whatever the previous cell left behind, so the middle line and the outer frame
	// render in different colours — which reads as a misaligned/broken frame on screen.
	it("colours every border glyph with the frame colour", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		view.handleInput("\t");
		for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");

		const problems: string[] = [];
		for (const terminalWidth of [160, 120, 80, 60]) {
			for (const [index, line] of view.render(terminalWidth).entries()) {
				let cursor = 0;
				while (cursor < line.length) {
					const character = line[cursor]!;
					if (!"│┼┴├┤╭╮╰╯".includes(character)) {
						cursor++;
						continue;
					}
					// The glyph must sit directly after a colour escape, so it never inherits state.
					const prefix = line.slice(0, cursor);
					if (!/\x1b\[[0-9;]*m$/.test(prefix)) {
						problems.push(`tw=${terminalWidth} row=${index} col=${cursor} glyph=${character}`);
					}
					cursor++;
				}
			}
		}
		expect(problems).toEqual([]);
	});

	// The string-level column test above passes even when the frame zigzags on a real terminal:
	// it measures with our own width model, which is the thing that can be wrong. Replay the
	// rows through a host font that renders ambiguous glyphs two cells wide instead.
	it("keeps every rule on its own column when the host font renders ambiguous glyphs wide", async () => {
		const store = await seedInspectorStore();
		const mismatches: string[] = [];
		for (const terminalWidth of [160, 120, 100, 80, 60]) {
			for (const focusDetail of [false, true]) {
				const view = new BranchInspectorOverlay(accessFor(store));
				if (focusDetail) {
					view.handleInput("\t");
					for (let step = 0; step < 40; step++) view.handleInput("\x1b[B");
				}
				const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
				const leftW = Math.max(12, Math.floor((boxWidth - 8) * 0.45));
				const allowed = new Set([3, leftW + 5, boxWidth]);
				for (const [index, line] of view.render(terminalWidth).entries()) {
					const columns = hostFrameColumns(line);
					if (columns.length === 0) continue;
					const stray = columns.filter((column) => !allowed.has(column));
					if (stray.length > 0 || columns.at(-1) !== boxWidth) {
						mismatches.push(`tw=${terminalWidth} detail=${focusDetail} row=${index} columns=${columns.join(",")}`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	// 三种视图的列表行来自不同投影（主线节点 / 分支行 / 分支内节点），框宽必须都收敛到同一值。
	// 这条原先挂在"f 键切换过滤范围"上 —— 而组件里根本没有 f 分支，等于空转。
	it("keeps one frame width across all three views", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		const widths = () => [...new Set(view.render(120).map((line) => visibleWidth(stripAnsi(line))))];
		const header = () => stripAnsi(view.render(120)[0]!);

		expect(header()).toContain("主线");
		expect(widths()).toEqual([96]);

		view.handleInput("\x1b[C"); // → 分支列表
		expect(header()).toContain("分支选择");
		expect(widths()).toEqual([96]);

		view.handleInput("\r"); // Enter → 分支历史
		expect(header()).toContain("分支历史");
		expect(widths()).toEqual([96]);

		view.handleInput("\x1b"); // Esc → 退回分支列表
		expect(header()).toContain("分支选择");
		expect(widths()).toEqual([96]);
	});

	// The panel is anchored above the bottom-pinned editor, so an oversized panel would be
	// trimmed by the overlay budget and lose its footer instead of showing a broken frame.
	it("renders a frame short enough for the overlay budget of a 24-row terminal", async () => {
		const store = await seedInspectorStore();
		const height = new BranchInspectorOverlay(accessFor(store)).render(120).length;
		expect(height).toBeLessThanOrEqual(20);
	});

	it("keeps the frame intact when a node preview carries newlines and long JSON", async () => {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "start" });
		const targetId = store.readRecords()[0]!.id;
		// The shape that broke the panel: a long line, then newlines, then more content.
		await store.appendMessage({
			role: "assistant",
			content: '{"error":"工具已返回，但结果被截断，需要读取完整输出文件"}\n请查看 fullOutputPath\n第三行内容',
		});
		await store.appendMessage({ role: "user", content: "继续" });
		await store.appendRewind({
			id: "rewind-node",
			requestId: "q1",
			targetId,
			fromId: store.readRecords().at(-1)!.id,
			source: "model",
			reason: "多行内容",
		});

		const view = new BranchInspectorOverlay(accessFor(store));
		const boxWidth = Math.max(54, Math.min(120 - 6, 96));
		const widths = new Set(view.render(120).map((line) => visibleWidth(stripAnsi(line))));
		expect([...widths]).toEqual([boxWidth]);
		// A newline inside a row would move the cursor down and shift the whole frame.
		expect(view.render(120).some((line) => line.includes("\n") || line.includes("\r"))).toBe(false);
	});

	it("分支列表是内核投影：一条 rewind 记录一行，被放弃的节点不出现在这里", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		view.handleInput("\x1b[C");
		const rendered = stripAnsi(view.render(120).join("\n"));
		expect(rendered).toContain("[只读分支]");
		// 该会话只有一条 rewind 记录 → 只有一行分支，行内是分支摘要（短 id · 节点数 · 原因）。
		expect(rendered).toContain("验证覆盖层布局宽度收敛与换行行为");
		// 被放弃的正文是那条分支的内容，不是分支本身 —— 不该被当成分支列出来。
		expect(rendered).not.toContain("被放弃的分支回复");
	});

	it("进入分支后列出被放弃的节点", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		view.handleInput("\x1b[C");
		view.handleInput("\r");
		const rendered = stripAnsi(view.render(120).join("\n"));
		expect(rendered).toContain("分支历史（只读）");
		expect(rendered).toContain("被放弃的分支回复");
	});
});

describe("BranchInspectorOverlay arrow-key semantics", () => {
	it("switches view while the list has focus, pages the detail pane once it has focus", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		const header = () => stripAnsi(view.render(100)[0]!);

		// 列表焦点：←/→ 仍是切视图（提示也这么写）。
		expect(header()).toContain("主线");
		view.handleInput("\x1b[C");
		expect(header()).toContain("分支选择");
		view.handleInput("\x1b[D");
		expect(header()).toContain("主线");

		// 详情焦点：←/→ 改去翻详情面板，而不是又切一次视图。
		view.handleInput("\t");
		view.handleInput("\x1b[C");
		expect(header()).toContain("主线");

		// 向后翻用右箭头，向前翻用左箭头；X/Y 会跟着动。
		const paged = () => stripAnsi(view.render(100).at(-1)!).match(/翻页详情 (\d+)\/(\d+)/);
		const start = paged();
		if (start) {
			view.handleInput("\x1b[C");
			expect(Number(paged()![1])).toBeGreaterThan(Number(start[1]));
			view.handleInput("\x1b[D");
			expect(Number(paged()![1])).toBe(Number(start[1]));
		}
	});
});

describe("BranchInspectorOverlay paging", () => {
	// list() 的分页游标必须被排空：漏一页会让第 51 条起消失，重复消费则会让同一条出现两次。
	it("drains every page in order without duplicates", async () => {
		const store = new MemorySessionStore();
		for (let i = 0; i < 125; i++) {
			await store.appendMessage({ role: i % 2 === 0 ? "user" : "assistant", content: "分页 " + i });
		}
		const port = { list: (options?: Parameters<typeof listSessionNodes>[1]) => listSessionNodes(store.state, options) };
		const drained = listAllSessionNodes(port, { scope: "main" });
		const expected = listSessionNodes(store.state, { scope: "main", limit: 1000 }).nodes;
		expect(drained.map((n) => n.id)).toEqual(expected.map((n) => n.id));
		expect(new Set(drained.map((n) => n.id)).size).toBe(drained.length);
	});


	// list() 的 limit 是分页页大小（默认 50），不是上限。面板若只取首页，第 51 条起
	// 会静默消失 —— 而标题还会把截断后的条数当作总数印出来，等于对用户撒谎。
	it("shows every mainline node once the history exceeds one page", async () => {
		const store = new MemorySessionStore();
		for (let i = 0; i < 60; i++) {
			await store.appendMessage({ role: i % 2 === 0 ? "user" : "assistant", content: "分页节点 " + i });
		}
		// 用显式大 limit 取真实总数，绝不把 bug 的产物（50）当成期望值
		const all = listSessionNodes(store.state, { scope: "main", limit: 1000 }).nodes;
		expect(all.length).toBeGreaterThan(50);

		const view = new BranchInspectorOverlay(accessFor(store));
		expect(stripAnsi(view.render(200).join("\n"))).toContain(all.length + " 节点");

		// 滚到列表末尾：最后一条必须可达，而不是停在第 50 条
		for (let step = 0; step < all.length; step++) view.handleInput("\x1b[B");
		expect(stripAnsi(view.render(200).join("\n"))).toContain("#" + all.at(-1)!.seq);
	});
});

describe("transcript card geometry", () => {
	// A card whose border rows disagree with its body rows reads as broken in the transcript.
	it("keeps one frame width for the rewind card and the generic custom-message card", () => {
		const rewind = new CustomMessageComponent({
			customType: "session-rewind",
			content: "[会话回溯 r1]",
			details: {
				record: { fromId: "aaaaaaa1", targetId: "bbbbbbb2", source: "model", reason: "前期假设错误，需要折叠整条路径" },
				effects: {
					modifiedFiles: ["src/config.ts", "tests/config.test.ts"],
					executedCommands: ["pnpm build"],
					dispatchedTasks: [{ id: "job-102", type: "job" }],
				},
			},
		} as never);
		const generic = new CustomMessageComponent({
			customType: "test:demo",
			content: "hello custom message\nsecond line with 中文内容 to check width handling",
		} as never);

		for (const [label, component, maxWidth, floor] of [
			["rewind", rewind, 88, 32],
			["generic", generic, 80, 24],
		] as const) {
			for (const terminalWidth of [160, 120, 100, 80, 60, 40]) {
				const declared = Math.max(floor, Math.min(terminalWidth, maxWidth));
				const widths = new Set(component.render(terminalWidth).map((line) => visibleWidth(stripAnsi(line))));
				expect({ label, terminalWidth, widths: [...widths] }).toEqual({ label, terminalWidth, widths: [declared] });
			}
		}
	});
});

describe("BranchInspectorOverlay：CRLF 详情不炸帧", () => {
	function makePort(content: string): import("../src/session/types.js").SessionAccess {
		return {
			list: () => ({
				nodes: Array.from({ length: 20 }, (_, i) => ({
					id: `node-${i}`, parentId: null, seq: i + 1, kind: "message" as const,
					active: true, canRewind: false, preview: `节点 ${i}`,
				})),
			}),
			listBranches: () => ({ branches: [] }),
			readBranch: () => ({ branch: { id: "b", nodeCount: 0, reason: "" }, nodes: [] }),
			read: () => ({
				id: "node-3", parentId: null, seq: 4, timestamp: "t", kind: "message" as const,
				message: { role: "tool" as const, content },
			}),
			requestRewind: () => { throw new Error("not used"); },
		} as unknown as import("../src/session/types.js").SessionAccess;
	}

	const CRLF_TOOL_OUTPUT = 'stdout 行一\r\nstdout 行二\r\n{"code":0}\r\n'.repeat(30);

	it("详情行不携带 CR（终端收到 CR 会从行首重写当前行）", () => {
		const overlay = new BranchInspectorOverlay(makePort(CRLF_TOOL_OUTPUT));
		overlay.render(96);
		overlay.handleInput("\x1b[B");
		const rows = overlay.render(96);
		const crlfRows = rows.filter((r) => r.includes("\r"));
		expect(crlfRows, `详情行携带物理 CR：\n${crlfRows.map((r) => JSON.stringify(r)).join("\n")}`).toEqual([]);
	});

	it("整帧行数不超预算（CR 引发的软换行会把后续行顶出视口）", () => {
		const overlay = new BranchInspectorOverlay(makePort(CRLF_TOOL_OUTPUT));
		overlay.handleInput("\x1b[B");
		const rows = overlay.render(96);
		expect(rows.length).toBeLessThanOrEqual(20);
	});
});

