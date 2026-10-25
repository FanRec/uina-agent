/**
 * UI 帧管线基准（可重复的前后对比工具，不进测试门禁）。
 *
 *   pnpm bench:ui              全部场景
 *   pnpm bench:ui -- steady    只跑名字含 steady 的场景
 *
 * 为什么不能直接用 tests/harness 的 SilentTerminal 计时：它的 syncWrite 会把帧喂给
 * VtScreen 逐格解析（每字符一次 slice + Segmenter），0.4 ms 的帧会被测成 10–30 ms。
 * 这里用最小假终端 + 空 syncWrite，只量「生产帧字符串」的 CPU 成本。
 *
 * 输出各相位 p50/p95，单位为毫秒。改动前后各跑一次，比较同一行的数字。
 */

import { UIHost } from "../src/ui/ui-host.js";
import { extractAnsiCode, normalizeFrameLine, resolveCarriageReturns, visibleWidth } from "../src/ui/core/utils.js";

interface LayoutView {
	transcriptContentW: number;
	transcriptH: number;
	totalPerm: number;
	scrollStart: number;
}

/** UIHost 的私有成员在基准里必须可达；用显式窄化代替 any 扩散。 */
interface HostView {
	renderCurrentFrame(): void;
	layoutFrame(): LayoutView;
	lastRenderedRows: string[];
}

interface BenchHost {
	host: UIHost;
	view: HostView;
	writes: number;
}

const WARMUP = 50;
const SAMPLES = 200;

function makeHost(columns: number, rows: number): BenchHost {
	const terminal = {
		columns,
		rows,
		isTTY: true,
		start: () => {},
		stop: () => {},
		write: () => {},
		syncWrite: () => {},
	};
	const host = new UIHost({ terminal: terminal as never, modelName: "bench" });
	let writes = 0;
	(host.terminal as unknown as { syncWrite(d: string): void }).syncWrite = () => {
		writes++;
	};
	host.start();
	return { host, view: host as unknown as HostView, writes };
}

const USER_LINE = "第 %d 轮：这个函数为什么慢，帮我看一下调用链。";
const ANSWER = "第 %d 段回答：中文与 English 混排的正文内容，用于撑出多行并让转录区有真实密度。\n\n";

function seedTurns(host: UIHost, turns: number): void {
	for (let i = 0; i < turns; i++) {
		host.transcript.startTurn(i + 1, USER_LINE.replace("%d", String(i + 1)));
		for (let p = 0; p < 3; p++) host.transcript.appendToken(ANSWER.replace("%d", String(p + 1)));
		host.transcript.finishTurn();
	}
	// 播种期的打字机游标与本次测量无关，避免心跳在后台产帧。
	host.transcript.smoothReveal.setEnabled(false);
	host.notifyToolActivity();
}

function measure(fn: () => void, samples = SAMPLES): number[] {
	for (let i = 0; i < WARMUP; i++) fn();
	const out: number[] = new Array(samples);
	for (let i = 0; i < samples; i++) {
		const t0 = process.hrtime.bigint();
		fn();
		out[i] = Number(process.hrtime.bigint() - t0) / 1e6;
	}
	return out;
}

