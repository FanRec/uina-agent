/**
 * 单子智能体全屏审查详情页组件（完整复刻 dsh-TUI SubagentDetailScene 视觉规范）。
 *
 * 特性：
 * 1. 顶栏固定身份与耗时元数据：状态指示灯、任务描述、模型/路由、起止时间戳、Token 明细与错误警示；
 * 2. 三大 Tab 标签页轮播切换：
 *    - 摘要 (summary)：两栏式属性网格 (StatGrid) 与最终结论/产物摘要；
 *    - 输出 (output)：全量事件流日志（思考链 ⌁、系统日志、流式输出、tail -f 自动吸底）；
 *    - 工具 (tools)：工具调用明细卡片（参数 JSON 语法着色、耗时统计、返回值预览与报错分析）；
 * 3. 实时交互控制：运行中按 X 键原地中断 (Interrupt)；
 * 4. 键盘导航：←/→ 翻页，↑/↓ 滚动日志，Esc 返回一级看板。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../core/utils.js";
import type { SubagentState } from "./subagent-dashboard.js";
import { highlightCode } from "./syntax-text.js";

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const min = Math.floor(ms / 60000);
	const sec = Math.floor((ms % 60000) / 1000);
	return `${min}m${sec}s`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

export type DetailTab = "summary" | "output" | "tools";

export class SubagentDetailScene {
	private subagent: SubagentState;
	private activeTab: DetailTab = "summary";
	private scrollOffsets: Record<DetailTab, number> = { summary: 0, output: 0, tools: 0 };
	private onInterruptCallback?: (agentId: string) => void;

	constructor(subagent: SubagentState, onInterrupt?: (agentId: string) => void) {
		this.subagent = subagent;
		this.onInterruptCallback = onInterrupt;
	}

	setSubagent(subagent: SubagentState): void {
		this.subagent = subagent;
	}

	getSubagent(): SubagentState {
		return this.subagent;
	}

	getActiveTab(): DetailTab {
		return this.activeTab;
	}

	turnPage(delta: number): void {
		const tabs: DetailTab[] = ["summary", "output", "tools"];
		const curIdx = tabs.indexOf(this.activeTab);
		const nextIdx = (curIdx + delta + tabs.length) % tabs.length;
		this.activeTab = tabs[nextIdx]!;
	}

	scrollUp(delta = 3): void {
		this.scrollOffsets[this.activeTab] = Math.max(0, this.scrollOffsets[this.activeTab] - delta);
	}

	scrollDown(delta = 3): void {
		this.scrollOffsets[this.activeTab] = this.scrollOffsets[this.activeTab] + delta;
	}

	interrupt(): void {
		if (this.onInterruptCallback) {
			this.onInterruptCallback(this.subagent.agentId);
		}
	}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		const boxWidth = getContentBoxWidth(terminalWidth - 4);
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const isRunning = this.subagent.status === "running" || this.subagent.status === "starting";
		const elapsed = this.subagent.completedAt ? this.subagent.completedAt - this.subagent.startedAt : Date.now() - this.subagent.startedAt;
		const totalTokens = this.subagent.tokens?.total ?? ((this.subagent.tokens?.input ?? 0) + (this.subagent.tokens?.output ?? 0) || 0);

		// 1. 顶边框
		const titleTag = `─ 子智能体审查 (Subagent Detail) `;
		const exitTag = ` ✕ ─`;
		const fillCount = Math.max(1, boxWidth - 2 - visibleWidth(titleTag) - visibleWidth(exitTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(fillCount)}${exitTag}╮${C.reset}`;

		// 2. 身份与状态行
		let statusGlyph = "🟢";
		let statusLabel = "已完成 (done)";
		let statusColor = C.green;
		if (isRunning) {
			statusGlyph = "🟡";
			statusLabel = "运行中 (running)";
			statusColor = C.yellow;
		} else if (this.subagent.status === "failed") {
			statusGlyph = "🔴";
			statusLabel = "失败 (failed)";
			statusColor = C.red;
		} else if (this.subagent.status === "cancelled") {
			statusGlyph = "🔴";
			statusLabel = "已手动中断 (cancelled)";
			statusColor = C.red;
		}

		const headerTitle = `  ${statusGlyph} ${C.bold}${this.subagent.description}${C.reset} · ${statusColor}${statusLabel}${C.reset}`;
		const headerMeta = `     ${C.dim}模型:${C.reset} ${this.subagent.model ?? "default"}  ${C.gray}·${C.reset}  ${C.dim}耗时:${C.reset} ${formatDuration(elapsed)}  ${C.gray}·${C.reset}  ${C.dim}Tokens:${C.reset} ${totalTokens || "—"}  ${C.gray}·${C.reset}  ${C.dim}工具调用:${C.reset} ${this.subagent.toolCalls.length}次`;
		const headerTime = `     ${C.dim}启动于:${C.reset} ${formatTime(this.subagent.startedAt)}${this.subagent.completedAt ? `  ${C.gray}·${C.reset}  ${C.dim}完成于:${C.reset} ${formatTime(this.subagent.completedAt)}` : ""}  ${C.gray}·${C.reset}  ${C.dim}ID:${C.reset} ${C.dim}${this.subagent.agentId}${C.reset}`;

		const wrapRow = (text: string) => {
			const pad = Math.max(0, innerW - visibleWidth(text));
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(pad)} ${borderCol}│${C.reset}`;
		};

		const headerLines = [
			wrapRow(truncateToWidth(headerTitle, innerW)),
			wrapRow(truncateToWidth(headerMeta, innerW)),
			wrapRow(truncateToWidth(headerTime, innerW)),
		];

		if (this.subagent.error) {
			headerLines.push(wrapRow(truncateToWidth(`     ${C.red}✗ 报错详情: ${this.subagent.error}${C.reset}`, innerW)));
		}

		// 3. Tab 标签栏 (summary / output / tools)
		const tabItems: Array<{ id: DetailTab; label: string }> = [
			{ id: "summary", label: "摘要 (Summary)" },
			{ id: "output", label: "事件日志 (Output)" },
			{ id: "tools", label: "工具明细 (Tools)" },
		];
		const tabSegments: string[] = [];
		for (let i = 0; i < tabItems.length; i++) {
			const item = tabItems[i]!;
			const isActive = item.id === this.activeTab;
			if (isActive) {
				tabSegments.push(`\x1b[7m\x1b[1m ${item.label} \x1b[0m`);
			} else {
				tabSegments.push(`${C.dim} ${item.label} ${C.reset}`);
			}
		}
		const tabIndexText = `${tabItems.findIndex((t) => t.id === this.activeTab) + 1}/${tabItems.length}`;
		const tabBar = `  ${tabSegments.join(` ${borderCol}│${C.reset} `)}    ${C.dim}${tabIndexText}${C.reset}`;
		const dividerLine = `  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`;

		// 4. Tab 主体内容组装
		const bodyRawLines: string[] = [];

		if (this.activeTab === "summary") {
			// 网格统计
			bodyRawLines.push(`  ${C.bold}${C.cyan}─ 运行属性网格 (StatGrid) ────────────────────────────────${C.reset}`);
			bodyRawLines.push(`  ${C.dim}状态:${C.reset}          ${statusColor}${statusLabel}${C.reset}`);
			bodyRawLines.push(`  ${C.dim}模型/路由:${C.reset}     ${this.subagent.model ?? "default"}`);
			bodyRawLines.push(`  ${C.dim}运行耗时:${C.reset}     ${formatDuration(elapsed)}`);
			bodyRawLines.push(`  ${C.dim}Token 消耗:${C.reset}   ${totalTokens || "—"} ${this.subagent.tokens?.input !== undefined ? `(输入 ${this.subagent.tokens.input} · 输出 ${this.subagent.tokens.output ?? 0})` : ""}`);
			bodyRawLines.push(`  ${C.dim}工具调用数:${C.reset}   ${this.subagent.toolCalls.length} 次`);
			bodyRawLines.push(`  ${C.dim}启动时间:${C.reset}     ${formatTime(this.subagent.startedAt)}`);
			if (this.subagent.completedAt) {
				bodyRawLines.push(`  ${C.dim}完成时间:${C.reset}     ${formatTime(this.subagent.completedAt)}`);
			}
			bodyRawLines.push("");

			// 最终成果总结
			bodyRawLines.push(`  ${C.bold}${C.cyan}─ 最终成果摘要 (Summary) ─────────────────────────────────${C.reset}`);
			if (this.subagent.summary) {
				for (const sLine of this.subagent.summary.split("\n")) {
					bodyRawLines.push(`  ${sLine}`);
				}
			} else {
				bodyRawLines.push(isRunning ? `  ${C.dim}子智能体正在持续推演分析中，尚未产出最终总结...${C.reset}` : `  ${C.dim}未记录总结摘要内容${C.reset}`);
			}
		} else if (this.activeTab === "output") {
			// 事件流输出
			if (this.subagent.outputEvents.length === 0 && this.subagent.output.length === 0) {
				bodyRawLines.push(`  ${C.dim}暂无输出日志事件${C.reset}`);
			} else {
				for (const ev of this.subagent.outputEvents) {
					if (ev.kind === "thinking") {
						bodyRawLines.push(`  ${C.dim}⌁ thinking: ${ev.text}${C.reset}`);
					} else if (ev.kind === "error") {
						bodyRawLines.push(`  ${C.red}✗ error: ${ev.text}${C.reset}`);
					} else if (ev.kind === "system") {
						bodyRawLines.push(`  ${C.dim}ℹ system: ${ev.text}${C.reset}`);
					} else {
						bodyRawLines.push(`  ${C.glowWhite}${ev.text}${!ev.settled && isRunning ? " ▍" : ""}${C.reset}`);
					}
				}
			}
		} else if (this.activeTab === "tools") {
			// 工具调用明细
			if (this.subagent.toolCalls.length === 0) {
				bodyRawLines.push(`  ${C.dim}该子智能体尚未调用任何工具${C.reset}`);
			} else {
				for (let i = 0; i < this.subagent.toolCalls.length; i++) {
					const tool = this.subagent.toolCalls[i]!;
					const toolStatusGlyph = tool.status === "running" ? `${C.yellow}· 运行中${C.reset}` : tool.status === "failed" ? `${C.red}× 失败${C.reset}` : `${C.green}✓ 成功${C.reset}`;
					const toolElapsed = tool.endedAt ? formatDuration(tool.endedAt - tool.startedAt) : "";

					bodyRawLines.push(`  ${C.bold}${C.glowWhite}#${i + 1} 🛠 ${tool.name}${C.reset}  ${toolStatusGlyph}  ${C.dim}${toolElapsed}${C.reset}`);

					if (tool.argsPreview) {
						bodyRawLines.push(`    ${C.dim}入参:${C.reset} ${highlightCode(tool.argsPreview, "json")}`);
					}
					if (tool.resultPreview) {
						bodyRawLines.push(`    ${C.gray}⎿ 返回:${C.reset} ${C.dim}${tool.resultPreview}${C.reset}`);
					}
					if (tool.error) {
						bodyRawLines.push(`    ${C.red}⎿ 错误:${C.reset} ${C.red}${tool.error}${C.reset}`);
					}
					bodyRawLines.push("");
				}
			}
		}

		// 视口截取与滚动
		const visibleBodyRows = Math.max(6, Math.min(14, terminalHeight - 12));
		// 如果在 output 且处于运行中，默认 tail -f 吸底
		if (this.activeTab === "output" && isRunning) {
			this.scrollOffsets.output = Math.max(0, bodyRawLines.length - visibleBodyRows);
		}

		const maxScroll = Math.max(0, bodyRawLines.length - visibleBodyRows);
		const effScroll = Math.max(0, Math.min(this.scrollOffsets[this.activeTab], maxScroll));
		const slicedBody = bodyRawLines.slice(effScroll, effScroll + visibleBodyRows);

		// 补足空行保持稳定盒高
		while (slicedBody.length < visibleBodyRows) {
			slicedBody.push("");
		}

		const renderedBodyLines = slicedBody.map((l) => wrapRow(truncateToWidth(l, innerW)));

		// 5. 底部操作指引行
		let interruptTip = "";
		if (isRunning && this.onInterruptCallback) {
			interruptTip = ` · ${C.bold}${C.yellow}X 中断运行${C.reset}`;
		}
		const hintText = `${C.dim}←/→ 切换分页 · ↑/↓ 滚动${interruptTip}${C.dim} · ${C.bold}Esc/Enter${C.reset}${C.dim} 返回看板${C.reset}`;
		const hintLine = wrapRow(hintText);

		// 6. 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;

		return [
			topLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			...headerLines,
			dividerLine,
			wrapRow(tabBar),
			dividerLine,
			...renderedBodyLines,
			dividerLine,
			hintLine,
			botLine,
		];
	}
}
