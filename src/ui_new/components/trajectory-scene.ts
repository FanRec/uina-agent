/**
 * 全屏审计轨迹看板 (TrajectoryScene)。
 *
 * 核心特性（复刻 dsh-TUI Trajectory 架构）：
 * 1. 双视图模式：
 *    - 时间线 (Timeline)：顶部余弦/密度能量波形带 (WaveBand) + 事件账本流 (Ledger) + 详情检查器 (Inspector)；
 *    - 性能热点 (Hotspot)：按工具与事件类别聚合，按耗时、Tokens 或错误率排序 Top 瓶颈；
 * 2. 余弦/时间密度波形带 (WaveBand)：将整场会话投影为 2 行 Unicode 字符柱 ( ▂▃▄▅▆▇█)，指示光标当前时段；
 * 3. 详情检查器 (Inspector)：展示精准毫秒级时间戳、耗时、Token 明细、入参 JSON 语法高亮与错误堆栈，支持 Enter 全屏最大化；
 * 4. 快捷排障动作：支持 e / E 快速前后跳转报错节点。
 */

import { C, visibleWidth, truncateToWidth, getContentBoxWidth } from "../core/utils.js";
import { highlightCode } from "./syntax-text.js";

export type TrajectoryNodeKind =
	| "turn_start"
	| "thinking"
	| "tool_call"
	| "model_stream"
	| "compaction"
	| "error"
	| "system";

export type TrajectoryNodeStatus = "running" | "completed" | "failed";

export interface TrajectoryNode {
	id: string;
	turn?: number;
	kind: TrajectoryNodeKind;
	label: string;
	status: TrajectoryNodeStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	tokens?: {
		input?: number;
		output?: number;
		total?: number;
	};
	argsJson?: string;
	resultPreview?: string;
	error?: string;
}

export interface HotspotRow {
	kind: TrajectoryNodeKind;
	name: string;
	count: number;
	totalDurationMs: number;
	avgDurationMs: number;
	totalTokens: number;
	errors: number;
}

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

/**
 * 余弦/密度能量波形带投影器 (WaveBand)
 */
export function projectWaveBand(nodes: TrajectoryNode[], width: number, cursorIndex: number): string[] {
	if (width <= 0) return ["", ""];
	if (nodes.length === 0) {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}

	const GLYPHS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const minTime = nodes[0]!.startedAt;
	const maxTime = Math.max(...nodes.map((n) => n.endedAt ?? n.startedAt), minTime + 1);
	const totalSpan = Math.max(1, maxTime - minTime);

	// 将全会话切分为 width 根时间柱
	const colNodes: TrajectoryNode[][] = Array.from({ length: width }, () => []);
	let cursorCol = 0;

	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		const midTime = (n.startedAt + (n.endedAt ?? n.startedAt)) / 2;
		const col = Math.min(width - 1, Math.max(0, Math.floor(((midTime - minTime) / totalSpan) * width)));
		colNodes[col]!.push(n);
		if (i === cursorIndex) {
			cursorCol = col;
		}
	}

	const line1Chars: string[] = [];
	const line2Chars: string[] = [];

	for (let col = 0; col < width; col++) {
		const list = colNodes[col]!;
		const count = list.length;
		const hasError = list.some((n) => n.status === "failed");
		const hasTool = list.some((n) => n.kind === "tool_call");
		const isCursor = col === cursorCol;

		let charColor = C.cyan;
		if (hasError) {
			charColor = C.red;
		} else if (hasTool) {
			charColor = C.yellow;
		}

		if (count === 0) {
			if (isCursor) {
				line1Chars.push(`${C.glowWhite}│${C.reset}`);
				line2Chars.push(`${C.glowWhite}▲${C.reset}`);
			} else {
				line1Chars.push(`${C.gray}·${C.reset}`);
				line2Chars.push(" ");
			}
			continue;
		}

		// 根据节点数与总耗时计算能量高度 (1 ~ 8)
		const heightVal = Math.min(8, Math.max(1, count * 2));
		const glyph = GLYPHS[heightVal]!;

		if (isCursor) {
			line1Chars.push(`\x1b[7m\x1b[1m${glyph}\x1b[0m`);
			line2Chars.push(`${C.glowWhite}▲${C.reset}`);
		} else {
			line1Chars.push(`${charColor}${glyph}${C.reset}`);
			line2Chars.push(`${C.dim}▂${C.reset}`);
		}
	}

	return [line1Chars.join(""), line2Chars.join("")];
}

