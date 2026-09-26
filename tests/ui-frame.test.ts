/**
 * 帧内容逐格一致性：写入终端的每一行必须"每个格子都被本帧涂过"，且行尾收尾必须
 * 脱离 pending-wrap 边界。
 *
 * 背景（真机实测）：
 *   1. HT（制表符）只把光标移到下一个 8 列制表位，**不涂色**被跳过的格子 —— 跳过的
 *      格子会保留上一帧的文本（看起来像两段内容重叠）或露出默认底色（底色缺口）。
 *   2. EL（`\x1b[K`）用**当时仍生效的背景色**涂满光标到行尾：所以"行尾谁的颜色"取决于
 *      写这一行时的 SGR 状态，除非我们显式指定。帧内每行必须以 reset 开始，行尾底色
 *      由这一行自己声明。
 *   3. 光标停在 pending-wrap 边界（写满最右列）时发 EL，Windows Terminal 会把**下一行**
 *      涂成本行底色（真机整行错色）。因此内容已到行末列的行，收尾前必须绝对定位离开边界。
 *
 * 逐格语义由 tests/helpers/vt-screen.ts 的 VtScreen 提供（SGR 优先解析、私有模式 CSI
 * 为 no-op、HT/CR 不涂色、真实折行与滚动计数）。旧模型把 SGR 当通用 CSI 吃掉，导致
 * 底色永不复位、"空洞"断言结构性失明，测试成败由模型伪影决定。
 */
import { describe, expect, it } from "vitest";
import { UIHost } from "../src/ui/ui-host.js";
import { MainScreenRenderer } from "../src/ui/core/renderer.js";
import { CURSOR_MARKER } from "../src/ui/core/types.js";
import { C, dropStrayControls, expandTabs, extractAnsiCode, normalizeFrameLine, resolveCarriageReturns, visibleWidth } from "../src/ui/core/utils.js";
import { VtScreen } from "./harness/index.js";

const COLUMNS = 171;
const ROWS = 30;
/** 与 ui-host 的布局口径一致：safeW = columns-1，转录内容宽 = safeW-2 */
const CONTENT_W = COLUMNS - 3;

/** 这一行执行到最后仍生效的底色（与 VtScreen 内部 bg 记法一致：r,g,b / idx:n / default） */
function declaredTailBg(row: string): string {
	let bg = "default";
	for (const m of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
		const codes = m[1]!.split(";").map((n) => (n ? parseInt(n, 10) : 0));
		for (let k = 0; k < codes.length; k++) {
			const code = codes[k]!;
			if (code === 0 || code === 49) bg = "default";
			else if (code === 48 && codes[k + 1] === 2) { bg = `${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`; k += 4; }
			else if (code === 48 && codes[k + 1] === 5) { bg = `idx:${codes[k + 2]}`; k += 2; }
		}
	}
	return bg;
}

