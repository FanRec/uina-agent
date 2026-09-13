import { describe, expect, it, vi } from "vitest";
import { UIHost } from "../src/ui/ui-host.js";
import { TranscriptContainer } from "../src/ui/components/transcript/index.js";
import { stripAnsi } from "../src/ui/core/utils.js";
import type { ProcessTerminal } from "../src/ui/core/terminal.js";
import { OverlayStack } from "../src/ui/core/overlay.js";
import { FocusManager } from "../src/ui/core/focus.js";
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "../src/ui/core/utils.js";
import { InputLine, snapToGraphemeBoundary } from "../src/ui/components/editor/index.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import { listSessionNodes, readSessionNode } from "../src/session/navigation.js";

function fakeTerminal(columns = 80, rows = 24): { terminal: ProcessTerminal; frames: string[] } {
	const frames: string[] = [];
	const terminal = {
		columns,
		rows,
		isTTY: true,
		syncWrite: (data: string) => { frames.push(data); },
		write: () => {},
		start: () => {},
		stop: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		cursorUp: () => {},
		cursorDown: () => {},
		clearLine: () => {},
		clearDown: () => {},
		moveTo: () => {},
	} as unknown as ProcessTerminal;
	return { terminal, frames };
}

const plainFrame = (frame: string): string[] =>
	frame
		.split(/\x1b\[\d+;1H/)
		.slice(1)
		.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ""));

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function scrollableHost(turns = 6): { host: UIHost; frames: string[] } {
	const { terminal, frames } = fakeTerminal();
	const host = new UIHost({ terminal, modelName: "TestModel" });
	host.start();
	host.transcript.startTurn(1, "USER-TURN-1");
	host.transcript.startTool("exec_command", { command: "ls -la" }, "call-1");
	host.transcript.addToolDone("exec_command", JSON.stringify({ stdout: "a\nb\nc" }), 100, "succeeded", "call-1", { command: "ls -la" });
	host.transcript.appendToken("done one");
	host.transcript.finishTurn();
	for (let n = 2; n <= turns; n++) {
		host.transcript.startTurn(n, `USER-TURN-${n}`);
		host.transcript.appendToken(`reply ${n} `.repeat(30));
		host.transcript.finishTurn();
	}
	return { host, frames };
}

describe("B1: transcript line model", () => {
	it("keeps hit-zone line indices aligned with rendered lines while streaming", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "长任务");
		// The reveal animation lags far behind the delivered text; hit zones must
		// still point at the rows that are actually drawn.
		transcript.appendToken("x".repeat(4000));
		transcript.startTool("exec_command", { command: "ls -la" }, "call-1");
		transcript.addToolDone("exec_command", JSON.stringify({ stdout: "a" }), 120, "succeeded", "call-1", { command: "ls -la" });
		const lines = transcript.render(80);
		const location = transcript.getToolLineIndices(80)[0];
		expect(location).toBeDefined();
		const header = stripAnsi(lines[location!.lineIndex] ?? "");
		expect(header).toContain("Exec");
	});

	it("produces the same locations whether or not render ran first", () => {
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "hello");
		transcript.appendToken("body");
		transcript.startTool("get_time", {}, "call-9");
		transcript.addToolDone("get_time", "12:00", 5, "succeeded", "call-9", {});
		const withoutRender = transcript.getToolLineIndices(80)[0]!.lineIndex;
		const lines = transcript.render(80);
		const withRender = transcript.getToolLineIndices(80)[0]!.lineIndex;
		expect(withRender).toBe(withoutRender);
		expect(stripAnsi(lines[withRender] ?? "")).toContain("GetTime");
	});

	it("keeps one start line per turn when turn numbers collide", () => {
		// turn_start 的 n 来自引擎 turnSeq，它从不从会话播种；恢复会话后引擎从 0
		// 重新计数，于是恢复出的第 1 轮与引擎新产出的轮次拿到同一个 n。
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "FIRST");
		transcript.appendToken("body-first");
		transcript.finishTurn();
		transcript.startTurn(1, "COLLIDING");
		transcript.appendToken("body-colliding");
		transcript.finishTurn();

		const turnStarts = transcript.getTurnStartLinesByUid(66);
		// 以 n 为键时第二次 set 会覆盖第一次，表里只剩一轮，▲/▼ 会整轮丢失。
		expect(turnStarts.size).toBe(2);
		const uids = transcript.getTimelineTurns().map((turn) => turn.uid);
		expect(uids).toHaveLength(2);
		expect(turnStarts.get(uids[0]!)).toBeLessThan(turnStarts.get(uids[1]!)!);
	});

	it("toggles one thinking block without touching the others in the same turn", () => {
		// 一个轮次里可以有多个思考块（thinking → 文本/工具 → thinking），
		// 所以折叠状态必须落在块上，不能落在轮次上。
		const transcript = new TranscriptContainer();
		transcript.startTurn(1, "Q");
		transcript.appendThinking("ONE");
		transcript.appendToken("mid");
		transcript.appendThinking("TWO");
		transcript.finishTurn();

		const locs = transcript.getThinkingLineIndices(60);
		expect(locs).toHaveLength(2);
		expect(locs[0]!.item.uid).not.toBe(locs[1]!.item.uid);

		transcript.toggleThinking(locs[0]!.item, 60);
		expect(locs[0]!.item.collapsed).toBe(false);
		expect(locs[1]!.item.collapsed).not.toBe(false);

		transcript.toggleThinking(locs[0]!.item, 60);
		expect(locs[0]!.item.collapsed).toBe(true);
		expect(locs[1]!.item.collapsed).not.toBe(false);

		// alt+o 是唯一的轮次级批量入口，逐块写入
		transcript.toggleAllThinking(true);
		expect(locs[0]!.item.collapsed).toBe(true);
		expect(locs[1]!.item.collapsed).toBe(true);
	});
});

