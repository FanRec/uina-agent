/**
 * 会话转录区卡片组件簇（Transcript Cards）。
 * 集中管理思考链卡片、压缩摘要卡片、扩展自定义消息卡片与扩展自定义条目卡片。
 */

import { imageNotice } from "../../../core/content.js";
import type { CustomMessage, MessageRenderer } from "../../../extensions/ui-contract.js";
import { Container } from "../../core/container.js";
import type { Component } from "../../core/types.js";
import { C, stripAnsi, visibleWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { fitLine, wrapLine } from "../../layout/fit.js";
import { applyCardBackground } from "./tool-view.js";

/* ------------------------------------------------------------------ */
/* 1. 思考链展示卡片                                                    */
/* ------------------------------------------------------------------ */

/** 格式化对话流内部的思考链块（永久行） */
export function formatThinkingLines(thinkingText: string, collapsed = true, width = 80, isHovered = false): string[] {
	thinkingText = sanitizeRenderText(thinkingText);
	if (!thinkingText || !thinkingText.trim()) return [];

	const iconColor = isHovered ? `${C.bold}${C.text}` : C.claude;
	const icon = `${iconColor}✦${C.reset}`;
	const titleText = isHovered ? `${C.bold}${C.text}思考${C.reset}` : `${C.bold}${C.claude}思考${C.reset}`;

	if (collapsed) {
		const clean = thinkingText.replace(/[\r\n]+/g, " ").trim();
		const maxSnippetLen = Math.max(10, width - 36);
		const snippet = clean.length > maxSnippetLen ? `${clean.slice(0, maxSnippetLen)}…` : clean;
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 展开)${C.reset}`
			: `${C.subtle}(ctrl+o 展开 · alt+o 全量)${C.reset}`;
		const line = `${icon} ${titleText} ${C.inactive}${snippet}${C.reset} ${hint}`;
		return [fitLine(line, width, "clip"), ""];
	}

	const hint = isHovered
		? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}`
		: `${C.subtle}(ctrl+o 收起 · alt+o 全量)${C.reset}`;
	const title = `${icon} ${titleText} ${hint}:`;
	const lines = [fitLine(title, width, "clip")];

	const wrapped = wrapLine(thinkingText.trim(), Math.max(20, width - 4));
	for (const line of wrapped) {
		lines.push(`${C.subtle}│${C.reset} ${C.inactive}${C.italic}${line}${C.reset}`);
	}
	lines.push(""); // 与后续助手正文保持一空行的垂直节奏
	return lines;
}

/* ------------------------------------------------------------------ */
/* 2. 会话压缩摘要卡片                                                 */
/* ------------------------------------------------------------------ */

export interface CompactionCardData {
	status?: "completed" | "failed" | "cancelled" | "noop";
	summary: string;
	/** canonical 主线中从压缩尾部起保留的条目数；旧 checkpoint 可未知。 */
	retainedTailEntries?: number;
	/** 压缩前 token 数；旧 checkpoint 未测量时保持未知，不补 0。 */
	tokensBefore?: number;
	collapsed: boolean;
}

/**
 * 格式化渲染会话压缩卡片行
 */
export function formatCompactionCardLines(record: CompactionCardData, width = 80, isHovered = false): string[] {
	const boxW = Math.max(20, width);
	if (record.status && record.status !== "completed") {
		const title =
			record.status === "failed" ? "压缩失败" : record.status === "cancelled" ? "压缩已取消" : "当前无需压缩";
		const header = `${C.subtle}───${C.inactive} ${title} ${C.subtle}${"─".repeat(Math.max(3, boxW - visibleWidth(title) - 5))}${C.reset}`;
		const detail = fitLine(`  ${record.summary.replace(/\s+/g, " ").trim()}`, boxW);
		return [header, `${C.inactive}${detail}${C.reset}`, `${C.subtle}${"─".repeat(boxW)}${C.reset}`];
	}
	const tokensBeforeStr =
		record.tokensBefore === undefined
			? undefined
			: record.tokensBefore >= 1000
				? `${(record.tokensBefore / 1000).toFixed(1)}k`
				: `${record.tokensBefore}`;

	const leftDashes = "───";
	const leftW = visibleWidth(leftDashes);

	if (record.collapsed) {
		const title = " 会话已压缩 ";
		const rightDashCount = Math.max(3, boxW - leftW - visibleWidth(title));
		const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

		const symbol = `${isHovered ? C.suggestion : C.inactive}∴${C.reset}`;
		const label = `${C.inactive}摘要已折叠 · ${C.reset}`;
		const hint = isHovered
			? `${C.suggestion}(点击 / ctrl+o 展开)${C.reset}`
			: `${C.inactive}(ctrl+o / 点击展开)${C.reset}`;

		const flat = record.summary.replace(/\s+/g, " ").trim();
		const budget = Math.max(8, boxW - (4 + visibleWidth("摘要已折叠 · ")) - (visibleWidth(hint) + 1));
		const preview = fitLine(flat, budget);
		const previewCol = isHovered ? C.text : C.inactiveShimmer;
		const rawLine = `  ${symbol} ${label}${previewCol}${preview}${C.reset} ${hint}`;

		const middleLine = isHovered
			? applyCardBackground(rawLine, C.toolCardBackground, boxW)
			: `${rawLine}${" ".repeat(Math.max(0, boxW - visibleWidth(rawLine)))}`;
		const botLine = `${C.subtle}${"─".repeat(boxW)}${C.reset}`;

		return [topLine, middleLine, botLine];
	}

	// 展开态：自适应标题
	const candidates = [
		` 会话已压缩 · 完整摘要${record.retainedTailEntries === undefined ? "" : ` (保留 ${record.retainedTailEntries} 条)`} `,
		` 会话已压缩 · 完整摘要 `,
		` 会话已压缩 `,
		"",
	];
	const title = candidates.find((t) => leftW + visibleWidth(t) + 3 <= boxW) ?? "";
	const rightDashCount = Math.max(3, boxW - leftW - visibleWidth(title));
	const topLine = `${C.subtle}${leftDashes}${C.inactive}${title}${C.subtle}${"─".repeat(rightDashCount)}${C.reset}`;

	const output: string[] = [topLine];

	// 正文自动折行与缩进
	const innerW = Math.max(10, boxW - 4);
	for (const line of wrapLine(record.summary.trim(), innerW)) {
		const lineContent = `  ${line}`;
		const effContent = visibleWidth(lineContent) > boxW ? fitLine(lineContent, boxW) : lineContent;
		output.push(`${C.text}${effContent}${" ".repeat(Math.max(0, boxW - visibleWidth(effContent)))}${C.reset}`);
	}

	// 底部统计与提示
	const arrow = `${isHovered ? C.suggestion : C.claude}↳${C.reset}`;
	const retained =
		record.retainedTailEntries === undefined ? "保留条目未知" : `保留 ${record.retainedTailEntries} 条主线记录`;
	const stats =
		tokensBeforeStr === undefined
			? `${C.inactive}压缩前 token 数未知${C.reset} · ${C.inactive}${retained}${C.reset}`
			: `${C.success}压缩前 ${tokensBeforeStr} tokens${C.reset} · ${C.inactive}${retained}${C.reset}`;
	const hint = isHovered
		? `${C.suggestion}(点击 / ctrl+o 收起)${C.reset}`
		: `${C.inactive}(ctrl+o / 点击收起)${C.reset}`;
	const footerRaw = `  ${arrow} ${stats} · ${hint}`;
	const effFooter = visibleWidth(footerRaw) > boxW ? fitLine(footerRaw, boxW) : footerRaw;
	output.push(`${effFooter}${" ".repeat(Math.max(0, boxW - visibleWidth(effFooter)))}`);
	output.push(`${C.subtle}${"─".repeat(boxW)}${C.reset}`);

	return output;
}

/* ------------------------------------------------------------------ */
/* 3. 扩展自定义卡片组件基础类与实现                                     */
/* ------------------------------------------------------------------ */

abstract class BaseCustomComponent<
	T extends { customType: string },
	R extends ((item: T, opts: { expanded: boolean }) => Component | undefined) | undefined,
> extends Container {
	constructor(
		protected readonly item: T,
		protected readonly renderer?: R,
		private readonly renderComponent: (component: Component, width: number, height?: number) => string[] = (
			component,
			width,
			height,
		) => component.render(width, height),
	) {
		super();
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	protected abstract renderFallback(w: number): string[];

	private rebuild(): void {
		this.clear();
		if (this.renderer) {
			try {
				const c = this.renderer(this.item, { expanded: false });
				if (c) {
					this.addChild({
						render: (width, height) => this.renderComponent(c, width, height),
						invalidate: () => c.invalidate?.(),
					});
					return;
				}
			} catch (err) {
				this.addChild({
					render: () => [`${C.red}✗ [${this.item.customType}] 渲染失败: ${String(err)}${C.reset}`],
					invalidate: () => {},
				});
				return;
			}
		}
		this.addChild({
			render: (w: number) => this.renderFallback(w),
			invalidate: () => {},
		});
	}
}

export class CustomMessageComponent extends BaseCustomComponent<CustomMessage, MessageRenderer> {
	/** Rewind card: one declared frame width, content rows measured in display columns. */
	private renderRewindCard(w: number): string[] {
		const boxW = Math.max(32, Math.min(w, 88));
		const innerW = boxW - 6;
		const borderCol = C.yellow;
		const tag = " ⟲ 会话回溯 · 主线反思 ";
		const topFill = Math.max(2, boxW - visibleWidth(tag) - 5);
		const header = `  ${borderCol}╭─${C.bold}${C.yellow}${tag}${C.reset}${borderCol}${"─".repeat(topFill)}╮${C.reset}`;

		const rows: string[] = [];
		const addLine = (label: string, value: string, valCol = C.reset) => {
			rows.push(`${C.bold}${label}:${C.reset} ${valCol}${sanitizeRenderText(value)}${C.reset}`);
		};

		const details = this.item.details as
			| {
					record?: { fromId: string; targetId: string; source: string; reason: string; note?: string };
					effects?: {
						modifiedFiles?: readonly string[];
						executedCommands?: readonly string[];
						dispatchedTasks?: readonly { id: string; type: string; label?: string }[];
					};
			  }
			| undefined;

		const record = details?.record;
		const effects = details?.effects;

		if (record) {
			addLine("回溯路径", `${record.fromId.slice(0, 8)} ➔ ${record.targetId.slice(0, 8)} [${record.source}]`, C.cyan);
			addLine("决策原因", record.reason, C.white);
			if (record.note) addLine("经验附注", record.note, C.green);
		} else {
			for (const rawLine of sanitizeRenderText(this.item.content).split("\n").slice(0, 4)) {
				rows.push(rawLine);
			}
		}

		if (effects) {
			if (effects.modifiedFiles && effects.modifiedFiles.length > 0) {
				addLine("涉及文件", effects.modifiedFiles.join(", "), C.yellow);
			}
			if (effects.executedCommands && effects.executedCommands.length > 0) {
				addLine("已跑命令", effects.executedCommands.join(", "), C.yellow);
			}
			if (effects.dispatchedTasks && effects.dispatchedTasks.length > 0) {
				addLine("派生任务", effects.dispatchedTasks.map((t) => `${t.type}:${t.id}`).join(", "), C.yellow);
			}
		}

		rows.push(`${C.gray}退出路径已转为只读历史，可用 /history 检视${C.reset}`);

		const body = rows.map((row) => {
			const text = fitLine(stripAnsi(row), innerW, "clip");
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(Math.max(0, innerW - visibleWidth(text)))} ${borderCol}│${C.reset}`;
		});

		const footer = `  ${borderCol}╰${"─".repeat(boxW - 4)}╯${C.reset}`;
		return [header, ...body, footer];
	}

	protected renderFallback(w: number): string[] {
		if (this.item.customType === "session-rewind") {
			return this.renderRewindCard(w);
		}
		const boxW = Math.max(24, Math.min(w, 80));
		const innerW = boxW - 6;
		const tag = `[${this.item.customType}]`;
		const borderCol = C.blue;
		const header = `  ${borderCol}╭─ ${C.bold}${tag}${C.reset}${borderCol} ${"─".repeat(Math.max(2, boxW - visibleWidth(tag) - 7))}╮${C.reset}`;
		const rawLines = sanitizeRenderText(this.item.content + imageNotice(this.item.images))
			.replace(/\r\n/g, "\n")
			.split("\n");
		const bodyLines = rawLines.map((line) => {
			const text = fitLine(stripAnsi(line), innerW, "clip");
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(Math.max(0, innerW - visibleWidth(text)))} ${borderCol}│${C.reset}`;
		});
		const footer = `  ${borderCol}╰${"─".repeat(boxW - 4)}╯${C.reset}`;
		return [header, ...bodyLines, footer];
	}
}

/* ------------------------------------------------------------------ */
/* 4. 结构化错误/告警流线卡片 (方案 A：极简边栏流线风格)                 */
/* ------------------------------------------------------------------ */

/** 诊断与异常信息的结构化领域模型（与终端 ANSI 表现层解耦） */
export interface DiagnosticModel {
	readonly level: "warning" | "error";
	readonly tag: string;
	readonly summary: string;
	readonly details: readonly string[];
}

/** 静态表驱动的常见网络与系统故障诊断提示库 */
const DIAGNOSTIC_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/HTTP\s*401\b/i, "鉴权未通过 · 请检查 API Key"],
	[/HTTP\s*403\b/i, "访问受限 · 请检查权限或代理配置"],
	[/HTTP\s*404\b/i, "资源未找到 · 请核对模型名或 API 端点"],
	[/HTTP\s*429\b/i, "请求频次超限或配额耗尽"],
	[/HTTP\s*5\d\d\b/i, "上游服务暂时故障"],
	[/\bECONNREFUSED\b/i, "连接被拒绝 · 目标服务未启动"],
	[/\bETIMEDOUT\b/i, "网络请求超时"],
];

