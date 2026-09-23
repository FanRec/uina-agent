/**
 * 交互式终端 TUI 门面与统一入口（createInteractiveUI）。
 * 对齐 Pi 的交互体验，向内调度 UIHost，向外提供清晰的事件流与生命周期接口。
 */

import { UIHost, type UIHostOptions } from "./ui-host.js";

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
	private currentThinkingId?: string;
	/** 工具事实只携带 callId：开始时刻由消费者自记，用于结算耗时。 */
	private readonly toolStartedAt = new Map<string, number>();

	/**
	 * 工具运行中的重绘需求已并入 UIHost 统一帧时钟：
	 * 旧实现是独立的 300ms setInterval；现在只需在工具状态变化时告知宿主，
	 * 宿主把 hasRunningTools() 作为心跳状态源之一（见 UIHost.updateHeartbeat）。
	 */
	private syncToolAnimationTimer(): void {
		this.host.notifyToolActivity();
	}

	private stopToolAnimationTimer(): void {
		this.host.notifyToolActivity();
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
				this.host.transcript.startTurn(m.turnNumber, m.userText, m.images);
				this.host.trajectoryProjection.onTurnStart(m.turnNumber, m.userText);
				this.host.activityLine.start("thinking", "正在思考与生成回复...");
				this.host.requestRender();
				break;

			case "usage_update":
				// Provider usage 描述过去的一次调用，不覆盖当前 RequestProjection 的上下文快照。
				// 服务端报回的 output 是"本次调用"的输出量（含工具调用参数的分），交给活动行
				// 按 step 结算：它既是这一步的分子，也是这一步解码区间的右端。
				if (m.usage.outputTokens !== undefined) this.host.activityLine.addRealOutputTokens(m.usage.outputTokens);
				break;

			case "context_update":
				this.host.setContext(m.snapshot);
				break;

			case "output_update":
				if (m.channel === "thinking") {
					if (!this.currentThinkingId) {
						this.currentThinkingId = this.host.trajectoryProjection.onThinkingStart("深度推理");
					}
					this.host.transcript.appendThinking(m.text);
					// 思考 token 也是「生成」，必须进解码区间：服务端报回的 outputTokens 是
					// completion_tokens，本就含思考 token。此前只有正文增量喂活动行，于是左端要等
					// 正文首字才起算 —— 分子含思考、分母不含，开思考后读数虚高几十倍。
					this.host.activityLine.addStreamText(m.text);
					this.host.activityLine.update("thinking", "正在深度推理 (Thinking)...");
					this.host.requestRender();
					break;
				}
				if (m.channel !== "content") break;
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				this.host.transcript.appendToken(m.text);
				this.host.activityLine.addStreamText(m.text);
				this.host.activityLine.update("streaming", "正在输出回复...");
				this.host.requestRender();
				break;

			case "tool_call": {
				// 模型调用到此结束，结算这一步的解码区间与输出量；接下来的工具执行时间不计入生成速度。
				this.host.activityLine.endStep();
				if (this.currentThinkingId) {
					this.host.trajectoryProjection.onThinkingDone(this.currentThinkingId);
					this.currentThinkingId = undefined;
				}
				if (m.callId) this.toolStartedAt.set(m.callId, Date.now());
				const callId = m.callId ?? `tool-${m.toolName}-${Date.now()}`;
				this.host.transcript.smoothReveal.snapToLatest();
				this.host.transcript.startTool(m.toolName, m.args, callId);
				this.host.trajectoryProjection.onToolStart(m.toolName, m.args, callId);
				this.host.activityLine.update("tool", `正在执行工具: ${m.toolName}`);
				this.syncToolAnimationTimer();
				this.host.requestRender();
				break;
			}

			case "tool_result": {
				// 工具事实携带 callId：耗时由消费者按开始时刻自算（事实流不携带宿主计时）。
				const startedAt = m.callId !== undefined ? this.toolStartedAt.get(m.callId) : undefined;
				if (m.callId !== undefined) this.toolStartedAt.delete(m.callId);
				const elapsed = startedAt === undefined ? 0 : Date.now() - startedAt;
				this.host.transcript.addToolDone(m.toolName, m.result, elapsed, m.status, m.callId, m.args, { images: m.images ? [...m.images] : undefined, details: m.details });
				this.host.trajectoryProjection.onToolDone(m.callId ?? "", m.toolName, m.result, elapsed, m.status);
				this.host.activityLine.update("streaming", `工具 ${m.toolName} 执行完毕，继续生成...`);
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
				this.host.trajectoryProjection.onTurnEnd(m.turnNumber, m.requestUsage);
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
				// 瞬态通知走 toast（对话框右侧上方，3s 消失），与模型切换提示同形态，不进 transcript
				this.host.notify(m.text, "info", 3000);
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
				this.host.setPendingQueue(m.items as QueuedMessage[]);
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
