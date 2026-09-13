/**
 * 帧内容逐格一致性：写入终端的每一行必须"每个格子都被我们涂过"。
 *
 * 背景：终端里的 HT（制表符）只把光标移到下一个 8 列制表位，**不会涂色**被跳过的格子。
 * 于是裸制表符进入帧会同时造成两类故障（同一根因）：
 *   1. 跳过的格子保留上一帧的旧文本 -> 看起来像两段内容"重叠"；
 *   2. 卡片底色行里跳过的格子露出默认底色 -> 底色"中间空缺一部分"。
 * 这里用一个逐格终端模型把"上一帧 + 本帧"与"空白屏 + 本帧"对比：两者不一致即为残留。
 * （模型的制表符语义按真机实测像素标定：跳过不涂色。）
 */
import { describe, expect, it } from "vitest";
import { UIHost } from "../src/ui/ui-host.js";
import { expandTabs, visibleWidth } from "../src/ui/core/utils.js";
import type { ProcessTerminal } from "../src/ui/core/terminal.js";

interface Cell { ch: string; bg: string; touched: boolean; cont?: boolean }

/** 逐格终端模型：支持 CUP / EL / ED / SGR 底色 / 制表符跳格不涂色 / 折行。 */
class Screen {
	private grid: Cell[][];
	private row = 0;
	private col = 0;
	private bg = "default";