/** 为单条故障描述注入直观的诊断建议（不重复追加已有提示） */
function enrichDiagnosticHint(text: string): string {
	for (const [regex, hint] of DIAGNOSTIC_HINTS) {
		const keyword = hint.split(" · ")[0]!;
		if (regex.test(text) && !text.includes(keyword)) {
			return `${text} ${C.subtle}(${hint})${C.reset}`;
		}
	}
	return text;
}

/**
 * 结构化解析原始错误或警告消息（纯函数，无 ANSI 副作用，便于单测与跨消费者复用）
 */
export function parseDiagnosticMessage(rawText: string): DiagnosticModel {
	const cleanRaw = sanitizeRenderText(rawText).trim();
	if (!cleanRaw) {
		return { level: "error", tag: "错误", summary: "", details: [] };
	}

	// 1. 剥离无用的外层套娃前缀（如 "✗ ", "[错误] ", "Error: " 等）
	let text = cleanRaw
		.replace(/^(?:[✗⚠*]|\s)+/, "")
		.replace(/^\[(?:错误|ERROR|Error)\]\s*/i, "")
		.replace(/^(?:错误|Error):\s*/i, "");

	// 2. 提取模块徽标 [模块名]
	let tag = "错误";
	const tagMatch = text.match(/^\[([^\]]+)\]\s*/);
	if (tagMatch) {
		tag = tagMatch[1]!.trim();
		text = text.slice(tagMatch[0].length).trim();
	}

	// 消除紧跟其后的重复模块名（如 "[模型目录] 模型目录:"）
	if (tag && text.startsWith(tag)) {
		text = text
			.slice(tag.length)
			.replace(/^[:：\s]+/, "")
			.trim();
	}
	// 规范化通用后缀（如 "模型目录刷新" -> "模型目录"，"命令错误" -> "命令"）
	const displayTag = tag.replace(/(?:刷新|错误|异常|失败)$/, "") || tag;

	// 3. 解析主摘要与子条目
	let summary = text;
	const details: string[] = [];

	if (text.includes("\n")) {
		// 优先尊重显式换行符
		const lines = text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		summary = lines[0] ?? text;
		details.push(...lines.slice(1));
	} else if (
		text.includes("；") &&
		(text.includes("未更新") || text.includes("失败:") || text.includes("失败：") || /\b\d+\/\d+\b/.test(text))
	) {
		// 优先按中文全角分号精确切分条目（避免误切代码或响应体内的英文分号）
		const parts = text
			.split("；")
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length > 1) {
			summary = parts[0]!;
			for (let i = 1; i < parts.length; i++) {
				const part = parts[i]!;
				const cleanPart = part.replace(/^(?:未更新|失败|错误)[:：\s]*/, "");
				if (cleanPart) details.push(cleanPart);
			}
		}
	} else if (text.includes(";") && /(?:;\s*(?:未更新|失败|failed|error))/i.test(text)) {
		// 英文分号仅在携带明确失败关键词前缀时切分
		const parts = text
			.split(";")
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length > 1) {
			summary = parts[0]!;
			for (let i = 1; i < parts.length; i++) {
				const part = parts[i]!;
				const cleanPart = part.replace(/^(?:未更新|失败|错误|failed|error)[:：\s]*/i, "");
				if (cleanPart) details.push(cleanPart);
			}
		}
	}

	// 4. 判定严重级别（奥卡姆剃刀与真实事实：全盘失败 0/N 是致命错误，只有真实部分成功才判定为降级告警）
	const hasPartialSuccess =
		/\b[1-9]\d*\/\d+\b/.test(summary) ||
		(summary.includes("已更新") && !summary.includes("0 家已更新") && !summary.includes("0/"));
	const isDegradedWarning =
		tag.includes("警告") || tag.toUpperCase().includes("WARN") || hasPartialSuccess || summary.includes("部分");

	return {
		level: isDegradedWarning ? "warning" : "error",
		tag: displayTag,
		summary,
		details,
	};
}

