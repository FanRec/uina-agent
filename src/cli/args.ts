/**
 * CLI 命令行参数解析与帮助信息格式化（零外部依赖，严格遵循奥卡姆剃刀原则）。
 */

export interface ParsedArgs {
	/** 用户在命令行直接输入的初始任务提示词（拼接所有的 positional 参数） */
	readonly prompt?: string;
	/** 是否启用批处理/打印模式（流式输出后立即退出进程，不进入交互 TUI） */
	readonly print: boolean;
	/** 临时覆盖当前会话使用的模型（如 openai/gpt-4o、deepseek-r1） */
	readonly model?: string;
	/** 是否启用纯内存会话（不加载历史、不持久化落盘） */
	readonly noSession: boolean;
	/** 是否请求显示帮助文档 */
	readonly help: boolean;
	/** 是否请求显示版本号 */
	readonly version: boolean;
	/** 原始位置参数列表 */
	readonly rawPositionals: readonly string[];
}

export const UINA_VERSION = "0.1.0";

/**
 * 解析命令行参数列表（通常传入 process.argv.slice(2)）。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const positionals: string[] = [];
	let print = false;
	let model: string | undefined;
	let noSession = false;
	let help = false;
	let version = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		if (arg === "--") {
			// 遇到双破折号，其后的所有参数均视为原始位置参数
			positionals.push(...argv.slice(i + 1));
			break;
		}

		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-v" || arg === "--version") {
			version = true;
			continue;
		}

		if (arg === "-p" || arg === "--print") {
			print = true;
			continue;
		}

		if (arg === "--no-session") {
			noSession = true;
			continue;
		}

		if (arg === "-m" || arg === "--model") {
			if (i + 1 < argv.length) {
				model = argv[++i];
			}
			continue;
		}

		if (arg.startsWith("-m=") || arg.startsWith("--model=")) {
			const eqIndex = arg.indexOf("=");
			model = arg.slice(eqIndex + 1);
			continue;
		}

		if (!arg.startsWith("-")) {
			positionals.push(arg);
		}
	}

	const prompt = positionals.length > 0 ? positionals.join(" ").trim() : undefined;

	return {
		prompt: prompt || undefined,
		print,
		model: model?.trim() || undefined,
		noSession,
		help,
		version,
		rawPositionals: positionals,
	};
}

/**
 * 格式化输出 CLI 帮助信息。
 */
export function formatHelp(): string {
	return [
		`Uina (v${UINA_VERSION}) — 开放式数字主体最小运行时`,
		"",
		"用法:",
		"  uina [选项] [prompt...]",
		"  uina -p, --print <prompt>",
		"  <command> | uina [选项] [prompt...]",
		"",
		"参数:",
		"  prompt...                     直接输入任务提示词。默认进入交互界面并自动执行该任务。",
		"",
		"选项:",
		"  -p, --print                   批处理模式（Print Mode）：流式打印回答后立即退出进程。",
		"  -m, --model <provider/model>  临时覆盖本次会话使用的模型（例如 openai/gpt-4o、deepseek-r1）。",
		"  --no-session                  纯内存临时模式（不加载历史、不写盘、不留痕迹）。",
		"  -v, --version                 显示当前版本号并退出。",
		"  -h, --help                    显示命令行帮助信息并退出。",
		"",
		"示例:",
		"  uina                          直接在当前目录进入交互式 TUI 会话",
		"  uina \"帮我审查当前目录代码\"    带任务进入交互式 TUI 会话并自动执行",
		"  uina -m deepseek-r1           指定模型并进入交互式会话",
		"  uina -p \"生成一个随机密码\"     直接输出结果后退出（批处理脚本适用）",
		"  git diff | uina \"总结本次修改\"  通过标准输入管道传入上下文",
		"",
	].join("\n");
}

/**
 * 异步读取管道中的标准输入（如果存在）。若在普通 TTY 终端下则安全返回 undefined。
 */
export async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise<string | undefined>((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");

		process.stdin.on("data", (chunk: string) => {
			data += chunk;
		});

		process.stdin.on("end", () => {
			const trimmed = data.trim();
			resolve(trimmed.length > 0 ? trimmed : undefined);
		});

		process.stdin.on("error", () => {
			resolve(undefined);
		});

		process.stdin.resume();
	});
}
