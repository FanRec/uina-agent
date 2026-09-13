/**
 * 只读会话历史与分支检视器（BranchInspectorOverlay）。
 * 遵循无状态 View 规范：状态唯一归属 SessionStore / SessionAccess，
 * 本组件只管理视图光标与滚动位置，完全只读拉取，杜绝状态污染。
 */

import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, stripAnsi, visibleWidth, truncateToWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { listAllSessionNodes } from "../../../session/navigation.js";
import type { SessionAccess, SessionNodeInfo, HydratedSessionEntry } from "../../../session/types.js";

type ViewMode = "main" | "branch-list" | "branch-history";

/** Visible list rows; combined with the engine budget this matches the other dashboards. */
const LIST_ROWS = 13;

export class BranchInspectorOverlay implements Component, Focusable {
	focused = true;
	private selectedIndex = 0;
	private detailScrollOffset = 0;
	// 翻页要按实际列宽算详情行数，否则 X/Y 与渲染出来的行数会对不上。
	private lastWidth = 80;
	private focusTarget: "list" | "detail" = "list";
	private viewMode: ViewMode = "main";
	private selectedBranchId: string | null = null;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(private readonly sessionPort: SessionAccess) {}

	private nodes(): SessionNodeInfo[] {
		if (this.viewMode === "main") return listAllSessionNodes(this.sessionPort, { scope: "main" });
		if (this.viewMode === "branch-history" && this.selectedBranchId && this.sessionPort.readBranch) return this.sessionPort.readBranch(this.selectedBranchId).nodes;
		if (this.sessionPort.listBranches) return this.sessionPort.listBranches().branches.map((b) => ({ id:b.id, parentId:b.targetId, seq:0, kind:"rewind", active:false, canRewind:false, preview:`分支 ${b.id.slice(0,6)} · ${b.nodeCount} 节点 · ${b.reason}` }));
		return listAllSessionNodes(this.sessionPort, { scope: "all" }).filter((n) => !n.active);
	}