/**
 * 轨迹事件状态存储单例 (TrajectoryStore)
 */
export class TrajectoryStore {
	private nodes: TrajectoryNode[] = [];
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {}
		}
	}

	list(): TrajectoryNode[] {
		return this.nodes;
	}

	get(id: string): TrajectoryNode | undefined {
		return this.nodes.find((n) => n.id === id);
	}

	record(options: {
		id?: string;
		turn?: number;
		kind: TrajectoryNodeKind;
		label: string;
		status?: TrajectoryNodeStatus;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		tokens?: { input?: number; output?: number; total?: number };
		argsJson?: string;
		resultPreview?: string;
		error?: string;
	}): TrajectoryNode {
		const node: TrajectoryNode = {
			id: options.id ?? `node-${this.nodes.length + 1}`,
			turn: options.turn,
			kind: options.kind,
			label: options.label,
			status: options.status ?? "completed",
			startedAt: options.startedAt ?? Date.now(),
			endedAt: options.endedAt,
			durationMs: options.durationMs,
			tokens: options.tokens,
			argsJson: options.argsJson,
			resultPreview: options.resultPreview,
			error: options.error,
		};
		if (!node.durationMs && node.endedAt && node.startedAt) {
			node.durationMs = node.endedAt - node.startedAt;
		}
		this.nodes.push(node);
		this.notify();
		return node;
	}

	completeNode(id: string, options: { endedAt?: number; durationMs?: number; status?: TrajectoryNodeStatus; resultPreview?: string; error?: string }): void {
		const node = this.nodes.find((n) => n.id === id);
		if (!node) return;
		if (options.endedAt) node.endedAt = options.endedAt;
		if (options.durationMs !== undefined) node.durationMs = options.durationMs;
		else if (node.endedAt) node.durationMs = node.endedAt - node.startedAt;
		if (options.status) node.status = options.status;
		if (options.resultPreview) node.resultPreview = options.resultPreview;
		if (options.error) node.error = options.error;
		this.notify();
	}

	aggregate(sortBy: "duration" | "tokens" | "errors" = "duration"): HotspotRow[] {
		const map = new Map<string, HotspotRow>();

		for (const n of this.nodes) {
			const key = `${n.kind}:${n.label}`;
			const existing = map.get(key);
			const dur = n.durationMs ?? (n.endedAt ? n.endedAt - n.startedAt : 0);
			const tok = n.tokens?.total ?? ((n.tokens?.input ?? 0) + (n.tokens?.output ?? 0));
			const err = n.status === "failed" ? 1 : 0;

			if (existing) {
				existing.count++;
				existing.totalDurationMs += dur;
				existing.avgDurationMs = Math.round(existing.totalDurationMs / existing.count);
				existing.totalTokens += tok;
				existing.errors += err;
			} else {
				map.set(key, {
					kind: n.kind,
					name: n.label,
					count: 1,
					totalDurationMs: dur,
					avgDurationMs: dur,
					totalTokens: tok,
					errors: err,
				});
			}
		}

		const rows = Array.from(map.values());
		if (sortBy === "duration") {
			rows.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
		} else if (sortBy === "tokens") {
			rows.sort((a, b) => b.totalTokens - a.totalTokens);
		} else if (sortBy === "errors") {
			rows.sort((a, b) => b.errors - a.errors);
		}
		return rows;
	}

	loadSampleData(): void {
		this.nodes = [];
		const now = Date.now() - 45000;

		// 1. 用户提问
		this.record({
			id: "step-1",
			turn: 1,
			kind: "turn_start",
			label: "用户提问：请帮我排查并发死锁与性能瓶颈",
			status: "completed",
			startedAt: now,
			endedAt: now + 50,
			durationMs: 50,
		});

		// 2. 深度思考
		this.record({
			id: "step-2",
			turn: 1,
			kind: "thinking",
			label: "DeepSeek-R1 深度推理 (思考链剖析)",
			status: "completed",
			startedAt: now + 100,
			endedAt: now + 3200,
			durationMs: 3100,
			resultPreview: "深入分析锁依赖图，推演事务超时与两阶段锁竞争路径...",
		});

		// 3. 快速工具调用 (grep_search)
		this.record({
			id: "step-3",
			turn: 1,
			kind: "tool_call",
			label: "grep_search",
			status: "completed",
			startedAt: now + 3300,
			endedAt: now + 3420,
			durationMs: 120,
			argsJson: `{"Query":"FOR UPDATE","SearchPath":"src/dao"}`,
			resultPreview: "匹配到 8 处悲观锁持有语句",
		});

		// 4. 慢速工具调用 (run_command 长测试)
		this.record({
			id: "step-4",
			turn: 1,
			kind: "tool_call",
			label: "run_command",
			status: "completed",
			startedAt: now + 3600,
			endedAt: now + 11200,
			durationMs: 7600,
			argsJson: `{"CommandLine":"pnpm test:concurrency --timeout=10000"}`,
			resultPreview: "并发吞吐量 1800 op/s，检测到 1 处重试重试冲突",
		});

		// 5. 异常报错工具调用
		this.record({
			id: "step-5",
			turn: 1,
			kind: "tool_call",
			label: "view_file",
			status: "failed",
			startedAt: now + 11300,
			endedAt: now + 11350,
			durationMs: 50,
			argsJson: `{"AbsolutePath":"e:/Uina/Uina/src/invalid_lock.ts"}`,
			error: "ENOENT: no such file or directory, open 'e:/Uina/Uina/src/invalid_lock.ts'",
		});

		// 6. 回复文本流与 Token 消耗
		this.record({
			id: "step-6",
			turn: 1,
			kind: "model_stream",
			label: "模型回复流生成 (deepseek-reasoner)",
			status: "completed",
			startedAt: now + 11400,
			endedAt: now + 15800,
			durationMs: 4400,
			tokens: { input: 1250, output: 2890, total: 4140 },
			resultPreview: "已完成死锁链排查，核心瓶颈在于 order.ts 与 inventory.ts 锁顺序倒置。",
		});

		// 7. 会话压缩 (Compaction)
		this.record({
			id: "step-7",
			turn: 1,
			kind: "compaction",
			label: "会话自动压缩释放上下文 (∴)",
			status: "completed",
			startedAt: now + 16000,
			endedAt: now + 16300,
			durationMs: 300,
			resultPreview: "压缩释放 14.2k tokens 上下文空间",
		});
	}
}

