/**
 * 临时诊断探针（跑完即删）：定位「旧 session 流中解码窗口被拉长」的凶手。
 *
 * 三类事件，NDJSON 落到 ~/.uina/diag-probe.jsonl：
 *  - lag    事件循环延迟：每 100ms 一拍，实际触发晚于计划 30ms 以上记一条。
 *  - deltas 一次模型调用的内容 delta 到达间隔摘要（usage 时结算）。
 *  - phase  阶段耗时（投影、compaction transformContext）。
 *
 * 仅当标记文件 ~/.uina/diag-probe.on 存在时启用；探针自身故障一律静默，不影响运行。
 */

import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const uinaDir = join(process.env.UINA_HOME ?? homedir(), ".uina");
const MARKER = join(uinaDir, "diag-probe.on");
const LOG = join(uinaDir, "diag-probe.jsonl");

let active = false;
let pending: string[] = [];
let deltas: number[] = [];

export function startDiagProbe(): void {
	if (active || !existsSync(MARKER)) return;
	active = true;
	let scheduled = Date.now() + 100;
	setInterval(() => {
		const now = Date.now();
		const lagMs = now - scheduled;
		if (lagMs > 30) pending.push(JSON.stringify({ t: now, kind: "lag", lagMs }));
		scheduled = now + 100;
		if (pending.length > 0) {
			try {
				appendFileSync(LOG, `${pending.join("\n")}\n`);
			} catch {
				// 探针失败不影响运行
			}
			pending = [];
		}
	}, 100).unref();
}

/** 每个内容 delta 到达时打点（collector 调用）。 */
export function diagDelta(): void {
	if (active && deltas.length < 20000) deltas.push(Date.now());
}

/** 一次调用结算：输出到达间隔摘要并清空缓冲（usage 时调用）。 */
export function diagDeltaSummary(): void {
	if (!active) return;
	const ds = deltas;
	deltas = [];
	if (ds.length < 2) return;
	const gaps: number[] = [];
	for (let i = 1; i < ds.length; i += 1) gaps.push(ds[i] - ds[i - 1]);
	gaps.sort((a, b) => a - b);
	const at = (p: number): number => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
	pending.push(
		JSON.stringify({
			t: Date.now(),
			kind: "deltas",
			n: ds.length,
			spanMs: ds[ds.length - 1] - ds[0],
			gapP50: at(0.5),
			gapP90: at(0.9),
			gapMax: gaps[gaps.length - 1],
			gapsOver30: gaps.filter((g) => g > 30).length,
		}),
	);
}

/** 阶段耗时打点。 */
export function diagPhase(name: string, ms: number, extra?: Record<string, unknown>): void {
	if (active)
		pending.push(JSON.stringify({ t: Date.now(), kind: "phase", name, ms: Math.round(ms * 10) / 10, ...extra }));
}
