import { imageNotice } from "../../../core/content.js";
import { wrapLine } from "../../layout/fit.js";

/**
 * 会话转录区容器（TranscriptContainer）。
 * 集中管理用户轮次、思考流、助手 Markdown 回复、工具调用、差异比对、压缩卡片与扩展自定义消息。
 * 自身实现 Component 契约，支持动态根据可用列宽完整重流。
 */

import type { ToolResultStatus } from "../../../core/types.js";
import type {
	CustomMessage,
	MarkdownTransformer,
	MessageRenderer,
	ToolRenderer,
} from "../../../extensions/ui-contract.js";
import type { PresentationNode, ToolNode, TurnNode } from "../../../presentation/projection.js";
import type { PromptSnapshotRecord } from "../../../session/prompt-snapshots.js";
import { projectInputMessage } from "../../../session/recovery.js";
import type { SessionEntry } from "../../../session/types.js";
import type { Component } from "../../core/types.js";
import { C, stripAnsi } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import {
	type CompactionCardData,
	CustomMessageComponent,
	formatCompactionCardLines,
	formatErrorCardLines,
	formatThinkingLines,
} from "./cards.js";
import {
	ContextCardComponent,
	type ContextCardData,
	type ExternalContextCardData,
	type PromptContextCardData,
} from "./context-card.js";
import { formatDiffCardLines } from "./diff-view.js";
import { SmoothRevealController } from "./smooth-reveal.js";
import { formatFullMarkdown } from "./stream-markdown.js";
import { formatToolCardLines } from "./tool-view.js";

export interface ToolRecord {
	name: string;
	result: string;
	/** journal 两端时间都已知时才存在；未知保持 undefined，不补 0。 */
	elapsedMs?: number;
}

export interface DiffRecord {
	oldText: string;
	newText: string;
	filename: string;
	collapsed?: boolean;
}

export type TurnItem =
	| {
			kind: "thinking";
			text: string;
			collapsed?: boolean;
			/** 块级身份。一个轮次可以有多个思考块（thinking → 工具 → thinking），
			 * 折叠状态与 hover 必须落在块上；落在轮次上会让整轮的思考一起亮、一起展开。 */
			uid: number;
	  }
	| { kind: "text"; text: string }
	| {
			kind: "tool";
			name: string;
			args?: unknown;
			result?: string;
			images?: import("../../../core/content.js").ImageContent[];
			details?: unknown;
			status: "running" | ToolResultStatus;
			elapsedMs?: number;
			startedAt?: number;
			callId?: string;
			collapsed?: boolean;
	  }
	| {
			kind: "diff";
			oldText: string;
			newText: string;
			filename: string;
			collapsed?: boolean;
	  }
	| {
			kind: "interrupt";
			text: string;
	  }
	| {
			/** 轮内到达的扩展自定义消息：journal 只有 entry 序没有轮归属，live 按时间序
			 * 归入当前轮，回放路径按轮间独立卡片重建——两者都是 journal 时间序。 */
			kind: "customMessage";
			message: CustomMessage;
	  }
	| { kind: "contextCard"; card: ContextCardData; expanded?: boolean };

/** 单个思考块。折叠与 hover 的身份单位。 */
export type ThinkingItem = Extract<TurnItem, { kind: "thinking" }>;

export interface TurnRecord {
	n: number;
	/** 由容器签发的唯一票据。n 来自展示投影的 `TurnNode.turn`（恢复与实时同一来源）；
	 * 缺节点的恢复缺口沿用最近轮号。凡是把轮次当键的地方——hover、块缓存、失效集合、
	 * typewriter、滚动定位、导航轨——一律用 uid，n 只作为显示用的轮次编号。 */
	readonly uid: number;
	userText: string;
	userImages?: readonly import("../../../core/content.js").ImageContent[];
	items: TurnItem[];
	readonly assistantMarkdown: string;
	readonly thinkingText?: string;
	readonly tools: ToolRecord[];
	readonly diffs?: DiffRecord[];
}

export function createTurnRecord(n: number, uid: number, userText = ""): TurnRecord {
	const items: TurnItem[] = [];
	return {
		n,
		uid,
		userText,
		items,
		get assistantMarkdown(): string {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "text" }> => it.kind === "text")
				.map((it) => it.text)
				.join("");
		},
		get thinkingText(): string | undefined {
			const texts = items
				.filter((it): it is Extract<TurnItem, { kind: "thinking" }> => it.kind === "thinking")
				.map((it) => it.text);
			return texts.length > 0 ? texts.join("\n") : undefined;
		},
		get tools(): ToolRecord[] {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool")
				.map((t) => ({
					name: t.name,
					result: t.result ?? "",
					...(t.elapsedMs === undefined ? {} : { elapsedMs: t.elapsedMs }),
				}));
		},
		get diffs(): DiffRecord[] {
			return items
				.filter((it): it is Extract<TurnItem, { kind: "diff" }> => it.kind === "diff")
				.map((d) => ({ oldText: d.oldText, newText: d.newText, filename: d.filename, collapsed: d.collapsed }));
		},
	};
}

export interface ThinkingLineLocation {
	turnN: number;
	lineIndex: number;
	lineCount?: number;
	/** 精确指向该 thinking 所属的轮次，不能只依赖可能重复的 turnN。 */
	turn: TurnRecord;
	/** 该行属于哪个思考块。一个轮次可有多个思考块，热区与折叠都以它为身份。 */
	item: ThinkingItem;
}

export interface ToolLineLocation {
	callId: string;
	lineIndex: number;
	lineCount: number;
	name: string;
	isExpanded: boolean;
	turn: TurnRecord;
	item: Extract<TurnItem, { kind: "tool" }>;
}

export interface CompactionLineLocation {
	index: number;
	lineIndex: number;
	lineCount: number;
	record: CompactionCardData;
}

/** UI-neutral replay decoration projected by the composition root. */
export interface CompactionReplayDecoration {
	readonly beforeEntryId: string;
	readonly summary: string;
	readonly tokensBefore?: number;
	readonly retainedTailEntries?: number;
}

export type TimelineItem =
	| { kind: "turn"; turn: TurnRecord }
	| { kind: "notice"; text: string }
	| { kind: "error"; text: string }
	| { kind: "compaction"; record: CompactionCardData }
	| { kind: "customMessage"; message: CustomMessage }
	| { kind: "contextCard"; card: ContextCardData; expanded?: boolean };
/** One settled turn rendered as a self-contained block. Location indices are
 * block-relative; the assembler rebases them onto the final line array. */
interface TurnBlock {
	kind: "turn";
	turn: TurnRecord;
	lines: string[];
	thinking: ThinkingLineLocation[];
	tools: ToolLineLocation[];
}

interface StaticBlock {
	kind: "static";
	lines: string[];
}

interface CompactionBlock {
	kind: "compaction";
	index: number;
	record: CompactionCardData;
	lines: string[];
}

type SettledBlock = TurnBlock | StaticBlock | CompactionBlock;

