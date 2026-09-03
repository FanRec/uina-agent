/**
 * 交互式终端 TUI 门面与统一入口（createInteractiveUI）。
 * 对齐 Pi 的交互体验，向内调度 UIHost，向外提供清晰的事件流与生命周期接口。
 */

import { UIHost, type UIHostOptions } from "./ui-host.js";
import type { ToolResultStatus } from "../core/types.js";
import type { QueuedMessage } from "../agent/queue.js";
import type { ExtensionUIContext } from "./extensions/types.js";

/** 渲染层消息契约（主体 hooks → UI 消息） */
export type OutMsg =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "turn_start"; n: number; text: string }
	| { type: "turn_end"; n: number; usage?: { usedTokens: number; contextWindow: number } }
	| { type: "error"; text: string }
	| { type: "notice"; text: string }
	| { type: "tool_start"; name: string; args: unknown; callId?: string }
	| {
		type: "tool_done";
		name: string;
		result: string;
		status?: ToolResultStatus;
		callId?: string;
		ts?: number;
		elapsedMs?: number;
	}
	| { type: "queue"; items: readonly QueuedMessage[] };

export interface InteractiveTUIOptions extends UIHostOptions {
	onDirectCommand?: (cmd: string) => void | Promise<void>;
	onCompactRequest?: (instruction?: string) => void | Promise<void>;
}

export class InteractiveTUI {
	readonly host: UIHost;
	private lineCallback?: (line: string, mode: "steer" | "followUp") => void;
	private sigintCallback?: () => void;
	private toolCallMap = new Map<string, { startedAt: number; name: string }>();

	constructor(options: InteractiveTUIOptions = {}) {
		this.host = new UIHost(options);

		this.host.onUserLine = (line, mode) => {
			const m = mode === "direct" ? "steer" : mode;
			this.lineCallback?.(line, m);
		};

		this.host.onInterrupt = () => {
			this.sigintCallback?.();
		};

		if (options.onDirectCommand) {
			this.host.onDirectCommand = options.onDirectCommand;
		}
		if (options.onCompactRequest) {
			this.host.onCompactRequest = options.onCompactRequest;
		}
	}

	get ctxUI(): ExtensionUIContext {
		return this.host.ctxUI;
	}

	start(): void {
		this.host.start();
	}

	onLine(cb: (line: string, mode: "steer" | "followUp") => void): void {
		this.lineCallback = cb;
	}

	onSIGINT(cb: () => void): void {
		this.sigintCallback = cb;
	}

	replaceInput(text: string): void {
		this.host.replaceInput(text);
	}

	loadHistory(messages: readonly import("../core/types.js").ChatMsg[]): void {
		this.host.loadHistory(messages);
	}

	render(m: OutMsg): void {
		switch (m.type) {
			case "turn_start":
				this.host.setBusy(true);
				this.host.transcript.startTurn(m.n, m.text);
				this.host.trajectoryProjection.onTurnStart(m.n, m.text);
				this.host.activityLine.update("streaming", "正在思考与生成回复...");
				this.host.requestRender();
				break;

			case "text":
				this.host.transcript.appendToken(m.text);
				this.host.incrementTokens(1);
				this.host.activityLine.update("streaming", "正在输出回复...");
				this.host.requestRender();
				break;

			case "thinking":
				this.host.transcript.appendThinking(m.text);
				this.host.activityLine.update("thinking", "正在深度推理 (Thinking)...");
				this.host.requestRender();
				break;

			case "tool_start": {
				const callId = m.callId ?? `tool-${m.name}-${Date.now()}`;
				this.toolCallMap.set(callId, { startedAt: Date.now(), name: m.name });
				this.host.transcript.commitThinking();
				this.host.trajectoryProjection.onToolStart(m.name, m.args, callId);
				this.host.activityLine.update("tool", `正在执行工具: ${m.name}`);
				this.host.requestRender();
				break;
			}

			case "tool_done": {
				const record = m.callId ? this.toolCallMap.get(m.callId) : undefined;
				const elapsed = m.elapsedMs ?? (m.ts ? Date.now() - m.ts : record ? Date.now() - record.startedAt : 0);
				if (m.callId) this.toolCallMap.delete(m.callId);

				const isError = m.status === "failed";
				this.host.transcript.addToolDone(m.name, m.result, elapsed);
				this.host.trajectoryProjection.onToolDone(m.callId ?? "", m.name, m.result, elapsed, isError);
				this.host.activityLine.update("streaming", `工具 ${m.name} 执行完毕，继续生成...`);
				this.host.requestRender();
				break;
			}

			case "turn_end":
				this.host.setBusy(false);
				this.host.transcript.finishTurn();
				this.host.trajectoryProjection.onTurnEnd(m.n, m.usage);
				if (m.usage) {
					this.host.setUsage(m.usage.usedTokens, m.usage.contextWindow);
				}
				this.host.activityLine.finish("本轮已完成");
				this.host.requestRender();
				break;

			case "notice":
				this.host.transcript.addNotice(m.text);
				this.host.requestRender();
				break;

			case "error":
				this.host.setBusy(false);
				this.host.transcript.addError(m.text);
				this.host.trajectoryProjection.onError(m.text);
				this.host.activityLine.reset();
				this.host.requestRender();
				break;

			case "queue":
				if (m.items.length > 0) {
					const queueText = m.items.map((i) => i.text).join(" | ");
					this.host.transcript.addNotice(`排队消息: ${queueText}`);
					this.host.requestRender();
				}
				break;
		}
	}

	close(): void {
		this.host.stop();
	}
}

export function createInteractiveUI(options: InteractiveTUIOptions = {}): InteractiveTUI {
	const tui = new InteractiveTUI(options);
	tui.start();
	return tui;
}

export { InteractiveTUI as SimpleTUI };