describe("B1: layout is the single source of truth", () => {
	it("scrollToTurn pins the target turn at the top of the viewport", async () => {
		const { host, frames } = scrollableHost();
		host.requestRender();
		await settle();
		host.scrollToTurn(3);
		host.requestRender();
		await settle();
		const rows = plainFrame(frames.at(-1)!);
		const visible = ["USER-TURN-1", "USER-TURN-2", "USER-TURN-3", "USER-TURN-4", "USER-TURN-5", "USER-TURN-6"].filter((turn) => rows.some((row) => row.includes(turn)));
		expect(visible).toContain("USER-TURN-3");
		expect(visible).not.toContain("USER-TURN-1");
		expect(visible).not.toContain("USER-TURN-2");
		expect(host.getScrollOffset()).toBeGreaterThan(0);
	});

	it("reports the nearest turn above and below the viewport", async () => {
		const { host } = scrollableHost();
		const nav = host as unknown as { upTurnUid: number | null; downTurnUid: number | null };
		host.requestRender();
		await settle();
		host.scrollToTop();
		host.requestRender();
		await settle();
		expect(nav.upTurnUid).toBeNull();
		expect(nav.downTurnUid).toBe(2);
		host.scrollToBottom();
		host.requestRender();
		await settle();
		expect(nav.upTurnUid).not.toBeNull();
		expect(nav.downTurnUid).toBeNull();
		host.scrollToTurn(3);
		host.requestRender();
		await settle();
		expect(nav.upTurnUid).toBe(2);
		expect(nav.downTurnUid).toBe(6);
	});

	it("scrolls to the asked-for turn when turn numbers collide", async () => {
		const { host, frames } = scrollableHost();
		// 第 7 个轮次故意复用第 1 轮的 n，模拟恢复会话后的撞号。
		host.transcript.startTurn(1, "USER-TURN-COLLIDE");
		host.transcript.appendToken("collide ".repeat(200));
		host.transcript.finishTurn();
		const turns = host.transcript.getTimelineTurns();
		expect(turns.map((turn) => turn.n)).toEqual([1, 2, 3, 4, 5, 6, 1]);
		const firstUid = turns[0]!.uid;
		const collidingUid = turns[6]!.uid;
		expect(collidingUid).not.toBe(firstUid);
		host.requestRender();
		await settle();

		host.scrollToTurn(firstUid);
		host.requestRender();
		await settle();
		let rows = plainFrame(frames.at(-1)!);
		expect(rows.some((row) => row.includes("USER-TURN-1"))).toBe(true);
		expect(rows.some((row) => row.includes("USER-TURN-COLLIDE"))).toBe(false);

		host.scrollToTurn(collidingUid);
		host.requestRender();
		await settle();
		rows = plainFrame(frames.at(-1)!);
		expect(rows.some((row) => row.includes("USER-TURN-COLLIDE"))).toBe(true);
	});

	it("highlights and toggles only the hovered thinking block inside one turn", async () => {
		const { terminal, frames } = fakeTerminal();
		const host = new UIHost({ terminal, modelName: "TestModel" });
		host.start();
		// 一个轮次里两个思考块：真实会话常常是 thinking → 文本/工具 → thinking。
		host.transcript.startTurn(1, "Q-ONE");
		host.transcript.appendThinking("THINK-ONE");
		host.transcript.appendToken("MID-TEXT");
		host.transcript.appendThinking("THINK-TWO");
		host.transcript.appendToken("A-ONE");
		host.transcript.finishTurn();
		host.requestRender();
		await settle();

		const rows = (): string[] => plainFrame(frames.at(-1)!).map(stripAnsi);
		expect(rows().filter((row) => row.includes("点击"))).toHaveLength(0);

		const oneRow = rows().findIndex((row) => row.includes("THINK-ONE"));
		expect(oneRow).toBeGreaterThan(0);
		// 真实鼠标移动（SGR：btn=35 为无按键移动，col/row 均为 1 基）
		host.handleInput(`\x1b[<35;10;${oneRow + 1}M`);
		host.requestRender();
		await settle();

		// 只有被悬停的那一个块亮，同轮的另一个块不受影响
		expect(rows().filter((row) => row.includes("点击"))).toHaveLength(1);
		expect(rows().some((row) => row.includes("THINK-ONE") && row.includes("点击"))).toBe(true);

		// 点击只展开被点的那个块，同轮的另一个块必须保持折叠
		host.handleInput(`\x1b[<0;10;${oneRow + 1}M`);
		await settle();
		host.handleInput(`\x1b[<0;10;${oneRow + 1}m`);
		host.requestRender();
		await settle();

		expect(rows().filter((row) => row.includes("收起"))).toHaveLength(1);
		expect(rows().some((row) => row.includes("THINK-TWO") && row.includes("展开"))).toBe(true);
	});
});