	constructor(private readonly cols: number, private readonly rows: number) {
		this.grid = Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => ({ ch: " ", bg: "default", touched: false })),
		);
	}

	private put(ch: string, wide: boolean): void {
		if (this.col >= this.cols) {
			this.row++;
			this.col = 0;
		}
		if (this.row >= this.rows) this.scroll();
		const cell = this.grid[this.row]![this.col]!;
		cell.ch = ch;
		cell.bg = this.bg;
		cell.touched = true;
		cell.cont = false;
		if (wide && this.col + 1 < this.cols) {
			const next = this.grid[this.row]![this.col + 1]!;
			next.ch = "";
			next.bg = this.bg;
			next.touched = true;
			next.cont = true;
		}
		this.col += wide ? 2 : 1;
	}

	private scroll(): void {
		this.grid.shift();
		this.grid.push(Array.from({ length: this.cols }, () => ({ ch: " ", bg: "default", touched: false })));
		this.row = this.rows - 1;
	}

	feed(data: string): void {
		let i = 0;
		while (i < data.length) {
			const rest = data.slice(i);
			const csi = rest.match(/^\x1b\[(\d*)(?:;(\d*))?([A-Za-z])/);
			if (csi) {
				const p1 = csi[1] ? parseInt(csi[1], 10) : 0;
				const p2 = csi[2] ? parseInt(csi[2], 10) : 0;
				const fn = csi[3]!;
				if (fn === "H") {
					this.row = Math.min(this.rows - 1, Math.max(0, (p1 || 1) - 1));
					this.col = Math.min(this.cols - 1, Math.max(0, (p2 || 1) - 1));
				} else if (fn === "K") {
					for (let x = this.col; x < this.cols; x++) {
						const cell = this.grid[this.row]![x]!;
						cell.ch = " ";
						cell.bg = this.bg;
					}
				} else if (fn === "J") {
					for (const r of this.grid) for (const c of r) { c.ch = " "; c.bg = "default"; c.touched = false; }
				}
				i += csi[0].length;
				continue;
			}
			const sgr = rest.match(/^\x1b\[([0-9;]*)m/);
			if (sgr) {
				const codes = sgr[1]!.split(";").map((n) => parseInt(n || "0", 10));
				for (let k = 0; k < codes.length; k++) {
					if (codes[k] === 0 || codes[k] === 49) this.bg = "default";
					else if (codes[k] === 48 && codes[k + 1] === 2) {
						this.bg = `${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`;
						k += 4;
					}
				}
				i += sgr[0].length;
				continue;
			}
			const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
			if (osc) { i += osc[0].length; continue; }
			const esc = rest.match(/^\x1b[@-Z\\-_]/);
			if (esc) { i += esc[0].length; continue; }
			const char = data[i]!;
			if (char === "\t") { this.col = Math.min(this.cols, (Math.floor(this.col / 8) + 1) * 8); i++; continue; }
			if (char === "\r") { this.col = 0; i++; continue; }
			if (char === "\n") { this.row++; if (this.row >= this.rows) this.scroll(); i++; continue; }
			const cp = data.codePointAt(i)!;
			const piece = String.fromCodePoint(cp);
			const wide =
				cp >= 0x1100 &&
				(cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
					(cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
					(cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
					(cp >= 0x1f300 && cp <= 0x1f9ff));
			this.put(piece, wide);
			i += piece.length;
		}
	}

	/** 每行的可见文本（去掉续格） */
	lines(): string[] {
		return this.grid.map((r) => r.map((c) => (c.cont ? "" : c.ch)).join("").replace(/\s+$/, ""));
	}

	/** 未被涂过色的连续片段（>=2 格才算，用于定位背景空洞） */
	holes(): string[] {
		const found: string[] = [];
		for (let r = 0; r < this.rows; r++) {
			const row = this.grid[r]!;
			let run = 0;
			let start = -1;
			for (let x = 0; x <= this.cols; x++) {
				const untouched = x < this.cols && !row[x]!.touched && row[x]!.bg === "default";
				if (untouched) {
					if (run === 0) start = x;
					run++;
				} else if (run >= 2) {
					found.push(`row=${r} x=${start}..${x - 1}`);
					run = 0;
				} else {
					run = 0;
				}
			}
		}
		return found;
	}
}

const COLUMNS = 171;
const ROWS = 30;

function fakeTerminal(): { terminal: ProcessTerminal; frames: string[] } {
	const frames: string[] = [];
	const terminal = {
		columns: COLUMNS,
		rows: ROWS,
		isTTY: true,
		syncWrite: (data: string) => { frames.push(data); },
		write: () => {}, start: () => {}, stop: () => {},
		hideCursor: () => {}, showCursor: () => {},
		cursorUp: () => {}, cursorDown: () => {},
		clearLine: () => {}, clearDown: () => {}, moveTo: () => {},
	} as unknown as ProcessTerminal;
	return { terminal, frames };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

const THINKING = [
	"Now let me see the callers:",
	"\t`ui-host.ts:1298` 传的是 TurnRecord 对象，不是轮次编号。",
	"",
	"\ttoggleThinking 的调用方全部传对象或 undefined——数字分支没有任何生产者。",
	"\t\t\t\t});\t// 四个制表符后接收尾",
].join("\n");

const STDOUT = [
	"=== transcript.ts 715-760 ===",
	"715: \t\t\t\t});",
	"716: \t\t\t\t\ttarget.collapsed = !wasCollapsed;",
].join("\n");

/** 造一个"含制表符的思考块 + 工具卡"的会话，分别取折叠帧与展开帧 */
async function renderFrames(): Promise<{ collapsedFrame: string; expandedFrame: string }> {
	const { terminal, frames } = fakeTerminal();
	const host = new UIHost({ terminal, modelName: "TestModel" });
	host.start();
	host.transcript.startTurn(1, "Q-ONE");
	host.transcript.appendThinking(THINKING);
	host.transcript.startTool("exec_command", { command: "cd E:\\Uina\\Uina; echo hi" }, "call-1");
	host.transcript.addToolDone(
		"exec_command",
		JSON.stringify({ stdout: STDOUT }),
		50,
		"succeeded",
		"call-1",
		{ command: "cd E:\\Uina\\Uina; echo hi" },
	);
	host.transcript.appendToken("收尾文本。");
	host.transcript.finishTurn();
	host.requestRender();
	await settle();
	const collapsedFrame = frames.at(-1)!;

	for (const loc of host.transcript.getThinkingLineIndices(80)) loc.item.collapsed = false;
	host.requestRender();
	await settle();
	return { collapsedFrame, expandedFrame: frames.at(-1)! };
}

const rowTexts = (frame: string): string[] =>
	frame
		.split(/\x1b\[\d+;1H/)
		.slice(1)
		.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));

describe("expandTabs", () => {
	it("展开到下一个 8 列制表位", () => {
		expect(expandTabs("\t")).toBe(" ".repeat(8));
		expect(expandTabs("ab\t")).toBe(`ab${" ".repeat(6)}`);
		expect(expandTabs("abcdefgh\t")).toBe(`abcdefgh${" ".repeat(8)}`);
		expect(expandTabs("中文\t")).toBe(`中文${" ".repeat(4)}`);
	});

	it("保留 ANSI 序列，且不改变可视宽度", () => {
		expect(expandTabs("\x1b[31m\t\x1b[0m")).toBe(`\x1b[31m${" ".repeat(8)}\x1b[0m`);
		expect(expandTabs("a\x1b[2m\tb")).toBe(`a\x1b[2m${" ".repeat(7)}b`);
		expect(visibleWidth(expandTabs("\t\tab\t"))).toBe(visibleWidth("\t\tab\t"));
	});

	it("没有制表符时原样返回", () => {
		expect(expandTabs("没有制表符")).toBe("没有制表符");
		expect(expandTabs("")).toBe("");
	});
});

describe("帧内容逐格一致性", () => {
	it("写出的帧行里绝不出现裸制表符", async () => {
		const { expandedFrame } = await renderFrames();
		const rows = rowTexts(expandedFrame);
		expect(rows.length).toBe(ROWS);
		const withTab = rows.filter((row) => row.includes("\t"));
		expect(withTab).toEqual([]);
		// 行宽按同一模型测量后仍不超宽（否则终端会折行、整帧错位）
		const tooWide = rows.filter((row) => visibleWidth(row) > COLUMNS);
		expect(tooWide).toEqual([]);
	});

	it("展开思考块不会把上一帧的旧文本留在屏幕格子里", async () => {
		const { collapsedFrame: collapsed, expandedFrame: expanded } = await renderFrames();

		const incremental = new Screen(COLUMNS, ROWS);
		incremental.feed(collapsed);
		incremental.feed(expanded);
		const fresh = new Screen(COLUMNS, ROWS);
		fresh.feed(expanded);

		expect(incremental.lines()).toEqual(fresh.lines());
	});

	it("帧里没有未被涂色的空洞（卡片底色不会被跳格漏掉）", async () => {
		const { expandedFrame } = await renderFrames();
		const screen = new Screen(COLUMNS, ROWS);
		screen.feed(expandedFrame);
		expect(screen.holes()).toEqual([]);
	});
});
