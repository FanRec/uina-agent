import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { listSessionNodes, readSessionNode } from "../src/session/navigation.js";
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
		summary: "经验摘要：先测量再落盘，避免提交无法使用的上下文。",
	});
	return store;
}

function accessFor(store: MemorySessionStore) {
	return {
		list: (options?: Parameters<typeof listSessionNodes>[1]) => listSessionNodes(store.readRecords(), options),
		read: (id: string) => readSessionNode(store.readRecords(), id),
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

	it("keeps one frame width while cycling the filter scope", async () => {
		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		for (const presses of [0, 1, 2, 3]) {
			for (let step = 0; step < presses; step++) view.handleInput("f");
			const widths = new Set(view.render(120).map((line) => visibleWidth(stripAnsi(line))));
			expect([...widths]).toEqual([96]);
		}
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

	it("shows the rewind facts of the selected node inside the frame", async () => {		const store = await seedInspectorStore();
		const view = new BranchInspectorOverlay(accessFor(store));
		view.handleInput("\x1b[C");
		view.handleInput("\r");
		const nodeCount = listSessionNodes(store.readRecords(), { scope: "all" }).nodes.length;
		for (let step = 0; step < nodeCount; step++) view.handleInput("\x1b[B");
		const rendered = view.render(120).map((line) => stripAnsi(line)).join("\n");
		expect(rendered).toContain("只读分支");
		expect(rendered).toContain("被放弃的分支回复");
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

