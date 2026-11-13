/**
 * stdio/print 消费者的事件 → 文本格式化（纯函数：返回字符串，不直接写 stdout）。
 * 从 cli/app.ts 的 renderStdio 拆出：文案与样式决策可单测；app.ts 负责
 * 按 HostEventRecord.at 记账工具耗时与最终写盘。
 *
 * G6：工具卡与 TUI 同源——同一 ToolModel 经 renderToolBlock 输出一致快照。
 */
import type { HostEvent } from "../host/events.js";
import type { ToolModel } from "../presentation/projection/tools.js";
import { sanitizeTerminalText } from "../ui/format.js";
import { renderToolBlock } from "../ui/render-text.js";

type LineFormatter = (message: HostEvent) => string | null;

/** 非 tool 事件的单行格式化表（键按事件类型收窄参数；未注册类型返回 null = 无输出）。 */
const STDIO_LINES: {
	[K in HostEvent["type"]]?: (m: Extract<HostEvent, { type: K }>) => string | null;
} = {
	// 模型 content 的可见正文只来自 expression 语义事件；原始 delta 仅用于记录诊断。
	expression: (m) => (m.event.kind === "text" ? sanitizeTerminalText(m.event.text) : null),
	turn_start: (m) => `\n${m.userText ? `你 > ${m.userText}\n` : ""}Uina > `,
	turn_end: () => "\n",
	session_rewind: (m) => `\n[会话回溯] ${m.fromId} → ${m.targetId}；退出路径只读，外部状态未撤销。\n`,
	notice: (m) => `\n⚠ ${m.text}\n`,
	provider_retry: (m) =>
		`\n⚠ ${m.provider} 连接失败（${m.status === undefined ? m.reason : `HTTP ${m.status}`}），${(m.delayMs / 1000).toFixed(1)} 秒后重试，第 ${m.attempt} 次\n`,
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
	const model: ToolModel = {
		name: message.toolName,
		args: message.args,
		status: "running",
	};
	const block = renderToolBlock(model, 100, { startedAt: 0, now: 0 });
	return `\n${block.join("\n")}`;
}

/** 工具结果块：与 TUI 共用 renderToolBlock（elapsed 由调用方按 record.at 两端计）。 */
export function formatToolResultBlock(
	message: Extract<HostEvent, { type: "tool_result" }>,
	elapsedMs: number | undefined,
): string {
	const model: ToolModel = {
		name: message.toolName,
		args: message.args,
		status: message.status,
		result: message.result,
		...(message.images?.length ? { imageCount: message.images.length } : {}),
		...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
	};
	const block = renderToolBlock(model, 100);
	return `\n${block.join("\n")}`;
}
