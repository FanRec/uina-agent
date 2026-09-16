/**
 * 真机帧落盘器（诊断专用，默认完全不工作）。
 *
 * 为什么需要：帧的"最后一步"——光标停在行末列附近后用 EL（`\x1b[K`）补齐剩余格子——
 * 它的正确性依赖终端语义（Windows Terminal 在 delayed-wrap / 行末列的 EL 行为与 xterm
 * 并不一致）。进程内模型只能验证"我们写了什么"，无法验证"终端怎么解释"，所以这类故障
 * 在测试里复现不出来，必须在真机上抓原始字节。
 *
 * 用法：设 `UINA_FRAME_LOG=<文件路径>` 启动 TUI，出现异常后退出，把文件交给诊断脚本。
 *   PowerShell:  $env:UINA_FRAME_LOG="$PWD\frame-log.jsonl"; pnpm start
 * 可选 `UINA_FRAME_LOG_MAX=<条数>`（默认 400，0 表示不限）控制落盘量；内容去重，
 * 心跳重绘的相同帧不会重复写。写盘失败绝不影响渲染。
 *
 * 关掉开关 = 零行为变化；彻底移除 = 删本文件 + `terminal.ts::syncWrite` 里的两行。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX = 400;

let seq = 0;
const seen = new Set<string>();

/** 开关是否打开（未设或空串视为关闭） */
export function frameLogEnabled(): boolean {
	const path = process.env["UINA_FRAME_LOG"];
	return typeof path === "string" && path.length > 0;
}

/** 便宜的字符串散列（仅用于去重，不做安全用途） */
function hash(data: string): number {
	let h = 2166136261;
	for (let i = 0; i < data.length; i++) {
		h ^= data.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** 把一帧的原始字节与当时的终端尺寸追加到日志（JSONL，一行一帧） */
export function logFrame(data: string, cols: number, rows: number): void {
	append({ kind: "frame", cols, rows, data });
}

/** 记一条非帧信息（如 Node 自报的终端尺寸），便于离线对照 */
export function logNote(kind: string, payload: Record<string, unknown>): void {
	append({ kind, ...payload });
}

/** 追加一行 JSONL（去重只对帧生效；探针记录一律落盘） */
function append(entry: Record<string, unknown>): void {
	if (!frameLogEnabled()) return;
	const max = Number(process.env["UINA_FRAME_LOG_MAX"] ?? DEFAULT_MAX);
	const isFrame = entry["kind"] === "frame";
	if (isFrame && Number.isFinite(max) && max > 0 && seen.size >= max) return;
	if (isFrame) {
		const cols = String(entry["cols"]);
		const rows = String(entry["rows"]);
		const data = String(entry["data"]);
		const key = `${cols}x${rows}:${data.length}:${hash(data)}`;
		if (seen.has(key)) return;
		seen.add(key);
	}
	try {
		const path = process.env["UINA_FRAME_LOG"]!;
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ seq: seq++, t: Date.now(), ...entry })}\n`, "utf-8");
	} catch {
		// 诊断落盘失败绝不能影响渲染
	}
}
