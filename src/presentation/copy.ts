/**
 * 文案与格式化的平台中立层（W6/I6）。
 *
 * 只做常量与纯函数：术语、状态词、耗时格式、错误可读化。不含 ANSI、
 * 宽度或终端判断——TUI/stdio 各自把文案嵌进自己的渲染，Web 未来直接复用。
 */

/** 统一耗时格式：compact（5s / 3m12s，状态头用）与 precise（950ms / 1.2s，工具卡用）。 */
export function formatDuration(ms: number, style: "compact" | "precise" = "compact"): string {
	const safe = Math.max(0, ms);
	if (style === "precise") {
		if (safe < 1000) return `${Math.round(safe)}ms`;
		const s = safe / 1000;
		if (s < 60) return `${s.toFixed(1)}s`;
		const m = Math.floor(s / 60);
		return `${m}m ${Math.round(s % 60)}s`;
	}
	const seconds = Math.floor(safe / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * 错误的可读化（C20）：不输出 `String(error)` 的 "[object Object]" 或裸构造器名。
 * Error 取 message；字符串原样；其余结构化值 JSON 摘要；兜底 String。
 */
export function toReadableError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null) {
		try {
			const json = JSON.stringify(error);
			if (json && json !== "{}" && json !== "[]") return json;
		} catch {
			// 循环引用等序列化失败：落到 String
		}
	}
	return String(error);
}
