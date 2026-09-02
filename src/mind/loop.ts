/**
 * Subject：前台循环，最小 Agent 主体。
 *
 * 一轮的流程：输入到达 → 空闲则开轮（busy 期间输入进 pending，轮末批量再入一轮）
 * → 组装上下文 → 模型流式决策 → 文本逐段输出 / 工具执行并回注 → 收尾。
 *
 * 限制条件对齐 pi（2026-09-02 空纪指令）：
 *  - 无工具轮/调用上限（pi 无此限制；模型产出 tool_calls 即继续，防失控靠模型本身）
 *  - 历史不硬截断条数（pi 无）；上下文用 compaction 管理：token 估算超阈值时，
 *    把最旧一段让模型压缩成摘要保留（pi 参数：reserve 16k / keepRecent 20k）
 *  - 工具消息进入上下文/会话时截断到 2000 字符（对齐 pi 的序列化层截断）
 */
import type {
	ChatMsg,
	CompletedToolCall,
	ModelProvider,
} from "../core/types.js";
import type { ToolBroker } from "../tools/broker.js";
import { buildContext } from "./context.js";

export interface LoopHooks {
	onToken: (text: string) => void;
	onTurnStart?: (n: number, text: string) => void;
	onTurnEnd?: (n: number) => void;
	/** 工具执行开始（渲染层据此显示"工具调用中"状态） */
	onToolStart?: (name: string, args: unknown) => void;
	/** 工具执行完成 */
	onToolDone?: (name: string, result: string) => void;
	/** 轮处理出错（provider/协议层异常）——渲染层结构化显示 */
	onError?: (msg: string) => void;
	/** 状态信号（非错误，如输出被截断）——渲染层黄色提示 */
	onNotice?: (msg: string) => void;
}

/** 模型上下文窗口（deepseek-chat 64K tokens）；估算超过 window-reserve 即触发压缩 */
const CONTEXT_WINDOW = 64 * 1024;
/** pi 默认：给回复预留的 token 数 */
const RESERVE_TOKENS = 16384;
/** pi 默认：保留最近的 token 数，更旧的压缩 */
const KEEP_RECENT_TOKENS = 20000;
/** 工具消息进入上下文时的序列化截断（pi compaction 文档：2000 字符 + 标记） */
const SERIALIZE_CAP = 2000;

export class Subject {
	private busy = false;
	private readonly pending: string[] = [];
	private history: ChatMsg[] = [];
	private turnSeq = 0;
	private stopped = false;
	/** 本轮是否已被 interrupt() 标记中断（工具中止后不再进下一轮 LLM） */
	private interrupted = false;
	/** 当前轮的工具取消信号（interrupt() → abort() → 正在执行的工具被杀） */
	private abort: AbortController | null = null;

	constructor(
		private readonly provider: ModelProvider,
		private readonly tools: ToolBroker,
		private readonly hooks: LoopHooks,
	) {}

	/** 接收输入：空闲立即开轮，busy 排队待轮末批量注入。 */
	pushInput(text: string): void {
		if (this.stopped || !text.trim()) return;
		if (this.busy) {
			this.pending.push(text);
			return;
		}
		void this.runTurn(text);
	}

	/**
	 * 强制中断当前轮（接口契约，对齐 pi 的 app.interrupt）：
	 * 中止正在执行的工具（kill 进程树）+ 停止后续决策。
	 * 流式输出阶段的中断要等当前段落流完才生效（不切模型连接，只停工具与循环）。
	 * 空闲时调用无效果。
	 */
	interrupt(): void {
		if (!this.busy) return;
		this.interrupted = true;
		this.abort?.abort();
	}

	/** 是否有轮在跑（渲染层据此决定 Ctrl+C 语义：中断 vs 退出） */
	isBusy(): boolean {
		return this.busy;
	}

	/** 恢复历史（会话续聊：--continue 时从会话文件注入起点）。 */
	addHistory(msgs: ChatMsg[]): void {
		this.history.push(...msgs);
	}

	/** 当前会话历史（退出时落盘用）。 */
	historySnapshot(): ChatMsg[] {
		return [...this.history];
	}

	stop(): void {
		this.stopped = true;
	}

