/**
 * 统一面板渲染器（TUI Surface 布局原语）。
 *
 * 所有居中面板（help/effort/prompt/trajectory/branch/model-picker/扩展浮层）
 * 的边框、标题、页脚由此统一产出；每行可视宽度精确等于 boxWidth——这是
 * 不变量，违反时开发态抛错、生产态按内容重裁并保留右边框，绝不再用
 * `…` 吃掉 `╯`。
 */

import { C, visibleWidth } from "../core/utils.js";
import { fitLine } from "./fit.js";

/** 开发态判定：NODE_ENV 未显式声明为 production 时按开发态严格校验。 */
export function isFrameDevMode(): boolean {
	try {
		return process.env["NODE_ENV"] !== "production";
	} catch {
		return true;
	}
}

export interface PanelSpec {
	/** 顶边框标题；缺省渲染素顶边。 */
	title?: string;
	/** 内容行；调用方按 innerWidth 预 fit，面板守卫只做最终校验。 */
	body: readonly string[];
	/** 页脚内容行（│ 包裹的一行）；缺省不渲染。 */
	footer?: string;
	/** 嵌入底边框的提示（╰─ 提示 ─╯ 风格）；与 footer 可共存。 */
	bottomTag?: string;
	/** 整框宽度（含左右边框与两个 padding 列），不含 leftPad。 */
	boxWidth: number;
	/** 左侧整体缩进（框外空列）。 */
	leftPad?: number;
	borderColor?: string;
	titleColor?: string;
	footerColor?: string;
}

/** 面板内宽：│ + space + 内容 + space + │。 */
export function panelInnerWidth(boxWidth: number): number {
	return Math.max(0, boxWidth - 4);
}

/** 渲染整个面板；输出每行（含 leftPad）可视宽度 <= leftPad + boxWidth，框行精确等于。 */
export function renderPanel(spec: PanelSpec): string[] {
	const boxWidth = Math.floor(spec.boxWidth);
	if (boxWidth < 4) return [];
	const leftPad = Math.max(0, spec.leftPad ?? 0);
	const pad = " ".repeat(leftPad);
	const border = spec.borderColor ?? C.subtle;
	const innerW = panelInnerWidth(boxWidth);

	const rows: string[] = [
		panelTopBorder(boxWidth, { title: spec.title, borderColor: border, titleColor: spec.titleColor, leftPad }),
	];
	for (const line of spec.body) rows.push(panelRow(line, boxWidth, { borderColor: border, leftPad }));
	if (spec.footer !== undefined)
		rows.push(panelRow(spec.footer, boxWidth, { borderColor: border, leftPad, color: spec.footerColor }));
	rows.push(panelBottomBorder(boxWidth, { tag: spec.bottomTag, borderColor: border, leftPad }));
	return rows;
}

// ── 面板部件（特殊布局的浮层按此拼装，每一件都过宽度守卫） ──────────────────

export interface PanelPieceOptions {
	borderColor?: string;
	titleColor?: string;
	leftPad?: number;
	/** 内容前置色（如 footer 的 dim）。 */
	color?: string;
}

/** 顶边框：╭─ 标题 ─…─╮，精确 boxWidth。 */
export function panelTopBorder(boxWidth: number, opts: PanelPieceOptions & { title?: string } = {}): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4) return "";
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	const title = opts.title ? fitLine(opts.title, Math.max(1, bw - 6), "ellipsis") : "";
	const tag = title ? `─ ${title} ` : "";
	const fill = Math.max(0, bw - 2 - visibleWidth(tag));
	return guard(
		`${pad}${border}╭${opts.titleColor ?? C.inactive}${tag}${border}${"─".repeat(fill)}╮${C.reset}`,
		bw,
		pad,
	);
}