/**
 * 全屏审计轨迹看板组件 (TrajectoryScene)
 */
export class TrajectoryScene {
	private store: TrajectoryStore;
	private view: "timeline" | "hotspot" = "timeline";
	private cursor = 0;
	private hotspotSort: "duration" | "tokens" | "errors" = "duration";
	private maximizedInspector = false;

	constructor(store: TrajectoryStore) {
		this.store = store;
	}

	getView(): "timeline" | "hotspot" {
		return this.view;
	}

	getCursor(): number {
		return this.cursor;
	}

	getNodes(): TrajectoryNode[] {
		return this.store.list();
	}

	getFocusedNode(): TrajectoryNode | undefined {
		const nodes = this.getNodes();
		return nodes[this.cursor];
	}

	turnView(delta: number): void {
		const views: Array<"timeline" | "hotspot"> = ["timeline", "hotspot"];
		const idx = views.indexOf(this.view);
		this.view = views[(idx + delta + views.length) % views.length]!;
	}

	toggleMaximize(): void {
		this.maximizedInspector = !this.maximizedInspector;
	}

	isMaximized(): boolean {
		return this.maximizedInspector;
	}

	navigateUp(): void {
		const total = this.view === "timeline" ? this.getNodes().length : this.store.aggregate(this.hotspotSort).length;
		if (total === 0) return;
		this.cursor = (this.cursor - 1 + total) % total;
	}

