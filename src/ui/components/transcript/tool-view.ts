import type { ToolResultStatus } from "../../../core/types.js";
/**
 * 工具调用状态与结果卡片组件（完美对齐 dsh-TUI / Claude Code 工具呈现规范）。
 *
 * 核心特性：
 * 1. 运行中生命感：
 *    - 600ms 同步心跳呼吸实心大圆点 ●（BLACK_CIRCLE）；
 *    - 1 秒挂钟实时累加秒表（· 1s, · 2s）；
 *    - 终端多行脚本命令首行折叠 + (… +N lines) 保护；
 * 2. 状态机与几何突变：
 *    - 运行中：呼吸闪烁 ●；
 *    - 已结算（完成）：静止小圆点 •（BULLET），被赋予工具类别语义色；
 *    - 异常/失败：几何形状突变为红色乘号 ✗（MULTIPLICATION_X），高亮错误与 Exit code；
 * 3. 悬挂层级与极简折叠：
 *    - 首行采用 ⎿ (GUTTER_FIRST: ' ⎿ ') 悬挂折角，后续行采用 3 空格延续 (GUTTER_REST: '   ')；
 *    - 正常退出隐去 exitCode: 0 噪点，非零或异常时显式标红；
 *    - 文本类输出 3 行预算折叠，Diff 代码变更 8 行预算折叠，单行溢出直显不折叠；
 *    - 最新失败单例追加 '⎿ Alt+T 查看轨迹'；
 * 4. 五维工具分类色彩语义学（Category Colors）：
 *    - write: 暖金 (Warm Gold) —— 写/修改文件
 *    - exec: 雾青 (Mist Cyan) —— 执行命令行
 *    - read: 沉静蓝 (Brand Blue) —— 查看/搜索文件
 *    - web: 天蓝/薄荷绿 (Web Teal) —— 网络请求/浏览器
 *    - task: 紫罗兰 (Violet) —— 子代理/后台任务
 * 5. 交互与双模展开：
 *    - 支持单卡折叠/展开与全局 Ctrl+O 展开；
 *    - 鼠标悬停感知：卡片底色微亮、折叠角标 ▾/▴ 浮现、折叠提示文字由暗淡升格为明亮。
 */

import { C, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { formatDiffCardLines } from "./diff-view.js";

export type ToolCategory = "write" | "exec" | "read" | "web" | "task" | "default";

export const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
	// write / mutate (Warm Gold / Amber)
	write: "write",
	write_file: "write",
	edit: "write",
	write_to_file: "write",
	replace_file_content: "write",
	str_replace_editor: "write",
	multiedit: "write",
	notebookedit: "write",
	apply_patch: "write",

	// exec (Mist Cyan)
	exec_command: "exec",
	execute_command: "exec",
	exec: "exec",
	run_command: "exec",
	bash: "exec",
	powershell: "exec",
	pwsh: "exec",
	sh: "exec",
	shell: "exec",
	terminal: "exec",
	cmd: "exec",
	command: "exec",

	// read (Brand Blue)
	read: "read",
	view_file: "read",
	read_file: "read",
	read_image: "read",
	get_time: "read",
	session_list: "read",
	session_read: "read",
	grep: "read",
	grep_search: "read",
	glob: "read",
	search: "read",
	find_by_name: "read",
	list_dir: "read",
	dir_list: "read",

	// web (Teal / Sky Blue)
	search_web: "web",
	web_search: "web",
	read_url_content: "web",
	web_fetch: "web",
	browser: "web",
	fetch: "web",

	// task (Violet / Purple)
	invoke_subagent: "task",
	manage_subagents: "task",
	subagent: "task",
	manage_task: "task",
	schedule: "task",
	define_subagent: "task",
	job: "task",
	job_list: "task",
	job_output: "task",
	job_kill: "task",
	subagent_start: "task",
	subagent_list: "task",
	subagent_status: "task",
	subagent_output: "task",
	subagent_messages: "task",
	subagent_send: "task",
	subagent_interrupt: "task",
	workflow: "task",
};

