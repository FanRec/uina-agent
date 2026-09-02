/**
 * Subject：前台循环，最小 Agent 主体。
 *
 * 一轮的流程：输入到达 → 空闲则开轮（busy 期间输入进 pending，轮末批量再入一轮）
 * → 组装上下文 → 模型流式决策 → 文本逐段输出 / 工具执行并回注 → 收尾。
 *
 * 关键约束：
 *  - 确定性代码拥有状态迁移（busy/pending/轮次边界），模型只提议工具与措辞；
 *  - 工具循环设上限，防模型失控死循环。
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

const MAX_TOOL_ROUNDS = 8;

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

	/** 决策循环：模型流式产出 → 若要工具则执行并回注 → 继续，直到模型完成。 */
	private async decide(text: string): Promise<void> {
		for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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
				this.history.push({
					role: "tool",
					tool_call_id: tc.id,
					content: result,
				});
			}
			// 工具结果已回注，进入下一 round 由模型基于结果继续
		}
		this.hooks.onToken("\n[达到工具循环上限，本轮终止]\n");
	}
}
