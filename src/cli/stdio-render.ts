/**
 * stdio/print 消费者的事件 → 文本格式化（纯函数：返回字符串，不直接写 stdout）。
 * 从 cli/app.ts 的 renderStdio 拆出：文案与样式决策可单测；app.ts 负责
 * tool_call/tool_result 的 startedAt 记账与最终写盘。
 */
import type { HostEvent } from "../host/events.js";
import { sanitizeTerminalText, toolStartLine, toolResultLines, type ToolResultStyle } from "../ui/format.js";

const PLAIN_STYLE: ToolResultStyle = {
	ok: (value) => value,
	err: (value) => value,
	warn: (value) => value,
	dim: (value) => value,
};

type LineFormatter = (message: HostEvent) => string | null;

/** 非 tool 事件的单行格式化表（键按事件类型收窄参数；未注册类型返回 null = 无输出）。 */
const STDIO_LINES: {
	[K in HostEvent["type"]]?: (m: Extract<HostEvent, { type: K }>) => string | null;
} = {
	output_update: (m) => (m.channel !== "content" ? null : sanitizeTerminalText(m.text)),
	turn_start: (m) => `\n${m.userText ? `你 > ${m.userText}\n` : ""}Uina > `,
	turn_end: () => "\n",
	session_rewind: (m) => `\n[会话回溯] ${m.fromId} → ${m.targetId}；退出路径只读，外部状态未撤销。\n`,
	notice: (m) => `\n⚠ ${m.text}\n`,
	provider_retry: (m) => `\n⚠ ${m.provider} 连接失败（${m.status === undefined ? m.reason : `HTTP ${m.status}`}），${(m.delayMs / 1000).toFixed(1)} 秒后重试，第 ${m.attempt} 次\n`,
	provider_recovered: (m) => `\n✓ ${m.provider} 已恢复连接，继续当前请求\n`,
	turn_aborted: () => "\n[已打断]\n",
	error: (m) => `[错误] ${m.text}\n`,
};

/** 非 tool 事件的文本行；tool 事件与未注册类型返回 null。 */
export function formatStdioEventLine(message: HostEvent): string | null {
	// 运行时键与 formatter 参数类型一一对应（表定义按 Extract 收窄），此处统一放宽
	const format = STDIO_LINES[message.type] as LineFormatter | undefined;
	return format ? format(message) : null;
}

export function formatToolCallLine(message: Extract<HostEvent, { type: "tool_call" }>): string {
	return `\n  ⏳ ${toolStartLine(message.toolName, message.args)}`;
}

/** 工具结果块：可选图片行 + 状态行 + 折叠结果行（elapsed 由调用方按 startedAt 计）。 */
export function formatToolResultBlock(
	message: Extract<HostEvent, { type: "tool_result" }>,
	elapsedMs: number,
): string {
	const parts: string[] = [];
	if (message.images?.length) {
		parts.push("\n  [图片: " + message.images.map((image) => image.alt ?? image.mimeType).join(", ") + "]");
	}
	parts.push(`\n  ${message.status === "succeeded" ? "✓" : "!"} ${message.toolName}`);
	for (const line of toolResultLines(message.result, elapsedMs, PLAIN_STYLE)) {
		parts.push(`\n    ${line}`);
	}
	return parts.join("");
}