	private moveSelection(delta: number, maxIndex: number): void {
		this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + delta));
		this.detailScrollOffset = 0;
	}

	handleInput(data: string): void {
		const nodes = this.nodes();

		if (matchesKey(data, Key.escape)) {
			if (this.viewMode === "branch-history") { this.viewMode = "branch-list"; this.selectedBranchId = null; this.selectedIndex = 0; this.onRequestRender?.(); return; }
			this.onClose?.(); this.onRequestRender?.(); return;
		}

		if (matchesKey(data, Key.tab)) {
			this.focusTarget = this.focusTarget === "list" ? "detail" : "list";
			this.onRequestRender?.();
			return;
		}

		// ←/→ 的语义取决于焦点，这不是可选的润色而是提示文案已经承诺的行为：
		// 底部写着「←→ 翻页详情 X/Y」时，按键必须真的翻页。
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const forward = matchesKey(data, Key.right);
			if (this.focusTarget === "detail") {
				const maxOffset = Math.max(0, this.detailRowCount() - LIST_ROWS);
				this.detailScrollOffset = Math.max(0, Math.min(maxOffset, this.detailScrollOffset + (forward ? LIST_ROWS : -LIST_ROWS)));
			} else {
				this.viewMode = this.viewMode === "main" ? "branch-list" : "main";
				this.selectedBranchId = null;
				this.selectedIndex = 0;
				this.detailScrollOffset = 0;
			}
			this.onRequestRender?.();
			return;
		}
		if (data === "\r" && this.viewMode === "branch-list" && this.sessionPort.listBranches) {
			const branches = this.sessionPort.listBranches().branches;
			if (branches[this.selectedIndex]) { this.selectedBranchId = branches[this.selectedIndex].id; this.viewMode = "branch-history"; this.selectedIndex = 0; this.detailScrollOffset = 0; this.onRequestRender?.(); return; }
		}

		if (matchesKey(data, Key.up)) {
			if (this.focusTarget === "list") this.moveSelection(-1, Math.max(0, nodes.length - 1));
			else this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
		} else if (matchesKey(data, Key.down)) {
			if (this.focusTarget === "list") this.moveSelection(1, Math.max(0, nodes.length - 1));
			else this.detailScrollOffset++;
		}
		this.onRequestRender?.();
	}

	/** 详情行数。渲染与翻页共用同一投影，X/Y 才不会和实际能翻的页数脱节。 */
	private detailRowCount(): number {
		const nodes = this.nodes();
		const selectedIndex = nodes.length === 0 ? -1 : Math.min(Math.max(0, this.selectedIndex), nodes.length - 1);
		const entry = selectedIndex < 0 ? null : this.tryReadEntry(nodes[selectedIndex]!.id);
		return formatNodeDetails(entry, this.detailWidth()).length;
	}

	private detailWidth(): number {
		const boxWidth = Math.max(54, Math.min((this.lastWidth || 80) - 6, 96));
		const splitBudget = boxWidth - 8;
		const leftW = Math.max(12, Math.floor(splitBudget * 0.45));
		return Math.max(8, splitBudget - leftW);
	}

	private tryReadEntry(id: string): HydratedSessionEntry | null {
		try {
			return this.sessionPort.read(id);
		} catch {
			return null;
		}
	}

	invalidate(): void {}

	render(terminalWidth = 80): string[] {
		// Same frame geometry as the sibling dashboards (trajectory / tasks / subagents).
		this.lastWidth = terminalWidth;
		const boxWidth = Math.max(54, Math.min(terminalWidth - 6, 96));
		const innerW = boxWidth - 6;
		const border = C.gray;
		const nodes = this.nodes();
		const selectedIndex = nodes.length === 0 ? -1 : Math.min(Math.max(0, this.selectedIndex), nodes.length - 1);

		// Split rows carry one extra separator and two padding spaces: leftW + rightW = boxWidth - 8.
		const splitBudget = boxWidth - 8;
		const leftW = Math.max(12, Math.floor(splitBudget * 0.45));
		const rightW = Math.max(8, splitBudget - leftW);

		// Columns, 1-based: 1-2 indent, 3 left rule, 4 space, 5.. left pane, middle rule, space,
		// right pane, space, right rule on boxWidth.
		const colMid = leftW + 5;
		const colRight = boxWidth;
		// The vertical rules are placed by absolute column (CHA) instead of being carried along
		// by padding arithmetic. Padding can only be right for one width policy, and the host
		// font — not us — decides it: a CJK fallback renders an East Asian Ambiguous glyph
		// (● ○ ◆ ◧ ▸ ⟲ ❯ ← → ·) two cells wide while visibleWidth measures one, so every rule
		// after one slides a cell on exactly the rows that contain one. The left rule never
		// shows it because the row's own indent anchors it — the reported "left is fine, middle
		// and right zigzag". CHA pins each rule to its own cell column, so the frame is straight
		// under either policy, and content that overruns is overwritten rather than shifted.
		const cha = (col: number): string => `\x1b[${col}G`;

		const cell = (text: string, width: number): string => padTo(truncateToWidth(stripAnsi(text), width, ""), width);
		// Every separator carries its own colour. Emitting a bare "│" after a reset let it
		// inherit the terminal default instead of the frame colour, so the middle line and the
		// right border rendered in different colours than the left one — a visibly broken frame
		// even though all three sat on the same column.
		const rule = `${border}│${C.reset}`;
		const output: string[] = [];
		const contentRow = (content: string, style = ""): string =>
			`  ${rule} ${style}${cell(content, innerW)}${C.reset} ${cha(colRight)}${rule}`;
		const splitRow = (left: string, right: string): string =>
			`  ${rule} ${cell(left, leftW)}${cha(colMid)}${rule} ${cell(right, rightW)} ${cha(colRight)}${rule}`;

		const titleTag = `─ 会话历史与分支检视器 [${this.viewMode === "main" ? "主线" : this.viewMode === "branch-list" ? "分支选择 [只读分支]" : "分支历史（只读）"}] `;
		output.push(`  ${border}╭${titleTag}${"─".repeat(Math.max(1, boxWidth - 4 - visibleWidth(titleTag)))}${cha(colRight)}${border}╮${C.reset}`);

		const help = `${this.viewMode === "main" ? "当前主线" : this.viewMode === "branch-list" ? "选择要查看的分支" : "废弃分支（只读）"} · ${nodes.length} 节点 · [←/→] 切换视图 [Tab] 焦点 ${this.focusTarget} [↑/↓] 移动 [Esc] 关闭`;
		output.push(contentRow(help, C.dim));
		output.push(`  ${border}├${"─".repeat(boxWidth - 4)}${cha(colRight)}${border}┤${C.reset}`);

		// The pane labels are coloured, so this row is built directly: running it through cell()
		// would strip the pane colours along with everything else, and passing it as a plain
		// string would leave the middle rule uncoloured.
		const paneLabel = (label: string, width: number): string => {
			const text = truncateToWidth(label, width, "");
			return `${C.bold}${C.claude}${text}${C.reset}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
		};
		output.push(`  ${rule} ${paneLabel("会话节点", leftW)}${cha(colMid)}${rule} ${paneLabel("节点详情", rightW)} ${cha(colRight)}${rule}`);
		// The cross must land on the same column as the body separator: the left dash run covers
		// the pane plus the space before the separator, the right run covers pane plus its space.
		output.push(`  ${border}├${"─".repeat(leftW + 1)}${cha(colMid)}${border}┼${"─".repeat(rightW + 2)}${cha(colRight)}${border}┤${C.reset}`);

		let selectedEntry: HydratedSessionEntry | null = null;
		// 与 detailRowCount() 走同一个读取路径：X/Y 的分母不能和实际渲染分叉。
		if (selectedIndex >= 0) selectedEntry = this.tryReadEntry(nodes[selectedIndex]!.id);

		const leftRows = formatNodeList(nodes, selectedIndex, leftW);
		const rightRows = formatNodeDetails(selectedEntry, rightW);
		const maxOffset = Math.max(0, rightRows.length - LIST_ROWS);
		this.detailScrollOffset = Math.min(this.detailScrollOffset, maxOffset);
		const visibleDetail = rightRows.slice(this.detailScrollOffset, this.detailScrollOffset + LIST_ROWS);

		for (let row = 0; row < LIST_ROWS; row++) {
			output.push(splitRow(leftRows[row] ?? "", visibleDetail[row] ?? ""));
		}

		// The bottom border must read as one continuous line, mirroring the title row: an inline
		// label with dashes filling the space on either side of it. Padding the hint cell out to
		// leftW with blanks left the whole left half of the frame with no bottom edge, and the
		// pane divider is terminated by a "┴" — a full-height "│" crossed the border line and
		// made it look broken at that column.
		const hint = rightRows.length > LIST_ROWS
			? `←→ 翻页详情 ${this.detailScrollOffset + 1}/${maxOffset + 1} · Esc 关闭`
			: `↑/↓ 移动 · Esc 关闭`;
		// Reserve at least one dash, one space and the corner either side of the junction.
		const hintText = truncateToWidth(hint, Math.max(1, colMid - 8), "");
		const leadFill = Math.max(1, colMid - 7 - visibleWidth(hintText));
		const tailFill = Math.max(1, boxWidth - 1 - colMid);
		output.push(`  ${border}╰${border}─ ${C.dim}${hintText} ${C.reset}${border}${"─".repeat(leadFill)}${cha(colMid)}${border}┴${border}${"─".repeat(tailFill)}${cha(colRight)}${border}╯${C.reset}`);
		return output;
	}
}

function padTo(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function formatNodeList(
	nodes: SessionNodeInfo[],
	selectedIndex: number,
	width: number,
): string[] {
	if (nodes.length === 0) return [`${C.dim}(当前筛选无节点)${C.reset}`];

	const windowStart = Math.max(0, Math.min(selectedIndex - Math.floor(LIST_ROWS / 2), Math.max(0, nodes.length - LIST_ROWS)));
	const rows: string[] = [];
	for (let i = windowStart; i < Math.min(nodes.length, windowStart + LIST_ROWS); i++) {
		const node = nodes[i]!;
		const isSelected = i === selectedIndex;
		const pointer = isSelected ? `${C.bold}${C.cyan}❯${C.reset}` : " ";
		const dot = node.active ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
		const kind = node.kind === "rewind"
			? `${C.warning}⟲${C.reset}`
			: node.kind === "compaction"
				? `${C.blue}◧${C.reset}`
				: node.kind === "input"
					? `${C.briefLabelYou}▸${C.reset}`
					: `${C.claude}◆${C.reset}`;
		// Session content is untrusted for rendering: it carries newlines, ANSI and control
		// characters. Collapse it to a single line before measuring, or one message destroys
		// the frame the same way a multi-line label would.
		const preview = sanitizeRenderText(node.preview).replace(/[\r\n\t]+/g, " ");
		const body = `${dot} ${kind} ${C.dim}#${node.seq}${C.reset} ${C.inactive}${node.id.slice(0, 6)}${C.reset} ${preview}`;
		const prefix = `${pointer} `;
		rows.push(`${prefix}${truncateToWidth(stripAnsi(body), width - visibleWidth(prefix), "")}`);
	}
	return rows;
}