	private async runTurn(text: string): Promise<void> {
		this.busy = true;
		this.interrupted = false;
		this.abort = new AbortController();
		const n = ++this.turnSeq;
		this.hooks.onTurnStart?.(n, text);

		try {
			// 本轮 + drain 循环：输出期间到达的排队输入持续消费直到为空。
			// 修复时序竞态：批量段运行中再次到达的消息也必须被轮末刷新消费，
			// 否则滞留在 pending 里等下一次轮才处理（"最后一条补充消息被吞"）。
			await this.decideBatch(text);
			if (!this.interrupted) {
				for (;;) {
					const queuedText = this.takePending();
					if (!queuedText) break;
					await this.decideBatch(queuedText);
				}
			}
		} catch (e) {
			// 错误成环：结构化错误进入历史（模型下轮可见、可自我纠正）+ 通知渲染层。
			// 剩余排队输入保留在 pending，下次 pushInput 开轮时会被 drain 消费。
			const msg = (e as Error).message;
			this.history.push({
				role: "user",
				content: `（系统提示）上轮处理出错：${msg}`,
			});
			this.hooks.onError?.(msg);
		} finally {
			this.abort = null;
			this.busy = false;
			this.hooks.onTurnEnd?.(n);
		}
	}

	/** 把输入作为一条 user 消息交付给决策循环 */
	private async decideBatch(text: string): Promise<void> {
		this.history.push({ role: "user", content: text });
		await this.decide(text);
	}