/** 底边框：╰─ 提示 ─…─╯ 或素底边，精确 boxWidth。 */
export function panelBottomBorder(boxWidth: number, opts: PanelPieceOptions & { tag?: string } = {}): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4) return "";
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	const tag = opts.tag ? fitLine(opts.tag, Math.max(1, bw - 6), "ellipsis") : "";
	const tagPart = tag ? `─ ${tag} ` : "";
	const fill = Math.max(0, bw - 2 - visibleWidth(tagPart));
	return guard(`${pad}${border}╰${C.dim}${tagPart}${C.reset}${border}${"─".repeat(fill)}╯${C.reset}`, bw, pad);
}

/** 内容行：│ 内容 │，内容按 panelInnerWidth 截断，精确 boxWidth。 */
export function panelRow(content: string, boxWidth: number, opts: PanelPieceOptions = {}): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4) return "";
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	const innerW = panelInnerWidth(bw);
	const prefixed = opts.color ? `${opts.color}${content}${C.reset}` : content;
	const fitted = fitLine(prefixed, innerW, "ellipsis");
	return guard(
		`${pad}${border}│${C.reset} ${fitted}${" ".repeat(Math.max(0, innerW - visibleWidth(fitted)))} ${border}│${C.reset}`,
		bw,
		pad,
	);
}

/** 框内分隔线：├───┤，精确 boxWidth。 */
export function panelDivider(boxWidth: number, opts: PanelPieceOptions = {}): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4) return "";
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	return guard(`${pad}${border}├${"─".repeat(Math.max(0, bw - 2))}┤${C.reset}`, bw, pad);
}

/** 框内交叉分隔线（带竖线接点）：├───┼───┤ 或自定义接点行，精确 boxWidth。 */
export function panelCrossDivider(boxWidth: number, columns: readonly number[], opts: PanelPieceOptions = {}): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4 || columns.length === 0) return panelDivider(boxWidth, opts);
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	let out = `${pad}${border}├`;
	let prev = 1;
	for (const col of columns) {
		const target = Math.min(bw - 2, Math.max(1, col - 1));
		out += `${"─".repeat(Math.max(0, target - prev))}┼`;
		prev = target + 1;
	}
	out += `${"─".repeat(Math.max(0, bw - 1 - prev))}┤${C.reset}`;
	return guard(out, bw, pad);
}

/** 双栏内容行：│ 左栏 │ 右栏 │；midCol 是中竖线的 1-based 列，精确 boxWidth。 */
export function panelSplitRow(
	boxWidth: number,
	left: string,
	right: string,
	midCol: number,
	opts: PanelPieceOptions = {},
): string {
	const bw = Math.floor(boxWidth);
	if (bw < 4) return "";
	const pad = " ".repeat(Math.max(0, opts.leftPad ?? 0));
	const border = opts.borderColor ?? C.subtle;
	// 行模型：│(1) sp left sp │ sp right sp │ = leftW + rightW + 7 = boxWidth
	// 中竖线 1-based 列 = 1 + 1 + leftW + 1 + 1 = leftW + 4
	const leftW = Math.max(1, midCol - 4);
	const rightW = Math.max(1, bw - 7 - leftW);
	const fittedLeft = fitLine(left, leftW, "ellipsis");
	const fittedRight = fitLine(right, rightW, "ellipsis");
	return guard(
		`${pad}${border}│${C.reset} ${fittedLeft}${" ".repeat(Math.max(0, leftW - visibleWidth(fittedLeft)))} ${border}│${C.reset} ${fittedRight}${" ".repeat(Math.max(0, rightW - visibleWidth(fittedRight)))} ${border}│${C.reset}`,
		bw,
		pad,
	);
}

/**
 * 宽度守卫：框行必须精确等于 boxWidth（不含 leftPad）。
 * 开发态抛错暴露排版算术错误；生产态重裁到框宽（内容行重走 fitLine，边框保留）。
 */
function guard(row: string, boxWidth: number, pad: string): string {
	const width = visibleWidth(row) - visibleWidth(pad);
	if (width === boxWidth) return row;
	if (isFrameDevMode()) {
		throw new Error(`面板行宽 ${width} != ${boxWidth}（面板算术错误）：${JSON.stringify(row.slice(0, 80))}`);
	}
	return `${pad}${fitLine(row.slice(pad.length), boxWidth, "clip")}`;
}
