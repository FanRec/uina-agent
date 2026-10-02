/**
 * 上下文检视器（ContextInspectorOverlay）——"谁在影响模型上下文"的只读展示面。
 *
 * 遵循无状态 View 规范：不缓存事实，每次渲染实时拉取——
 * - 回合边界事实（系统提示词全文 + prepare 注入）来自 UIHost 缓存的 context_prepare 事件；
 * - 每请求改写与 auxiliary 登记经 ContextIntelPort 实时直读聚合层；
 * - custom_message 清单经 SessionAccess 只读查询。
 * 零注入显式标"（无）"而不是隐藏段落——"零注入"本身是要看到的事实。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";
import type { HostEvent, InjectionProvenance } from "../../../host/events.js";
import type { SessionAccess } from "../../../session/types.js";
import type { AuxiliaryGroup } from "../../adapters/context-intel.js";

type ContextPrepareEvent = Extract<HostEvent, { type: "context_prepare" }>;

export interface ContextInspectorDeps {
	getPrepare: () => ContextPrepareEvent | undefined;
	getTransformInjections: () => readonly InjectionProvenance[];
	getAuxiliarySummary: () => readonly AuxiliaryGroup[];
	sessionPort?: SessionAccess;
}

/** 内容区可见行数（不含标题行与提示行）。 */
const CONTENT_ROWS = 22;
/** 明细清单最多展开的条目数（超出的折叠为计数行）。 */
const MAX_DETAIL_ROWS = 8;

