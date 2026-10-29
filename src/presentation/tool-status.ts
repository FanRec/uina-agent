/**
 * 工具终态展示矩阵：单一语义源，供 TUI 工具卡、stdio 结果行与后续展示面共用。
 *
 * 五态集合本身以 `core/types` 的 `TOOL_RESULT_STATUSES` 为准；本矩阵只描述展示语义
 * （图标/文案/语气/空输出文案），不携带 ANSI、颜色常量或宽度。
 * `running` 不在此矩阵内：它是进行态，由各 surface 用自己的动画表达。
 */

import type { ToolResultStatus } from "../core/types.js";

export type ToolTone = "success" | "error" | "warning" | "neutral";

export interface ToolStatusSpec {
	readonly icon: string;
	readonly label: string;
	readonly tone: ToolTone;
	/** 无结果输出时的正文。 */
	readonly emptyText: string;
}

export const TOOL_STATUS_SPEC: Record<ToolResultStatus, ToolStatusSpec> = {
	succeeded: { icon: "✓", label: "完成", tone: "success", emptyText: "执行完成，无输出" },
	failed: { icon: "✗", label: "失败", tone: "error", emptyText: "失败，无输出" },
	cancelled: { icon: "⊘", label: "已取消", tone: "warning", emptyText: "已取消，无输出" },
	unknown: { icon: "?", label: "结果未知", tone: "warning", emptyText: "结果未知" },
	not_started: { icon: "○", label: "未执行", tone: "neutral", emptyText: "未执行" },
};
