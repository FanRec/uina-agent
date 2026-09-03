/**
 * 工具调用状态与结果卡片组件（复刻 Claude Code / dsh-TUI 完整封闭细线卡片）。
 * 特性：
 * 1. 运行中显示动态呼吸状态；
 * 2. 完成后原地闭合为带有顶边框、内容与底边框的纯净独立卡片；
 * 3. 超长输出折叠首屏 6 行，单行截断，支持右下角耗时徽章。
 */

import type { Component } from "../core/types.js";
import { C, visibleWidth, truncateToWidth, wrapTextWithAnsi, getContentBoxWidth } from "../core/utils.js";

export function formatToolCardLines(
	name: string,
	result: string,
	elapsedMs: number,
	width = 80,
): string[] {
	const cardWidth = getContentBoxWidth(width - 4);
	const t = elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`;

	let obj: Record<string, unknown> | null = null;
	try {
		obj = JSON.parse(result) as Record<string, unknown>;
	} catch {
		obj = null;
	}

	const bodyLines: string[] = [];
	let isError = false;

	if (obj && typeof obj === "object") {
		if (obj.cancelled) {
			bodyLines.push(`${C.yellow}⚠ 操作已取消${C.reset}`);
		} else {
			const errText = typeof obj.error === "string" ? obj.error : "";
			if (errText) {
				isError = true;
				bodyLines.push(`${C.red}✗ 错误: ${errText.slice(0, 100)}${C.reset}`);
			}
			if (typeof obj.stderr === "string" && obj.stderr.trim()) {
				for (const l of obj.stderr.trim().split("\n").slice(0, 4)) {
					bodyLines.push(`${C.red}  ${l.slice(0, 120)}${C.reset}`);
				}
			}
			if (typeof obj.stdout === "string" && obj.stdout.trim()) {
				for (const l of obj.stdout.trim().split("\n").slice(0, 6)) {
					bodyLines.push(`${C.gray}  ${l.slice(0, 120)}${C.reset}`);
				}
			}
			if (!errText && !("stdout" in obj) && !("stderr" in obj)) {
				const keys = Object.keys(obj)
					.slice(0, 3)
					.map((k) => `${k}: ${String(obj![k]).slice(0, 30)}`)
					.join(", ");
				bodyLines.push(`${C.dim}  ${keys}${C.reset}`);
			}
		}
	} else {
		const raw = String(result).trim();
		if (raw) {
			for (const l of raw.split("\n").slice(0, 6)) {
				bodyLines.push(`${C.gray}  ${l.slice(0, 120)}${C.reset}`);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────
	// 1. 卡片顶边框：┌─ ✓ [工具] ${name} ────────────────────────┐
	// ─────────────────────────────────────────────────────────────
	const statusIcon = isError ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
	const headerTag = `┌─ ${statusIcon} ${C.iceBlue}[工具] ${name}${C.reset} `;
	const topTagW = visibleWidth(headerTag);
	const topFillLen = Math.max(1, cardWidth - topTagW - 1);
	const topLine = `  ${C.gray}${headerTag}${"─".repeat(topFillLen)}┐${C.reset}`;

	const output: string[] = [topLine];

	// ─────────────────────────────────────────────────────────────
	// 2. 卡片内部内容行：│  ...                                 │
	// ─────────────────────────────────────────────────────────────
	const innerW = cardWidth - 4;
	for (const rawLine of bodyLines) {
		const cleanLine = rawLine.replace(/\r$/, "");
		const truncated = truncateToWidth(cleanLine, innerW, "");
		const lineW = visibleWidth(truncated);
		const pad = Math.max(0, innerW - lineW);
		output.push(`  ${C.gray}│${C.reset} ${truncated}${" ".repeat(pad)} ${C.gray}│${C.reset}`);
	}

	// ─────────────────────────────────────────────────────────────
	// 3. 卡片底边框：└────────────────────────────────── 1.2s ──┘
	// ─────────────────────────────────────────────────────────────
	const badge = `${t}`;
	const badgeW = visibleWidth(badge);
	const botFillLen = Math.max(1, cardWidth - badgeW - 5);
	const botLine = `  ${C.gray}└${"─".repeat(botFillLen)} ${badge} ─┘${C.reset}`;
	output.push(botLine);

	return output;
}

export class ActiveToolComponent implements Component {
	private name = "";
	private args: unknown = null;
	private active = false;

	start(name: string, args: unknown): void {
		this.name = name;
		this.args = args;
		this.active = true;
	}

	clear(): void {
		this.active = false;
		this.name = "";
		this.args = null;
	}

	render(width: number): string[] {
		if (!this.active) return [];
		const cardWidth = getContentBoxWidth(width - 4);
		let argStr = "";
		try {
			argStr = JSON.stringify(this.args ?? {});
		} catch {
			argStr = String(this.args);
		}
		if (argStr === "{}") argStr = "";
		const shortArg = argStr.length > 36 ? `${argStr.slice(0, 33)}…` : argStr;

		const topTag = `  ${C.gray}┌─ ${C.yellow}⏳${C.reset} ${C.iceBlue}[工具] ${this.name}${C.reset} ${C.dim}${shortArg}${C.reset} `;
		const topTagW = visibleWidth(topTag);
		const topFillLen = Math.max(2, cardWidth - topTagW - 1);
		const topLine = `${topTag}${C.gray}${"─".repeat(topFillLen)}┐${C.reset}`;

		const botLine = `  ${C.gray}└${"─".repeat(cardWidth - 3)}┘${C.reset}`;
		return [topLine, botLine];
	}
}
