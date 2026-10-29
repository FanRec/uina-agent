/**
 * 工具调用的平台中立展示模型（只读纯数据）。
 *
 * 名称、参数、状态、结果、错误、图片计数、耗时——渲染面（TUI/stdio 的
 * renderToolBlock、未来 Web 的组件）从这里取事实；解析与样式不属于本层。
 */

import type { ToolResultStatus } from "../../core/types.js";

export interface ToolModel {
	readonly name: string;
	readonly callId?: string;
	readonly args?: unknown;
	readonly status: "running" | ToolResultStatus;
	/** 原始结果文本（JSON 字符串或纯文本）；解析由渲染面负责。 */
	readonly result?: string;
	readonly durationMs?: number;
	/** 结果携带的图片数量（渲染面据此提示，不因自定义渲染丢附件）。 */
	readonly imageCount?: number;
}
