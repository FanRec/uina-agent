/**
 * W0 基线：1000 节点转录的单帧成本（只记录，不设门槛）。
 *
 *   pnpm bench:ui
 *
 * 只产出规划附录 B.1 要求的可复现基线（80×24、120×40、200×60，以及 1000 节点
 * 转录的 80×24）。终端用空 syncWrite 的假实现，计时只覆盖「生产帧字符串」的 CPU 成本。
 */

import { UIHost } from "../src/ui/ui-host.js";
import type { ProcessTerminal } from "../src/ui/core/terminal.js";

interface HostView {
	renderCurrentFrame(): void;
}

interface BenchHost {
	host: UIHost;
	view: HostView;
}

const WARMUP = 20;
const SAMPLES = 100;

const USER_LINE = "第 %d 轮：把这段输出整理成可读的报告，并指出缺失的证据。";
const ANSWER = "第 %d 段：这是混排中文与 English 的正文，用来让转录区达到真实密度；结论只写已经验证的事实。\n\n";
const STDOUT = JSON.stringify({
	stdout: "第一行\n第二行\n第三行",
	stderr: "",
	exitCode: 0,
});

function makeHost(columns: number, rows: number): BenchHost {
	const terminal = {
		columns,
		rows,
		isTTY: true,
		start: () => {},
		stop: () => {},
		write: () => {},
		syncWrite: () => {},
	} as unknown as ProcessTerminal;
	const host = new UIHost({ terminal, modelName: "bench" });
	host.start();
	return { host, view: host as unknown as HostView };
}

/** 每个回合 4 个节点（用户、回答、工具调用、工具结果），250 回合 = 1000 节点。 */
function seedNodes(host: UIHost, turns: number): void {
	for (let i = 0; i < turns; i++) {
		const callId = `call-${i}`;
		host.transcript.startTurn(i + 1, USER_LINE.replace("%d", String(i + 1)));
		host.transcript.appendToken(ANSWER.replace("%d", String(i + 1)).repeat(3));
		host.transcript.startTool({
			kind: "tool",
			id: `turn:${i + 1}:tool:${callId}`,
			turn: i + 1,
			callId,
			name: "exec_command",
			args: { command: `echo ${i}` },
			status: "running",
		});
		host.transcript.addToolDone({
			kind: "tool",
			id: `turn:${i + 1}:tool:${callId}`,
			turn: i + 1,
			callId,
			name: "exec_command",
			args: { command: `echo ${i}` },
			status: "succeeded",
			durationMs: 25,
			result: STDOUT,
		});
		host.transcript.finishTurn();
	}
	host.transcript.smoothReveal.setEnabled(false);
}

function measure(fn: () => void): number[] {
	for (let i = 0; i < WARMUP; i++) fn();
	const out: number[] = new Array(SAMPLES);
	for (let i = 0; i < SAMPLES; i++) {
		const t0 = process.hrtime.bigint();
		fn();
		out[i] = Number(process.hrtime.bigint() - t0) / 1e6;
	}
	return out;
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function report(label: string, values: readonly number[]): void {
	const p50 = percentile(values, 0.5).toFixed(3).padStart(8);
	const p95 = percentile(values, 0.95).toFixed(3).padStart(8);
	const max = Math.max(...values)
		.toFixed(3)
		.padStart(8);
	console.log(`${label.padEnd(28)} p50 ${p50} ms   p95 ${p95} ms   max ${max} ms`);
}

function bench(columns: number, rows: number, turns: number): void {
	const { host, view } = makeHost(columns, rows);
	if (turns > 0) seedNodes(host, turns);
	view.renderCurrentFrame();
	const nodes = turns * 4;
	console.log(`\n[${columns}×${rows}] ${nodes} 节点`);
	report(
		"  稳态整帧",
		measure(() => view.renderCurrentFrame()),
	);
	// 全量失效后再产一帧：布局与宽度适配都重算，是重建路径的上界。
	host.transcript.invalidate();
	report(
		"  失效后整帧",
		measure(() => view.renderCurrentFrame()),
	);
	host.stop();
}

console.log("W0 帧基线（identity markdown，数值为下界）");
for (const [columns, rows] of [
	[80, 24],
	[120, 40],
	[200, 60],
] as const) {
	bench(columns, rows, 0);
}
bench(80, 24, 250);