export function getToolCategory(toolName: string): ToolCategory {
	return CATEGORY_BY_TOOL[toolName.toLowerCase()] ?? "default";
}

/** 工具名称在各类别下的品牌主题色 */
export function getToolCategoryColor(category: ToolCategory): string {
	switch (category) {
		case "write":
			return C.toolDotWrite || "\x1b[38;2;216;178;112m"; // Warm Gold
		case "exec":
			return C.toolDotExec || "\x1b[38;2;127;174;153m"; // Mist Cyan
		case "read":
			return C.toolDotRead || "\x1b[38;2;130;184;199m"; // Mist Blue
		case "web":
			return C.toolDotWeb || "\x1b[38;2;125;161;222m"; // Sky/Teal
		case "task":
			return C.toolDotTask || "\x1b[38;2;209;148;174m"; // Violet
		default:
			return C.iceBlue || "\x1b[38;2;171;194;236m";
	}
}

/** 格式化工具显示名称（对齐 Claude Code 大驼峰规范） */
export function displayName(rawName: string): string {
	const KNOWN: Record<string, string> = {
		bash: "Bash",
		powershell: "PowerShell",
		pwsh: "PowerShell",
		exec_command: "Exec",
		execute_command: "Exec",
		exec: "Exec",
		run_command: "RunCommand",
		read: "Read",
		read_file: "Read",
		read_image: "ReadImage",
		view_file: "ViewFile",
		glob: "Glob",
		grep: "Grep",
		grep_search: "Grep",
		write: "Write",
		write_file: "Write",
		write_to_file: "Write",
		edit: "Edit",
		replace_file_content: "Edit",
		str_replace_editor: "Edit",
		multiedit: "MultiEdit",
		subagent: "Task",
		invoke_subagent: "Subagent",
		manage_subagents: "Subagents",
		manage_task: "ManageTask",
		search_web: "WebSearch",
		read_url_content: "ReadUrl",
		schedule: "Schedule",

		// Uina 自有工具（dsh/Claude Code 别名表之外的本地工具名）
		get_time: "GetTime",
		session_list: "SessionList",
		session_read: "SessionRead",
		session_rewind: "SessionRewind",
		job_list: "JobList",
		job_output: "JobOutput",
		job_kill: "JobKill",
		subagent_start: "SubagentStart",
		subagent_list: "SubagentList",
		subagent_status: "SubagentStatus",
		subagent_output: "SubagentOutput",
		subagent_messages: "SubagentMessages",
		subagent_send: "SubagentSend",
		subagent_interrupt: "SubagentInterrupt",
	};
	const mapped = KNOWN[rawName.toLowerCase()];
	if (mapped) return mapped;
	if (rawName.length === 0) return rawName;
	// 兜底：按 _ / - / 空格切词再大驼峰，避免未登记的新工具显示成 "Get_time"
	return rawName
		.split(/[_\-\s]+/)
		.filter((part) => part.length > 0)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

/** 时间格式化（<1s 显示 ms，>=1s 显示 1 位小数秒） */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const remS = Math.round(s % 60);
	return `${m}m ${remS}s`;
}

/** 折叠行数预算（CC 规范：文本 3 行，Diff 8 行） */
export const TEXT_BODY_MAX_LINES = 3;
export const DIFF_BODY_MAX_LINES = 8;

export const GUTTER_FIRST = " ⎿ ";
export const GUTTER_REST = "   ";

export const BLACK_CIRCLE = "●";
export const BULLET = "•";
export const MULTIPLICATION_X = "✗";

export interface ToolCardRenderOptions {
	isExpanded?: boolean;
	isHovered?: boolean;
	isNewestFailure?: boolean;
	startedAt?: number;
	now?: number;
	diffLayout?: "auto" | "split" | "unified";
	verbose?: boolean;
}

/** 解析多行命令标题并折叠为首行 */
export function foldTerminalCommand(cmd: string): { first: string; hidden: number } | undefined {
	const normalized = cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const firstNl = normalized.indexOf("\n");
	if (firstNl === -1) return undefined;
	const lines = normalized.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length <= 1) return undefined;
	return {
		first: lines[0]!.trim(),
		hidden: lines.length - 1,
	};
}