/**
 * 单个宽度的已结算块缓存。layoutFrame 在「内容不满屏」时会用两个宽度各跑一次
 * computeLayout（gutter 预留 innerW-3 / 无 gutter innerW-1），单槽缓存在短会话
 * 每帧全量重建两次；按宽度分槽（LRU 2）让两个宽度各自命中。
 *
 * timeline 是 append-only（除 loadSession/clear/rewind 的全量 invalidate），
 * 所以 builtItems 之后的条目按序物化即可，无需重建既有块。
 */
interface SettledCache {
	blocks: SettledBlock[];
	/** 已物化的 timeline 条目数 */
	builtItems: number;
	/** 已物化的压缩卡数量（决定下一张压缩卡的 index） */
	builtCompactions: number;
	staleTurns: Set<number>;
	staleCompactions: Set<number>;
}

/** Layout output collected while one turn is rendered. */
interface LayoutSink {
	thinking: ThinkingLineLocation[];
	tools: ToolLineLocation[];
}

/** The single line model consumed by rendering, scrolling and mouse hit zones. */
export interface LineModel {
	lines: string[];
	/** uid → 该轮次起始行号（相对转录区，不含 banner）。 */
	turnStartByUid: Map<number, number>;
	thinkingLocations: ThinkingLineLocation[];
	toolLocations: ToolLineLocation[];
	compactionLocations: CompactionLineLocation[];
}

export class TranscriptContainer implements Component {
	readonly smoothReveal = new SmoothRevealController();
	private readonly timeline: TimelineItem[] = [];
	private readonly historyTurns: TurnRecord[] = [];
	private currentTurn: TurnRecord | null = null;
	/** uid 的唯一签发点（轮次与思考块共用）：只在本容器内递增，绝不重复。 */
	private uidSeq = 0;
	/** 被悬停的思考【块】uid。一个轮次可以有多个思考块，故不能存轮次身份。 */
	private hoveredThinkingUid: number | null = null;
	private hoveredToolId: string | null = null;
	private hoveredCompactionIndex: number | null = null;
	private readonly expandedToolIds = new Set<string>();
	/** Settled timeline blocks, keyed by width + expansion state only.
	 * Hover is applied per block at assembly time so a mouse move never
	 * invalidates every settled turn. */
	private settledCaches = new Map<number, SettledCache>();
	private hoveredBlockCache = new Map<string, TurnBlock>();

	invalidate(): void {
		this.settledCaches.clear();
		this.hoveredBlockCache.clear();
		// 段落缓存不清：键 = width + streaming + 块原文，内容寻址，跨失效安全
		//（旧实现靠 commitCurrentTurn 的 invalidate 清缓存，掩盖了键缺 streaming 维度）
	}

	/** Rebuild only one settled turn's block; the rest of the cache stays valid. */
	invalidateTurn(turnUid: number): void {
		for (const cache of this.settledCaches.values()) cache.staleTurns.add(turnUid);
		this.hoveredBlockCache.clear();
	}

	/** Rebuild only one compaction card. */
	invalidateCompaction(index: number): void {
		for (const cache of this.settledCaches.values()) cache.staleCompactions.add(index);
	}

	/** @param thinkingUid 思考块的 uid（块级身份，一个轮次可有多个块）。 */
	setHoveredThinkingUid(thinkingUid: number | null): boolean {
		if (this.hoveredThinkingUid !== thinkingUid) {
			this.hoveredThinkingUid = thinkingUid;
			// Hover is applied at assembly time, so only the hover cache is
			// dropped; settled blocks stay valid.
			this.hoveredBlockCache.clear();
			return true;
		}
		return false;
	}

	getHoveredThinkingUid(): number | null {
		return this.hoveredThinkingUid;
	}

	setHoveredToolId(toolId: string | null): boolean {
		if (this.hoveredToolId !== toolId) {
			this.hoveredToolId = toolId;
			this.hoveredBlockCache.clear();
			return true;
		}
		return false;
	}

	getHoveredToolId(): string | null {
		return this.hoveredToolId;
	}

	setHoveredCompaction(index: number | null): boolean {
		if (this.hoveredCompactionIndex !== index) {
			this.hoveredCompactionIndex = index;
			return true;
		}
		return false;
	}

	getHoveredCompaction(): number | null {
		return this.hoveredCompactionIndex;
	}

	hasRunningTools(): boolean {
		if (this.currentTurn?.items.some((it) => it.kind === "tool" && it.status === "running")) {
			return true;
		}
		for (const t of this.historyTurns) {
			if (t.items.some((it) => it.kind === "tool" && it.status === "running")) {
				return true;
			}
		}
		return false;
	}

	/** 最新失败工具缓存：undefined = 待重算。ownerUid 供「±1 行提示」迁移时定点失效。 */
	private latestFailedCache: { item: Extract<TurnItem, { kind: "tool" }>; ownerUid: number } | null | undefined =
		undefined;

	private resolveLatestFailed(): { item: Extract<TurnItem, { kind: "tool" }>; ownerUid: number } | null {
		if (this.latestFailedCache !== undefined) return this.latestFailedCache;
		let result: { item: Extract<TurnItem, { kind: "tool" }>; ownerUid: number } | null = null;
		if (this.currentTurn) {
			for (let i = this.currentTurn.items.length - 1; i >= 0; i--) {
				const it = this.currentTurn.items[i]!;
				if (it.kind === "tool" && it.status === "failed") {
					result = { item: it, ownerUid: this.currentTurn.uid };
					break;
				}
			}
		}
		if (!result) {
			for (let t = this.historyTurns.length - 1; t >= 0; t--) {
				const turn = this.historyTurns[t]!;
				for (let i = turn.items.length - 1; i >= 0; i--) {
					const it = turn.items[i]!;
					if (it.kind === "tool" && it.status === "failed") {
						result = { item: it, ownerUid: turn.uid };
						break;
					}
				}
				if (result) break;
			}
		}
		this.latestFailedCache = result;
		return result;
	}

	getLatestFailedTool(): Extract<TurnItem, { kind: "tool" }> | null {
		return this.resolveLatestFailed()?.item ?? null;
	}

	/**
	 * 工具状态变更落地后调用：比较新旧「最新失败工具」，精确失效受影响的已结算块。
	 * isNewestFailure 只影响 ±1 行提示，所以受影响面 = 旧 owner 块 + 新 owner 块，
	 * 且 owner 在 currentTurn 的部分本来每帧重排、无需失效。
	 */
	private syncLatestFailedInvalidation(
		prev: { item: Extract<TurnItem, { kind: "tool" }>; ownerUid: number } | null,
	): void {
		this.latestFailedCache = undefined;
		const next = this.resolveLatestFailed();
		if (prev?.item === next?.item && prev?.ownerUid === next?.ownerUid) return;
		const currentUid = this.currentTurn?.uid;
		if (prev && prev.ownerUid !== currentUid) this.invalidateTurn(prev.ownerUid);
		if (next && next.ownerUid !== currentUid && next.ownerUid !== prev?.ownerUid) {
			this.invalidateTurn(next.ownerUid);
		}
	}

