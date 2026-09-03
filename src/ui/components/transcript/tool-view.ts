/**
 * 工具调用状态与结果卡片组件（复刻 Claude Code / dsh-TUI 完整封闭细线卡片）。
 * 特性：
 * 1. 运行中显示动态呼吸状态；
 * 2. 完成后原地闭合为带有顶边框、内容与底边框的纯净独立卡片；
 * 3. 超长输出折叠首屏 6 行，单行截断，支持右下角耗时徽章。
 */

import type { Component } from "../../core/types.js";
import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../../core/utils.js";

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
			const errText = typeof obj.error === "string" ? obj.error.replace(/\r/g, "").trim() : "";
			if (errText) {
				isError = true;
				bodyLines.push(`${C.red}✗ 错误: ${errText.slice(0, 100)}${C.reset}`);
			}
			if (typeof obj.stderr === "string" && obj.stderr.trim()) {
				const lines = obj.stderr.split(/\r?\n/).map((s) => s.replace(/\r/g, "").trimEnd()).filter(Boolean);
				for (const l of lines.slice(0, 4)) {
					bodyLines.push(`${C.red}  ${l.slice(0, 120)}${C.reset}`);
				}
			}
			if (typeof obj.stdout === "string" && obj.stdout.trim()) {
				const lines = obj.stdout.split(/\r?\n/).map((s) => s.replace(/\r/g, "").trimEnd()).filter(Boolean);
				for (const l of lines.slice(0, 6)) {
					bodyLines.push(`${C.gray}  ${l.slice(0, 120)}${C.reset}`);
				}
			}
			if (bodyLines.length === 0 && !errText && !("stdout" in obj) && !("stderr" in obj)) {
				const keys = Object.keys(obj)
					.slice(0, 3)
					.map((k) => `${k}: ${String(obj![k]).replace(/\r/g, "").slice(0, 30)}`)
					.join(", ");
				if (keys) bodyLines.push(`${C.dim}  ${keys}${C.reset}`);
			}
			if (bodyLines.length === 0) {
				bodyLines.push(`${C.dim}  (执行完成，无输出)${C.reset}`);
			}
		}
	} else {
		const raw = String(result).replace(/\r/g, "").trim();
		if (raw) {
			const lines = raw.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean);
			for (const l of lines.slice(0, 6)) {
				bodyLines.push(`${C.gray}  ${l.slice(0, 120)}${C.reset}`);
			}
		}
		if (bodyLines.length === 0) {
			bodyLines.push(`${C.dim}  (执行完成，无输出)${C.reset}`);
		}
	}

	// ─────────────────────────────────────────────────────────────
	// 1. 卡片顶边框：┌─ ✓ [工具] ${name} ────────────────────────┐
	// ─────────────────────────────────────────────────────────────
	const statusIcon = isError ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
	const topTag = `  ${C.gray}┌─ ${statusIcon} ${C.iceBlue}[工具] ${name}${C.reset} `;
	const topTagW = visibleWidth(topTag);
	const topFillLen = Math.max(1, cardWidth - topTagW - 1);
	const topLine = `${topTag}${C.gray}${"─".repeat(topFillLen)}┐${C.reset}`;

	const output: string[] = [topLine];

	// ─────────────────────────────────────────────────────────────
	// 2. 卡片内部内容行：│  ...                                 │
	// ─────────────────────────────────────────────────────────────
	const innerW = cardWidth - 6; // 左右各空 1 格加边框与前导 2 格空格
	for (const rawLine of bodyLines) {
		const cleanLine = rawLine.replace(/\r/g, "");
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
	const botFillLen = Math.max(1, cardWidth - badgeW - 7);
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

	invalidate(): void {}
}
