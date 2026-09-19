/**
 * 真机帧日志诊断：读 `UINA_FRAME_LOG` 落盘的 JSONL，逐帧还原"屏幕到底成了什么"，
 * 并打印/落盘异常证据。
 *
 * 用法：
 *   pnpm diagnose:frames [日志路径]        # 默认 ./frame-log.jsonl
 *
 * 它回答四个问题：
 *   1. 每帧是否写满视口行数？有没有折行/滚动（整屏错位的唯一来源）？
 *   2. 有没有"从没被涂过"的格子（真机上会残留上一帧内容 —— 缺口/重叠）？
 *   3. 行尾 EL 是在什么位置、什么底色下发出的（WT 在行末列发 EL 会把下一行涂色）？
 *   4. 相邻帧之间到底哪几行的内容变了（把异常时刻定位到具体帧）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { VtScreen, type Run } from "../tests/harness/index.js";
import { visibleWidth } from "../src/ui/core/utils.js";

interface LoggedFrame { seq: number; t: number; cols: number; rows: number; data: string; kind?: string }

const path = process.argv[2] ?? "frame-log.jsonl";
const all: LoggedFrame[] = readFileSync(path, "utf-8")
	.split(/\r?\n/)
	.filter((l) => l.trim().length > 0)
	.map((l) => JSON.parse(l) as LoggedFrame);

// (0) 最要紧的一条：Node 自报的终端尺寸 vs 终端自己报告的尺寸
const nodeSize = all.find((e) => (e as unknown as { kind?: string }).kind === "node-size") as unknown as { cols: number; rows: number; isTTY: boolean } | undefined;
const sizes = all.filter((e) => (e as unknown as { kind?: string }).kind === "size-report") as unknown as Array<{ cols: number; rows: number; raw: string }>;
console.log(`日志 ${path}：${all.length} 条（帧 ${all.filter((e) => (e.kind ?? "frame") === "frame").length}）`);
if (nodeSize || sizes.length) {
	console.log(`\n[终端尺寸] Node 自报：${nodeSize ? `${nodeSize.cols}x${nodeSize.rows} (isTTY=${nodeSize.isTTY})` : "（缺失）"}`);
	console.log(`          终端回执：${sizes.length ? sizes.map((s) => `${s.cols}x${s.rows}`).join(" , ") : "（无回执：该终端不支持 CSI 18t）"}`);
	const t = sizes.at(-1);
	if (nodeSize && t) {
		console.log(nodeSize.cols === t.cols && nodeSize.rows === t.rows
			? "          → 一致 ✔（帧高/行宽与窗口相符）"
			: `          → ★ 不一致：Node 以为 ${nodeSize.cols}x${nodeSize.rows}，窗口实际 ${t.cols}x${t.rows} —— 帧会写到可视区之外，终端每帧滚动，整屏行映射错位（残留片段/顶部冒出旧内容/hover 错位都由此而来）`);
	}
} else {
	console.log(`\n[终端尺寸] 未采集到（日志里没有 node-size/size-report 条目）`);
}

const frames: LoggedFrame[] = all.filter((e) => (e.kind ?? "frame") === "frame");

const rowsOf = (f: LoggedFrame): string[] => f.data.split(/\x1b\[\d+;1H/).slice(1);

let flagged = 0;
const report: string[] = [];
for (const f of frames) {
	const rows = rowsOf(f);
	const screen = new VtScreen(f.cols, f.rows);
	screen.feed(f.data);
	const idle = screen.unpaintedRuns();
	const widths = rows.map((r) => visibleWidth(r.replace(/\x1b\[K/g, "")));
	const boundaryRows = widths.filter((w) => w >= f.cols - 1).length;
	// EL 前是否先绝对定位（HEAD 只在满宽行这样做），以及 EL 当时的行底色
	const elCount = (f.data.match(/\x1b\[K/g) ?? []).length;
	const cupThenEl = (f.data.match(/\x1b\[\d+;\d+H\x1b\[K/g) ?? []).length;
	const inlineEl = elCount - cupThenEl;
	const problems: string[] = [];
	if (rows.length !== f.rows) problems.push(`定位行数=${rows.length}≠${f.rows}`);
	if (screen.scrolled) problems.push(`滚动=${screen.scrolled}`);
	if (screen.wrapped) problems.push(`折行=${screen.wrapped}`);
	if (screen.tabJumps) problems.push(`制表跳格=${screen.tabJumps}`);
	if (screen.crMoves) problems.push(`行内回车=${screen.crMoves}`);
	if (idle.length) problems.push(`未涂色区段=${idle.length}`);
	if (problems.length) {
		flagged++;
		report.push(`#${f.seq} t=${new Date(f.t).toLocaleTimeString()} ${f.cols}x${f.rows} :: ${problems.join(" / ")}`);
		if (idle.length) report.push(`   ${idle.slice(0, 6).map((r: Run) => `row${r.row} x=${r.start}..${r.end}`).join(" | ")}`);
	}
	if (flagged <= 3 && problems.length === 0) {
		report.push(
			`#${f.seq} t=${new Date(f.t).toLocaleTimeString()} ${f.cols}x${f.rows} 干净：行宽达末列附近=${boundaryRows}/${rows.length} EL=${elCount}(绝对定位后=${cupThenEl} 就地=${inlineEl})`,
		);
	}
}

console.log(`\n[逐帧结论]`);
for (const line of report.slice(-40)) console.log("  " + line);
if (flagged === 0) console.log("  （没有几何/覆盖类异常：故障若可见，只可能来自终端对行末 EL 的解释，见下方落盘）");

// 相邻帧差异：把"异常出现的时刻"定位到具体帧
console.log(`\n[相邻帧差异] 只列"行内容发生变化"的帧（最多 12 帧）`);
let shown = 0;
for (let i = 1; i < frames.length && shown < 12; i++) {
	const a = rowsOf(frames[i - 1]!);
	const b = rowsOf(frames[i]!);
	const changed: number[] = [];
	for (let r = 0; r < Math.max(a.length, b.length); r++) {
		if ((a[r] ?? "") !== (b[r] ?? "")) changed.push(r);
	}
	if (changed.length === 0 || changed.length === Math.max(a.length, b.length)) continue;
	console.log(`  #${frames[i]!.seq} 变了 ${changed.length} 行：${changed.slice(0, 12).join(",")}${changed.length > 12 ? "…" : ""}`);
	shown++;
}

// 落盘最后一帧的文本还原，方便肉眼比对真机画面
const last = frames.at(-1)!;
const screen = new VtScreen(last.cols, last.rows);
screen.feed(last.data);
const out = `${path}.render.txt`;
writeFileSync(out, screen.lines().join("\n") + "\n", "utf-8");
console.log(`\n最后一帧已还原为文本：${out}（${last.cols}x${last.rows}）`);