	toggleTool(
		targetOrId?: string | Extract<TurnItem, { kind: "tool" }>,
		width = 80,
	): { toggled: boolean; lineDelta: number } {
		const allTurns = [...this.historyTurns];
		if (this.currentTurn) allTurns.push(this.currentTurn);

		let targetItem: Extract<TurnItem, { kind: "tool" }> | undefined;
		let ownerTurn: TurnRecord | undefined;
		if (typeof targetOrId === "object") {
			targetItem = targetOrId;
			ownerTurn = allTurns.find((t) => t.items.includes(targetOrId));
		} else if (typeof targetOrId === "string") {
			for (const t of allTurns) {
				const found = t.items.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> =>
						it.kind === "tool" && (it.callId === targetOrId || it.name === targetOrId),
				);
				if (found) {
					targetItem = found;
					ownerTurn = t;
					break;
				}
			}
		} else {
			for (let i = allTurns.length - 1; i >= 0; i--) {
				const found = allTurns[i]!.items.slice()
					.reverse()
					.find((it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool");
				if (found) {
					targetItem = found;
					ownerTurn = allTurns[i];
					break;
				}
			}
		}

		if (targetItem) {
			const callId = targetItem.callId || `tool-${targetItem.name}`;
			const wasExpanded = targetItem.collapsed === false || this.expandedToolIds.has(callId);
			const beforeCount = this.renderTool(targetItem, width, {
				isExpanded: wasExpanded,
				startedAt: targetItem.startedAt,
			}).length;

			targetItem.collapsed = wasExpanded;
			if (wasExpanded) {
				this.expandedToolIds.delete(callId);
			} else {
				this.expandedToolIds.add(callId);
			}
			if (ownerTurn) this.invalidateTurn(ownerTurn.uid);
			else this.invalidate();

			const afterCount = this.renderTool(targetItem, width, {
				isExpanded: !wasExpanded,
				startedAt: targetItem.startedAt,
			}).length;

			return { toggled: true, lineDelta: afterCount - beforeCount };
		}

		return { toggled: false, lineDelta: 0 };
	}

	toggleAllTools(collapsed?: boolean): void {
		const allTurns = [...this.historyTurns];
		if (this.currentTurn) allTurns.push(this.currentTurn);

		const allToolItems: Array<Extract<TurnItem, { kind: "tool" }>> = [];
		for (const t of allTurns) {
			for (const it of t.items) {
				if (it.kind === "tool") allToolItems.push(it);
			}
		}

		if (allToolItems.length === 0) return;

		const anyExpanded = allToolItems.some(
			(it) => it.collapsed === false || (it.callId && this.expandedToolIds.has(it.callId)),
		);
		const targetExpanded = collapsed !== undefined ? !collapsed : !anyExpanded;

		for (const it of allToolItems) {
			it.collapsed = !targetExpanded;
			const id = it.callId || `tool-${it.name}`;
			if (targetExpanded) {
				this.expandedToolIds.add(id);
			} else {
				this.expandedToolIds.delete(id);
			}
		}
		this.invalidate();
	}

	private toolRenderer: (name: string) => ToolRenderer | undefined = () => undefined;
	private markdownTransformer: MarkdownTransformer = (text) => text;
	private renderComponent: (component: Component, width: number, height?: number) => string[] = (
		component,
		width,
		height,
	) => component.render(width, height);
	private renderTool(
		item: Extract<TurnItem, { kind: "tool" }>,
		width: number,
		options: import("./tool-view.js").ToolCardRenderOptions,
	): string[] {
		let failure: string | undefined;
		try {
			const component = this.toolRenderer(item.name)?.(structuredClone(item), {
				width,
				expanded: options.isExpanded ?? false,
				hovered: options.isHovered ?? false,
				elapsedMs: item.elapsedMs,
			});
			if (component) {
				const lines = this.renderComponent(component, width);
				// 自定义渲染器不能丢掉附件元数据（A18）：图片提示与内置路径一致。
				if (item.images?.length) {
					lines.push("  [图片 " + item.images.map((image) => image.mimeType).join(", ") + "；终端显示元数据]");
				}
				return lines;
			}
		} catch (error) {
			failure = "[tool renderer " + item.name + ": " + String(error) + "]";
		}
		const text = item.result ?? "";
		const lines = formatToolCardLines(item.name, text, item.elapsedMs, width, item.status, item.args, options);
		if (item.images?.length)
			lines.push("  [图片 " + item.images.map((image) => image.mimeType).join(", ") + "；终端显示元数据]");
		if (failure) lines.push(failure);
		return lines;
	}
	private transformMarkdown(text: string, role: "user" | "assistant", width: number, streaming: boolean): string {
		try {
			return this.markdownTransformer(text, { role, width, streaming });
		} catch (error) {
			return text + "\n[markdown renderer: " + String(error) + "]";
		}
	}
	private messageRenderer: (type: string) => MessageRenderer | undefined = () => undefined;

	setRendererResolver(resolve: {
		message(type: string): MessageRenderer | undefined;
		tool?(name: string): ToolRenderer | undefined;
		markdown?: MarkdownTransformer;
		componentRenderer?: (component: Component, width: number, height?: number) => string[];
	}): void {
		this.messageRenderer = resolve.message;
		this.toolRenderer = resolve.tool ?? (() => undefined);
		this.markdownTransformer = resolve.markdown ?? ((text) => text);
		this.renderComponent = resolve.componentRenderer ?? ((component, width, height) => component.render(width, height));
		this.invalidate();
	}

	startTurn(n: number, userText: string, images?: readonly import("../../../core/content.js").ImageContent[]): void {
		if (this.currentTurn) {
			this.commitCurrentTurn();
		}
		this.currentTurn = createTurnRecord(n, ++this.uidSeq, userText);
		this.currentTurn.userImages = images;
	}

	appendToken(token: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "text") {
			last.text += token;
			this.smoothReveal.feed(`turn-${this.currentTurn.uid}-text`, last.text);
		} else {
			this.currentTurn.items.push({ kind: "text", text: token });
			this.smoothReveal.feed(`turn-${this.currentTurn.uid}-text`, token);
		}
	}

	appendThinking(text: string): void {
		if (!this.currentTurn) return;
		const last = this.currentTurn.items.at(-1);
		if (last && last.kind === "thinking") {
			last.text += text;
		} else {
			this.currentTurn.items.push({ kind: "thinking", text, uid: ++this.uidSeq });
		}
	}

	startTool(node: ToolNode): void {
		if (!this.currentTurn) {
			this.startTurn(this.historyTurns.length + 1, "");
		}
		this.currentTurn?.items.push({
			kind: "tool",
			name: node.name,
			args: node.args,
			status: "running",
			startedAt: node.startedAt,
			callId: node.callId,
		});
		// 当前轮由 ensureModel 每帧无条件重排，无需任何失效信号
	}

