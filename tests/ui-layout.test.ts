import { describe, expect, it, vi } from "vitest";
import { UIHost } from "../src/ui/ui-host.js";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { stripAnsi } from "../src/ui/core/utils.js";
import type { ProcessTerminal } from "../src/ui/core/terminal.js";
import { OverlayStack } from "../src/ui/core/overlay.js";
import { FocusManager } from "../src/ui/core/focus.js";
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "../src/ui/core/utils.js";
import { InputLine, snapToGraphemeBoundary } from "../src/ui/components/editor/input-line.js";

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
	frame.split("\r\n").map((line) => stripAnsi(line).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));

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
		expect(stripAnsi(lines[withRender] ?? "")).toContain("Get_time");
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
		const nav = host as unknown as { upTurnN: number | null; downTurnN: number | null };
		host.requestRender();
		await settle();
		host.scrollToTop();
		host.requestRender();
		await settle();
		expect(nav.upTurnN).toBeNull();
		expect(nav.downTurnN).toBe(2);
		host.scrollToBottom();
		host.requestRender();
		await settle();
		expect(nav.upTurnN).not.toBeNull();
		expect(nav.downTurnN).toBeNull();
		host.scrollToTurn(3);
		host.requestRender();
		await settle();
		expect(nav.upTurnN).toBe(2);
		expect(nav.downTurnN).toBe(6);
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
