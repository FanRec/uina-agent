/**
 * 交互式终端 TUI 门面与统一入口（createInteractiveUI）。
 * 对齐 Pi 的交互体验，向内调度 UIHost，向外提供清晰的事件流与生命周期接口。
 */

import { UIHost, type UIHostOptions } from "./ui-host.js";
import { installUIFeatures, type UIFeatureOptions } from "./features.js";
import { TrajectoryProjection } from "./adapters/agent-events.js";

import type { ExtensionUIContext } from "../extensions/ui-contract.js";
import type { SessionEntry } from "../session/types.js";
import type { PromptSnapshotRecord } from "../session/prompt-snapshots.js";
import type { CompactionReplayDecoration } from "./components/transcript/transcript.js";
import type { PromptContextCardData } from "./components/transcript/context-card.js";
import { promptSnapshotFingerprint } from "../session/prompt-snapshots.js";

import type { HostEvent, HostSnapshot } from "../host/events.js";
import type { TuiIntent } from "./intents.js";

export type { HostEvent };

export interface InteractiveTUIOptions extends UIHostOptions {
	features?: UIFeatureOptions;
}

export class InteractiveTUI {
	private readonly host: UIHost;
	private intentCallback?: (intent: TuiIntent) => void;
	private currentThinkingId?: string;
	private readonly trajectoryProjection: TrajectoryProjection;
	private readonly featureDisposer: () => void;
	/** 工具事实只携带 callId：开始时刻由消费者自记，用于结算耗时。 */
	private readonly toolStartedAt = new Map<string, number>();
	private lastPromptFingerprint?: string;
	private previousSystemPrompt?: string;

	/**
	 * 工具运行中的重绘需求已并入 UIHost 统一帧时钟：
	 * 旧实现是独立的 300ms setInterval；现在只需在工具状态变化时告知宿主，
	 * 宿主把 hasRunningTools() 作为心跳状态源之一（见 UIHost.updateHeartbeat）。
	 * （旧 sync/stop 双方法同名同实现，是三定时器方案的化石，已并入本单点。）
	 */
	private notifyToolActivity(): void {
		this.host.notifyToolActivity();
	}

	/** 结束当前思考块（若打开）：思考块的开关在 output_update/tool_call/turn 终态等
	 * 五处出现，统一收口避免漏一处导致轨迹投影悬挂。 */
	private closeThinking(): void {
		if (this.currentThinkingId) {
			this.trajectoryProjection.onThinkingDone(this.currentThinkingId);
			this.currentThinkingId = undefined;
		}
	}

	constructor(options: InteractiveTUIOptions = {}) {
		this.host = new UIHost(options);
		const features = installUIFeatures(this.host, options.features);
		this.trajectoryProjection = features.trajectory;
		this.featureDisposer = features.dispose;

		this.host.onUserLine = (line, mode) => {
			// mode 原样穿透：direct/steer/followUp 的归一单点在 host.submitText，
			// 门面不改名（旧实现把 direct 改写成 steer，语义误导且被 host 重判兜底）。
			this.emitIntent({ type: "submit", text: line, mode });
		};

		this.host.onCancel = (source) => {
			this.emitIntent({ type: "cancel", source });
		};
		this.host.onInteraction = () => this.emitIntent({ type: "interaction" });

		this.host.onInterruptAndDeliver = (text) => {
			this.emitIntent({ type: "interrupt-and-deliver", text });
		};

		this.host.onPullBackQueue = () => {
			this.emitIntent({ type: "pull-back-queue" });
		};

		this.host.onThinkingLevelCycle = () => {
			this.emitIntent({ type: "cycle-thinking-level" });
		};
	}

	private emitIntent(intent: TuiIntent): void {
		this.intentCallback?.(intent);
	}

	get extensionUI(): ExtensionUIContext {
		return this.host.ctxUI;
	}

	start(): void {
		this.host.start();
	}

	onIntent(cb: (intent: TuiIntent) => void): void {
		this.intentCallback = cb;
	}

	initialize(snapshot: HostSnapshot): void {
		this.updateSnapshot(snapshot);
	}

	updateSnapshot(snapshot: HostSnapshot): void {
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
		promptSnapshots: readonly PromptSnapshotRecord[] = [],
	): void {
		const latest = promptSnapshots.at(-1);
		this.lastPromptFingerprint = latest?.fingerprint;
		this.previousSystemPrompt = latest?.systemPrompt;
		this.host.loadSession(entries, decorations, promptSnapshots);
	}

