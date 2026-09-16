/**
 * 渲染共享的工具格式化（TUI 与 stdio 渲染器共用，避免两处重复逻辑）。
 * 对齐 pi 的工具展示形态：调用行 + 结果折叠区首屏（摘要几行 + 截断标记）。
 */

import { truncateToWidth } from "./core/utils.js";

export type Style = (s: string) => string;

/** 格式化毫秒耗时为紧凑文本（如 5s, 3m12s） */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSec = seconds % 60;
	return `${minutes}m${remSec}s`;
}

export function sanitizeTerminalText(value: string): string {
	return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

/** Drop C0 control characters (except tab/newline/CR) and Unicode format
 * characters. Pi does the same at the tool-output boundary
 * (coding-agent/src/utils/shell.ts sanitizeBinaryOutput). */
export function sanitizeBinaryOutput(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a || code === 0x0d) { out += char; continue; }
		if (code <= 0x1f) continue;
		if (code >= 0xfff9 && code <= 0xfffb) continue;
		out += char;
	}
	return out;
}

/** Text entering a rendered surface from an untrusted source (model output,
 * tool output, extension content): strip ANSI/OSC and control characters so a
 * payload cannot drive the terminal. */
export function sanitizeRenderText(value: string): string {
	return sanitizeBinaryOutput(sanitizeTerminalText(value));
}

/**
 * 只保留 SGR（颜色/属性）转义，剥掉其它一切转义与裸控制字符。
 *
 * 用于**工具输出**这类"要保留颜色、但绝不允许驱动光标"的内容：
 *   - 保留：`\x1b[32m` 这类颜色/属性序列（工具输出的绿/红/加粗都在这里）；
 *   - 剥掉：光标移动/定位/擦除（`\x1b[H`/`\x1b[2J`/`\x1b[K`）、OSC/APC、字符集
 *     （`\x1b(B`）等 —— 任何一个漏进帧都会让终端吞掉我们后面的定位/底色序列；
 *   - 丢弃：孤立 ESC 与其它 C0/C1/DEL（保留 \t\n\r 交给后续步骤处理）。
 *
 * 与 `sanitizeRenderText` 的区别就是"是否保留颜色"：前者全剥（不受信文本用），
 * 后者留 SGR（工具输出用，颜色是它的语义信息）。
 */
export function keepSgrOnly(value: string): string {
	if (!value) return "";
	const sgr = /\x1b\[[0-9;]*m/y;
	// sanitizeTerminalText 的同一套覆盖面（CSI/OSC/APC/字符集），锚定在当前位置整段剥掉
	const esc =
		/[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/y;
	let out = "";
	let i = 0;
	while (i < value.length) {
		if (value.charCodeAt(i) === 0x1b) {
			sgr.lastIndex = i;
			const kept = sgr.exec(value);
			if (kept) {
				out += kept[0];
				i += kept[0].length;
				continue;
			}
			esc.lastIndex = i;
			const dropped = esc.exec(value);
			i += dropped ? dropped[0].length : 1; // 非 SGR 转义整段丢弃；孤立 ESC 丢单字节
			continue;
		}
		const code = value.charCodeAt(i);
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			out += value[i];
		} else if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			out += value[i];
		}
		i++;
	}
	return out;
}

export interface ToolResultStyle {
	ok: Style;
	err: Style;
	warn: Style;
	dim: Style;
}

/** 工具调用行的参数摘要：空对象不显示，长参数截断 60 字符 */
export function toolStartLine(name: string, args: unknown): string {
	let argText = "";
	try {
		argText = JSON.stringify(args ?? {});
	} catch {
		argText = String(args);
	}
	if (!argText || argText === "{}") return `[工具] ${name}`;
	const slim = argText.length > 60 ? `${argText.slice(0, 57)}…` : argText;
	return `[工具] ${name} ${slim}`;
}

/**
 * 工具结果的展示行（对齐 pi 折叠区第一屏）：解析结构化返回，
 * stdout 摘要几行 + 截断标记；error 红字 / cancelled 黄字 / 普通结果灰字。
 */
export function toolResultLines(
	result: string,
	elapsedMs: number,
	s: ToolResultStyle,
): string[] {
	result = sanitizeTerminalText(result);
	const t =
		elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;

	let obj: Record<string, unknown> | null = null;
	try {
		obj = JSON.parse(result) as Record<string, unknown>;
	} catch {
		obj = null;
	}

	if (obj && typeof obj === "object") {
		if (obj.cancelled || obj.status === "cancelled") return [s.warn(`⚠ 已取消（${t}）`)];
		if (obj.status === "unknown") return [s.warn(`⚠ 结果未知（${t}）`)];
		if (obj.status === "not_started") return [s.warn(`⚠ 未执行（${t}）`)];
		const errText = typeof obj.error === "string" ? obj.error : "";
		const hasErr = errText !== "";
		const lines: string[] = [];
		if (hasErr) lines.push(s.err(`✗ ${errText.slice(0, 120)}（${t}）`));
		if (typeof obj.stderr === "string" && obj.stderr.trim()) {
			if (hasErr) lines.push(...indentLines(obj.stderr, s.err));
			else {
				lines.push(s.warn("stderr"));
				lines.push(...indentLines(obj.stderr, s.warn));
			}
		}
		if (typeof obj.stdout === "string" && obj.stdout.trim()) {
			if (hasErr) lines.push(s.err("── stdout ──"));
			lines.push(...indentLines(obj.stdout, hasErr ? s.err : s.dim));
			lines.push(s.dim(`（${t}）`));
		}
		// 其他结构化返回（非 stdout/error 形状）：键值摘要一行
		if (!hasErr && !("stdout" in obj) && !("stderr" in obj)) {
			const keys = Object.keys(obj)
				.slice(0, 3)
				.map((k) => `${k}: ${short(obj[k])}`)
				.join(", ");
			lines.push(s.dim(`↳ ${keys}`));
		}
		return lines.length > 0 ? lines : [s.dim(`↳ ${t}`)];
	}

	const text = String(result).trim();
	return text ? indentLines(text, s.dim) : [s.dim(`↳ ${t}`)];
}

function short(v: unknown): string {
	try {
		const j = JSON.stringify(v);
		return j && j.length > 40 ? `${j.slice(0, 37)}…` : (j ?? "null");
	} catch {
		return "?";
	}
}

/** 多行文本 → 缩进展示（最多 6 行，行超 200 字符截断，超行数加标记） */
function indentLines(text: string, style: Style): string[] {
	const all = text.split("\n");
	const raw = all.slice(0, 6);
	const out = raw.map((l) => {
		const safeLine = truncateToWidth(l, 200);
		return style(safeLine);
	});
	if (all.length > 6) out.push(style(`… 还有 ${all.length - 6} 行未显示`));
	return out;
}
