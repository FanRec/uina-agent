import { ExtensionHost } from "../../../src/extensions/host.js";
import { ToolBroker, type Tool, type ToolExecutionResult } from "../../../src/tools/broker.js";
import type { HookHandler, HookName } from "../../../src/runtime/hooks.js";
import type { RuntimeEvent } from "../../../src/runtime/events.js";
import { mockTool } from "../core/subject-harness.js";

export interface ExtensionHarnessOptions {
	tools?: Tool[];
	broker?: ToolBroker;
	host?: ExtensionHost;
}

/**
 * 扩展机制测试门面（ExtensionHarness）：
 * 统一集成 ExtensionHost 与 ToolBroker，消灭扩展与钩子测试中的初始化胶水代码。
 */
export class ExtensionHarness {
	readonly host: ExtensionHost;
	readonly tools: ToolBroker;
	readonly errors: string[] = [];

	constructor(host: ExtensionHost, tools: ToolBroker) {
		this.host = host;
		this.tools = tools;

		this.host.onError((err) => {
			this.errors.push(err.error);
		});
	}

	static create(options: ExtensionHarnessOptions = {}): ExtensionHarness {
		const host = options.host ?? new ExtensionHost();
		const tools = options.broker ?? new ToolBroker();
		if (options.tools) {
			for (const t of options.tools) tools.register(t);
		}
		return new ExtensionHarness(host, tools);
	}

	/** 注册快速 Mock 工具 */
	registerTool(
		name: string,
		run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | unknown = () => "ok",
	): Tool {
		const tool = mockTool(name, run);
		this.tools.register(tool);
		return tool;
	}

	/** 挂载干预钩子 */
	onHook<K extends HookName>(name: K, handler: HookHandler<K>): this {
		this.host.onHook(name, handler);
		return this;
	}

	/** 广播事实事件 */
	emit(event: RuntimeEvent): Promise<void> {
		return this.host.emit(event);
	}

	/** 执行工具（走 Broker 校验与执行） */
	async execute(name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
		const prepared = this.tools.prepare(name, args);
		return this.tools.execute(prepared);
	}
}

export function createExtensionHarness(options?: ExtensionHarnessOptions): ExtensionHarness {
	return ExtensionHarness.create(options);
}