/** 从 SGR 序列里取底色标识（与 VtScreen 内部记录格式一致：r,g,b） */
const rgbOf = (sgr: string): string => sgr.replace(/\x1b\[48;2;(\d+);(\d+);(\d+)m/, "$1,$2,$3");

import { createSilentTerminal } from "./harness/index.js";

it("full 与 delta 渲染最终产生相同的逐格屏幕和 cursor", () => {
	const fullTerminal = createSilentTerminal(12, 5);
	const deltaTerminal = createSilentTerminal(12, 5);
	const fullRenderer = new MainScreenRenderer(fullTerminal.terminal);
	const deltaRenderer = new MainScreenRenderer(deltaTerminal.terminal);
	const frames = [
		[`\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m你好🙂A`, `cursor${CURSOR_MARKER} row`, "old tail"],
		[`\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m你好🙂B`, `cursor${CURSOR_MARKER} row`, "old tail"],
		[`\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m你好🙂B`, `cursor row${CURSOR_MARKER}`, "old tail"],
		[`\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m你好🙂B`, `cursor row${CURSOR_MARKER}`],
	];

	for (const frame of frames) {
		fullRenderer.handleResize();
		fullRenderer.renderFrame(frame);
		deltaRenderer.renderFrame(frame);
	}

	expect(deltaTerminal.screen.grid).toEqual(fullTerminal.screen.grid);
	expect([deltaTerminal.screen.row, deltaTerminal.screen.col, deltaTerminal.screen.fg, deltaTerminal.screen.bg])
		.toEqual([fullTerminal.screen.row, fullTerminal.screen.col, fullTerminal.screen.fg, fullTerminal.screen.bg]);
	expect(deltaTerminal.writes[2]).toMatch(/^\x1b\[2;\d+H\x1b\[\?25h$/);
	expect(deltaTerminal.writes[3]).toContain("\x1b[J");
});

it("renderer 丢弃非 SGR 终端控制序列及其 payload", () => {
	const fake = createSilentTerminal(20, 3);
	const renderer = new MainScreenRenderer(fake.terminal);
	renderer.renderFrame(["A\x1b[2J B\x1b]52;c;clipboard\x07C\x1bPdevice-data\x1b\\D"]);

	expect(fake.screen.rowText(0)).toBe("A BCD");
	expect(fake.writes[0]).not.toMatch(/\x1b\[2J|\x1b\]52|device-data/);
});

const fakeTerminal = () => createSilentTerminal(COLUMNS, ROWS);

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

/** 按 CUP 拆帧：每项是"这一行的定位之后写出去的那段字节" */
function frameRows(frame: string): string[] {
	return frame.split(/\x1b\[\d+;1H/).slice(1);
}

/** 某行字节里"我们实际写出的可见宽度"（不含 EL，EL 只涂不写内容） */
function emittedWidth(row: string): number {
	return visibleWidth(row.replace(/\x1b\[K/g, ""));
}

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

const LONG_COMMAND = [
	'cd E:\\Uina\\Uina; rg -n "row=" tests/ui-frame.test.ts -B 6 | Select-Object -First 20;',
	'python -c "print(1)"',
].join("\n");

interface Shot { tag: string; frame: string }

/** 覆盖 totalPerm < / == / > transcriptH 三态，以及 折叠/展开/hover 三种视图 */
async function shots(): Promise<Shot[]> {
	const { terminal, frames } = fakeTerminal();
	const host = new UIHost({ terminal, modelName: "TestModel" });
	host.start();
	host.transcript.startTurn(1, "Q-ONE");
	host.transcript.appendThinking(THINKING);
	host.transcript.startTool("exec_command", { command: "cd E:\\Uina\\Uina; echo hi" }, "call-1");
	host.transcript.addToolDone("exec_command", JSON.stringify({ stdout: STDOUT }), 50, "succeeded", "call-1", {
		command: "cd E:\\Uina\\Uina; echo hi",
	});

	const out: Shot[] = [];
	const snap = async (tag: string): Promise<void> => {
		host.requestRender();
		await settle();
		out.push({ tag, frame: frames.at(-1)! });
	};

	await snap("短内容·折叠");
	host.transcript.setHoveredToolId("call-1");
	await snap("短内容·折叠+hover");
	host.transcript.toggleTool("call-1", CONTENT_W);
	await snap("短内容·展开+hover");
	host.transcript.toggleTool("call-1", CONTENT_W);
	await snap("短内容·收起+hover");
	host.transcript.setHoveredToolId(null);

	// 多行命令参数 + 多行输出：把内容推到超过视口（totalPerm > transcriptH）
	host.transcript.startTool("exec_command", { command: LONG_COMMAND }, "call-2");
	host.transcript.addToolDone("exec_command", JSON.stringify({ stdout: STDOUT }), 30, "succeeded", "call-2", {
		command: LONG_COMMAND,
	});
	host.transcript.appendToken("收尾文本。");
	await snap("长内容·折叠");
	host.transcript.setHoveredToolId("call-2");
	await snap("长内容·折叠+hover");
	host.transcript.toggleTool("call-2", CONTENT_W);
	await snap("长内容·展开+hover");
	return out;
}

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

describe("帧几何：与终端尺寸严格一致", () => {
	it("每个状态都定位满 ROWS 行，且不折行、不滚动", async () => {
		for (const { tag, frame } of await shots()) {
			expect(frameRows(frame).length, `${tag}: 帧行数`).toBe(ROWS);
			const screen = new VtScreen(COLUMNS, ROWS);
			screen.feed(frame);
			expect(screen.wrapped, `${tag}: 折行次数`).toBe(0);
			expect(screen.scrolled, `${tag}: 滚动次数`).toBe(0);
		}
	});

	it("行内绝不出现换行/裸制表符/裸回车/孤立控制符，也不超宽", async () => {
		for (const { tag, frame } of await shots()) {
			const screen = new VtScreen(COLUMNS, ROWS);
			screen.feed(frame);
			expect(screen.tabJumps, `${tag}: 制表符跳格`).toBe(0);
			expect(screen.crMoves, `${tag}: 行内回车`).toBe(0);
			const tooWide = frameRows(frame).filter((row) => emittedWidth(row) > COLUMNS);
			expect(tooWide, `${tag}: 超宽行`).toEqual([]);
			const offenders: string[] = [];
			frameRows(frame).forEach((row, r) => {
				const bad = strayControls(row);
				if (bad.length) offenders.push(`${tag}: row${r} ${bad.join(",")}`);
			});
			expect(offenders, `${tag}: 非法控制字符`).toEqual([]);
		}
	});

	it("每一行的每一格都被本帧涂过（真机不会残留上一帧内容）", async () => {
		for (const { tag, frame } of await shots()) {
			const screen = new VtScreen(COLUMNS, ROWS);
			screen.feed(frame);
			const idle = screen.unpaintedRuns().map((r) => `${tag}: row${r.row} x=${r.start}..${r.end}`);
			expect(idle).toEqual([]);
		}
	});

	it("行尾底色必须等于这一行自己声明的底色（而不是继承当前 SGR）", async () => {
		for (const { tag, frame } of await shots()) {
			const screen = new VtScreen(COLUMNS, ROWS);
			screen.feed(frame);
			frameRows(frame).forEach((row, r) => {
				// 行尾列（我们从未写入内容的那一格）必须被这一行声明的底色涂到
				expect(screen.tailBg(r), `${tag}: row${r} 行尾底色`).toBe(declaredTailBg(row));
			});
		}
	});

	// 已知未落实的契约：本布局每一行都恰好停在行末列前一格，即每行都贴着 pending-wrap 边界；
	// HEAD 在此处就地发 EL。真机 A/B 之前不落地（见 dev 记录：CUP 保护在真机是否更糟需实测）。
	// 标 it.fails：一旦这里变成通过，说明该契约已落地，必须回来删掉这个标记。
	it.fails("内容已到行末列的行，收尾前必须绝对定位离开 pending-wrap 再擦（已知未落实）", async () => {
		for (const { tag, frame } of await shots()) {
			frameRows(frame).forEach((row, r) => {
				const width = emittedWidth(row);
				const hasEl = row.includes("\x1b[K");
				if (!hasEl) {
					// 没有 EL：这一行必须已经铺满整行，否则行尾会残留上一帧
					expect(width, `${tag}: row${r} 未铺满却不清尾`).toBeGreaterThanOrEqual(COLUMNS);
					return;
				}
				if (width >= COLUMNS - 1) {
					expect(
						row.includes(`\x1b[${r + 1};${COLUMNS}H`),
						`${tag}: row${r} 未离开 pending-wrap 边界就发 EL（真机会把下一行涂成本行底色）`,
					).toBe(true);
				}
			});
		}
	});
});

describe("跨帧：上一帧不得在屏幕上残留", () => {
	it("增量喂帧必须与「只喂最后一帧」逐格一致（展开/收起/滚动都不留残影）", async () => {
		const all = await shots();
		const incremental = new VtScreen(COLUMNS, ROWS);
		for (const { frame } of all) incremental.feed(frame);
		const fresh = new VtScreen(COLUMNS, ROWS);
		fresh.feed(all[all.length - 1]!.frame);
		const ghosts = incremental
			.lines()
			.map((line, r) => (line === fresh.lines()[r] ? null : `row${r}: ${JSON.stringify(line)}`))
			.filter((v): v is string => v !== null);
		expect(ghosts).toEqual([]);
	});

	it("展开再收起必须回到展开前的屏幕（回程逐格一致）", async () => {
		const all = await shots();
		const collapsed = all.find((s) => s.tag === "短内容·折叠+hover")!;
		const expanded = all.find((s) => s.tag === "短内容·展开+hover")!;
		const restored = all.find((s) => s.tag === "短内容·收起+hover")!;
		const linesOf = (f: string): string[] => {
			const s = new VtScreen(COLUMNS, ROWS);
			s.feed(f);
			return s.lines();
		};
		// 前提：展开确实改变了屏幕（否则这条测试是假的）
		expect(linesOf(expanded.frame)).not.toEqual(linesOf(collapsed.frame));
		// 收起后必须逐格回到展开前
		expect(linesOf(restored.frame)).toEqual(linesOf(collapsed.frame));
	});
});

describe("边界态：内容刚好压在视口高度附近时展开", () => {
	/** 造一个"极少工具调用、内容刚好不到一屏"的会话，再展开一张卡让它越界 */
	async function boundaryShots(): Promise<{ host: UIHost; taken: Array<{ tag: string; frame: string }> }> {
		const { terminal, frames } = fakeTerminal();
		const host = new UIHost({ terminal, modelName: "TestModel" });
		host.start();
		host.transcript.startTurn(1, "边界态问题");
		host.transcript.appendThinking(THINKING);

		const layoutOf = (): { totalPerm: number; transcriptH: number; scrollStart: number } =>
			(host as unknown as { lastLayout: { totalPerm: number; transcriptH: number; scrollStart: number } }).lastLayout;

		// 逐条补工具调用，直到内容离视口高度只剩一两行
		for (let i = 0; i < 40; i++) {
			host.requestRender();
			await settle();
			const { totalPerm, transcriptH } = layoutOf();
			if (totalPerm >= transcriptH - 2) break;
			const id = `pad-${i}`;
			host.transcript.startTool("exec_command", { command: `echo ${i}` }, id);
			host.transcript.addToolDone("exec_command", JSON.stringify({ stdout: `pad-${i}` }), 5, "succeeded", id, {
				command: `echo ${i}`,
			});
		}

		// 目标卡：多行命令参数 + 多行输出（折叠时只有几行，展开会多出十几行）
		const stdout = Array.from({ length: 14 }, (_, i) => `line-${i}`).join("\n");
		host.transcript.startTool("exec_command", { command: LONG_COMMAND }, "call-big");
		host.transcript.addToolDone("exec_command", JSON.stringify({ stdout }), 20, "succeeded", "call-big", {
			command: LONG_COMMAND,
		});

		// 逐个快照各自持有自己的帧（不能靠下标去套 frames：心跳会额外推帧）
		const taken: Shot[] = [];
		const snap = async (tag: string): Promise<void> => {
			host.requestRender();
			await settle();
			taken.push({ tag, frame: frames.at(-1)! });
		};
		await snap("折叠");
		host.transcript.setHoveredToolId("call-big");
		await snap("折叠+hover");
		// 走真机按键路径（ctrl+o）：展开/收起必须经过 preserveScrollAnchor
		host.handleInput("\x0f");
		await snap("展开+hover");
		host.handleInput("\x0f");
		await snap("收起+hover");
		return { host, taken };
	}

	it("展开会越过「内容高度 == 视口高度」这条边界，且跨帧不留残影、收起能回到原屏幕", async () => {
		const { host, taken } = await boundaryShots();
		const layoutOf = (): { totalPerm: number; transcriptH: number; scrollStart: number } =>
			(host as unknown as { lastLayout: { totalPerm: number; transcriptH: number; scrollStart: number } }).lastLayout;
		const frameOf = (tag: string): string => taken.find((s) => s.tag === tag)!.frame;
		const collapsed = frameOf("折叠+hover");
		const expanded = frameOf("展开+hover");
		const restored = frameOf("收起+hover");

		const linesOf = (f: string): string[] => {
			const s = new VtScreen(COLUMNS, ROWS);
			s.feed(f);
			return s.lines();
		};

		// 前提：展开确实把内容推过了视口高度（否则这条测试没覆盖到边界态）
		const expandedScreen = new VtScreen(COLUMNS, ROWS);
		expandedScreen.feed(expanded);
		expect(linesOf(expanded)).not.toEqual(linesOf(collapsed));

		// 1) 跨帧无残影：把折叠帧→展开帧依次喂进去，必须与只喂展开帧逐格一致
		const incremental = new VtScreen(COLUMNS, ROWS);
		incremental.feed(collapsed);
		incremental.feed(expanded);
		const fresh = new VtScreen(COLUMNS, ROWS);
		fresh.feed(expanded);
		const ghosts = incremental
			.lines()
			.map((line, r) => (line === fresh.lines()[r] ? null : `row${r}: ${JSON.stringify(line)}`))
			.filter((v): v is string => v !== null);
		expect(ghosts).toEqual([]);

		// 2) 收起后回到展开前的屏幕（视口不整屏重排、不残留）
		expect(linesOf(restored)).toEqual(linesOf(collapsed));

		// 3) 两帧都必须完整覆盖整屏（真机不会残留上一帧内容）
		for (const f of [collapsed, expanded, restored]) {
			const s = new VtScreen(COLUMNS, ROWS);
			s.feed(f);
			expect(s.unpaintedRuns()).toEqual([]);
			expect(s.scrolled).toBe(0);
			expect(s.wrapped).toBe(0);
		}
		expect(layoutOf().totalPerm).toBeGreaterThan(0);
	});
});

describe("回车（CR）：CRLF 内容不得让终端替我们重写行", () => {
	/** 造一张工具卡（stdout 可控），返回该帧的逐格屏幕 */
	async function cardScreen(stdout: string): Promise<VtScreen> {
		const { terminal, frames } = fakeTerminal();
		const host = new UIHost({ terminal, modelName: "TestModel" });
		host.start();
		host.transcript.startTurn(1, "Q-CR");
		host.transcript.startTool("exec_command", { command: "rg -n row= tests/ui-frame.test.ts" }, "call-cr");
		host.transcript.addToolDone("exec_command", JSON.stringify({ stdout }), 30, "succeeded", "call-cr", {
			command: "rg -n row= tests/ui-frame.test.ts",
		});
		host.transcript.finishTurn();
		host.requestRender();
		await settle();
		const screen = new VtScreen(COLUMNS, ROWS);
		screen.feed(frames.at(-1)!);
		return screen;
	}

	it("CRLF 输出与 LF 输出必须渲染成逐格相同的屏幕", async () => {
		const crlf = await cardScreen("line-A\r\nline-B\r\nline-C\r\n");
		const lf = await cardScreen("line-A\nline-B\nline-C\n");
		expect(crlf.lines()).toEqual(lf.lines());
		// 帧里绝不允许出现回车：终端遇到 \r 会把该行从第 1 列重写，行尾格子没人涂
		expect(crlf.crMoves).toBe(0);
		expect(crlf.unpaintedRuns()).toEqual([]);
	});

	it("行内裸 CR 按终端覆盖语义落地（进度条只留最终状态，而不是两段拼接）", async () => {
		const screen = await cardScreen("progress 50%\rprogress 100%\n");
		const text = screen.lines().join("\n");
		expect(screen.crMoves).toBe(0);
		expect(text).not.toContain("progress 50%progress 100%");
		expect(text).toContain("progress 100%");
	});
});

describe("时钟高亮带：覆盖严格等于卡片行集合", () => {

	it("hover 时带子覆盖的行集合恰好是这张卡的行集合，且带内无未涂色格子", async () => {
		const { terminal, frames } = fakeTerminal();
		const host = new UIHost({ terminal, modelName: "TestModel" });
		host.start();
		host.transcript.startTurn(1, "Q-ONE");
		host.transcript.startTool("exec_command", { command: "echo hi" }, "call-1");
		host.transcript.addToolDone("exec_command", JSON.stringify({ stdout: "hi" }), 30, "succeeded", "call-1", {
			command: "echo hi",
		});
		host.transcript.finishTurn();

		host.requestRender();
		await settle();
		host.transcript.setHoveredToolId("call-1");
		host.requestRender();
		await settle();
		const frame = frames.at(-1)!;
		const screen = new VtScreen(COLUMNS, ROWS);
		screen.feed(frame);

		const card = rgbOf(C.toolCardBackground);
		const banded = screen.rowsWithBg(card);
		const loc = host.transcript.getToolLineIndices(CONTENT_W).find((l) => l.callId === "call-1")!;
		const layout = (host as unknown as { lastLayout: { bannerCount: number; scrollStart: number } }).lastLayout;
		const expected = Array.from({ length: loc.lineCount }, (_, i) => layout.bannerCount + loc.lineIndex + i - layout.scrollStart)
			.filter((row) => row >= 0 && row < ROWS);
		expect(
			banded,
			`banded=${JSON.stringify(banded)} expected=${JSON.stringify(expected)} loc=${JSON.stringify(loc)} banner=${layout.bannerCount} scrollStart=${layout.scrollStart}`,
		).toEqual(expected);

		const idleInBand = screen.unpaintedRuns().filter((r) => banded.includes(r.row));
		expect(idleInBand).toEqual([]);
	});
});

/** 逐字符找出"非法控制字符"：ESC 必须开启一个合法 ANSI 序列，其余 C0/DEL/C1 一律非法 */
function strayControls(line: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		const code = line.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			out.push(`\\x${code.toString(16).padStart(2, "0")}`);
		}
		i++;
	}
	return out;
}

describe("帧行规范化（孤立控制符 / 回车语义）", () => {
	it("丢弃孤立 ESC，保留合法 ANSI 序列与制表符", () => {
		expect(dropStrayControls("a\u001bb")).toBe("ab");
		expect(dropStrayControls("\u001b[31m红\u001b[0m")).toBe("\u001b[31m红\u001b[0m");
		expect(dropStrayControls("靠左\u0007响铃")).toBe("靠左响铃");
		expect(dropStrayControls("\t制表")).toBe("\t制表");
		// 制表符与回车放行给后续两步处理；换行与其它 C0/C1 一律丢弃
		//（帧行里出现换行会让终端多推进一行、整帧错位，必须拦在帧外）
		expect(dropStrayControls("a\rb\nc")).toBe("a\rbc");
		expect(dropStrayControls("x\u0001y\u009bz")).toBe("xyz");
	});

	it("回车按终端覆盖语义落地", () => {
		expect(resolveCarriageReturns("abc\rde")).toBe("dec");
		expect(resolveCarriageReturns("abc\rdef")).toBe("def");
		expect(resolveCarriageReturns("进度 50%\r进度 100%")).toBe("进度 100%");
		expect(resolveCarriageReturns("abc\r\nnext")).toBe("abc\nnext");
	});

	it("normalizeFrameLine 三者按序落地：丢控制符 → 回车覆盖 → 展开制表符", () => {
		expect(normalizeFrameLine("a\u001b\rb")).toBe("b");
		// "xy" 占 2 列 → 制表符推进到第 8 列 = 补 6 个空格
		expect(normalizeFrameLine("x\u0000y\tz")).toBe(`xy${" ".repeat(6)}z`);
	});
});

describe("真机工具输出：JSON 解码后才出现的裸 ESC 不得进帧", () => {
	/** 真机 vitest 输出（从 session.jsonl 取出，含 SGR 与尾部 \u001b\r） */
	const REAL_STDOUT =
		"Test Files \u001b[22m \u001b[1m\u001b[32m43 passed\u001b[39m\u001b[22m\u001b[90m (43)\u001b[39m\r\n" +
		"\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m608 passed\u001b[39m\u001b[22m\u001b[90m (608)\u001b[39m\r\n" +
		"\u001b\r\n";

	async function realCardScreen(): Promise<{ screen: VtScreen; frame: string }> {
		const { terminal, frames } = fakeTerminal();
		const host = new UIHost({ terminal, modelName: "TestModel" });
		host.start();
		host.transcript.startTurn(1, "Q-REAL");
		host.transcript.startTool("exec_command", { command: "npx vitest run 2>&1 | Out-File dev\\all.log" }, "call-real");
		host.transcript.addToolDone("exec_command", JSON.stringify({ code: 0, stdout: REAL_STDOUT }), 30, "succeeded", "call-real", {
			command: "npx vitest run 2>&1 | Out-File dev\\all.log",
		});
		host.transcript.finishTurn();
		host.requestRender();
		await settle();
		const frame = frames.at(-1)!;
		const screen = new VtScreen(COLUMNS, ROWS);
		screen.feed(frame);
		return { screen, frame };
	}

	it("帧里绝不出现孤立控制字符（否则终端会吞掉后续定位/底色序列）", async () => {
		const { frame } = await realCardScreen();
		const offenders: string[] = [];
		frameRows(frame).forEach((row, r) => {
			const bad = strayControls(row);
			if (bad.length) offenders.push(`row${r}: ${bad.join(",")}`);
		});
		expect(offenders).toEqual([]);
	});

	it("卡片结果区不会多出「只有一个 - 」的行，且整屏逐格完整", async () => {
		const { screen } = await realCardScreen();
		const loneDash = screen.lines().filter((l) => l.trim() === "-");
		expect(loneDash).toEqual([]);
		expect(screen.unpaintedRuns()).toEqual([]);
		expect(screen.scrolled).toBe(0);
		expect(screen.wrapped).toBe(0);
		expect(screen.lines().join("\n")).toContain("Tests  608 passed (608)");
	});
});
