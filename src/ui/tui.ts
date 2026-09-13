/**
 * 交互式终端 TUI 门面与统一入口（createInteractiveUI）。
 * 对齐 Pi 的交互体验，向内调度 UIHost，向外提供清晰的事件流与生命周期接口。
 */

import { UIHost, type UIHostOptions } from "./ui-host.js";
import { STREAM_CHARS_PER_TOKEN } from "./components/widgets/activity-line.js";
import type { QueuedMessage } from "../agent/queue.js";
import type { ExtensionUIContext } from "../extensions/ui-contract.js";
import type { SessionEntry } from "../session/types.js";

import type { HostEvent } from "../host/events.js";

export type { HostEvent };

export interface InteractiveTUIOptions extends UIHostOptions {
	onDirectCommand?: (cmd: string) => void | Promise<void>;
	onCompactRequest?: (instruction?: string) => void | Promise<void>;
}

export class InteractiveTUI {
	readonly host: UIHost;
	private lineCallback?: (line: string, mode: "steer" | "followUp") => void;
	private sigintCallback?: () => void;
	private cancelCallback?: (source?: "escape" | "ctrl+c") => void;
	private exitCallback?: () => void;
	private forceExitCallback?: () => void;
	private interruptAndDeliverCallback?: (text: string) => void;
	private pullBackQueueCallback?: () => void;
	private thinkingLevelCycleCallback?: () => void;
	private toolCallMap = new Map<string, { startedAt: number; name: string; args?: unknown }>();
	private currentThinkingId?: string;
	private toolAnimationTimer?: NodeJS.Timeout;

	private syncToolAnimationTimer(): void {
		const hasRunning = this.toolCallMap.size > 0 || this.host.transcript.hasRunningTools();
		if (hasRunning && !this.toolAnimationTimer) {
			this.toolAnimationTimer = setInterval(() => {
				if (this.toolCallMap.size === 0 && !this.host.transcript.hasRunningTools()) {
					this.stopToolAnimationTimer();
					return;
				}
				this.host.requestRender();
			}, 300);
		} else if (!hasRunning && this.toolAnimationTimer) {
			this.stopToolAnimationTimer();
		}
	}

	private stopToolAnimationTimer(): void {
		if (this.toolAnimationTimer) {
			clearInterval(this.toolAnimationTimer);
			this.toolAnimationTimer = undefined;
		}
	}

	constructor(options: InteractiveTUIOptions = {}) {
		this.host = new UIHost(options);

		this.host.onUserLine = (line, mode) => {
			const m = mode === "direct" ? "steer" : mode;
			this.lineCallback?.(line, m);
		};

		this.host.onCancel = (source) => {
			this.cancelCallback?.(source);
		};

		this.host.onExit = () => {
			this.exitCallback?.();
		};

		this.host.onInterrupt = (force) => {
			if (force) {
				this.forceExitCallback?.();
			} else {
				if (!this.cancelCallback) {
					this.sigintCallback?.();
				}
			}
		};

		this.host.onInterruptAndDeliver = (text) => {
			this.interruptAndDeliverCallback?.(text);
		};

		this.host.onPullBackQueue = () => {
			this.pullBackQueueCallback?.();
		};

		this.host.onThinkingLevelCycle = () => {
			this.thinkingLevelCycleCallback?.();
		};

	}

	get ctxUI(): ExtensionUIContext {
		return this.host.ctxUI;
	}