describe("B1: hover is local", () => {
	it("reuses settled blocks and keeps indices stable when hovering", async () => {
		const { host } = scrollableHost();
		const W = 77; // transcriptContentW for an 80-column terminal
		host.requestRender();
		await settle();
		const internals = host.transcript as unknown as { settledBlocks: unknown; hoveredBlockCache: Map<string, unknown> };
		const blocksBefore = internals.settledBlocks;
		const indexBefore = host.transcript.getToolLineIndices(W)[0]!.lineIndex;
		const lineCountBefore = host.transcript.render(W).length;

		expect(host.transcript.setHoveredToolId("call-1")).toBe(true);
		host.requestRender();
		await settle();

		expect(internals.settledBlocks).toBe(blocksBefore);
		expect(internals.hoveredBlockCache.size).toBe(1);
		expect(host.transcript.getToolLineIndices(W)[0]!.lineIndex).toBe(indexBefore);
		expect(host.transcript.render(W).length).toBe(lineCountBefore);
		expect(stripAnsi(host.transcript.render(W)[indexBefore] ?? "")).toMatch(/[▴▾]/);

		expect(host.transcript.setHoveredToolId(null)).toBe(true);
		expect(host.transcript.getToolLineIndices(W)[0]!.lineIndex).toBe(indexBefore);
	});

	it("keeps identity separate when two turns share the same turn number", () => {
		// n 来自引擎 turnSeq 与恢复期局部计数两套不共享的计数器，撞号是常态。
		// 身份一旦退回 n，hover 会同时命中多个轮次，hoveredBlockCache 还会把
		// 一个轮次的块发给另一个轮次，导致内容被顶替、行数突变、视口跳动。
		const transcript = new TranscriptContainer();
		for (const [user, think] of [["ALPHA", "THINK-A"], ["BRAVO", "THINK-B"], ["CHARLIE", "THINK-C"]] as const) {
			transcript.startTurn(1, user);
			transcript.appendThinking(think);
			transcript.appendToken(`BODY-${user.length}`);
			transcript.finishTurn();
		}

		const locs = transcript.getThinkingLineIndices(78);
		expect(locs).toHaveLength(3);
		expect(new Set(locs.map((l) => l.turn.uid)).size).toBe(3); // 身份唯一
		expect(new Set(locs.map((l) => l.turn.n)).size).toBe(1); // n 确实撞号

		const before = transcript.render(78).map(stripAnsi);
		expect(transcript.setHoveredThinkingUid(locs[0]!.item.uid)).toBe(true);
		const after = transcript.render(78).map(stripAnsi);

		// 只有一个轮次进入 hover 态
		expect(after.filter((l) => l.includes("点击"))).toHaveLength(1);
		// 每个轮次保留自己的行，不被撞号邻居顶替
		for (const tag of ["ALPHA", "BRAVO", "CHARLIE", "THINK-A", "THINK-B", "THINK-C"]) {
			expect(after.filter((l) => l.includes(tag))).toHaveLength(1);
		}
		// hover 不得改变总行数，否则 totalPerm 突变会让视口位移
		expect(after).toHaveLength(before.length);
	});
});