export class ContextInspectorOverlay implements Component, Focusable {
	focused = true;
	private scrollOffset = 0;
	private lastWidth = 80;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(private readonly deps: ContextInspectorDeps) {}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return;
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onClose?.();
			this.onRequestRender?.();
			return;
		}
		const bodyRows = this.bodyRowCount();
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.min(Math.max(0, bodyRows - CONTENT_ROWS), this.scrollOffset + 1);
		} else if (matchesKey(data, Key.pageup)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - CONTENT_ROWS);
		} else if (matchesKey(data, Key.pagedown)) {
			this.scrollOffset = Math.min(Math.max(0, bodyRows - CONTENT_ROWS), this.scrollOffset + CONTENT_ROWS);
		} else {
			return;
		}
		this.onRequestRender?.();
	}

	invalidate(): void {}

	render(terminalWidth = 80): string[] {
		this.lastWidth = terminalWidth;
		const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 100));
		const innerW = boxWidth - 6;
		const border = C.gray;
		const rows = this.bodyRows(innerW);
		const maxOffset = Math.max(0, rows.length - CONTENT_ROWS);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visible = rows.slice(this.scrollOffset, this.scrollOffset + CONTENT_ROWS);

		const titleTag = `─ 上下文检视器 ${this.turnLabel()} `;
		const topFill = Math.max(1, boxWidth - 4 - visibleWidth(titleTag));
		const output: string[] = [`  ${border}╭${C.bold}${titleTag}${C.reset}${border}${"─".repeat(topFill)}╮${C.reset}`];

		const cell = (text: string): string => {
			const clipped = truncateToWidth(text, innerW, "…");
			return `${clipped}${" ".repeat(Math.max(0, innerW - visibleWidth(clipped)))}`;
		};
		for (const row of visible) {
			output.push(`  ${border}│${C.reset} ${cell(row)} ${border}│${C.reset}`);
		}
		for (let pad = visible.length; pad < CONTENT_ROWS; pad++) {
			output.push(`  ${border}│${C.reset} ${" ".repeat(innerW)} ${border}│${C.reset}`);
		}

		const hint =
			rows.length > CONTENT_ROWS
				? `↑/↓ 滚动 · PgUp/PgDn 翻页 ${this.scrollOffset + 1}-${Math.min(rows.length, this.scrollOffset + CONTENT_ROWS)}/${rows.length} · Esc 关闭`
				: `Esc 关闭`;
		const hintText = truncateToWidth(hint, Math.max(1, boxWidth - 8), "…");
		const hintFill = Math.max(1, boxWidth - 6 - visibleWidth(hintText));
		output.push(`  ${border}╰─ ${C.dim}${hintText}${C.reset}${border}${"─".repeat(hintFill)}╯${C.reset}`);
		return output;
	}

	/** 与滚动上限共用同一投影：行数分母不能和实际渲染分叉。 */
	private bodyRowCount(): number {
		return this.bodyRows(Math.max(48, Math.min((this.lastWidth || 80) - 6, 100) - 6)).length;
	}

	private turnLabel(): string {
		const prepare = this.deps.getPrepare();
		return prepare ? `[回合 ${prepare.turnNumber}]` : "[尚无回合]";
	}

	/** 正文行投影（每次渲染实时构建）；四段各自单一职责，段序即阅读序。 */
	private bodyRows(innerW: number): string[] {
		return [
			...this.promptSection(innerW),
			...this.prepareSection(),
			...this.transformSection(),
			...this.durableSection(),
		];
	}

	private section(title: string, rows: string[]): string[] {
		return ["", `${C.bold}${C.suggestion}▸ ${title}${C.reset}`, ...rows];
	}

	private empty(): string {
		return `${C.inactive}（无）${C.reset}`;
	}

	private promptSection(innerW: number): string[] {
		const prepare = this.deps.getPrepare();
		if (!prepare) return this.section("系统提示词（本回合最终生效）", [this.empty()]);
		const contributors = prepare.injections.filter((item) => item.kind === "systemPrompt");
		const rows = [
			`${C.text}${prepare.systemPrompt.length}${C.reset} 字符 · 贡献者 ${
				contributors.length === 0 ? `${C.inactive}仅基座${C.reset}` : `${C.text}${contributors.length}${C.reset} 个改写`
			}`,
		];
		for (const item of contributors) {
			rows.push(`  ${C.suggestion}${item.extension}${C.reset} · 改写 · ${item.chars} 字符`);
		}
		for (const line of hardWrap(prepare.systemPrompt, innerW)) {
			rows.push(`${C.dim}${line}${C.reset}`);
		}
		return this.section("系统提示词（本回合最终生效）", rows);
	}

	private prepareSection(): string[] {
		const prepare = this.deps.getPrepare();
		const injections = (prepare?.injections ?? []).filter((item) => item.kind !== "systemPrompt");
		const rows = injections.length === 0 ? [this.empty()] : injections.map(formatInjection);
		return this.section("本回合注入（turn.prepare）", rows);
	}

	private transformSection(): string[] {
		const transform = this.deps.getTransformInjections();
		if (transform.length === 0) return this.section("每请求改写（transformContext · 最近一次请求）", [this.empty()]);
		const rows = transform.slice(-MAX_DETAIL_ROWS).map(formatInjection);
		if (transform.length > MAX_DETAIL_ROWS) {
			rows.push(`${C.inactive}…仅显示最近 ${MAX_DETAIL_ROWS} / ${transform.length} 步${C.reset}`);
		}
		return this.section("每请求改写（transformContext · 最近一次请求）", rows);
	}

	private durableSection(): string[] {
		const rows: string[] = [];
		const messages = this.customMessageSummary();
		if (messages === undefined) {
			rows.push(`custom_message: ${this.empty()}`);
		} else {
			rows.push(`${C.text}${messages.total}${C.reset} 条 custom_message`);
			for (const item of messages.latest) {
				rows.push(`  ${C.inactive}#${item.seq}${C.reset} ${C.dim}${item.preview}${C.reset}`);
			}
		}
		const auxiliary = this.deps.getAuxiliarySummary();
		if (auxiliary.length === 0) {
			rows.push(`auxiliary: ${this.empty()}`);
		} else {
			for (const group of auxiliary.slice(0, MAX_DETAIL_ROWS)) {
				rows.push(`  ${C.suggestion}${group.label}${C.reset} ×${group.count}`);
			}
			if (auxiliary.length > MAX_DETAIL_ROWS) {
				rows.push(`${C.inactive}…共 ${auxiliary.length} 类${C.reset}`);
			}
		}
		return this.section("持久自定义信息", rows);
	}

	/** custom_message 清单（主线 canonical）；无 sessionPort 的消费者返回 undefined。 */
	private customMessageSummary(): { total: number; latest: readonly { seq: number; preview: string }[] } | undefined {
		if (!this.deps.sessionPort) return undefined;
		const nodes = this.deps.sessionPort.list({ scope: "main" }).nodes.filter((node) => node.kind === "custom_message");
		return {
			total: nodes.length,
			latest: nodes.slice(-3).map((node) => ({ seq: node.seq, preview: node.preview })),
		};
	}
}

function formatInjection(item: InjectionProvenance): string {
	const who = `${C.suggestion}${item.extension}${C.reset}`;
	switch (item.kind) {
		case "messages":
			return `${who} · ${item.messageCount ?? 0} 条消息 · ${item.chars} 字符 · ${C.dim}${item.preview}${C.reset}`;
		case "systemPrompt":
			return `${who} · 改写系统提示词 · ${item.chars} 字符`;
		case "model":
			return `${who} · 切换模型 · ${C.dim}${item.preview}${C.reset}`;
		case "thinkingLevel":
			return `${who} · 思考档位 · ${C.dim}${item.preview}${C.reset}`;
		default:
			return `${who} · 投影改写 · ${item.preview}`;
	}
}

/** 按可见宽度硬折行（检视器宽度小于提示词行宽时保内容不丢失）。 */
function hardWrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length === 0) {
			out.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const ch of rawLine) {
			const charWidth = visibleWidth(ch);
			if (currentWidth + charWidth > width && current.length > 0) {
				out.push(current);
				current = ch;
				currentWidth = charWidth;
			} else {
				current += ch;
				currentWidth += charWidth;
			}
		}
		out.push(current);
	}
	return out;
}
