import { UinaHost } from "../../../src/host/host.js";
import type { AgentInput } from "../../../src/agent/loop.js";
import type { AgentMessage, ChatMsg, Model } from "../../../src/core/types.js";
import type { ToolExecutionResult } from "../../../src/tools/broker.js";

import { IsolatedEnv } from "../environment/isolated-env.js";
import { createSilentTerminal, type SilentTerminalResult } from "../environment/silent-terminal.js";
import { Scenario } from "../provider/scenario.js";
import { EventCollector } from "./event-collector.js";

export interface HarnessOptions {
	readonly model?: Partial<Model>;
	readonly scenario?: Scenario;
	readonly env?: IsolatedEnv;
	readonly terminal?: SilentTerminalResult;
	readonly autoStart?: boolean;
	readonly useConfig?: boolean;
	readonly hostOptions?: Partial<import("../../../src/host/host.js").UinaHostOptions>;
}

/**
 * Uina 测试门面（UinaTestHarness）：
 * 极简高能的被测系统驱动器。
 * 封装 UinaHost 装配、静音终端、隔离文件环境与剧本 Provider，
 * 绝大部分集成与端到端测试均可通过本门面一站式完成。
 */
export class UinaTestHarness {
	readonly host: UinaHost;
	readonly env: IsolatedEnv;
	readonly scenario: Scenario;
	readonly events: EventCollector;
	readonly terminal: SilentTerminalResult;

	private readonly options: HarnessOptions;
	private disposed = false;

	private constructor(
		host: UinaHost,
		env: IsolatedEnv,
		scenario: Scenario,
		events: EventCollector,
		terminal: SilentTerminalResult,
		options: HarnessOptions,
	) {
		this.host = host;
		this.env = env;
		this.scenario = scenario;
		this.events = events;
		this.terminal = terminal;
		this.options = options;

		// 订阅所有事件至收集器
		this.host.subscribe(this.events.listener);
	}

	static async create(options: HarnessOptions = {}): Promise<UinaTestHarness> {
		const env = options.env ?? (await IsolatedEnv.create());
		const scenario = options.scenario ?? new Scenario(options.model);
		const terminal = options.terminal ?? createSilentTerminal();
		const events = new EventCollector();

		const host = await UinaHost.create({
			cwd: env.cwd,
			sessionPath: env.sessionPath,
			...(options.useConfig ? {} : { model: scenario.model }),
			stream: (m, req, onDelta, signal) => scenario.stream(m, req, onDelta, signal),
			...options.hostOptions,
		});

		if (options.autoStart !== false) {
			await host.start();
		}

		return new UinaTestHarness(host, env, scenario, events, terminal, options);
	}

	/** 手动启动内置能力与项目扩展（当 autoStart 为 false 时使用） */
	async start(): Promise<void> {
		await this.host.start();
	}

	/** 投递用户消息并执行（默认 direct 模式） */
	async send(text: string, mode: "direct" | "steer" | "followUp" = "direct"): Promise<void> {
		if (mode === "direct") {
			await this.host.submitText(text, "direct");
		} else {
			await this.host.pushInput(text, mode);
		}
	}

	/** 投递结构化 AgentInput */
	async accept(input: AgentInput): Promise<void> {
		await this.host.send(input);
	}

	/** 等待当前所有后台任务与主体轮次执行完毕 */
	async waitForIdle(): Promise<void> {
		await this.host.waitForIdle();
	}

	/** 打断当前活动轮次 */
	interrupt(): void {
		this.host.interrupt();
	}

	/**
	 * 模拟进程崩溃并基于同一 session 文件重新启动：
	 * 验证崩溃恢复、未完成工具结算与历史持久化一致性的终极利器。
	 */
	async restart(): Promise<UinaTestHarness> {
		await this.host.dispose();
		const newEvents = new EventCollector();

		const newHost = await UinaHost.create({
			cwd: this.env.cwd,
			sessionPath: this.env.sessionPath,
			model: this.scenario.model,
			stream: (m, req, onDelta, signal) => this.scenario.stream(m, req, onDelta, signal),
			...this.options.hostOptions,
		});

		if (this.options.autoStart !== false) {
			await newHost.start();
		}

		return new UinaTestHarness(newHost, this.env, this.scenario, newEvents, this.terminal, this.options);
	}

	/** 直接调用工具 */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
		return this.host.runToolDirect(name, args, signal);
	}

	/** 获取当前主线历史消息快照 */
	get history(): readonly (AgentMessage | ChatMsg)[] {
		return this.host.subject.historySnapshot();
	}

	/** 获取排队待办快照 */
	get queue() {
		return this.host.snapshot().queue;
	}

	/** 获取终端屏幕上的当前可见纯文本内容 */
	get visibleTerminalText(): string {
		return this.terminal.getVisibleText();
	}

	isBusy(): boolean {
		return this.host.isBusy();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.host.dispose().catch(() => undefined);
		await this.env.dispose().catch(() => undefined);
	}
}
