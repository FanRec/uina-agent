/**
 * runApp 的纯决策内核：初始 prompt 组合、运行模式判定、启动横幅、退出码。
 * 从组合根拆出使这些分支可单测；app.ts 只保留装配与 IO。
 */

export interface RunModeInput {
	print?: boolean;
	/** readPipedStdin 的结果（undefined = 无管道输入） */
	piped: string | undefined;
	prompt?: string;
	/** UINA_ONESHOT_MSG 环境变量（undefined = 未设置） */
	oneshot?: string;
	stdoutTTY?: boolean;
	stdinTTY?: boolean;
}

export interface RunMode {
	initialPrompt: string | undefined;
	isPrintMode: boolean;
	shouldRunTUI: boolean;
}

/**
 * 初始 prompt 优先级：oneshot 环境变量 > 管道输入（可与 -p 叠加拼接）> -p 参数。
 */
export function composeInitialPrompt(
	piped: string | undefined,
	prompt: string | undefined,
	oneshot: string | undefined,
): string | undefined {
	if (oneshot !== undefined) return oneshot;
	if (piped && prompt) return `${prompt}\n\n[标准输入内容]:\n${piped}`;
	if (piped) return piped;
	return prompt;
}

/**
 * 运行模式：print = 显式 --print、oneshot、或非 TTY stdout 且带有初始任务；
 * TUI 仅在 stdin/stdout 双 TTY 且非 print 时启用。
 */
export function resolveRunMode(input: RunModeInput): RunMode {
	const initialPrompt = composeInitialPrompt(input.piped, input.prompt, input.oneshot);
	const isPrintMode =
		input.print === true ||
		input.oneshot !== undefined ||
		(!input.stdoutTTY && initialPrompt !== undefined);
	const shouldRunTUI = input.stdoutTTY === true && input.stdinTTY === true && !isPrintMode;
	return { initialPrompt, isPrintMode, shouldRunTUI };
}

/**
 * 启动横幅：非 TUI 非 print 显示就绪行；恢复会话时显示消息数（print 模式不显示）。
 * 返回空串表示无需输出；多段以空行连接，段后各带一个空行（逐字节对齐旧实现）。
 */
export function formatStartupBanner(
	modelName: string,
	historyCount: number,
	shouldRunTUI: boolean,
	isPrintMode: boolean,
): string {
	const parts: string[] = [];
	if (!shouldRunTUI && !isPrintMode) parts.push(`Uina 就绪（模型：${modelName}）— /quit 退出`);
	if (historyCount > 0 && !isPrintMode) parts.push(`（已恢复 JSONL 会话：${historyCount} 条消息）`);
	return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}

/** 退出码：print/oneshot 模式下发生过错误 → 1，其余 0。 */
export function resolveExitCode(isPrintMode: boolean, isOneshot: boolean, hadError: boolean): number {
	return (isPrintMode || isOneshot) && hadError ? 1 : 0;
}