/**
 * 格式化会话转录区内的错误/警告卡片（方案 A：极简流线边栏风格）。
 * 针对模型目录刷新、网络错误、命令报错等异常提供高内聚、高可读性的结构化排版与严格不超宽折行。
 */
export function formatErrorCardLines(rawText: string, width = 80): string[] {
	const model = parseDiagnosticMessage(rawText);
	if (!model.summary) return [];

	const accentColor = model.level === "warning" ? C.warning : C.error;
	const icon = model.level === "warning" ? "⚠" : "✗";
	const bar = `${accentColor}│${C.reset}`;
	const badge = `${C.bold}${C.claude}[${model.tag}]${C.reset}`;

	const lines: string[] = [];

	// 1. 首行摘要组装与安全换行（物理宽度绝对防御）
	const inlineLead = `  ${bar} ${accentColor}${icon}${C.reset} ${badge} `;
	const inlineLeadW = visibleWidth(inlineLead);

	const leadPrefix = `  ${bar} ${accentColor}${icon}${C.reset} `;
	const leadPrefixW = visibleWidth(leadPrefix);

	// 若屏幕超窄，行首徽标挤压内容，则首行独立放徽标，次行悬挂内容
	const shouldSplitHeader = width <= inlineLeadW + 6;

	if (shouldSplitHeader) {
		const maxTagW = Math.max(2, width - leadPrefixW - 2);
		const displayTag = visibleWidth(model.tag) > maxTagW ? fitLine(model.tag, maxTagW) : model.tag;
		const safeBadge = `${C.bold}${C.claude}[${displayTag}]${C.reset}`;
		lines.push(`${leadPrefix}${safeBadge}`);

		const contentLead = `  ${bar}   `;
		const contentLeadW = visibleWidth(contentLead);
		const avail = Math.max(1, width - contentLeadW);
		const enriched = model.details.length === 0 ? enrichDiagnosticHint(model.summary) : model.summary;
		const wrapped = wrapLine(`${C.text}${enriched}${C.reset}`, avail);
		for (const w of wrapped) {
			lines.push(`${contentLead}${w}`);
		}
	} else {
		const firstAvail = Math.max(1, width - inlineLeadW);
		const enriched = model.details.length === 0 ? enrichDiagnosticHint(model.summary) : model.summary;
		const wrapped = wrapLine(`${C.text}${enriched}${C.reset}`, firstAvail);

		if (wrapped.length > 0) {
			lines.push(`${inlineLead}${wrapped[0]!}`);
			// 宽屏悬挂对齐（文字整齐垂直对齐），窄屏紧凑缩进（避免空间不足）
			const indentSpaces = width >= 60 ? Math.max(3, inlineLeadW - 3) : 3;
			const subsequentLead = `  ${bar}${" ".repeat(indentSpaces)}`;
			const subLeadW = visibleWidth(subsequentLead);
			const subAvail = Math.max(1, width - subLeadW);
			for (let i = 1; i < wrapped.length; i++) {
				const rewrapped = wrapLine(wrapped[i]!, subAvail);
				for (const rw of rewrapped) {
					lines.push(`${subsequentLead}${rw}`);
				}
			}
		} else {
			lines.push(`${inlineLead}${C.text}${model.summary}${C.reset}`);
		}
	}

	// 2. 详情条目组装与安全换行（支持调用栈平滑排版）
	for (const detail of model.details) {
		const isStackLine = detail.startsWith("at ");
		const enriched = enrichDiagnosticHint(detail);
		const prefix = isStackLine ? `  ${bar}     ` : `  ${bar}   ${C.subtle}•${C.reset} `;
		const subsequentPrefix = `  ${bar}     `;
		const prefixW = visibleWidth(prefix);
		const subPrefixW = visibleWidth(subsequentPrefix);
		const avail = Math.max(1, width - prefixW);
		const subAvail = Math.max(1, width - subPrefixW);

		const textToWrap = isStackLine ? `${C.subtle}${enriched}${C.reset}` : enriched;
		const wrapped = wrapLine(textToWrap, avail);
		if (wrapped.length > 0) {
			lines.push(`${prefix}${wrapped[0]!}`);
			for (let i = 1; i < wrapped.length; i++) {
				const rewrapped = wrapLine(wrapped[i]!, subAvail);
				for (const rw of rewrapped) {
					lines.push(`${subsequentPrefix}${rw}`);
				}
			}
		}
	}

	// 垂直节奏空行与全行物理宽度硬保证
	lines.push("");
	return lines.map((l) => (visibleWidth(l) > width ? fitLine(l, width, "clip") : l));
}