	/**
	 * 宿主事件 → TUI 状态翻译。session_rewind 需要调用方附带压缩回放装饰
	 * （事件按 1:1 透传纪律不携带派生数据，装饰由 cli 从 host 当前 auxiliary 计算）。
	 */
	consume(
		m: HostEvent,
		rewindDecorations: readonly CompactionReplayDecoration[] = [],
		promptSnapshots: readonly PromptSnapshotRecord[] = [],
	): void {
		switch (m.type) {
			case "model_select":
				if (this.host.modelName !== m.model) this.host.setModel(m.model);
				break;

			case "thinking_level_select":
				this.host.setReasoningEffort(m.level);
				break;

			case "session_rewind":
				this.currentThinkingId = undefined;
				this.host.replayRewind(m.entries, rewindDecorations, m.turnNumber, promptSnapshots);
				break;
			case "turn_start":
				this.currentThinkingId = undefined;
				this.host.setProviderRetryMessage();
				this.host.markUsageEstimated();
				this.host.setBusy(true);
				this.host.startTurnCard(m.turnNumber, m.userText, m.images);
				this.trajectoryProjection.onTurnStart(m.turnNumber, m.userText);
				break;

			case "usage_update":
				// Provider usage 描述过去的一次调用，不覆盖当前 RequestProjection 的上下文快照。
				// 服务端报回的 output 是"本次调用"的输出量（含工具调用参数的分），交给活动行
				// 按 step 结算：它既是这一步的分子，也是这一步解码区间的右端。
				if (m.usage.outputTokens !== undefined) this.host.addStreamedOutputTokens(m.usage.outputTokens);
				this.host.setRequestUsage(m.usage);
				break;

			case "context_update":
				this.host.setContext(m.snapshot);
				break;

			case "context_prepare": {
				const fingerprint = promptSnapshotFingerprint(m.systemPrompt, m.injections);
				if (fingerprint !== this.lastPromptFingerprint) {
					const snapshot: PromptContextCardData = {
						kind: "prompt",
						id: `prompt-${m.turnNumber}-${fingerprint.slice(0, 12)}`,
						turnNumber: m.turnNumber,
						systemPrompt: m.systemPrompt,
						injections: [...m.injections],
						...(this.previousSystemPrompt === undefined ? {} : { previousSystemPrompt: this.previousSystemPrompt }),
					};
					this.host.addPromptSnapshot(snapshot);
					this.lastPromptFingerprint = fingerprint;
					this.previousSystemPrompt = m.systemPrompt;
				}
				break;
			}

			case "external_input":
				this.host.addExternalInput({
					kind: "external",
					inputId: m.inputId,
					source: m.source,
					receivedAt: m.receivedAt,
					text: m.text,
					...(m.images ? { images: [...m.images] } : {}),
				});
				break;

			case "session_compact":
				if (m.status === "completed") {
					this.host.addCompaction({
						status: m.status,
						summary: m.summary ?? "会话已压缩",
						retainedTailEntries: m.retainedTailEntries ?? 0,
						tokensBefore: m.tokensBefore ?? 0,
						collapsed: true,
					});
					this.trajectoryProjection.onCompaction(m.summary ?? "会话已压缩", m.tokensBefore ?? 0);
				}
				break;

			case "provider_retry":
				this.host.setProviderRetryMessage(
					`${m.provider} 连接失败（${m.status === undefined ? m.reason : `HTTP ${m.status}`}），${(m.delayMs / 1000).toFixed(1)} 秒后重试，第 ${m.attempt} 次`,
				);
				this.host.notify(
					`正在重试 ${m.provider}（第 ${m.attempt} 次，${(m.delayMs / 1000).toFixed(1)} 秒后）`,
					"warning",
					Math.min(3000, Math.max(1000, m.delayMs)),
				);
				break;

			case "provider_recovered":
				this.host.setProviderRetryMessage();
				this.host.notify(`${m.provider} 已恢复连接，继续当前请求`, "info", 2000);
				break;

			case "output_update":
				if (m.channel === "thinking") {
					if (!this.currentThinkingId) {
						this.currentThinkingId = this.trajectoryProjection.onThinkingStart("深度推理");
					}
					// 思考 token 也是「生成」，必须进解码区间（host 内活动行同步喂流）。
					this.host.appendThinkingStream(m.text);
					break;
				}
				if (m.channel !== "content") break;
				this.closeThinking();
				this.host.appendAssistantStream(m.text);
				break;

			case "tool_call": {
				// 模型调用到此结束，结算这一步的解码区间与输出量；接下来的工具执行时间不计入生成速度。
				this.closeThinking();
				if (m.callId) this.toolStartedAt.set(m.callId, Date.now());
				const callId = m.callId ?? `tool-${m.toolName}-${Date.now()}`;
				this.host.beginToolCard(m.toolName, m.args, callId);
				this.trajectoryProjection.onToolStart(m.toolName, m.args, callId);
				this.notifyToolActivity();
				break;
			}

			case "tool_result": {
				// 工具事实携带 callId：耗时由消费者按开始时刻自算（事实流不携带宿主计时）。
				const startedAt = m.callId !== undefined ? this.toolStartedAt.get(m.callId) : undefined;
				if (m.callId !== undefined) this.toolStartedAt.delete(m.callId);
				const elapsed = startedAt === undefined ? 0 : Date.now() - startedAt;
				this.host.settleToolCard(m.toolName, m.result, elapsed, m.status, m.callId, m.args, {
					images: m.images ? [...m.images] : undefined,
					details: m.details,
				});
				this.trajectoryProjection.onToolDone(m.callId ?? "", m.toolName, m.result, elapsed, m.status);
				this.notifyToolActivity();
				break;
			}

			case "turn_end":
				this.host.setProviderRetryMessage();
				this.closeThinking();
				this.notifyToolActivity();
				this.host.setBusy(false);
				this.host.finishTurnCard();
				this.trajectoryProjection.onTurnEnd(m.turnNumber, m.requestUsage);
				if (m.requestUsage) {
					this.host.setRequestUsage(m.requestUsage);
				}
				break;

			case "turn_aborted":
				this.host.setProviderRetryMessage();
				this.closeThinking();
				this.notifyToolActivity();
				this.host.interruptTurnCard();
				this.host.setBusy(false);
				break;

			case "notice":
				// 瞬态通知走 toast（对话框右侧上方，3s 消失），与模型切换提示同形态，不进 transcript
				this.host.notify(m.text, "info", 3000);
				break;

			case "error":
				this.host.setProviderRetryMessage();
				this.closeThinking();
				this.notifyToolActivity();
				this.host.setBusy(false);
				this.host.addErrorCard(m.text);
				this.trajectoryProjection.onError(m.text);
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
				// 终点由 session_compact 卡片表达；逐块进度不进转录（会刷屏）。
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
				// 逐块进度噪声：起点由 session_compact_start 提示，终点由 session_compact 卡片。
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
