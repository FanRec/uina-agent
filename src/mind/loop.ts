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
		const n = ++this.turnSeq;
		this.hooks.onTurnStart?.(n, text);

		try {
			this.history.push({ role: "user", content: text });
			await this.decide(text);

			// 轮末刷新排队：输出期间到达的输入合并为一条，按序再入一轮
			const queued = this.pending.splice(0);
			const queuedText = queued
				.map((q) => q.trim())
				.filter(Boolean)
				.join("\n");
			if (queuedText) await this.decide(queuedText);
		} catch (e) {
			this.hooks.onToken(`\n[内部错误] ${(e as Error).message}\n`);
		} finally {
			this.busy = false;
			this.hooks.onTurnEnd?.(n);
		}
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

	/** 极简 token 估算：中文约 1 字符≈1 token，英文约 4 字符≈1 token；带每条消息固定开销。保守上浮防超限。 */
	private estimateTokens(msgs: ChatMsg[]): number {
		let sum = 0;
		for (const m of msgs) {
			const content = (m.content ?? "").length;
			// 中文为主场景：content*0.8；英文 4 字符 1 token → 0.4；取 0.7 居中并上浮 20%
			sum += Math.ceil(content * 0.7) + 4;
		}
		return sum;
	}

	/** 决策循环：模型流式产出 → 若要工具则执行并回注 → 继续，直到模型完成。
	 *  无轮次上限（对齐 pi）：每次工具结果都回注后进入下一 round。 */
	private async decide(text: string): Promise<void> {
		await this.maybeCompact();

		for (;;) {
			const msgs = buildContext({
				userText: text,
				history: this.history,
			});

			const toolCalls: CompletedToolCall[] = [];
			let reply = "";

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
							toolCalls.push({ id: d.call.id, name: d.call.name, args: {} });
						}
					}
				},
			);

			if (toolCalls.length === 0) {
				if (reply.trim())
					this.history.push({ role: "assistant", content: reply });
				return;
			}

			this.history.push({
				role: "assistant",
				content: reply,
				tool_calls: toolCalls,
			});
			for (const tc of toolCalls) {
				this.hooks.onToolStart?.(tc.name, tc.args);
				const result = await this.tools.run(
					tc.name,
					(tc.args ?? {}) as Record<string, unknown>,
				);
				this.hooks.onToolDone?.(tc.name, result);
				// 序列化层截断（对齐 pi：进上下文/会话的工具结果 ≤2000 字符 + 标记）
				this.history.push({
					role: "tool",
					tool_call_id: tc.id,
					content: truncateForContext(result),
				});
			}
			// 工具结果已回注，进入下一 round 由模型基于结果继续
		}
	}
}

/** 工具消息的序列化截断：保留前 2000 字符，超出部分换成标记（对齐 pi） */
function truncateForContext(s: string): string {
	if (s.length <= SERIALIZE_CAP) return s;
	return `${s.slice(0, SERIALIZE_CAP)}…[截断: 完整内容 ${s.length} 字符]`;
}