	addToolDone(node: ToolNode): void {
		const result = sanitizeRenderText(node.result ?? "");
		const prevFailed = this.resolveLatestFailed();
		if (!this.currentTurn) {
			const lastTurn = this.historyTurns[this.historyTurns.length - 1];
			if (lastTurn) {
				const existingTool = lastTurn.items.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool" && it.callId === node.callId,
				);
				if (existingTool) {
					// 该工具属于已结算/打断的上一轮，严禁开辟新轮次或生成重复工具卡
					this.applyToolNode(existingTool, node, result);
					this.invalidateTurn(lastTurn.uid);
					this.syncLatestFailedInvalidation(prevFailed);
					return;
				}
			}
			this.startTurn(this.historyTurns.length + 1, "");
		}
		if (!this.currentTurn) return;

		let runningTool = this.currentTurn.items.find(
			(it): it is Extract<TurnItem, { kind: "tool" }> => it.kind === "tool" && it.callId === node.callId,
		);
		if (!runningTool) {
			runningTool = this.currentTurn.items
				.slice()
				.reverse()
				.find(
					(it): it is Extract<TurnItem, { kind: "tool" }> =>
						it.kind === "tool" && it.status === "running" && it.name === node.name,
				);
		}

		if (runningTool) {
			this.applyToolNode(runningTool, node, result);
		} else {
			const item: Extract<TurnItem, { kind: "tool" }> = {
				kind: "tool",
				name: node.name,
				args: node.args,
				result,
				...(node.images ? { images: [...node.images] } : {}),
				...(node.details === undefined ? {} : { details: node.details }),
				startedAt: node.startedAt,
				elapsedMs: node.durationMs,
				status: node.status === "running" ? "unknown" : node.status,
				callId: node.callId,
			};
			this.currentTurn.items.push(item);
		}
		this.syncLatestFailedInvalidation(prevFailed);
	}

	private applyToolNode(item: Extract<TurnItem, { kind: "tool" }>, node: ToolNode, result: string): void {
		item.status = node.status === "running" ? "unknown" : node.status;
		item.result = result;
		if (node.images) item.images = [...node.images];
		if (node.details !== undefined) item.details = node.details;
		if (item.startedAt === undefined) item.startedAt = node.startedAt;
		item.elapsedMs = node.durationMs;
		if (node.args !== undefined && item.args === undefined) item.args = node.args;
	}

	/**
	 * turn_end / turn_aborted：把投影已结算的工具节点写回既有卡片。
	 * 不创建新轮或新卡片——卡片必须已由 tool_call 建立；缺卡片说明实时链路断开，
	 * 由投影节点如实保留状态，不在这里补造。
	 */
	settleToolNodes(nodes: readonly PresentationNode[]): void {
		const prevFailed = this.resolveLatestFailed();
		const all = this.allTurns();
		const stale = new Set<number>();
		let changed = false;
		for (const node of nodes) {
			if (node.kind !== "tool" || node.status === "running") continue;
			const owner = all.find((turn) => turn.items.some((item) => item.kind === "tool" && item.callId === node.callId));
			const item = owner?.items.find(
				(candidate): candidate is Extract<TurnItem, { kind: "tool" }> =>
					candidate.kind === "tool" && candidate.callId === node.callId,
			);
			if (!owner || !item) continue;
			this.applyToolNode(item, node, sanitizeRenderText(node.result ?? ""));
			if (owner !== this.currentTurn) stale.add(owner.uid);
			changed = true;
		}
		if (!changed) return;
		for (const uid of stale) this.invalidateTurn(uid);
		this.syncLatestFailedInvalidation(prevFailed);
	}

	addCompaction(record: CompactionCardData): void {
		this.timeline.push({ kind: "compaction", record });
	}

	addPromptSnapshot(snapshot: PromptContextCardData): void {
		// 轮内=尾部重排；timeline=尾部追加（buildSettledBlocks 按 builtItems 差额物化）
		if (this.currentTurn) this.currentTurn.items.push({ kind: "contextCard", card: snapshot });
		else this.timeline.push({ kind: "contextCard", card: snapshot });
	}

	addExternalInput(input: ExternalContextCardData): void {
		if (this.currentTurn) this.currentTurn.items.push({ kind: "contextCard", card: input });
		else this.timeline.push({ kind: "contextCard", card: input });
	}

	toggleContextCard(id?: string): boolean {
		const matches = (item: Extract<TurnItem, { kind: "contextCard" }>): boolean => {
			if (id === undefined) return true;
			const itemId = item.card.kind === "external" ? item.card.inputId : item.card.id;
			return itemId === id;
		};
		for (let index = this.timeline.length - 1; index >= 0; index--) {
			const item = this.timeline[index]!;
			if (item.kind !== "contextCard" || !matches(item)) continue;
			item.expanded = !item.expanded;
			// static 块没有 uid/index 定位键，保持全量失效（低频用户操作）
			this.invalidate();
			return true;
		}
		const turns = this.allTurns();
		for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
			const items = turns[turnIndex]!.items;
			for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
				const item = items[itemIndex]!;
				if (item.kind !== "contextCard" || !matches(item)) continue;
				item.expanded = !item.expanded;
				this.invalidateTurn(turns[turnIndex]!.uid);
				return true;
			}
		}
		return false;
	}

	addCustomMessage(msg: CustomMessage): void {
		if (msg.display === false) return;
		// 轮内到达时归入当前轮（时间序）；不能先 commit 当前轮——流式/工具追加都
		// 依赖现存 currentTurn，切轮会静默丢弃后续增量。
		if (this.currentTurn) {
			this.currentTurn.items.push({ kind: "customMessage", message: msg });
		} else {
			this.timeline.push({ kind: "customMessage", message: msg });
		}
	}

	addNotice(text: string): void {
		const formatted = `  ${C.blue}ℹ ${text}${C.reset}`;
		this.timeline.push({ kind: "notice", text: formatted });
	}

	addError(text: string): void {
		this.timeline.push({ kind: "error", text });
	}

	finishTurn(): void {
		this.commitCurrentTurn();
	}

	interruptTurn(_modelName?: string): void {
		this.smoothReveal.snapToLatest();
		// G8：中断提示的主体是用户自己的下一步，不拿模型名冒充。
		const notice = "已打断 · 接下来想做什么？";
		if (this.currentTurn) {
			if (this.currentTurn.items.some((it) => it.kind === "interrupt")) {
				return;
			}
			// 工具终态由投影结算（turn.aborted → cancelled）；容器只负责封顶与打断行。
			this.currentTurn.items.push({ kind: "interrupt", text: notice });
			this.finishTurn();
		} else {
			const lastTurn = this.historyTurns[this.historyTurns.length - 1];
			if (lastTurn && lastTurn.items.some((it) => it.kind === "interrupt")) {
				return;
			}
			this.timeline.push({ kind: "notice", text: `  \x1b[2m${notice}\x1b[0m` });
		}
	}

	getCurrentTurn(): TurnRecord | null {
		return this.currentTurn;
	}

	getHistory(): readonly TurnRecord[] {
		return this.historyTurns;
	}

	/**
	 * Restores the display projection from the same ordered entries used to
	 * build provider history. Operational events never become transcript rows.
	 *
	 * 工具卡的状态、参数与耗时只取 `nodes`；轮号也只取 `nodes` 中的 `TurnNode`
	 * （投影是唯一来源，容器不再本地递增）。缺节点时才退回 canonical 消息字段。
	 */
	loadSession(
		entries: readonly SessionEntry[],
		nodes: readonly PresentationNode[],
		decorations: readonly CompactionReplayDecoration[] = [],
		promptSnapshots: readonly PromptSnapshotRecord[] = [],
	): void {
		this.clear();
		const toolNodes = new Map<string, ToolNode>();
		const turnNodes: TurnNode[] = [];
		for (const node of nodes) {
			if (node.kind === "tool") toolNodes.set(node.callId, node);
			else if (node.kind === "turn") turnNodes.push(node);
		}
		// 遇 user 消息按序消费一个 TurnNode；辅助轮（无 user 的恢复缺口）沿用最近轮号。
		let turnCursor = 0;
		let lastTurnNumber = 0;
		const consumeTurnNumber = (): number => {
			const node = turnNodes[turnCursor];
			if (!node) return lastTurnNumber;
			turnCursor++;
			lastTurnNumber = node.turn;
			return node.turn;
		};
		let current: TurnRecord | null = null;
		const commit = (): void => {
			if (!current) return;
			this.historyTurns.push(current);
			this.timeline.push({ kind: "turn", turn: current });
			current = null;
		};
		const createTurn = (turnNumber: number, userText = ""): TurnRecord =>
			createTurnRecord(turnNumber, ++this.uidSeq, userText);

		const decorationsByEntry = new Map<string, CompactionReplayDecoration[]>();
		for (const decoration of decorations) {
			const list = decorationsByEntry.get(decoration.beforeEntryId) ?? [];
			list.push(decoration);
			decorationsByEntry.set(decoration.beforeEntryId, list);
		}
		let promptIndex = 0;
		const appendPromptSnapshot = (snapshot: PromptSnapshotRecord): void => {
			const item: Extract<TurnItem, { kind: "contextCard" }> = {
				kind: "contextCard",
				card: {
					kind: "prompt",
					id: snapshot.id,
					turnNumber: snapshot.turnNumber,
					systemPrompt: snapshot.systemPrompt,
					injections: snapshot.injections,
				},
			};
			if (current) current.items.push(item);
			else this.timeline.push(item);
		};
		for (const entry of entries) {
			while (
				promptIndex < promptSnapshots.length &&
				(entry.seq === undefined || promptSnapshots[promptIndex]!.seq < entry.seq)
			) {
				appendPromptSnapshot(promptSnapshots[promptIndex]!);
				promptIndex++;
			}
			const before = entry.id ? decorationsByEntry.get(entry.id) : undefined;
			if (before) {
				commit();
				for (const decoration of before) {
					this.timeline.push({
						kind: "compaction",
						record: {
							summary: decoration.summary,
							...(decoration.retainedTailEntries === undefined
								? {}
								: { retainedTailEntries: decoration.retainedTailEntries }),
							...(decoration.tokensBefore === undefined ? {} : { tokensBefore: decoration.tokensBefore }),
							collapsed: true,
						},
					});
				}
			}
			if (entry.kind === "rewind") {
				commit();
				this.timeline.push({
					kind: "customMessage",
					message: {
						customType: "session-rewind",
						content:
							entry.notice + "\n[当前主线从此处继续]" + (entry.record.note ? `\n[经验附注] ${entry.record.note}` : ""),
						details: { record: entry.record, effects: entry.effects },
					},
				});
				continue;
			}
			if (entry.kind === "custom_message") {
				if (entry.display === false) continue;
				commit();
				this.timeline.push({
					kind: "customMessage",
					message: {
						customType: entry.customType,
						content: entry.content,
						...(entry.images === undefined ? {} : { images: entry.images }),
						...(entry.details === undefined ? {} : { details: entry.details }),
					},
				});
				continue;
			}

			if (
				entry.kind === "input" &&
				entry.input.source?.kind === "runtime" &&
				entry.input.source.origin === "external"
			) {
				const item: Extract<TurnItem, { kind: "contextCard" }> = {
					kind: "contextCard",
					card: {
						kind: "external",
						inputId: entry.input.id,
						source: entry.input.source,
						receivedAt: entry.input.receivedAt ?? entry.timestamp ?? "",
						text: entry.input.text,
						...(entry.input.images ? { images: entry.input.images } : {}),
					},
				};
				if (current) current.items.push(item);
				else this.timeline.push(item);
				continue;
			}
			const msg =
				entry.kind === "input"
					? projectInputMessage(entry.input)
					: entry.kind === "message"
						? entry.message
						: undefined;
			if (!msg) continue;
			if (msg.role === "user") {
				commit();
				current = createTurn(consumeTurnNumber(), msg.content);
				current.userImages = msg.images;
			} else if (msg.role === "assistant") {
				current ??= createTurn(lastTurnNumber);
				if (msg.thinking) {
					current.items.push({ kind: "thinking", text: msg.thinking, uid: ++this.uidSeq });
				}
				if (msg.content) {
					current.items.push({ kind: "text", text: msg.content });
				}
				// 中止是结构化事实（status），不再靠正文包含“已打断”猜测。
				if (msg.status === "aborted") {
					current.items.push({ kind: "interrupt", text: "已打断 · 接下来想继续做什么？" });
				}
			} else if (msg.role === "tool") {
				current ??= createTurn(lastTurnNumber);
				const node = toolNodes.get(msg.tool_call_id);
				const status: "running" | ToolResultStatus =
					node === undefined ? (msg.status ?? "unknown") : node.status === "running" ? "unknown" : node.status;
				current.items.push({
					kind: "tool",
					name: node?.name ?? msg.name ?? "tool",
					args: node?.args,
					result: msg.content,
					...(msg.images ? { images: msg.images } : {}),
					...(msg.details === undefined ? {} : { details: msg.details }),
					startedAt: node?.startedAt,
					elapsedMs: node?.durationMs,
					status,
					callId: msg.tool_call_id,
				});
			}
		}
		while (promptIndex < promptSnapshots.length) {
			appendPromptSnapshot(promptSnapshots[promptIndex]!);
			promptIndex++;
		}
		commit();
		this.invalidate();
	}

	clear(): void {
		this.timeline.length = 0;
		this.historyTurns.length = 0;
		this.currentTurn = null;
		this.currentParagraphCache.clear();
		this.latestFailedCache = undefined;
		this.invalidate();
	}

	/** 全量轮次（历史 + 当前）。 */
	private allTurns(): TurnRecord[] {
		const all = [...this.historyTurns];
		if (this.currentTurn) all.push(this.currentTurn);
		return all;
	}

	/**
	 * 解析目标思考块及其所属轮次。
	 * @param target 指定块时按对象浅查找（顺带校验它确实属于本容器）；省略则取最后一个思考块。
	 */
	private resolveThinking(target?: ThinkingItem): { turn: TurnRecord; item: ThinkingItem } | null {
		const all = this.allTurns();
		if (target) {
			for (const turn of all) {
				for (const item of turn.items) {
					if (item === target && item.kind === "thinking") return { turn, item };
				}
			}
			return null;
		}
		for (let i = all.length - 1; i >= 0; i--) {
			const turn = all[i]!;
			for (let j = turn.items.length - 1; j >= 0; j--) {
				const item = turn.items[j]!;
				if (item.kind === "thinking") return { turn, item };
			}
		}
		return null;
	}

	/**
	 * 折叠/展开【单个】思考块。
	 * @param target 目标块；省略时取最后一个思考块（Ctrl+O 语义）。
	 * 一个轮次可以有多个思考块，故这里绝不做轮次级批量切换——那会让整轮一起展开。
	 */
	toggleThinking(target?: ThinkingItem, width = 80): { toggled: boolean; lineDelta: number } {
		const resolved = this.resolveThinking(target);
		if (!resolved) return { toggled: false, lineDelta: 0 };
		const { turn, item } = resolved;
		const wasCollapsed = item.collapsed ?? true;
		const beforeCount = formatThinkingLines(item.text, wasCollapsed, width).length;
		item.collapsed = !wasCollapsed;
		this.invalidateTurn(turn.uid);
		const afterCount = formatThinkingLines(item.text, !wasCollapsed, width).length;
		return { toggled: true, lineDelta: afterCount - beforeCount };
	}

	/** 全展开/全折叠（alt+o）：唯一的轮次级批量入口，但逐块写入块状态。 */
	toggleAllThinking(collapsed?: boolean): void {
		const items = this.allTurns()
			.flatMap((turn) => turn.items)
			.filter((item): item is ThinkingItem => item.kind === "thinking");
		if (items.length === 0) return;
		const targetState = collapsed ?? items.some((item) => item.collapsed === false);
		for (const item of items) item.collapsed = targetState;
		this.invalidate();
	}

	toggleCompaction(index?: number): boolean {
		const compactions = this.timeline.filter(
			(it): it is Extract<TimelineItem, { kind: "compaction" }> => it.kind === "compaction",
		);
		if (compactions.length === 0) return false;
		const target = index !== undefined ? compactions[index] : compactions.at(-1);
		if (target) {
			target.record.collapsed = !target.record.collapsed;
			const targetIndex = index !== undefined ? index : compactions.length - 1;
			this.invalidateCompaction(targetIndex);
			return true;
		}
		return false;
	}

	private commitCurrentTurn(): void {
		if (this.currentTurn) {
			this.smoothReveal.snapToLatest(`turn-${this.currentTurn.uid}-text`);
			this.historyTurns.push(this.currentTurn);
			this.timeline.push({ kind: "turn", turn: this.currentTurn });
			this.currentTurn = null;
			// 提交只是 timeline 尾部追加，settled 缓存按 builtItems 差额物化，无需全量重建
		}
	}

	private formatUserLine(text: string, width: number): string[] {
		text = this.transformMarkdown(text, "user", width, false);
		const lines: string[] = [""];
		const prefix = `${C.bold}${C.briefLabelYou}❯ ${C.reset}`;
		const leadW = 2; // "❯ " 占 2 列
		const contentBudget = Math.max(10, width - leadW - 2);
		const wrapped = wrapLine(text, contentBudget);
		if (wrapped.length === 0) {
			lines.push(`${prefix}`);
		} else {
			lines.push(`${prefix}${C.bold}${C.briefLabelYou}${wrapped[0]}${C.reset}`);
			const indent = "  ";
			for (let i = 1; i < wrapped.length; i++) {
				lines.push(`${indent}${C.bold}${C.briefLabelYou}${wrapped[i]}${C.reset}`);
			}
		}
		lines.push("");
		return lines;
	}

	/**
	 * 助手文本渲染的段落级缓存层。
	 *
	 * 每帧对当前回合的累积全文重跑 markdown 管线是流式长文卡顿的根因（实测 40KB
	 * 单帧 2.8ms、100KB 7.4ms）。切块策略与旧全文管线逐行同构：
	 *
	 * - 单空行（围栏内除外）是切块分隔符，本身产出一个 "" 行 —— 与全文管线对
	 *   空行的处理（rawLine 为空 → push("")）一致；
	 * - 每个文本 item 的末尾恒补一个 "" 行（旧实现 883 行 formatted.push("")），
	 *   由 formatAssistantMarkdown 而非块内完成；
	 * - 围栏（``` ）内部的空行不切块、也照原文进入块内容；
	 * - 非尾块永不增长，行数组直接命中缓存（键 = width + 块原文）；仅尾块每帧
	 *   重排，成本 O(增量)。
	 *
	 * 正确性前提：transformMarkdown 与 sanitizeRenderText 逐块应用等价于全文应用
	 * ——内置实现逐字符、无跨行状态；streaming 标志按块传递。● 前缀是轮次粒度
	 * （本轮首个文本 item 的首行），在拼接阶段注入，不进缓存。
	 */
	private currentParagraphCache = new Map<string, string[]>();

	/** 围栏感知切块：块内含行内容，不含分隔空行；分隔空行数量另计。 */
	private splitAssistantBlocks(text: string): Array<{ block: string; blankAfter: number }> {
		const parts: Array<{ block: string; blankAfter: number }> = [];
		const lines = text.split("\n");
		let block: string[] = [];
		let inFence = false;
		const flush = () => {
			if (block.length > 0) parts.push({ block: block.join("\n"), blankAfter: 0 });
			block = [];
		};
		for (const line of lines) {
			if (!inFence && /^\s*```/.test(line)) inFence = true;
			else if (inFence && /^\s*```/.test(line)) inFence = false;
			if (!inFence && line === "") {
				flush();
				if (parts.length > 0) parts[parts.length - 1]!.blankAfter++;
			} else {
				block.push(line);
			}
		}
		flush();
		return parts;
	}

	private formatAssistantMarkdown(md: string, width: number, isFirstParagraph = true, streaming = false): string[] {
		const parts = this.splitAssistantBlocks(md);
		const contentBudget = Math.max(20, width - 2);
		const formatted: string[] = [];
		let isFirst = isFirstParagraph;

		for (const { block, blankAfter } of parts) {
			// streaming 必须进键：commit 后同一块文本会以 streaming=false 重渲染，
			// 键缺维度会复用流式态渲染结果（旧实现靠 invalidate 清缓存掩盖）
			const cacheKey = `${width}:${streaming ? 1 : 0}:${block}`;
			let blockLines = this.currentParagraphCache.get(cacheKey);
			if (!blockLines) {
				blockLines = this.formatAssistantBlock(block, contentBudget, streaming);
				if (this.currentParagraphCache.size >= 4096) {
					const oldest = this.currentParagraphCache.keys().next().value;
					if (oldest !== undefined) this.currentParagraphCache.delete(oldest);
				}
				this.currentParagraphCache.set(cacheKey, blockLines);
			}
			// ● 前缀是轮次粒度（本轮首个文本 item 的首行），拼接时注入，不改缓存内容
			if (isFirst && blockLines.length > 0 && !blockLines[0]!.startsWith("│") && !blockLines[0]!.startsWith("├")) {
				formatted.push(`${C.bold}${C.text}● ${C.reset}${blockLines[0]!}`);
				formatted.push(...blockLines.slice(1));
				isFirst = false;
			} else {
				formatted.push(...blockLines);
			}
			// 分隔空行逐个产出（与全文管线对空行的处理一致）
			for (let b = 0; b < blankAfter; b++) formatted.push("");
		}
		// 旧全文管线在 item 末尾恒补一个空行；无内容时不补（旧实现 !md 提前返回）
		if (parts.length > 0) formatted.push("");
		return formatted;
	}

	/** 单块渲染：与旧 formatAssistantMarkdown 主体逐行等价（仅去掉首行前缀与末尾补行）。 */
	private formatAssistantBlock(block: string, contentBudget: number, streaming: boolean): string[] {
		let transformed = this.transformMarkdown(block, "assistant", contentBudget, streaming);
		transformed = sanitizeRenderText(transformed);
		if (!transformed) return [];
		const rawLines = formatFullMarkdown(transformed, contentBudget);
		const formatted: string[] = [];

		for (const rawLine of rawLines) {
			if (!rawLine.trim()) {
				formatted.push("");
				continue;
			}
			const clean = stripAnsi(rawLine).trimStart();
			if (
				clean.startsWith("┌") ||
				clean.startsWith("│") ||
				clean.startsWith("└") ||
				clean.startsWith("├") ||
				clean.startsWith("┼") ||
				clean.startsWith("┴") ||
				clean.startsWith("┬")
			) {
				formatted.push(rawLine.trimStart());
				continue;
			}
			const wrapped = wrapLine(rawLine.trim(), contentBudget);
			formatted.push(...wrapped);
		}
		return formatted;
	}

	/** 取/建指定宽度的缓存槽（LRU 2：命中移到队尾，超容淘汰最旧）。 */
	private settledCacheFor(width: number): SettledCache {
		const existing = this.settledCaches.get(width);
		if (existing) {
			this.settledCaches.delete(width);
			this.settledCaches.set(width, existing);
			return existing;
		}
		const cache: SettledCache = {
			blocks: [],
			builtItems: 0,
			builtCompactions: 0,
			staleTurns: new Set(),
			staleCompactions: new Set(),
		};
		if (this.settledCaches.size >= 2) {
			const oldest = this.settledCaches.keys().next().value;
			if (oldest !== undefined) this.settledCaches.delete(oldest);
		}
		this.settledCaches.set(width, cache);
		return cache;
	}

	/** 物化单个 timeline 条目为一个已结算块。 */
	private buildTimelineBlock(item: TimelineItem, width: number, compactionIndex: number): SettledBlock {
		switch (item.kind) {
			case "notice":
				return { kind: "static", lines: wrapLine(item.text, Math.max(20, width - 2)) };
			case "error":
				return { kind: "static", lines: formatErrorCardLines(item.text, width) };
			case "compaction":
				return {
					kind: "compaction",
					index: compactionIndex,
					record: item.record,
					lines: formatCompactionCardLines(item.record, width, false),
				};
			case "turn":
				return this.buildTurnBlock(item.turn, width, false, this.getLatestFailedTool());
			case "customMessage": {
				const comp = new CustomMessageComponent(
					item.message,
					this.messageRenderer(item.message.customType),
					this.renderComponent,
				);
				return { kind: "static", lines: comp.render(width) };
			}
			case "contextCard": {
				const comp = new ContextCardComponent(item.card);
				if (item.expanded) comp.toggle();
				return { kind: "static", lines: comp.render(width) };
			}
		}
	}

	private buildSettledBlocks(width: number): SettledBlock[] {
		const cache = this.settledCacheFor(width);
		// 1) 物化 timeline 尾部新增条目（append-only：既不触碰也不重建既有块）
		while (cache.builtItems < this.timeline.length) {
			const item = this.timeline[cache.builtItems]!;
			const compactionIndex = item.kind === "compaction" ? cache.builtCompactions : -1;
			cache.blocks.push(this.buildTimelineBlock(item, width, compactionIndex));
			if (item.kind === "compaction") cache.builtCompactions++;
			cache.builtItems++;
		}
		// 2) 只重建 stale 的轮次/压缩块
		if (cache.staleTurns.size > 0 || cache.staleCompactions.size > 0) {
			const latestFailed = this.getLatestFailedTool();
			cache.blocks = cache.blocks.map((block) => {
				if (block.kind === "turn" && cache.staleTurns.has(block.turn.uid)) {
					return this.buildTurnBlock(block.turn, width, false, latestFailed);
				}
				if (block.kind === "compaction" && cache.staleCompactions.has(block.index)) {
					return { ...block, lines: formatCompactionCardLines(block.record, width, false) };
				}
				return block;
			});
			cache.staleTurns.clear();
			cache.staleCompactions.clear();
			this.hoveredBlockCache.clear();
		}
		return cache.blocks;
	}

	/** Render one turn exactly once: lines and hit-zone metadata come from the
	 * same pass, so streaming and settled turns can never disagree. */
	private buildTurnBlock(
		turn: TurnRecord,
		width: number,
		hover: boolean,
		latestFailed: Extract<TurnItem, { kind: "tool" }> | null,
	): TurnBlock {
		const lines: string[] = [];
		const sink: LayoutSink = { thinking: [], tools: [] };
		this.layoutTurn(turn, width, lines, sink, { hover, latestFailed });
		return { kind: "turn", turn, lines, thinking: sink.thinking, tools: sink.tools };
	}

	private layoutTurn(
		turn: TurnRecord,
		width: number,
		out: string[],
		sink: LayoutSink,
		opts: { isCurrent?: boolean; hover?: boolean; latestFailed?: Extract<TurnItem, { kind: "tool" }> | null } = {},
	): void {
		const isCurrent = opts.isCurrent ?? false;
		const hover = opts.hover ?? false;
		const activeFailed = opts.latestFailed !== undefined ? opts.latestFailed : this.getLatestFailedTool();

		if (turn.userText || turn.userImages?.length)
			out.push(...this.formatUserLine(turn.userText + imageNotice(turn.userImages), width));

		let hasRenderedText = false;
		for (const item of turn.items) {
			if (item.kind === "thinking") {
				const isHovered = hover && this.hoveredThinkingUid === item.uid;
				const collapsed = item.collapsed ?? true;
				const lines = formatThinkingLines(item.text, collapsed, width, isHovered);
				sink.thinking.push({ turnN: turn.n, lineIndex: out.length, lineCount: lines.length, turn, item });
				out.push(...lines);
			} else if (item.kind === "text") {
				const textToRender = isCurrent
					? this.smoothReveal.getRevealedText(`turn-${turn.uid}-text`, item.text, true)
					: item.text;
				out.push(...this.formatAssistantMarkdown(textToRender, width, !hasRenderedText, isCurrent));
				hasRenderedText = true;
			} else if (item.kind === "tool") {
				const toolId = item.callId || `tool-${item.name}`;
				const isExpanded = item.collapsed === false || this.expandedToolIds.has(toolId);
				const isHovered = hover && this.hoveredToolId === toolId;
				const isNewestFailure = item === activeFailed;
				const lines = this.renderTool(item, width, {
					isExpanded,
					isHovered,
					isNewestFailure,
					startedAt: item.startedAt,
				});
				sink.tools.push({
					callId: toolId,
					lineIndex: out.length,
					lineCount: lines.length,
					name: item.name,
					isExpanded,
					turn,
					item,
				});
				out.push(...lines);
			} else if (item.kind === "diff") {
				out.push(...formatDiffCardLines(item.oldText, item.newText, item.filename, item.collapsed ?? true, width));
			} else if (item.kind === "interrupt") {
				out.push(`  \x1b[2m${item.text}\x1b[0m`);
			} else if (item.kind === "customMessage") {
				const comp = new CustomMessageComponent(
					item.message,
					this.messageRenderer(item.message.customType),
					this.renderComponent,
				);
				out.push(...comp.render(width));
			} else if (item.kind === "contextCard") {
				const comp = new ContextCardComponent(item.card);
				if (item.expanded) comp.toggle();
				out.push(...comp.render(width));
			}
		}
	}

	/** Hover on settled turns rebuilds only the affected block. */
	private turnBlockFor(base: TurnBlock, width: number): TurnBlock {
		const hoveredThinkingHere =
			this.hoveredThinkingUid !== null &&
			base.turn.items.some((it) => it.kind === "thinking" && it.uid === this.hoveredThinkingUid);
		const hoveredToolHere =
			this.hoveredToolId !== null && base.tools.some((tool) => tool.callId === this.hoveredToolId);
		if (!hoveredThinkingHere && !hoveredToolHere) return base;
		const key = `${width}:${base.turn.uid}:${this.hoveredToolId ?? ""}:${this.hoveredThinkingUid ?? ""}`;
		const cached = this.hoveredBlockCache.get(key);
		if (cached) return cached;
		const rebuilt = this.buildTurnBlock(base.turn, width, true, this.getLatestFailedTool());
		this.hoveredBlockCache.clear();
		this.hoveredBlockCache.set(key, rebuilt);
		return rebuilt;
	}

	private assemble(blocks: readonly SettledBlock[], width: number): LineModel {
		const lines: string[] = [];
		const turnStartByUid = new Map<number, number>();
		const thinkingLocations: ThinkingLineLocation[] = [];
		const toolLocations: ToolLineLocation[] = [];
		const compactionLocations: CompactionLineLocation[] = [];

		for (const block of blocks) {
			const start = lines.length;
			if (block.kind === "turn") {
				const rendered = this.turnBlockFor(block, width);
				turnStartByUid.set(block.turn.uid, start);
				lines.push(...rendered.lines);
				for (const loc of rendered.thinking) thinkingLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
				for (const loc of rendered.tools) toolLocations.push({ ...loc, lineIndex: start + loc.lineIndex });
			} else if (block.kind === "compaction") {
				const cardLines =
					this.hoveredCompactionIndex === block.index
						? formatCompactionCardLines(block.record, width, true)
						: block.lines;
				compactionLocations.push({
					index: block.index,
					lineIndex: start,
					lineCount: cardLines.length,
					record: block.record,
				});
				lines.push(...cardLines);
			} else {
				lines.push(...block.lines);
			}
		}
		return { lines, turnStartByUid, thinkingLocations, toolLocations, compactionLocations };
	}

	/** The single line model consumed by render, scrolling and hit zones. */
	private ensureModel(width: number): LineModel {
		const model = this.assemble(this.buildSettledBlocks(width), width);
		if (this.currentTurn) {
			const start = model.lines.length;
			const sink: LayoutSink = { thinking: [], tools: [] };
			this.layoutTurn(this.currentTurn, width, model.lines, sink, { isCurrent: true, hover: true });
			model.turnStartByUid.set(this.currentTurn.uid, start);
			model.thinkingLocations.push(...sink.thinking);
			model.toolLocations.push(...sink.tools);
		}
		return model;
	}

	/**
	 * 帧内单一行模型：与 render(width) 语义恒等，但返回内部引用（零拷贝）。
	 *
	 * ui-host 每帧要从行模型同时取：行序列、轮次起始表、思考/工具/压缩卡热区索引。
	 * 旧的 getter 们各自走一遍 ensureModel，同一帧内 assemble 重复执行 5 次（实测占
	 * 转录区每帧开销的 ~85%）。本方法让一帧只算一次；调用方约定：仅在当前帧内消费，
	 * 不得持有到下一帧或就地变更。
	 */
	getFrameModel(width: number): LineModel {
		return this.ensureModel(width);
	}

	render(width: number): string[] {
		return this.ensureModel(width).lines.slice();
	}

	getTimelineTurns(): Array<{ uid: number; n: number; userText: string }> {
		const result: Array<{ uid: number; n: number; userText: string }> = [];
		for (const t of this.historyTurns) {
			result.push({ uid: t.uid, n: t.n, userText: t.userText });
		}
		if (this.currentTurn) {
			result.push({ uid: this.currentTurn.uid, n: this.currentTurn.n, userText: this.currentTurn.userText });
		}
		return result;
	}

	/**
	 * 获取每一轮次在转录完整行序列中的起始行号映射表。
	 *
	 * 键是轮次的 uid（身份），不是 n（可能撞号的显示编号）。用 n 当键会让
	 * 同号轮次互相覆盖，表里只剩最后一个，▲/▼ 导航会整轮丢失、刻度跳错轮次。
	 */
	getTurnStartLinesByUid(width: number): Map<number, number> {
		return new Map(this.ensureModel(width).turnStartByUid);
	}

	/**
	 * 获取所有思考折叠行在完整行序列中的索引位置
	 */
	getThinkingLineIndices(width: number): ThinkingLineLocation[] {
		return this.ensureModel(width).thinkingLocations.slice();
	}

	/**
	 * 获取所有工具卡片行在完整行序列中的索引位置与元数据
	 */
	getToolLineIndices(width: number): ToolLineLocation[] {
		return this.ensureModel(width).toolLocations.slice();
	}

	/**
	 * 获取所有会话压缩卡片行在完整行序列中的索引位置与元数据
	 */
	getCompactionLineIndices(width: number): CompactionLineLocation[] {
		return this.ensureModel(width).compactionLocations.slice();
	}
}
