import type { ToolResultStatus } from "../../../core/types.js";
import type { ToolModel } from "../../../presentation/projection/tools.js";
import { renderToolBlock, type ToolCardRenderOptions } from "../../render-text.js";

/**
 * 工具卡片的 TUI 入口（G6 后降为薄适配器）。
 *
 * 渲染的唯一实现在 `src/ui/render-text.ts` 的 renderToolBlock（TUI 与 stdio 共用）；
 * 本文件保留旧的函数签名与既有消费者依赖的 re-export。
 */

export {
	applyCardBackground,
	BLACK_CIRCLE,
	CATEGORY_BY_TOOL,
	DIFF_BODY_MAX_LINES,
	displayName,
	extractSummaryArgs,
	foldTerminalCommand,
	GUTTER_FIRST,
	GUTTER_REST,
	getToolCategory,
	getToolCategoryColor,
	renderToolBlock,
	TEXT_BODY_MAX_LINES,
	TOOL_TONE_COLORS,
} from "../../render-text.js";

import { formatDuration as formatDurationBase } from "../../../presentation/copy.js";
/** 工具卡口径（precise）：950ms / 1.2s / 3m 5s。 */
export const formatDuration = (ms: number): string => formatDurationBase(ms, "precise");
export type { ToolCardRenderOptions, ToolCategory } from "../../render-text.js";

/** 旧签名适配：把散参组装成 ToolModel 后交给共享渲染。 */
export function formatToolCardLines(
	name: string,
	result: string,
	elapsedMs: number | undefined,
	width = 80,
	status: "running" | ToolResultStatus = "unknown",
	args?: unknown,
	options: ToolCardRenderOptions = {},
): string[] {
	const model: ToolModel = {
		name,
		args,
		status,
		result,
		...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
	};
	return renderToolBlock(model, width, options);
}