describe("B3: overlay geometry", () => {
	const comp = (lines: string[]) => ({ render: () => lines });

	it("resolves percentage height against the available rows, including zero", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(Array.from({ length: 10 }, (_, i) => String(i))), { maxHeight: "50%" });
		expect(stack.renderAbove(80, 10)).toHaveLength(5);
		expect(stack.renderAbove(80, 6)).toHaveLength(3);
		expect(stack.renderAbove(80, 0)).toEqual([]);
	});

	it("clamps every overlay to its declared width", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(["x".repeat(200)]), { width: 20 });
		const above = stack.renderAbove(80, 10);
		expect(above).toHaveLength(1);
		expect(visibleWidth(above[0]!)).toBeLessThanOrEqual(80);
		expect(stripAnsi(above[0]!).trim().length).toBeLessThanOrEqual(20);
	});

	it("applies maxHeight per overlay", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(["a", "b", "c", "d"]), { maxHeight: 2 });
		expect(stack.renderAbove(80, 10)).toHaveLength(2);
	});

	it("offsetY moves the block away from the editor and negative values trim it", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(["a", "b"]), { offsetY: 2 });
		const padded = stack.renderAbove(80, 10);
		expect(padded).toHaveLength(4);
		expect(padded[0]!.trimEnd()).toBe("a");
		expect(padded[2]!.trim()).toBe("");

		const trimmed = new OverlayStack(new FocusManager(), () => {});
		trimmed.showOverlay(comp(["a", "b", "c"]), { offsetY: -1 });
		expect(trimmed.renderAbove(80, 10)).toHaveLength(2);
	});

	it("margin adds rows above and below and shrinks the box width", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(["body"]), { margin: { top: 1, bottom: 1, left: 4, right: 4 } });
		const above = stack.renderAbove(40, 10);
		expect(above).toHaveLength(3);
		expect(above[0]!.trim()).toBe("");
		expect(above[2]!.trim()).toBe("");
		expect(above[1]!.indexOf("body")).toBeGreaterThanOrEqual(4);
		expect(visibleWidth(above[1]!)).toBeLessThanOrEqual(40);
	});

	it("anchors right and keeps the editor-adjacent rows when over budget", () => {
		const stack = new OverlayStack(new FocusManager(), () => {});
		stack.showOverlay(comp(["top", "bottom"]), { anchor: "top-right", width: 6 });
		const above = stack.renderAbove(40, 10);
		expect(above[0]!.indexOf("top")).toBeGreaterThan(30);

		const overflow = new OverlayStack(new FocusManager(), () => {});
		overflow.showOverlay(comp(["far", "near"]), {});
		const clipped = overflow.renderAbove(40, 1);
		expect(clipped).toHaveLength(1);
		expect(clipped[0]!.trimEnd()).toBe("near");
	});
});

