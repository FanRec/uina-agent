/**
 * 渲染共享的工具格式化（TUI 与 stdio 渲染器共用，避免两处重复逻辑）。
 * 对齐 pi 的工具展示形态：调用行 + 结果折叠区首屏（摘要几行 + 截断标记）。
 */

export type Style = (s: string) => string;

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
	const t = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;

	let obj: Record<string, unknown> | null = null;
	try {
		obj = JSON.parse(result) as Record<string, unknown>;
	} catch {
		obj = null;
	}

	if (obj && typeof obj === "object") {
		if (obj.cancelled) return [s.warn(`⚠ 已取消（${t}）`)];
		const errText = typeof obj.error === "string" ? obj.error : "";
		const hasErr = errText !== "";
		const lines: string[] = [];
		if (hasErr) lines.push(s.err(`✗ ${errText.slice(0, 120)}（${t}）`));
		if (typeof obj.stderr === "string" && obj.stderr.trim() && hasErr) {
			lines.push(...indentLines(obj.stderr, s.err));
		}
		if (typeof obj.stdout === "string" && obj.stdout.trim()) {
			if (hasErr) lines.push(s.err("── stdout ──"));
			lines.push(...indentLines(obj.stdout, hasErr ? s.err : s.dim));
			lines.push(s.dim(`（${t}）`));
		}
		// 其他结构化返回（非 stdout/error 形状）：键值摘要一行
		if (!hasErr && !("stdout" in obj) && !("stderr" in obj)) {
			const keys = Object.keys(obj).slice(0, 3).map((k) => `${k}: ${short(obj[k])}`).join(", ");
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
		const styled = style(l);
		return styled.length > 204 ? `${styled.slice(0, 200)}…` : styled;
	});
	if (all.length > 6) out.push(style(`… 还有 ${all.length - 6} 行未显示`));
	return out;
}