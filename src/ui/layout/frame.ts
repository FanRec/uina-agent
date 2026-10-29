/**
 * 帧几何纯函数（Bottom-Pinned Frame Engine 的唯一几何事实源）。
 *
 * computeFrame 的输入是已渲染的行序列与纯数据，输出是纯几何；
 * UIHost 只负责装配（渲染各区域、喂入滚动状态），不再持有布局算术。
 * 渲染、滚动、热区命中共用同一份 FrameLayout，口径不得分叉。
 */

import type { LineModel } from "../components/transcript/transcript.js";

export interface FrameLayout {
	width: number;
	height: number;
	hasGutter: boolean;
	innerW: number;
	inputWidth: number;
	inputLines: string[];
	inputH: number;
	belowLines: string[];
	belowH: number;
	maxAboveH: number;
	overlayLines: string[];
	suggestionLines: string[];
	pendingLines: string[];
	aboveLines: string[];
	aboveH: number;
	bannerLines: string[];
	bannerCount: number;
	transcriptLines: string[];
	permanentLines: string[];
	totalPerm: number;
	safeW: number;
	transcriptContentW: number;
	transcriptH: number;
	maxScroll: number;
	effScroll: number;
	scrollStart: number;
	visibleTranscript: string[];
	/** 帧内单一行模型（转录区原始引用，仅当帧有效）。 */
	frameModel: LineModel;
}

export interface FrameInput {
	width: number;
	height: number;
	inputLines: readonly string[];
	contextBarLines: readonly string[];
	footerLines: readonly string[];
	belowWidgetLines: readonly string[];
	aboveWidgetLines: readonly string[];
	/** 浮层行依赖 maxAboveH（几何内部值），由装配方以回调渲染。 */
	renderOverlays: (innerW: number, maxAboveH: number) => readonly string[];
	hasVisibleOverlay: boolean;
	suggestionLines: readonly string[];
	pendingLines: readonly string[];
	bannerLines: readonly string[];
	transcriptLines: readonly string[];
	frameModel: LineModel;
	scrollOffset: number;
	reserveGutter: boolean;
}

/**
 * 单次帧几何：对 scrollOffset 只读（报告钳制值，不回写），
 * 渲染、scrollToTurn、preserveScrollAnchor、热区命中因此不能互相漂移。
 */
export function computeFrame(input: FrameInput): FrameLayout {
	const { width, height } = input;
	const innerW = width;

	// The input line keeps one safety column so the terminal never wraps it.
	const inputWidth = Math.max(2, innerW - 1);
	const inputLines = [...input.inputLines];
	const inputH = inputLines.length;

	const contextBarLines = [...input.contextBarLines];
	// The footer slot is a real frame region: extensions that call setFooter()
	// must see it, otherwise the API silently does nothing.
	const footerLines = [...input.footerLines];
	const belowLines = [...contextBarLines, ...input.belowWidgetLines, ...footerLines];
	const belowH = belowLines.length;

	const aboveEditorWidgets = [...input.aboveWidgetLines];
	const maxAboveH = Math.max(0, height - inputH - belowH - 1);
	const overlayLines = [...input.renderOverlays(innerW, maxAboveH)];

	const suggestionLines =
		input.hasVisibleOverlay || input.suggestionLines.length === 0 ? [] : [...input.suggestionLines];
	const pendingLines = input.hasVisibleOverlay || input.pendingLines.length === 0 ? [] : [...input.pendingLines];

	// The stack is ordered top → editor-adjacent; when the budget is exceeded
	// keep the lines closest to the input box instead of the far ones, and make
	// the overflow visible instead of silently dropping rows (audit C18).
	const aboveRaw = [...aboveEditorWidgets, ...overlayLines, ...suggestionLines, ...pendingLines];
	const hiddenAbove = Math.max(0, aboveRaw.length - Math.max(0, maxAboveH - 1));
	const aboveLines =
		aboveRaw.length > maxAboveH
			? maxAboveH >= 1
				? [
						`… 上方还有 ${hiddenAbove} 行未显示（浮层/部件超出高度预算）`,
						...aboveRaw.slice(aboveRaw.length - maxAboveH + 1),
					]
				: []
			: aboveRaw;
	const aboveH = aboveLines.length;

	const breathingGap = 1;
	const transcriptH = Math.max(0, height - inputH - belowH - aboveH - breathingGap);
	const safeW = input.reserveGutter ? Math.max(20, innerW - 1) : innerW;
	const transcriptContentW = Math.max(18, input.reserveGutter ? safeW - 2 : innerW - 1);
	const bannerLines = [...input.bannerLines];
	const transcriptLines = [...input.transcriptLines];
	// 帧内单一行模型：一次产出，行序列与热区索引全部同源
	const permanentLines = [...bannerLines, ...transcriptLines];
	const totalPerm = permanentLines.length;
	const maxScroll = Math.max(0, totalPerm - transcriptH);

	const effScroll = totalPerm <= transcriptH ? 0 : Math.max(0, Math.min(input.scrollOffset, maxScroll));
	const scrollStart = totalPerm <= transcriptH ? 0 : totalPerm - transcriptH - effScroll;
	const visibleTranscript =
		totalPerm <= transcriptH
			? [...permanentLines, ...new Array(transcriptH - totalPerm).fill("")]
			: permanentLines.slice(scrollStart, scrollStart + transcriptH);

	return {
		width,
		height,
		hasGutter: input.reserveGutter && maxScroll > 0,
		innerW,
		inputWidth,
		inputLines,
		inputH,
		belowLines,
		belowH,
		maxAboveH,
		overlayLines,
		suggestionLines,
		pendingLines,
		aboveLines,
		aboveH,
		bannerLines,
		bannerCount: bannerLines.length,
		transcriptLines,
		permanentLines,
		totalPerm,
		safeW,
		transcriptContentW,
		transcriptH,
		maxScroll,
		effScroll,
		scrollStart,
		visibleTranscript,
		frameModel: input.frameModel,
	};
}