/** 提取参数中的主要指令或文件路径 */
export function extractSummaryArgs(_name: string, args: unknown): { summary: string; isMultiLine: boolean; full: string } {
	if (!args) return { summary: "", isMultiLine: false, full: "" };
	let parsedArgs = args;
	if (typeof args === "string") {
		const trimmed = args.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				parsedArgs = JSON.parse(trimmed);
			} catch {}
		}
	}

	let raw = "";
	if (typeof parsedArgs === "object" && parsedArgs !== null) {
		const rec = parsedArgs as Record<string, unknown>;
		if (typeof rec.CommandLine === "string") raw = rec.CommandLine;
		else if (typeof rec.command === "string") raw = rec.command;
		else if (typeof rec.cmd === "string") raw = rec.cmd;
		else if (typeof rec.path === "string") raw = rec.path;
		else if (typeof rec.file_path === "string") raw = rec.file_path;
		else if (typeof rec.TargetFile === "string") raw = rec.TargetFile;
		else if (typeof rec.AbsolutePath === "string") raw = rec.AbsolutePath;
		else if (typeof rec.query === "string") raw = rec.query;
		else if (typeof rec.Query === "string") raw = rec.Query;
		else if (typeof rec.pattern === "string") raw = rec.pattern;
		else if (typeof rec.Pattern === "string") raw = rec.Pattern;
		else if (typeof rec.prompt === "string") raw = rec.prompt;
		else if (typeof rec.Prompt === "string") raw = rec.Prompt;
		else {
			try {
				raw = JSON.stringify(parsedArgs);
				if (raw === "{}") raw = "";
			} catch {
				raw = String(parsedArgs);
			}
		}
	} else {
		raw = String(parsedArgs);
	}

	const full = sanitizeRenderText(raw).trim();
	const isMultiLine = full.includes("\n");
	return { summary: full, isMultiLine, full };
}

/** 提取结果中的文件 Diff 信息（若存在） */
function extractDiff(args: unknown, resultObj: Record<string, unknown> | null): { oldText: string; newText: string; filename: string } | null {
	// 1. 如果结果对象直接包含了 diff 字段
	if (resultObj) {
		if (typeof resultObj.oldText === "string" && typeof resultObj.newText === "string") {
			const filename = typeof resultObj.filename === "string" ? resultObj.filename : (resultObj.path as string) || "file";
			return { oldText: resultObj.oldText, newText: resultObj.newText, filename };
		}
	}
	// 2. 如果参数里有 replace_file_content / edit 特征
	if (args && typeof args === "object") {
		const rec = args as Record<string, unknown>;
		if (typeof rec.TargetContent === "string" && typeof rec.ReplacementContent === "string") {
			const filename = String(rec.TargetFile || rec.path || "file");
			return { oldText: rec.TargetContent, newText: rec.ReplacementContent, filename };
		}
	}
	return null;
}

/** 结构化值 → 单行文本：对象/数组走 JSON，绝不渲染成 "[object Object]" */
function formatStructuredValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	// 值里的换行会撑破卡片的 ⎿ 悬挂缩进，单行化后再交给折叠预算
	return String(value).replace(/\r?\n/g, "⏎ ");
}

/**
 * 为终端文本行应用整行卡片背景色（完美对齐 dsh-TUI 悬停高亮与微卡片设计）。
 *
 * 核心设计：
 * 1. 自动根据终端可视列宽计算并填充行尾空格（Padding to targetWidth），确保背景铺满整张卡片横向宽度；
 * 2. 拦截并重写行内的 ANSI Reset 控制码（\x1b[0m / \x1b[m），立即重新注入背景色转义序列，
 *    彻底根治“ANSI reset 导致背景断裂成前缀小色块”的终端渲染顽疾；
 * 3. 尊重终端双字节全角字符（CJK）与 Emoji 宽度，绝不产生对齐错位。
 */
