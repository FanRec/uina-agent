/**
 * 交互式终端 TUI 门面与统一入口（createInteractiveUI）。
 * 对齐 Pi 的交互体验，向内调度 UIHost，向外提供清晰的事件流与生命周期接口。
 */

import type { ExtensionUIContext } from "../extensions/ui-contract.js";
import type { HostEvent, HostEventRecord, HostSnapshot } from "../host/events.js";
import type { PresentationIntent } from "../presentation/actions.js";
import { PresentationController } from "../presentation/controller.js";
import type { AssistantNode, ThinkingNode, ToolNode, TurnNode } from "../presentation/projection.js";
import { sanitizeExternal } from "../presentation/sanitize.js";
import type { SessionCustomEntryRecord, SessionEntry, SessionEventRecord } from "../session/types.js";
import type { CompactionReplayDecoration } from "./components/transcript/transcript.js";
import { installUIFeatures, type UIFeatureOptions } from "./features.js";
import { UIHost, type UIHostOptions } from "./ui-host.js";

export type { HostEvent };

export interface InteractiveTUIOptions extends UIHostOptions {
	features?: UIFeatureOptions;
}

/** 非 completed 压缩终态的卡片正文：toast 只闪一下，原因必须留在转录里。 */
function compactionTerminalText(event: Extract<HostEvent, { type: "session_compact" }>): string {
	if (event.status === "failed") return event.error ?? "未提供错误原因";
	if (event.status === "cancelled") return event.error ?? "压缩被中止";
	return "当前上下文无需压缩";
}

export class InteractiveTUI {
	private readonly host: UIHost;
	private readonly controller = new PresentationController();
	private readonly featureDisposer: () => void;

	/**
	 * 工具运行中的重绘需求已并入 UIHost 统一帧时钟：
	 * 旧实现是独立的 300ms setInterval；现在只需在工具状态变化时告知宿主，
	 * 宿主把 hasRunningTools() 作为心跳状态源之一（见 UIHost.updateHeartbeat）。
	 * （旧 sync/stop 双方法同名同实现，是三定时器方案的化石，已并入本单点。）
	 */
	private notifyToolActivity(): void {
		this.host.notifyToolActivity();
	}

	constructor(options: InteractiveTUIOptions = {}) {
		this.host = new UIHost(options);
		const features = installUIFeatures(this.host, this.controller.trajectory, options.features);
		this.featureDisposer = features.dispose;

		this.host.onUserLine = (line, mode) => {
			// mode 原样穿透：direct/steer/followUp 的归一单点在 host.submitText，
			// 门面不改名（旧实现把 direct 改写成 steer，语义误导且被 host 重判兜底）。
			this.emitIntent({ type: "input.submit", text: line, mode });
		};

		this.host.onCancel = (source) => {
			this.emitIntent({ type: "turn.cancel", source });
		};
		this.host.onInteraction = () => this.emitIntent({ type: "ui.interaction" });

		this.host.onInterruptAndDeliver = (text) => {
			this.emitIntent({ type: "turn.interruptAndDeliver", text });
		};

		this.host.onPullBackQueue = () => {
			this.emitIntent({ type: "queue.pullBack" });
		};

		this.host.onThinkingLevelCycle = () => {
			this.emitIntent({ type: "thinking.cycle" });
		};
	}

	private emitIntent(intent: PresentationIntent): void {
		this.controller.dispatch(intent);
	}

	get extensionUI(): ExtensionUIContext {
		return this.host.ctxUI;
	}

	start(): void {
		this.host.start();
	}

	onIntent(cb: (intent: PresentationIntent) => void): void {
		this.controller.onIntent(cb);
	}

	initialize(snapshot: HostSnapshot): void {
		this.updateSnapshot(snapshot);
	}

	updateSnapshot(snapshot: HostSnapshot): void {
		this.controller.applySnapshot(snapshot);
		if (this.host.modelName !== snapshot.modelName) this.host.setModel(snapshot.modelName);
		this.host.setThinkingLevels(snapshot.thinkingLevels);
		if (this.host.getReasoningEffort() !== snapshot.thinkingLevel) {
			this.host.setReasoningEffort(snapshot.thinkingLevel);
		}
		if (snapshot.context) this.host.setContext(snapshot.context);
		if (this.host.isBusy() !== snapshot.busy) this.host.setBusy(snapshot.busy);
		this.host.setPendingQueue(snapshot.queue);
	}

	getDraft(): string {
		return this.host.inputLine.getText();
	}

	setDraft(text: string): void {
		this.host.replaceInput(text);
	}

