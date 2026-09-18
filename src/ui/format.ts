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
 * 工具结果的中立解析视图：与展示样式解耦（纯数据，可独立单测）。
 *
 * - `text`：非 JSON / 非对象 JSON（如裸数字）——按纯文本缩进展示；
 * - `cancelled/unknown/not_started`：终态标记行；
 * - `structured`：结构化返回。`error` 为空串表示无错；`stderr/stdout` 仅在
 *   字段为 string 时填充（字段存在但类型不对时保持 undefined，渲染层据此
 *   走键值摘要或耗时回退，与旧实现语义一致）。
 */
export type ToolResultView =
	| { kind: "cancelled" }
	| { kind: "unknown" }
	| { kind: "not_started" }
	| { kind: "text"; text: string }
	| {
			kind: "structured";
			obj: Record<string, unknown>;
			error: string;
			stderr?: string;
			stdout?: string;
	  };

type StructuredToolResultView = Extract<ToolResultView, { kind: "structured" }>;

function tryParseObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** 结构化返回的终态分类：cancelled 优先（obj.cancelled 真值即命中，对齐旧语义）。 */
function classifyTerminalStatus(
	obj: Record<string, unknown>,
): "cancelled" | "unknown" | "not_started" | null {
	if (obj.cancelled || obj.status === "cancelled") return "cancelled";
	if (obj.status === "unknown") return "unknown";
	if (obj.status === "not_started") return "not_started";
	return null;
}

/** 解析工具结果为中立视图（纯函数：先剥 ANSI，再 JSON 解析 + 分类）。 */
export function parseToolResult(result: string): ToolResultView {
	const clean = sanitizeTerminalText(result);
	const obj = tryParseObject(clean);
	if (obj === null) return { kind: "text", text: clean.trim() };
	const status = classifyTerminalStatus(obj);
	if (status) return { kind: status };
	return {
		kind: "structured",
		obj,
		error: typeof obj.error === "string" ? obj.error : "",
		stderr: typeof obj.stderr === "string" ? obj.stderr : undefined,
		stdout: typeof obj.stdout === "string" ? obj.stdout : undefined,
	};
}

function formatElapsed(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 把中立视图渲染为展示行（样式决策集中于此，解析不参与）。 */
export function renderToolResult(
	view: ToolResultView,
	elapsedMs: number,
	s: ToolResultStyle,
): string[] {
	const t = formatElapsed(elapsedMs);
	switch (view.kind) {
		case "cancelled":
			return [s.warn(`⚠ 已取消（${t}）`)];
		case "unknown":
			return [s.warn(`⚠ 结果未知（${t}）`)];
		case "not_started":
			return [s.warn(`⚠ 未执行（${t}）`)];
		case "text":
			return view.text ? indentLines(view.text, s.dim) : [s.dim(`↳ ${t}`)];
		case "structured":
			return structuredResultLines(view, t, s);
	}
}

function structuredResultLines(
	view: StructuredToolResultView,
	t: string,
	s: ToolResultStyle,
): string[] {
	const lines = [
		...errorHeader(view.error, t, s),
		...stderrSection(view, s),
		...stdoutSection(view, t, s),
	];
	return lines.length > 0 ? lines : otherKeysOrTime(view, t, s);
}

function errorHeader(error: string, t: string, s: ToolResultStyle): string[] {
	return error ? [s.err(`✗ ${error.slice(0, 120)}（${t}）`)] : [];
}

function stderrSection(
	view: StructuredToolResultView,
	s: ToolResultStyle,
): string[] {
	const stderr = view.stderr;
	if (!stderr || !stderr.trim()) return [];
	if (view.error) return indentLines(stderr, s.err);
	return [s.warn("stderr"), ...indentLines(stderr, s.warn)];
}

function stdoutSection(
	view: StructuredToolResultView,
	t: string,
	s: ToolResultStyle,
): string[] {
	const stdout = view.stdout;
	if (!stdout || !stdout.trim()) return [];
	const lines = view.error ? [s.err("── stdout ──")] : [];
	lines.push(...indentLines(stdout, view.error ? s.err : s.dim));
	lines.push(s.dim(`（${t}）`));
	return lines;
}

/** 无 error/stdout/stderr 正文时的回退：键值摘要一行；有 stderr/stdout 键
 * （但正文为空白）时不得走摘要，退到耗时行——对齐旧实现的存在性判断。 */
function otherKeysOrTime(
	view: StructuredToolResultView,
	t: string,
	s: ToolResultStyle,
): string[] {
	if (!view.error && !("stdout" in view.obj) && !("stderr" in view.obj)) {
		const keys = Object.keys(view.obj)
			.slice(0, 3)
			.map((k) => `${k}: ${short(view.obj[k])}`)
			.join(", ");
		return [s.dim(`↳ ${keys}`)];
	}
	return [s.dim(`↳ ${t}`)];
}

/**
 * 工具结果的展示行（对齐 pi 折叠区第一屏）：解析结构化返回，
 * stdout 摘要几行 + 截断标记；error 红字 / cancelled 黄字 / 普通结果灰字。
 * 解析（parseToolResult）与渲染（renderToolResult）已拆分，本函数保持旧签名。
 */
export function toolResultLines(
	result: string,
	elapsedMs: number,
	s: ToolResultStyle,
): string[] {
	return renderToolResult(parseToolResult(result), elapsedMs, s);
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