export function applyCardBackground(line: string, bg: string, width: number): string {
	if (!bg) return line;
	const curW = visibleWidth(line);
	const effLine = curW > width ? truncateToWidth(line, width, "…") : line;
	const effW = curW > width ? visibleWidth(effLine) : curW;
	const padLen = Math.max(0, width - effW);
	const padding = " ".repeat(padLen);

	const patched = effLine
		.replace(/\x1b\[0?m/g, `\x1b[0m${bg}`)
		.replace(/\x1b\[49m/g, bg);

	return `${bg}${patched}${padding}${C.reset}`;
}

function finishCard(lines: string[], isHovered: boolean, width: number): string[] {
	const flattenedLines: string[] = [];
	for (const line of lines) {
		if (line.includes("\n")) {
			for (const sub of line.split("\n")) {
				flattenedLines.push(sub);
			}
		} else {
			flattenedLines.push(line);
		}
	}

	const out: string[] = [];
	for (const line of flattenedLines) {
		// 软换行先于底色：hover 只改样式不改内容，两态行数恒等（反抖动）。
		// 若先上色再截断，超宽行会被拍平成单行加 …，hover 前后状态不一致。
		const wrapped = wrapTextWithAnsi(line, width);
		for (const frag of wrapped) {
			out.push(isHovered ? applyCardBackground(frag, C.toolCardBackground, width) : frag);
		}
	}
	out.push("");
	return out;
}

/**
 * 格式化渲染单张工具卡片的所有行
 */
export function formatToolCardLines(
	name: string,
	result: string,
	elapsedMs: number,
	width = 80,
	status: "running" | ToolResultStatus = "unknown",
	args?: unknown,
	options: ToolCardRenderOptions = {},
): string[] {
	name = sanitizeRenderText(name);
	result = sanitizeRenderText(result);
	const maxW = Math.max(24, width);
	const category = getToolCategory(name);
	const catColor = getToolCategoryColor(category);
	const toolDisplayName = displayName(name);
	const isExpanded = Boolean(options.isExpanded || options.verbose);
	const isHovered = Boolean(options.isHovered);
	const now = options.now ?? Date.now();
	const isRunning = status === "running";
	const isError = status === "failed";
	// ToolResultStatus has five outcomes; only "succeeded" may look like success.
	const isUnconfirmed = status === "unknown" || status === "cancelled" || status === "not_started";

	// 1. 呼吸灯与指示图标 (ToolUseLoader)
	let iconStr = "";
	if (isError) {
		iconStr = `${C.red}${MULTIPLICATION_X}${C.reset} `;
	} else if (isUnconfirmed) {
		// Never render an unconfirmed outcome with the success bullet.
		iconStr = `${C.warning}?${C.reset} `;
	} else if (isRunning) {
		const isBlinkVisible = Math.floor(now / 600) % 2 === 0;
		const char = isBlinkVisible ? BLACK_CIRCLE : " ";
		iconStr = `${C.dim}${char}${C.reset} `;
	} else {
		iconStr = `${catColor}${BULLET}${C.reset} `;
	}

	// 2. 标题行参数解析与多行折叠
	const { summary: argSummary, isMultiLine: argIsMultiLine } = extractSummaryArgs(name, args);
	let displayArg = argSummary;
	let argFoldHint = "";

	if (argIsMultiLine && !isExpanded) {
		const folded = foldTerminalCommand(argSummary);
		if (folded) {
			displayArg = folded.first;
			argFoldHint = ` ${C.dim}… +${folded.hidden} lines (ctrl+o to expand)${C.reset}`;
		}
	}

	// 单行参数超长截断仅在收起态生效；展开态全文交由 finishCard 软换行（信息零丢失）
	const HEADER_ARGS_BUDGET = 120;
	if (!isExpanded && displayArg.length > HEADER_ARGS_BUDGET) {
		displayArg = `${displayArg.slice(0, HEADER_ARGS_BUDGET - 1)}…`;
	}

	// 3. 耗时字符串与秒表
	let elapsedText = "";
	if (isRunning) {
		const runMs = options.startedAt ? Math.max(0, now - options.startedAt) : elapsedMs;
		elapsedText = ` · ${formatDuration(runMs)}`;
	} else if (elapsedMs > 0) {
		elapsedText = ` · ${formatDuration(elapsedMs)}`;
	}

	const statusSuffix = status === "cancelled" ? " · 已取消" : status === "unknown" ? " · 结果未知" : status === "not_started" ? " · 未执行" : "";
	const statusColor = isError ? C.error : isUnconfirmed ? C.warning : C.dim;
	const elapsedColor = isHovered ? C.text : C.dim;
	const hoverIndicator = isHovered ? (isExpanded ? ` ${C.dim}▴${C.reset}` : ` ${C.dim}▾${C.reset}`) : "";

	// 组装标题行：● Name(args) · 1.2s ▾
	let titleContent = "";
	if (displayArg) {
		const isCmd = category === "exec";
		const parenOpen = isCmd ? "(" : " ";
		const parenClose = isCmd ? ")" : "";
		titleContent = `${C.bold}${catColor}${toolDisplayName}${C.reset}${C.dim}${parenOpen}${C.reset}${displayArg}${argFoldHint}${C.dim}${parenClose}${C.reset}`;
	} else {
		titleContent = `${C.bold}${catColor}${toolDisplayName}${C.reset}`;
	}

	const headerSuffix = `${elapsedColor}${elapsedText}${C.reset}${statusSuffix ? `${statusColor}${statusSuffix}${C.reset}` : ""}${hoverIndicator}`;
	const headerLine = `${iconStr}${titleContent}${headerSuffix}`;

	// 4. 解析结果体 (Body lines)
	let obj: Record<string, unknown> | null = null;
	try {
		obj = typeof result === "string" ? (JSON.parse(result) as Record<string, unknown>) : (result as Record<string, unknown>);
	} catch {
		obj = null;
	}

	const cardLines: string[] = [headerLine];

	// 5. 运行中且暂无输出时：显示呼吸占位
	if (isRunning && (!result || result.trim() === "")) {
		const runMs = options.startedAt ? Math.max(0, now - options.startedAt) : elapsedMs;
		const runLine = `${C.dim}${GUTTER_FIRST}Running… (${formatDuration(runMs)})${C.reset}`;
		cardLines.push(runLine);
		return finishCard(cardLines, isHovered, maxW);
	}

	// 6. 检查是否为 Diff 视图
	const diffInfo = extractDiff(args, obj);
	if (diffInfo) {
		const diffLines = formatDiffCardLines(
			diffInfo.oldText,
			diffInfo.newText,
			diffInfo.filename,
			!isExpanded,
			maxW - 4,
		);
		for (const dl of diffLines) {
			cardLines.push(`   ${dl}`);
		}
		if (options.isNewestFailure) {
			cardLines.push(`   ${C.subtle}⎿ Alt+T 查看轨迹${C.reset}`);
		}
		return finishCard(cardLines, isHovered, maxW);
	}

	// 7. 处理执行失败或取消状态
	if (obj && obj.cancelled) {
		cardLines.push(`${C.yellow}${GUTTER_FIRST}⚠ 操作已取消${C.reset}`);
		return finishCard(cardLines, isHovered, maxW);
	}

	const rawError = isError
		? (obj && typeof obj.error === "string" ? obj.error : String(result || "执行遇到错误"))
		: (obj && typeof obj.error === "string" ? obj.error : "");

	if (rawError) {
		const errClean = rawError.replace(/\r/g, "").trim();
		const errLines = errClean.split("\n").map((l) => l.trimEnd()).filter(Boolean);
		for (let i = 0; i < errLines.length; i++) {
			const gutter = i === 0 ? GUTTER_FIRST : GUTTER_REST;
			cardLines.push(`${C.red}${gutter}${errLines[i]!}${C.reset}`);
		}
		if (options.isNewestFailure) {
			cardLines.push(`   ${C.subtle}⎿ Alt+T 查看轨迹${C.reset}`);
		}
		return finishCard(cardLines, isHovered, maxW);
	}

	// 8. 正常输出体提取与格式化
	const bodyLines: string[] = [];

	if (obj && typeof obj === "object") {
		// 非零退出码标红
		const exitCode = typeof obj.code === "number" ? obj.code : typeof obj.exitCode === "number" ? obj.exitCode : 0;
		if (exitCode !== 0) {
			bodyLines.push(`${C.red}Exit code ${exitCode}${C.reset}`);
		}
		if (obj.signal) {
			bodyLines.push(`${C.red}Killed by signal ${String(obj.signal)}${C.reset}`);
		}

		const stdout = typeof obj.stdout === "string" ? obj.stdout.replace(/\r/g, "").trim() : "";
		const stderr = typeof obj.stderr === "string" ? obj.stderr.replace(/\r/g, "").trim() : "";
		const output = typeof obj.output === "string" ? obj.output.replace(/\r/g, "").trim() : "";

		if (stdout) {
			bodyLines.push(...stdout.split("\n").map((s) => s.trimEnd()));
		} else if (output) {
			bodyLines.push(...output.split("\n").map((s) => s.trimEnd()));
		}

		if (stderr) {
			const errs = stderr.split("\n").map((s) => s.trimEnd());
			for (const errLine of errs) {
				bodyLines.push(`${C.red}${errLine}${C.reset}`);
			}
		}

		if (!stdout && !output && !stderr && exitCode === 0) {
			const skipKeys = new Set(["code", "exitCode", "elapsedMs", "status", "cancelled"]);
			if (Array.isArray(obj)) {
				// 结构化列表（session_list / job_list / subagent_list …）每项独占一行，
				// 交给折叠预算处理，而不是渲染成 "0: [object Object]"。
				if (obj.length === 0) {
					bodyLines.push(`${C.dim}[]${C.reset}`);
				} else {
					for (const item of obj) {
						bodyLines.push(formatStructuredValue(item));
					}
				}
			} else {
				const customKeys = Object.keys(obj).filter((k) => !skipKeys.has(k));
				if (customKeys.length > 0) {
					const summary = customKeys
						.slice(0, 3)
						.map((k) => `${k}: ${formatStructuredValue(obj![k]).slice(0, 40)}`)
						.join(", ");
					bodyLines.push(`${C.dim}${summary}${C.reset}`);
				}
			}
		}
	} else {
		const rawStr = String(result ?? "").replace(/\r/g, "").trim();
		if (rawStr) {
			bodyLines.push(...rawStr.split("\n").map((s) => s.trimEnd()));
		}
	}

	// 9. 行数预算裁剪 (3 行预算，溢出 1 行直显)
	const budget = TEXT_BODY_MAX_LINES;
	let visibleLines: string[] = [];
	let hiddenCount = 0;

	if (isExpanded || bodyLines.length <= budget) {
		visibleLines = bodyLines;
	} else if (bodyLines.length - budget === 1) {
		// 单行溢出容差直接显示（dsh-TUI / CC 经典交互规范）
		visibleLines = bodyLines;
	} else {
		visibleLines = bodyLines.slice(0, budget);
		hiddenCount = bodyLines.length - budget;
	}

	// 10. 挂载 ⎿ 悬挂缩进输出
	if (visibleLines.length === 0) {
		cardLines.push(`${C.dim}${GUTTER_FIRST}(执行完成，无输出)${C.reset}`);
	} else {
		for (let i = 0; i < visibleLines.length; i++) {
			const gutter = i === 0 ? GUTTER_FIRST : GUTTER_REST;
			const text = visibleLines[i]!;
			const full = `${C.dim}${gutter}${C.reset}${text}`;
			cardLines.push(full);
		}

		if (hiddenCount > 0) {
			const hintColor = isHovered ? C.text : C.dim;
			const hint = `${C.dim}${GUTTER_REST}${C.reset}${hintColor}… +${hiddenCount} lines (ctrl+o to expand)${C.reset}`;
			cardLines.push(hint);
		}
	}

	// 11. 最新失败单例轨迹指针
	if (options.isNewestFailure) {
		cardLines.push(`   ${C.subtle}⎿ Alt+T 查看轨迹${C.reset}`);
	}

	return finishCard(cardLines, isHovered, maxW);
}