function pct(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function report(label: string, values: number[]): void {
	console.log(
		`${label.padEnd(34)} p50 ${pct(values, 0.5).toFixed(3).padStart(7)}   p95 ${pct(values, 0.95).toFixed(3).padStart(7)}   max ${Math.max(
			...values,
		)
			.toFixed(3)
			.padStart(7)}`,
	);
}

function gc(): void {
	(globalThis as { gc?: () => void }).gc?.();
}

/** 稳态帧：多尺寸 + 分相位。 */
function benchSteady(filter: string): void {
	for (const [cols, rows] of [
		[80, 24],
		[120, 30],
		[200, 60],
		[240, 70],
	] as const) {
		if (filter && !"steady".includes(filter)) return;
		const bench = makeHost(cols, rows);
		seedTurns(bench.host, 200);
		bench.view.renderCurrentFrame();

		const layout = bench.view.layoutFrame();
		console.log(`\n[steady ${cols}×${rows}] ${layout.totalPerm} 行`);
		report(
			"  frame（整帧）",
			measure(() => bench.view.renderCurrentFrame()),
		);
		report(
			"  layoutFrame",
			measure(() => bench.view.layoutFrame()),
		);
		report(
			"  getFrameModel",
			measure(() => bench.host.transcript.getFrameModel(layout.transcriptContentW)),
		);
		report(
			"  renderWrite（fit+差量+写入）",
			measure(() => bench.host.renderer.renderFrame(bench.view.lastRenderedRows)),
		);
		bench.host.stop();
		gc();
	}
}

/** 大历史：全量重建 vs 稳态，验证 O(N) 斜率。 */
function benchHistory(filter: string): void {
	if (filter && !"history".includes(filter)) return;
	for (const turns of [200, 800, 2000]) {
		const bench = makeHost(160, 45);
		seedTurns(bench.host, turns);
		bench.view.renderCurrentFrame();
		const lines = bench.view.layoutFrame().totalPerm;
		const rebuild: number[] = [];
		for (let i = 0; i < 20; i++) {
			bench.host.transcript.invalidate();
			rebuild.push(measure(() => bench.view.renderCurrentFrame(), 1)[0]!);
		}
		console.log(`\n[history ${turns} 轮] ${lines} 行`);
		report(
			"  稳态帧",
			measure(() => bench.view.renderCurrentFrame(), 100),
		);
		report("  全量失效后一帧", rebuild);
		bench.host.stop();
		gc();
	}
}

/** 流式：当前轮持续追加 + 一个运行中的工具卡。 */
function benchStreaming(filter: string): void {
	if (filter && !"streaming".includes(filter)) return;
	const bench = makeHost(120, 30);
	seedTurns(bench.host, 200);
	bench.host.transcript.startTurn(999, "流式提问");
	bench.host.transcript.appendToken("开始输出。\n\n");
	bench.view.renderCurrentFrame();
	const layout = bench.view.layoutFrame();

	let chars = 0;
	const frame = measure(() => {
		const chunk = "增量 token 内容，中文与 English 混排，模拟真实流式增量。".repeat(4);
		chars += chunk.length;
		bench.host.transcript.appendToken(chunk);
		bench.view.renderCurrentFrame();
	}, 200);
	console.log(`\n[streaming 120×30] 每帧追加 ${Math.round(chars / 200)} 字符`);
	report("  流式追加 + 整帧", frame);
	report(
		"  getFrameModel（尾部重排）",
		measure(() => bench.host.transcript.getFrameModel(layout.transcriptContentW)),
	);

	bench.host.transcript.startTool("read_file", { path: "src/ui/ui-host.ts" }, "bench-tool");
	const withTool = measure(() => {
		bench.view.renderCurrentFrame();
		// 推进时钟：工具卡依赖 Date.now() 的秒表与呼吸点
		clock += 16;
	}, 200);
	console.log("[streaming 120×30] 运行中的工具卡");
	report("  整帧", withTool);
	bench.host.stop();
	gc();
}

let clock = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => clock;

/** 微基准：把「每帧跑几百次」的原语单独钉在表里。 */
function benchMicro(filter: string): void {
	if (filter && !"micro".includes(filter)) return;
	const ANSI = "\x1b[38;2;232;230;224m";
	const cjkLine = `${ANSI}${"这是一行中文正文，混排 ascii 与标点 punctuation，用来模拟转录区真实行内容。".repeat(3).slice(0, 110)}\x1b[0m`;
	const crLine = Array.from({ length: 5000 }, (_, i) => `进度 ${i}%`.padEnd(40, ".")).join("\r");

	let tick = 0;
	console.log("\n[micro]");
	report(
		"  visibleWidth（每次新串）",
		measure(() => visibleWidth(`${cjkLine}${tick++}`), 20000),
	);
	report(
		"  visibleWidth（memo 命中）",
		measure(() => visibleWidth(cjkLine), 20000),
	);
	report(
		"  normalizeFrameLine（133 字符）",
		measure(() => normalizeFrameLine(cjkLine), 20000),
	);
	report(
		"  resolveCarriageReturns（205KB/5000 段）",
		measure(() => resolveCarriageReturns(crLine), 200),
	);
	report(
		"  extractAnsiCode（命中）",
		measure(() => extractAnsiCode(`x${cjkLine}`, 1), 20000),
	);
}

const filter = process.argv[2]?.trim() ?? "";
console.log("UI 帧管线基准（identity markdown，数值为下界）");
benchSteady(filter);
benchHistory(filter);
benchStreaming(filter);
benchMicro(filter);
Date.now = realNow;