describe("B2: grapheme-aware width", () => {
	it("counts clusters, not code points", () => {
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("你好世界")).toBe(8);
		expect(visibleWidth("\x1b[31m你好\x1b[0m world")).toBe(10);
		expect(visibleWidth("👍🏽")).toBe(2);
		expect(visibleWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe(2);
		expect(visibleWidth("\u{1F1E8}\u{1F1F3}")).toBe(2);
		expect(visibleWidth("e\u0301")).toBe(1);
		expect(visibleWidth("\u0301")).toBe(0);
	});

	it("expands tabs to 8-column tab stops", () => {
		expect(visibleWidth("\t")).toBe(8);
		expect(visibleWidth("ab\t")).toBe(8);
		expect(visibleWidth("12345678\t")).toBe(16);
	});

	it("never splits a grapheme cluster when truncating", () => {
		const emoji = "👍🏽👍🏽👍🏽";
		const truncated = truncateToWidth(emoji, 5);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(5);
		const content = stripAnsi(truncated).replace(/…$/, "");
		expect(emoji.startsWith(content)).toBe(true);
	});

	it("never splits a grapheme cluster when wrapping", () => {
		const emoji = "👍🏽👍🏽👍🏽";
		const lines = wrapTextWithAnsi(emoji, 4);
		expect(lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
		expect(lines.map(stripAnsi).join("")).toBe(emoji);
	});
});

describe("Editor grapheme model", () => {
	const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

	it("treats a ZWJ emoji as one two-column atom", () => {
		const line = new InputLine();
		line.setText(`${FAMILY}x`);
		const layout = (line as unknown as { getVisualLayout(w: number): Array<{ positions: Array<{ charIdx: number; col: number }> }> }).getVisualLayout(80);
		const positions = layout[0]!.positions;
		// The cluster starts at 0 and the next atom starts right after it:
		// col 2 proves the family emoji occupies two columns, not one per code point.
		expect(positions[0]).toEqual({ charIdx: 0, col: 0 });
		expect(positions[1]).toEqual({ charIdx: FAMILY.length, col: 2 });
	});

	it("wraps a run of ZWJ emoji exactly like an equal-width ASCII run", () => {
		const emojiLine = new InputLine();
		emojiLine.setText(FAMILY.repeat(18));
		const asciiLine = new InputLine();
		asciiLine.setText("ab".repeat(18));
		expect(emojiLine.render(40).length).toBe(asciiLine.render(40).length);
	});

	it("snaps a cursor inside a cluster to the cluster start", () => {
		expect(snapToGraphemeBoundary(1, `${FAMILY}x`)).toBe(0);
		expect(snapToGraphemeBoundary(4, `${FAMILY}x`)).toBe(0);
		expect(snapToGraphemeBoundary(FAMILY.length, `${FAMILY}x`)).toBe(FAMILY.length);
	});
});

describe("Incremental layout invalidation", () => {
	it("rebuilds only the affected turn block when a card is expanded", async () => {
		const { host } = scrollableHost();
		host.requestRender();
		await settle();
		const internals = host.transcript as unknown as { settledBlocks: { blocks: unknown[] } };
		const before = internals.settledBlocks.blocks.slice();
		expect(host.transcript.toggleTool("call-1", 77).toggled).toBe(true);
		host.requestRender();
		await settle();
		const after = internals.settledBlocks.blocks;
		expect(after[0]).not.toBe(before[0]);
		expect(after[1]).toBe(before[1]);
	});

	it("preserveScrollAnchor renders the transcript once, not twice", async () => {
		const { host } = scrollableHost();
		host.requestRender();
		await settle();
		const spy = vi.spyOn(host.transcript, "render");
		spy.mockClear();
		host.preserveScrollAnchor(() => { host.transcript.toggleTool("call-1", 77); }, 0);
		expect(spy.mock.calls.length).toBe(1);
		spy.mockRestore();
	});
});

describe("C: overlay frame composition", () => {
	// A panel row wider than its declared box is wrapped by the terminal, which pushed the
	// bottom-pinned editor into the middle of the panel. The composed frame must never
	// contain a row wider than the terminal, and the panel must cover its own region.
	it("opens the history panel through Alt+H and composes a frame without wrapping", async () => {
		const { terminal, frames } = fakeTerminal(148, 29);
		const store = new MemorySessionStore();
		for (let i = 0; i < 50; i++) {
			await store.appendMessage({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `${i} 条 ${i % 3 === 0 ? '{"error":"工具已返回"}' : "**你好！** 很高兴你又来找我 😌～ 🍞"}`,
			});
		}
		const host = new UIHost({
			terminal,
			modelName: "TestModel",
			sessionPort: {
				list: (options) => listSessionNodes(store.readRecords(), options),
				read: (id) => readSessionNode(store.readRecords(), id),
				requestRewind: async () => ({ requestId: "probe", status: "committed" as const }),
			},
		});
		host.start();
		host.transcript.startTurn(1, "你好");
		host.transcript.appendToken("**你好！** 很高兴你又来找我。");
		host.transcript.finishTurn();
		await settle();

		host.handleInput("\x1bh");
		await settle();
		expect(plainFrame(frames.at(-1) ?? "").some((line) => line.includes("会话历史与分支检视器"))).toBe(true);

		// Walk to the bottom of the list, where the earlier breakage was reported.
		for (let step = 0; step < 80; step++) host.handleInput("\x1b[B");
		await settle();

		const lines = plainFrame(frames.at(-1) ?? "");
		expect(lines.length).toBe(29);
		expect(lines.filter((line) => visibleWidth(line) > 148)).toEqual([]);
	});
});