	/** 清空排队输入，合并成一条 user 消息（空则返回空串） */
	private takePending(): string {
		const queued = this.pending.splice(0);
		return queued
			.map((q) => q.trim())
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Compaction（对齐 pi）：
	 * 估算上下文 token，超 CONTEXT_WINDOW - RESERVE 时，从最新往前保留
	 * KEEP_RECENT_TOKENS，更旧的压缩成一条 "[历史摘要] xxx" user 消息。
	 * 历史里已有摘要则不再压（摘要作为下次压缩的迭代上下文，对齐 pi 的
	 * "passing the previous summary as iterative context"）。
	 */
	private async maybeCompact(): Promise<void> {
		if (this.estimateTokens(this.history) <= CONTEXT_WINDOW - RESERVE_TOKENS) {
			return;
		}
		const head = this.history[0];
		if (
			head &&
			head.role === "user" &&
			(head.content ?? "").startsWith("[历史摘要]")
		) {
			return;
		}

		// 找 cut point：从最新往回累计到 KEEP_RECENT_TOKENS，前面的压缩
		let keepFrom = 0;
		let acc = 0;
		for (let i = this.history.length - 1; i >= 0; i--) {
			acc += this.estimateTokens([this.history[i]]);
			if (acc >= KEEP_RECENT_TOKENS) {
				keepFrom = i;
				break;
			}
		}
		const oldest = this.history.splice(0, keepFrom);
		const transcript = oldest
			.map((m) => `[${m.role}] ${m.content ?? ""}`)
			.join("\n");

		let summary = "";
		try {
			await this.provider.stream(
				{
					messages: [
						{
							role: "system",
							content:
								"你是 Uina。把以下历史对话压缩成不超过 200 字的中文摘要：只保留关键事实、用户偏好、未完成事项。不要寒暄。",
						},
						{ role: "user", content: transcript },
					],
				},
				(d) => {
					if (d.kind === "text") summary += d.text;
				},
			);
		} catch {
			// 压缩失败不阻断：直接丢最旧部分 + 留一句占位
		}
		const final = summary.trim().slice(0, 300);
		this.history.unshift({
			role: "user",
			content: `[历史摘要] ${final || "（压缩失败，已丢弃最旧对话）"}`,
		});
	}

	/** 极简 token 估算：中文约 1 字符≈1 token，英文约 4 字符≈1 token；带每条消息固定开销。
	 *  含 assistant.tool_calls 的 JSON 序列化长度（wire 上会真实膨胀，不算会低估触发偏晚）。
	 *  保守上浮防超限。 */
	private estimateTokens(msgs: ChatMsg[]): number {
		let sum = 0;
		for (const m of msgs) {
			const content = (m.content ?? "").length;
			// 中文为主场景：content*0.7 居中上浮；每条固定开销 4
			sum += Math.ceil(content * 0.7) + 4;
			if ("tool_calls" in m && m.tool_calls) {
				for (const tc of m.tool_calls) {
					sum += Math.ceil(JSON.stringify(tc.args ?? {}).length * 0.7) + 2;
				}
			}
		}
		return sum;
	}

	/** 决策循环：模型流式产出 → 若要工具则执行并回注 → 继续，直到模型完成。
	 *  无轮次上限（对齐 pi）：每次工具结果都回注后进入下一 round。
	 *  中断：interrupt() 置 flag + abort 信号——工具中止、不再进下一轮 LLM。 */
	private async decide(text: string): Promise<void> {
		await this.maybeCompact();

		for (;;) {
			if (this.interrupted) {
				this.emitInterrupted();
				return;
			}

			const msgs = buildContext({
				userText: text,
				history: this.history,
			});

			const toolCalls: CompletedToolCall[] = [];
			let reply = "";
			let finishReason: string | null = null;

			await this.provider.stream(
				{ messages: msgs, tools: this.tools.defs() },
				(d) => {
					if (d.kind === "text") {
						reply += d.text;
						this.hooks.onToken(d.text);
					} else if (d.kind === "tool_call") {
						try {
							toolCalls.push({
								id: d.call.id,
								name: d.call.name,
								args: JSON.parse(d.call.args || "{}"),
							});
						} catch {
							toolCalls.push({
								id: d.call.id,
								name: d.call.name,
								args: {},
							});
						}
					} else if (d.kind === "finish" && !finishReason) {
						finishReason = d.reason;
					}
				},
			);

			if (toolCalls.length === 0) {
				if (reply.trim())
					this.history.push({ role: "assistant", content: reply });
				// 截断信号（finish_reason=length）：回复不完整。暴露而非静默——
				// 半截回复照旧入史（模型需要知道自己说了什么），另附一条提示让模型
				// 下一轮继续完成；同时 onNotice 走黄色告警给用户看见（不吞信号）。
				if (finishReason === "length") {
					this.hooks.onNotice?.(
						"本轮回复被输出长度限制截断，模型将收到提示继续完成",
					);
					if (reply.trim()) {
						this.history.push({
							role: "user",
							content: "（系统提示）上轮回复因输出长度限制被截断，请继续完成。",
						});
					}
				}
				return;
			}

			this.history.push({
				role: "assistant",
				content: reply,
				tool_calls: toolCalls,
			});
			const executedIds = new Set<string>();
			for (const tc of toolCalls) {
				if (this.interrupted) {
					break; // 中断：未执行的工具不再执行
				}
				this.hooks.onToolStart?.(tc.name, tc.args);
				const result = await this.tools.run(
					tc.name,
					(tc.args ?? {}) as Record<string, unknown>,
					this.abort?.signal,
				);
				this.hooks.onToolDone?.(tc.name, result);
				// 序列化层截断（对齐 pi：进上下文/会话的工具结果 ≤2000 字符 + 标记）
				this.history.push({
					role: "tool",
					tool_call_id: tc.id,
					content: truncateForContext(result),
				});
				executedIds.add(tc.id);
			}

			if (this.interrupted) {
				// 源头消除（替换旧占位方案）：assistant.tool_calls 已整体入史，未执行的工具
				// 实际没跑——直接从该消息移除它们，让"声明=实际执行"自然配对完整。
				// 不伪造"（已中断，未执行）"假结果给模型（假信息会掩盖真实历史损坏）。
				const asstIndex = this.history.length - 1 - executedIds.size;
				const asst = this.history[asstIndex];
				if (
					asst &&
					asst.role === "assistant" &&
					"tool_calls" in asst &&
					asst.tool_calls
				) {
					const kept = asst.tool_calls.filter((t) => executedIds.has(t.id));
					if (kept.length === 0 && !(asst.content ?? "").trim()) {
						this.history.splice(asstIndex, 1); // 一个都没执行且无正文 → 删整条
					} else {
						asst.tool_calls = kept;
					}
				}
				this.emitInterrupted();
				return; // 中断后不再进下一轮 LLM
			}
			// 工具结果已回注，进入下一 round 由模型基于结果继续
		}
	}

	/** 中断收口：标记 + 一条历史占位 + 渲染层提示 */
	private emitInterrupted(): void {
		this.history.push({ role: "assistant", content: "[已中断]" });
		this.hooks.onToken("\n[已中断] 当前对话已停止。\n");
	}
}

/** 工具消息的序列化截断：保留前 2000 字符，超出部分换成标记（对齐 pi） */
function truncateForContext(s: string): string {
	if (s.length <= SERIALIZE_CAP) return s;
	return `${s.slice(0, SERIALIZE_CAP)}…[截断: 完整内容 ${s.length} 字符]`;
}

/**
 * 会话历史校验：找出"assistant 声明了 tool_calls 但无对应 tool 结果"的孤儿 id（配对破损）。
 * 由 main 在 --continue 恢复时调用——发现破损显式报错（暴露而非兜底），不自动补占位。
 */
export function findOrphanToolCalls(msgs: readonly ChatMsg[]): string[] {
	const declared = new Set<string>();
	for (const m of msgs) {
		if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
			for (const t of m.tool_calls) declared.add(t.id);
		}
	}
	for (const m of msgs) {
		if (m.role === "tool") declared.delete(m.tool_call_id);
	}
	return [...declared];
}