	openHistory(): void {
		this.host.openHistory();
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

	onCancel(cb: (source?: "escape" | "ctrl+c") => void): void {
		this.cancelCallback = cb;
	}

	onExit(cb: () => void): void {
		this.exitCallback = cb;
	}

	onForceExit(cb: () => void): void {
		this.forceExitCallback = cb;
	}

	onInterruptAndDeliver(cb: (text: string) => void): void {
		this.interruptAndDeliverCallback = cb;
	}

	onPullBackQueue(cb: () => void): void {
		this.pullBackQueueCallback = cb;
	}

	onThinkingLevelCycle(cb: () => void): void {
		this.thinkingLevelCycleCallback = cb;
	}

	replaceInput(text: string): void {
		this.host.replaceInput(text);
	}

	loadHistory(messages: readonly import("../core/types.js").ChatMsg[]): void {
		this.host.loadHistory(messages);
	}

	loadSession(entries: readonly SessionEntry[]): void {
		this.host.loadSession(entries);
	}

	setPendingQueue(items: readonly QueuedMessage[]): void {
		this.host.setPendingQueue(items);
	}

	render(m: HostEvent): void {
		switch (m.type) {
			case "session_rewind":
				this.currentThinkingId = undefined;
				this.host.transcript.clear();
				this.host.loadSession(m.entries);
				if (m.turnNumber !== undefined) {
					this.host.transcript.startTurn(m.turnNumber, "");
					this.host.activityLine.start("thinking", "正在思考与生成回复...");
				} else {
					this.host.activityLine.reset();
				}
				this.host.markUsageEstimated();
				this.host.requestRender();
				break;
			case "turn_start":
				this.currentThinkingId = undefined;
				this.host.markUsageEstimated();
				this.host.setBusy(true);
				this.host.transcript.startTurn(m.n, m.text, m.images);
				this.host.trajectoryProjection.onTurnStart(m.n, m.text);
				this.host.activityLine.start("thinking", "正在思考与生成回复...");
				this.host.requestRender();
				break;

			case "usage_update":
				// 回合进行中也要让上下文占用推进：每次模型调用收尾都有真实 usage。
				this.host.setUsage(m.usedTokens, m.contextWindow, m.actual ?? false, {
					input: m.inputTokens,
					output: m.outputTokens,
					cacheRead: m.cacheRead,
					cacheWrite: m.cacheWrite,
					segments: m.segments,
				});
				// 服务端的 output 是"本次调用"的输出量，累加成回合总量用于速度计算：
				// 一个回合可以有多轮模型调用，各自输出都应计入这一轮的生成速度。
				if (m.outputTokens !== undefined) this.host.activityLine.addRealOutputTokens(m.callId, m.outputTokens);
				break;

			case "text":
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				this.host.transcript.appendToken(m.text);
				{
					const estimatedTokens = Math.max(1, Math.ceil(m.text.length / STREAM_CHARS_PER_TOKEN));
					this.host.activityLine.addTokens(estimatedTokens);
				}
				this.host.activityLine.update("streaming", "正在输出回复...");
				this.host.requestRender();
				break;

			case "thinking":
				if (!this.currentThinkingId) {
					this.currentThinkingId = this.host.trajectoryProjection.onThinkingStart("深度推理");
				}
				this.host.transcript.appendThinking(m.text);
				{
					// 思考 token 也是「生成」，必须进解码跨度：服务端报回的 outputTokens
					// 是 completion_tokens，本就含思考 token。此前只有正文增量走 addTokens，
					// 于是分母要等正文首字才起算 —— 分子含思考、分母不含，开思考后读数虚高几十倍。
					const thinkingTokens = Math.max(1, Math.ceil(m.text.length / STREAM_CHARS_PER_TOKEN));
					this.host.activityLine.addTokens(thinkingTokens);
				}
				this.host.activityLine.update("thinking", "正在深度推理 (Thinking)...");
				this.host.requestRender();
				break;

			case "tool_start": {
				// 模型调用到此结束，封存解码跨度；接下来的工具执行时间不计入生成速度。
				this.host.activityLine.sealDecodeSpan();
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				const callId = m.callId ?? `tool-${m.name}-${Date.now()}`;
				this.toolCallMap.set(callId, { startedAt: Date.now(), name: m.name, args: m.args });
				this.host.transcript.smoothReveal.snapToLatest();
				this.host.transcript.commitThinking();
				this.host.transcript.startTool(m.name, m.args, callId);
				this.host.trajectoryProjection.onToolStart(m.name, m.args, callId);
				this.host.activityLine.update("tool", `正在执行工具: ${m.name}`);
				this.syncToolAnimationTimer();
				this.host.requestRender();
				break;
			}

			case "tool_done": {
				const record = m.callId ? this.toolCallMap.get(m.callId) : undefined;
				const elapsed = m.elapsedMs ?? (m.ts ? Date.now() - m.ts : record ? Date.now() - record.startedAt : 0);
				if (m.callId) this.toolCallMap.delete(m.callId);

				const status = m.status ?? "unknown";
				this.host.transcript.addToolDone(m.name, m.result, elapsed, status, m.callId, record?.args, { images: m.images, details: m.details });
				this.host.trajectoryProjection.onToolDone(m.callId ?? "", m.name, m.result, elapsed, status);
				this.host.activityLine.update("streaming", `工具 ${m.name} 执行完毕，继续生成...`);
				this.syncToolAnimationTimer();
				this.host.requestRender();
				break;
			}

			case "turn_end":
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				this.stopToolAnimationTimer();
				this.host.setBusy(false);
				this.host.transcript.finishTurn();
				this.host.trajectoryProjection.onTurnEnd(m.n, m.usage);
				if (m.usage) {
					this.host.setUsage(
						m.usage.usedTokens,
						m.usage.contextWindow,
						m.usage.actual ?? false,
						{
							input: m.usage.inputTokens,
							output: m.usage.outputTokens,
							cacheRead: m.usage.cacheRead,
							cacheWrite: m.usage.cacheWrite,
							segments: m.usage.segments,
						},
					);
				}
				const elapsed = this.host.getLastElapsedMs();
				const history = this.host.transcript.getHistory();
				const lastTurn = history[history.length - 1];
				const isInterrupted = lastTurn?.items.some((it) => it.kind === "interrupt");
				if (isInterrupted) {
					this.host.activityLine.finish("已打断当前轮次", elapsed > 0 ? elapsed : undefined);
				} else {
					this.host.activityLine.finish("本轮已完成", elapsed > 0 ? elapsed : undefined);
				}
				this.host.requestRender();
				break;

			case "turn_aborted":
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				this.stopToolAnimationTimer();
				this.host.transcript.interruptTurn(this.host.modelName);
				this.host.setBusy(false);
				this.host.activityLine.finish("已打断当前轮次");
				this.host.requestRender();
				break;

			case "notice":
				this.host.transcript.addNotice(m.text);
				this.host.requestRender();
				break;

			case "error":
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				this.stopToolAnimationTimer();
				this.host.setBusy(false);
				this.host.transcript.addError(m.text);
				this.host.trajectoryProjection.onError(m.text);
				this.host.activityLine.reset();
				this.host.requestRender();
				break;

			case "queue":
				this.host.setPendingQueue(m.items);
				break;
		}
	}

	close(): void {
		this.stopToolAnimationTimer();
		this.host.stop();
	}
}

export function createInteractiveUI(options: InteractiveTUIOptions = {}): InteractiveTUI {
	const tui = new InteractiveTUI(options);
	tui.start();
	return tui;
}