	navigateDown(): void {
		const total = this.view === "timeline" ? this.getNodes().length : this.store.aggregate(this.hotspotSort).length;
		if (total === 0) return;
		this.cursor = (this.cursor + 1) % total;
	}

	setCursor(index: number): void {
		const total = this.getNodes().length;
		if (index >= 0 && index < total) {
			this.cursor = index;
		}
	}

	seekError(forward = true): boolean {
		const nodes = this.getNodes();
		if (nodes.length === 0) return false;
		const dir = forward ? 1 : -1;
		let check = this.cursor + dir;
		while (check >= 0 && check < nodes.length) {
			if (nodes[check]!.status === "failed") {
				this.cursor = check;
				return true;
			}
			check += dir;
		}
		// 环形折返寻找
		check = forward ? 0 : nodes.length - 1;
		while (check !== this.cursor) {
			if (nodes[check]!.status === "failed") {
				this.cursor = check;
				return true;
			}
			check += dir;
		}
		return false;
	}

	formatLines(terminalWidth = 80, terminalHeight = 24): string[] {
		const boxWidth = getContentBoxWidth(terminalWidth - 4);
		const innerW = boxWidth - 4;
		const borderCol = C.gray;
		const nodes = this.getNodes();
		const focusedNode = this.getFocusedNode();

		// 1. 顶边框与右上角 ✕ 退出按钮
		const titleTag = `─ 全屏审计轨迹 (Trajectory) `;
		const exitTag = ` ✕ ─`;
		const fillCount = Math.max(1, boxWidth - 2 - visibleWidth(titleTag) - visibleWidth(exitTag));
		const topLine = `  ${borderCol}╭${titleTag}${"─".repeat(fillCount)}${exitTag}╮${C.reset}`;

		// 2. 全局统计指标行
		const totalNodes = nodes.length;
		const errorCount = nodes.filter((n) => n.status === "failed").length;
		const totalDur = nodes.reduce((sum, n) => sum + (n.durationMs ?? 0), 0);
		const totalTokens = nodes.reduce((sum, n) => sum + (n.tokens?.total ?? 0), 0);

		const metricsBar = `  ${C.bold}会话节点:${C.reset} ${totalNodes}    ${C.bold}总耗时:${C.reset} ${formatDuration(totalDur)}    ${C.bold}Tokens:${C.reset} ${totalTokens || "—"}    ${errorCount > 0 ? `${C.red}${C.bold}错误:${C.reset} ${errorCount} 处${C.reset}` : `${C.dim}错误: 0${C.reset}`}`;
		const dividerLine = `  ${borderCol}├${"─".repeat(boxWidth - 2)}┤${C.reset}`;

		const wrapRow = (text: string) => {
			const pad = Math.max(0, innerW - visibleWidth(text));
			return `  ${borderCol}│${C.reset} ${text}${" ".repeat(pad)} ${borderCol}│${C.reset}`;
		};

		// 3. 视图切换 Tab 栏 (Timeline vs Hotspot)
		const tabTimeline = this.view === "timeline" ? `\x1b[7m\x1b[1m 时间线 (Timeline) \x1b[0m` : `${C.dim} 时间线 (Timeline) ${C.reset}`;
		const tabHotspot = this.view === "hotspot" ? `\x1b[7m\x1b[1m 性能热点 (Hotspot) \x1b[0m` : `${C.dim} 性能热点 (Hotspot) ${C.reset}`;
		const tabRow = `  ${tabTimeline} ${borderCol}│${C.reset} ${tabHotspot}    ${C.dim}(按 Tab 或 ←/→ 切换)${C.reset}`;

		// 4. 中间内容区 (Timeline 模式含 WaveBand + Ledger；Hotspot 模式含性能排名)
		const mainContentLines: string[] = [];

		if (!this.maximizedInspector) {
			if (this.view === "timeline") {
				// 4.1 WaveBand (能量柱波形带)
				const waveLines = projectWaveBand(nodes, innerW - 4, this.cursor);
				mainContentLines.push(wrapRow(`  ${C.dim}【余弦密度能量波形带 · 全会话投影】${C.reset}`));
				mainContentLines.push(wrapRow(`  ${waveLines[0]}`));
				mainContentLines.push(wrapRow(`  ${waveLines[1]}`));
				mainContentLines.push(wrapRow(`  ${C.gray}${"─".repeat(innerW - 4)}${C.reset}`));

				// 4.2 Ledger (事件步骤账本流)
				if (nodes.length === 0) {
					mainContentLines.push(wrapRow(`  ${C.dim}当前会话尚未记录审计事件节点${C.reset}`));
				} else {
					// 渲染可见的 Ledger 条目 (最多显示 5~6 行)
					const visibleRows = 5;
					const startIdx = Math.max(0, Math.min(this.cursor - Math.floor(visibleRows / 2), nodes.length - visibleRows));
					const sliceNodes = nodes.slice(startIdx, startIdx + visibleRows);

					for (let i = 0; i < sliceNodes.length; i++) {
						const actualIdx = startIdx + i;
						const n = sliceNodes[i]!;
						const isFocused = actualIdx === this.cursor;

						let glyph = "●";
						let glyphCol = C.cyan;
						if (n.status === "failed") {
							glyph = "✗";
							glyphCol = C.red;
						} else if (n.kind === "tool_call") {
							glyph = "🛠";
							glyphCol = C.yellow;
						} else if (n.kind === "thinking") {
							glyph = "⌁";
							glyphCol = C.dim;
						} else if (n.kind === "compaction") {
							glyph = "∴";
							glyphCol = C.blue;
						}

						const prefix = isFocused ? `${C.bold}${C.glowWhite}❯ ` : "  ";
						const idTag = `${C.dim}[#${actualIdx + 1}]${C.reset}`;
						const labelStyled = isFocused ? `${C.bold}${C.cyan}${n.label}${C.reset}` : `${n.label}`;
						const durText = n.durationMs ? `${C.gray}·${C.reset} ${C.dim}${formatDuration(n.durationMs)}${C.reset}` : "";
						const tokText = n.tokens?.total ? `${C.gray}·${C.reset} ${C.dim}${n.tokens.total} tok${C.reset}` : "";

						const lineText = `${prefix}${glyphCol}${glyph}${C.reset} ${idTag} ${labelStyled} ${durText} ${tokText}`;
						mainContentLines.push(wrapRow(truncateToWidth(lineText, innerW)));
					}
				}
			} else {
				// 4.3 Hotspot (性能瓶颈热点排序)
				mainContentLines.push(wrapRow(`  ${C.bold}${C.cyan}▼ 性能热点聚合分析 (Top Bottlenecks · 按总耗时倒序)${C.reset}`));
				const hotspots = this.store.aggregate(this.hotspotSort);

				if (hotspots.length === 0) {
					mainContentLines.push(wrapRow(`  ${C.dim}暂无聚合热点数据${C.reset}`));
				} else {
					for (let i = 0; i < Math.min(6, hotspots.length); i++) {
						const h = hotspots[i]!;
						const isFocused = i === this.cursor;
						const prefix = isFocused ? `${C.bold}${C.glowWhite}❯ ` : "  ";
						const rankTag = `${C.bold}#${i + 1}${C.reset}`;
						const nameStyled = isFocused ? `${C.bold}${C.cyan}${h.name}${C.reset}` : `${C.bold}${h.name}${C.reset}`;
						const stats = `${C.gray}·${C.reset} ${C.dim}调用 ${h.count}次${C.reset} ${C.gray}·${C.reset} ${C.yellow}总耗时 ${formatDuration(h.totalDurationMs)}${C.reset} ${C.gray}·${C.reset} ${C.dim}均耗时 ${formatDuration(h.avgDurationMs)}${C.reset} ${h.errors > 0 ? `${C.red}(${h.errors}次错误)${C.reset}` : ""}`;

						mainContentLines.push(wrapRow(truncateToWidth(`${prefix}${rankTag} ${nameStyled} ${stats}`, innerW)));
					}
				}
			}
		}

		// 5. 下半部：详情检查器 (Inspector Pane)
		const inspectorLines: string[] = [];
		const inspectorTitle = focusedNode
			? `【详情检查器 · #${this.cursor + 1} ${focusedNode.label}】`
			: `【详情检查器】`;
		const inspectorHeader = `  ${this.maximizedInspector ? `${C.bold}${C.cyan}▼ ${inspectorTitle} (全屏放大模式)${C.reset}` : `${C.bold}${C.cyan}▼ ${inspectorTitle}${C.reset}`}`;
		inspectorLines.push(wrapRow(inspectorHeader));

		const inspectorRowBudget = this.maximizedInspector ? Math.max(10, terminalHeight - 10) : 5;

		if (!focusedNode) {
			inspectorLines.push(wrapRow(`  ${C.dim}暂无选中节点${C.reset}`));
			while (inspectorLines.length < inspectorRowBudget) {
				inspectorLines.push(wrapRow(""));
			}
		} else {
			inspectorLines.push(wrapRow(`    ${C.dim}事件类型:${C.reset} ${focusedNode.kind}    ${C.dim}状态:${C.reset} ${focusedNode.status === "failed" ? `${C.red}失败 (failed)${C.reset}` : `${C.green}成功 (completed)${C.reset}`}    ${C.dim}启动时间:${C.reset} ${formatTime(focusedNode.startedAt)}`));
			if (focusedNode.durationMs) {
				inspectorLines.push(wrapRow(`    ${C.dim}耗时:${C.reset} ${formatDuration(focusedNode.durationMs)}    ${focusedNode.tokens ? `${C.dim}Tokens:${C.reset} ${focusedNode.tokens.total} (in ${focusedNode.tokens.input ?? 0} · out ${focusedNode.tokens.output ?? 0})` : ""}`));
			}
			if (focusedNode.argsJson) {
				inspectorLines.push(wrapRow(`    ${C.dim}入参 JSON:${C.reset} ${highlightCode(focusedNode.argsJson, "json")}`));
			}
			if (focusedNode.resultPreview) {
				inspectorLines.push(wrapRow(`    ${C.gray}⎿ 返回产物:${C.reset} ${C.dim}${focusedNode.resultPreview}${C.reset}`));
			}
			if (focusedNode.error) {
				inspectorLines.push(wrapRow(`    ${C.red}⎿ 异常报错:${C.reset} ${C.red}${focusedNode.error}${C.reset}`));
			}

			while (inspectorLines.length < inspectorRowBudget) {
				inspectorLines.push(wrapRow(""));
			}
		}

		// 6. 底部操作指引
		const maxTip = this.maximizedInspector ? "Enter 恢复双屏" : "Enter 全屏详情";
		const hintText = `${C.dim}↑/↓ 移动 · ←/→ 切视图 · ${maxTip} · ${C.bold}${C.red}e/E${C.reset}${C.dim} 搜寻错误 · ${C.bold}Esc${C.reset}${C.dim} 退出${C.reset}`;
		const hintLine = wrapRow(hintText);

		// 7. 底边框
		const botLine = `  ${borderCol}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`;

		if (this.maximizedInspector) {
			return [
				topLine,
				`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
				wrapRow(metricsBar),
				dividerLine,
				wrapRow(tabRow),
				dividerLine,
				...inspectorLines,
				dividerLine,
				hintLine,
				botLine,
			];
		}

		return [
			topLine,
			`  ${borderCol}│${" ".repeat(innerW + 2)}│${C.reset}`,
			wrapRow(metricsBar),
			dividerLine,
			wrapRow(tabRow),
			dividerLine,
			...mainContentLines,
			dividerLine,
			...inspectorLines,
			dividerLine,
			hintLine,
			botLine,
		];
	}
}