function formatNodeDetails(entry: HydratedSessionEntry | null, width: number): string[] {
	if (!entry) return [`${C.dim}(未选中任何节点)${C.reset}`];

	const label = (name: string, value: string): string => `${C.dim}${name}:${C.reset} ${value}`;
	const rows: string[] = [
		label("节点", `${C.claude}${entry.id}${C.reset}`),
		label("父级", `${entry.parentId ?? "(根节点)"}`),
		label("序号", `${C.dim}#${entry.seq}${C.reset}  类型 ${entry.kind}`),
		label("时间", `${C.dim}${entry.timestamp}${C.reset}`),
	];

	if (entry.kind === "rewind") {
		rows.push(`${C.warning}── 回溯记录 ──${C.reset}`);
		rows.push(label("目标", entry.record.targetId));
		rows.push(label("原位置", entry.record.fromId));
		rows.push(label("来源", entry.record.source));
		rows.push(...wrapPlain(label("原因", entry.record.reason), width));
		if (entry.record.summary) rows.push(...wrapPlain(label("摘要", entry.record.summary), width));
		if (entry.effects) {
			if (entry.effects.modifiedFiles.length > 0) {
				rows.push(...wrapPlain(label("修改文件", entry.effects.modifiedFiles.join(", ")), width));
			}
			if (entry.effects.executedCommands.length > 0) {
				rows.push(...wrapPlain(label("执行命令", entry.effects.executedCommands.join(", ")), width));
			}
			if (entry.effects.dispatchedTasks.length > 0) {
				rows.push(...wrapPlain(label("派生任务", entry.effects.dispatchedTasks.map((task) => `${task.type}:${task.id}`).join(", ")), width));
			}
		}
		return rows;
	}

	if (entry.kind === "message") {
		const message = entry.message;
		rows.push(`${C.claude}── 对话消息 [${message.role}] ──${C.reset}`);
		for (const line of plainLines(message.content)) {
			rows.push(...wrapPlain(line, width));
		}
		if (message.role === "assistant" && message.tool_calls?.length) {
			rows.push(`${C.dim}工具调用 (${message.tool_calls.length})${C.reset}`);
			for (const call of message.tool_calls) {
				rows.push(...wrapPlain(`${C.cyan}${call.name}${C.reset}(${JSON.stringify(call.args ?? {})})`, width));
			}
		}
		return rows;
	}

	if (entry.kind === "compaction") {
		rows.push(`${C.blue}── 历史压缩摘要 ──${C.reset}`);
		rows.push(label("保留尾部", `${entry.retainedTail.length} 条消息`));
		rows.push(label("压缩前", `${entry.tokensBefore} tokens`));
		rows.push(...wrapPlain(entry.summary, width));
		return rows;
	}

	if (entry.kind === "input") {
		rows.push(`${C.briefLabelYou}── 输入 ──${C.reset}`);
		rows.push(label("模式", entry.input.mode));
		rows.push(label("来源", entry.input.source?.type ?? "user"));
		rows.push(...wrapPlain(entry.input.text, width));
		return rows;
	}

	if (entry.kind === "custom_message") {
		rows.push(`${C.inactive}── 扩展内容 [${entry.customType}] ──${C.reset}`);
		rows.push(...wrapPlain(entry.content, width));
	}

	return rows;
}

function plainLines(text: string): string[] {
	return stripAnsi(String(text)).split("\n");
}

/** Wraps already-styled text by visible width without emitting an over-wide row. */
function wrapPlain(text: string, width: number): string[] {
	const plain = stripAnsi(text);
	if (visibleWidth(plain) <= width) return [text];
	const rows: string[] = [];
	let rest = plain;
	while (rest.length > 0 && rows.length < 6) {
		let cut = Math.min(rest.length, width);
		while (cut > 1 && visibleWidth(rest.slice(0, cut)) > width) cut--;
		rows.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) rows.push("…");
	return rows;
}