	addNotice(text: string): void {
		this.host.transcript.addNotice(text);
		this.host.requestRender();
	}

	notify(message: string, type: "info" | "warning" | "error" = "info", timeoutMs?: number): void {
		this.host.notify(message, type, timeoutMs);
	}

	restoreSession(
		entries: readonly SessionEntry[],
		decorations: readonly CompactionReplayDecoration[] = [],
		auxiliary: readonly (SessionEventRecord | SessionCustomEntryRecord)[] = [],
	): void {
		const view = this.controller.replaceAll(entries, auxiliary);
		this.host.loadSession(entries, view.transcript, decorations);
	}

	/**
	 * 宿主事件 → TUI 状态翻译。session_rewind 需要调用方附带压缩回放装饰
	 * （事件按 1:1 透传纪律不携带派生数据，装饰由 cli 从 host 当前 auxiliary 计算）。
	 */
	consume(
		record: HostEventRecord,
		rewindDecorations: readonly CompactionReplayDecoration[] = [],
		auxiliary: readonly (SessionEventRecord | SessionCustomEntryRecord)[] = [],
	): void {
		const m = record.event;
		const nodes = this.controller.ingest(record);
		switch (m.type) {
			case "model_select":
				if (this.host.modelName !== m.model) this.host.setModel(m.model);
				break;

			case "thinking_level_select":
				this.host.setReasoningEffort(m.level);
				break;

			case "session_rewind": {
				const view = this.controller.replaceAll(m.entries, auxiliary, m.turnNumber);
				this.host.replayRewind(m.entries, view.transcript, rewindDecorations, m.turnNumber);
				break;
			}
			case "turn_start": {
				const node = nodes.find((candidate): candidate is TurnNode => candidate.kind === "turn");
				if (!node) break;
				this.host.setProviderRetryMessage();
				this.host.markUsageEstimated();
				this.host.setBusy(true, record.at);
				this.host.startTurnCard(node);
				break;
			}

			case "usage_update":
				// Provider usage 描述过去的一次调用，不覆盖当前 RequestProjection 的上下文快照。
				// 服务端报回的 output 是"本次调用"的输出量（含工具调用参数的分），交给活动行
				// 按 step 结算：它既是这一步的分子，timing.decodeMs 是这一步的解码窗口。
				if (m.usage.outputTokens !== undefined) {
					this.host.addStreamedOutputTokens(m.usage.outputTokens, m.usage.timing, m.usage.reasoningTokens);
				}
				this.host.setRequestUsage(m.usage);
				break;

			case "context_update":
				this.host.setContext(m.snapshot);
				break;

			case "external_input":
				this.host.addExternalInput({
					kind: "external",
					inputId: m.inputId,
					source: m.source,
					receivedAt: m.receivedAt,
					text: sanitizeExternal(m.text),
					...(m.images ? { images: [...m.images] } : {}),
				});
				break;

			case "session_compact":
				// 进度与终态清理的唯一写入者是 builtin 扩展（C5：单一写入者）；
				// TUI 只表达转录卡片与即时 toast。
				if (m.status === "completed") {
					this.host.addCompaction({
						status: m.status,
						summary: m.summary ?? "会话已压缩",
						...(m.retainedTailEntries === undefined ? {} : { retainedTailEntries: m.retainedTailEntries }),
						...(m.tokensBefore === undefined ? {} : { tokensBefore: m.tokensBefore }),
						collapsed: true,
					});
				} else {
					// toast 即时提示 + 终态卡片留存原因（W2c 收口）。
					this.host.notify(
						m.status === "failed"
							? "会话压缩失败，已保留原历史"
							: m.status === "cancelled"
								? "会话压缩被中止"
								: "当前上下文无需压缩",
						m.status === "failed" ? "error" : m.status === "cancelled" ? "warning" : "info",
						3000,
					);
					this.host.addCompaction({
						status: m.status,
						summary: compactionTerminalText(m),
						collapsed: true,
					});
				}
				break;

			case "provider_retry":
				// 重试只保留 activity 状态行（C8）：toast 与状态行重复，且每次重试都闪会淹没真正要紧的通知。
				this.host.setProviderRetryMessage(
					`${m.provider} 连接失败（${m.status === undefined ? m.reason : `HTTP ${m.status}`}），${(m.delayMs / 1000).toFixed(1)} 秒后重试，第 ${m.attempt} 次`,
					record.at,
				);
				break;

			case "provider_recovered":
				this.host.setProviderRetryMessage();
				this.host.notify(`${m.provider} 已恢复连接，继续当前请求`, "info", 2000);
				break;

			case "output_update": {
				if (m.channel === "thinking") {
					// 思考 token 也是「生成」，必须进解码区间（host 内活动行同步喂流）。
					const node = nodes.find(
						(candidate): candidate is ThinkingNode => candidate.kind === "thinking" && candidate.status === "running",
					);
					this.host.appendThinkingNode(node, sanitizeExternal(m.text));
					break;
				}
				if (m.channel !== "content") break;
				const node = nodes.find((candidate): candidate is AssistantNode => candidate.kind === "assistant");
				this.host.appendAssistantNode(node, sanitizeExternal(m.text));
				break;
			}

			case "tool_call": {
				// 模型调用到此结束，结算这一步的解码区间与输出量；接下来的工具执行时间不计入生成速度。
				const node = nodes.find(
					(candidate): candidate is ToolNode => candidate.kind === "tool" && candidate.callId === m.callId,
				);
				if (!node) break;
				this.host.beginToolCard(node);
				this.notifyToolActivity();
				break;
			}

			case "tool_result": {
				const node = nodes.find(
					(candidate): candidate is ToolNode => candidate.kind === "tool" && candidate.callId === m.callId,
				);
				if (!node || node.status === "running") break;
				this.host.settleToolCard(node);
				this.notifyToolActivity();
				break;
			}

			case "turn_end":
				this.host.setProviderRetryMessage();
				this.notifyToolActivity();
				this.host.setBusy(false, record.at);
				this.host.finishTurnCard(nodes);
				if (m.requestUsage) {
					this.host.setRequestUsage(m.requestUsage);
				}
				break;

			case "turn_aborted":
				this.host.setProviderRetryMessage();
				this.notifyToolActivity();
				this.host.interruptTurnCard(nodes);
				this.host.setBusy(false, record.at);
				break;

			case "notice":
				// 瞬态通知走 toast（对话框右侧上方，3s 消失），与模型切换提示同形态，不进 transcript
				this.host.notify(sanitizeExternal(m.text), "info", 3000);
				break;

			case "error":
				this.host.setProviderRetryMessage();
				this.notifyToolActivity();
				this.host.setBusy(false, record.at);
				this.host.addErrorCard(sanitizeExternal(m.text));
				break;

			case "queue":
				this.host.setPendingQueue(m.items);
				break;

			case "custom_message": {
				// 事件载荷是 readonly 视图（1:1 透传纪律），UI 契约收可变数组：接缝处
				// 一次性拷贝，罕见路径，分配成本可忽略。
				const { customType, content, images, display, details } = m.message;
				this.host.addCustomMessage({
					customType,
					content,
					...(images ? { images: [...images] } : {}),
					...(display !== undefined ? { display } : {}),
					...(details !== undefined ? { details } : {}),
				});
				break;
			}

			case "session_compact_start":
				// 压缩可能耗时数十秒（多块摘要 + 再压缩 + fit 测量），起点给一条提示，
				// 逐块进度由 builtin 扩展写工作指示（C5 单一写入者），终点由 session_compact 表达。
				this.host.notify("正在压缩会话历史…", "info", 2500);
				break;

			// ── 设计内忽略清单：每条忽略都是显式决策，新增事件类型时 default 的
			// never 断言会编译报错，强迫在此处理或在此登记。 ──
			case "agent_start":
			case "agent_end":
			case "agent_settled":
				// Subject 步骤生命周期：TUI 消费 turn 粒度（turn_start/turn_end/turn_aborted）。
				break;
			case "output_start":
			case "output_end":
			case "output_interrupted":
				// 流式由 output_update 增量驱动，输出生命周期由回合收口表达。
				break;
			case "input_accepted":
			case "input_settled":
				// 人类输入由 turn_start 回显；外部 runtime 输入由 external_input 卡片表达。
				break;
			case "custom_entry":
				// 扩展私有辅助词汇：由域专属表面表达（压缩卡片与 /prompt 快照）。
				break;
			case "session_compact_progress":
				// 逐块进度的唯一写入者是 builtin 扩展（pi.ui.setWorking，C5）；
				// TUI 不重复写，避免同一指示器两条漂移的生命周期。
				break;
			default: {
				// 穷尽性收口：走到这里说明 RuntimeEvent 有新类型未显式决策。
				const _exhaustive: never = m;
				return _exhaustive;
			}
		}
	}

	close(): void {
		this.notifyToolActivity();
		this.featureDisposer();
		this.host.stop();
	}
}

export function createInteractiveUI(options: InteractiveTUIOptions = {}): InteractiveTUI {
	return new InteractiveTUI(options);
}
