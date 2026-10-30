/**
 * CLI 命令行参数解析与帮助信息格式化（零外部依赖，严格遵循奥卡姆剃刀原则）。
 */

export interface ParsedArgs {
	/** 用户在命令行直接输入的初始任务提示词（拼接所有的 positional 参数） */
	readonly prompt?: string;
	readonly extensions?: readonly string[];
	/** 是否启用批处理/打印模式（流式输出后立即退出进程，不进入交互 TUI） */
	readonly print: boolean;
	/** 临时覆盖当前会话使用的模型（如 openai/gpt-4o、deepseek-r1） */
	readonly model?: string;
	/** 主体 profile ID：提供时 session/settings/扩展资源绑定到 profiles/<id>/。 */
	readonly profile?: string;
	/** 是否启用纯内存会话（不加载历史、不持久化落盘） */
	readonly noSession: boolean;
	/** 是否启动多前端网关（observe/intent 两动词；默认关闭，绑定 127.0.0.1） */
	readonly gateway: boolean;
	/** 网关端口（默认 8787） */
	readonly gatewayPort: number;
	/** 网关绑定地址（默认 127.0.0.1；出本机是显式行为） */
	readonly gatewayHost: string;
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
	const extensions: string[] = [];
	let print = false;
	let model: string | undefined;
	let noSession = false;
	let profile: string | undefined;
	let gateway = false;
	let gatewayPort = 8787;
	let gatewayHost = "127.0.0.1";
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

		if (arg === "-e" || arg === "--extension") {
			const entry = argv[++i];
			if (!entry || entry.startsWith("-")) throw new Error("--extension 需要文件或目录路径");
			extensions.push(entry);
			continue;
		}
		if (arg.startsWith("--extension=") || arg.startsWith("-e=")) {
			const entry = arg.slice(arg.indexOf("=") + 1);
			if (!entry) throw new Error("--extension 需要路径");
			extensions.push(entry);
			continue;
		}
		if (arg === "--no-session") {
			noSession = true;
			continue;
		}

		if (arg === "--gateway") {
			gateway = true;
			continue;
		}
		if (arg === "--gateway-port") {
			const value = argv[++i];
			const port = value === undefined ? Number.NaN : Number(value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--gateway-port 需要 1-65535 的整数");
			gatewayPort = port;
			continue;
		}
		if (arg.startsWith("--gateway-port=")) {
			const port = Number(arg.slice("--gateway-port=".length));
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--gateway-port 需要 1-65535 的整数");
			gatewayPort = port;
			continue;
		}
		if (arg === "--gateway-host") {
			const value = argv[++i];
			if (!value) throw new Error("--gateway-host 需要绑定地址");
			gatewayHost = value;
			continue;
		}
		if (arg.startsWith("--gateway-host=")) {
			const value = arg.slice("--gateway-host=".length);
			if (!value) throw new Error("--gateway-host 需要绑定地址");
			gatewayHost = value;
			continue;
		}

		if (arg === "--profile") {
			if (i + 1 < argv.length) {
				profile = argv[++i]!.trim() || undefined;
				continue;
			}
			throw new Error("--profile 需要主体 ID");
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
		...(extensions.length ? { extensions } : {}),
		profile,
		print,
		model: model?.trim() || undefined,
		noSession,
		gateway,
		gatewayPort,
		gatewayHost,
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
		"  -e, --extension <path>        加载扩展文件或目录；可重复。",
		"  --no-session                  纯内存临时模式（不加载历史、不写盘、不留痕迹）。",
		"  --gateway                     启动多前端网关（浏览器/手机薄面；默认 127.0.0.1:8787）。",
		"  --gateway-port <1-65535>      网关端口（默认 8787）。",
		"  --gateway-host <addr>         网关绑定地址（默认 127.0.0.1；非回环绑定会打印安全提示）。",
		"  -v, --version                 显示当前版本号并退出。",
		"  -h, --help                    显示命令行帮助信息并退出。",
		"",
		"示例:",
		"  uina                          直接在当前目录进入交互式 TUI 会话",
		'  uina "帮我审查当前目录代码"    带任务进入交互式 TUI 会话并自动执行',
		"  uina -m deepseek-r1           指定模型并进入交互式会话",
		'  uina -p "生成一个随机密码"     直接输出结果后退出（批处理脚本适用）',
		'  git diff | uina "总结本次修改"  通过标准输入管道传入上下文',
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
