/**
 * 展示侧的表达语义视图（输出表达体系）：
 * - visibleAssistantText：从 canonical 原文 + 表达注解得出可见文字（剔除已识别标签，
 *   保留其他原文）。与 core/expression.ts 的 stripExpressionTags 同一规则——
 *   presentation core 只允许 type-only 依赖 core，因此本地镜像；等价性由
 *   tests/presentation-expression.test.ts 断言。
 * - speechSayUtterance：`speech.say` 的可见表达唯一来源是已提交的 Canonical Tool
 *   Result 的 details.speech；没有该事实的历史不推断曾经说过。
 */

import type { ExpressionAnnotation } from "../core/expression.js";

/** 从原文剔除已识别表达标签的语法字节，保留其余原文；没有注解原样返回。 */
export function visibleAssistantText(content: string, annotation?: ExpressionAnnotation): string {
	if (!annotation || annotation.tags.length === 0) return content;
	const ranges = annotation.tags
		.map((tag) => ("rawRange" in tag ? tag.rawRange : undefined))
		.filter((range): range is readonly [number, number] => range !== undefined)
		.sort((a, b) => a[0] - b[0]);
	if (ranges.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start < cursor) continue;
		result += content.slice(cursor, start);
		cursor = Math.min(end, content.length);
	}
	result += content.slice(cursor);
	return result;
}

/** speech.say 受理事实（tool result details.speech，version 1）的形状。 */
export interface SpeechSayUtterance {
	readonly utteranceId: string;
	readonly text: string;
}

/**
 * 从已提交的 Tool Result 派生 speech.say 的可见表达；仅当工具真实受理
 * （details.speech.accepted === true）时返回文字。失败、未受理、未开始不生成
 * “已说”文字；旧无 details.speech 的历史不推断曾经说过。
 */
export function speechSayUtterance(toolName: string, args: unknown, details: unknown): SpeechSayUtterance | null {
	if (toolName !== "speech") return null;
	if (!args || typeof args !== "object" || (args as { action?: unknown }).action !== "say") return null;
	if (!details || typeof details !== "object") return null;
	const speech = (details as { speech?: unknown }).speech;
	if (!speech || typeof speech !== "object") return null;
	const record = speech as { version?: unknown; utteranceId?: unknown; text?: unknown; accepted?: unknown };
	if (record.version !== 1 || record.accepted !== true) return null;
	if (typeof record.utteranceId !== "string" || record.utteranceId.length === 0) return null;
	if (typeof record.text !== "string" || record.text.length === 0) return null;
	return { utteranceId: record.utteranceId, text: record.text };
}
