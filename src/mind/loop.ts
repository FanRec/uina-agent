/**
 * Subject：前台循环，最小 Agent 主体。
 *
 * 一轮的流程：事件到达 → 空闲则开轮（busy 期间输入进 pending，轮末批量再入一轮）
 * → 组装上下文 → 模型流式决策 → 文本逐段输出 / 工具执行并回注 → 收尾。
 *
 * 关键约束：
 *  - 确定性代码拥有状态迁移（busy/pending/轮次边界），模型只提议工具与措辞；
 *  - 工具循环设上限，防模型失控死循环；
 *  - 后台任务完成（job_done）以"内部事件"形式唤醒主体，与普通输入同路。
 */
import type { Bus } from "../core/bus.js";
import type { RuntimeStore } from "../core/store.js";
import type {
	ChatMsg,
	CompletedToolCall,
	ModelProvider,
} from "../core/types.js";
import type { MemoryPort } from "../memory/port.js";
import type { ToolBroker } from "../tools/broker.js";
import { buildContext } from "./context.js";

export interface LoopHooks {
	onToken: (text: string) => void;
	onTurnStart?: (n: number, info: { text: string; viaInternal: boolean }) => void;
	onTurnEnd?: (n: number) => void;
	onTool?: (name: string, args: unknown, result: string) => void;
}

const MAX_TOOL_ROUNDS = 3;

interface PendingInput {
	text: string;
	extra?: string;
}

export class Subject {
	private busy = false;
	private readonly pending: PendingInput[] = [];
	private history: ChatMsg[] = [];
	private turnSeq = 0;
	private stopped = false;

	constructor(
		private readonly bus: Bus,
		private readonly store: RuntimeStore,
		private readonly provider: ModelProvider,
		private readonly memory: MemoryPort,
		private readonly tools: ToolBroker,
		private readonly hooks: LoopHooks,
	) {
		this.bus.on((e) => {
			if (this.stopped) return;
			if (e.type === "user_input") {
				this.pushInput(e.text);
			} else if (e.type === "job_done") {
				this.pushInput(
					"",
					`你启动的后台任务（${e.jobId}）已完成，结果：${e.result}。请自然地接上。`,
				);
			}
		});
	}

	/** 接收输入：空闲立即开轮，busy 排队待轮末批量注入。 */
	pushInput(text: string, extra?: string): void {
		if (this.busy) {
			this.pending.push({ text, extra });
			return;
		}
		void this.runTurn(text, extra);
	}

	stop(): void {
		this.stopped = true;
	}

	private async runTurn(text: string, extra?: string): Promise<void> {
		this.busy = true;
		const n = ++this.turnSeq;
		this.store.nextTurnId();
		this.bus.emit({ type: "turn_start", id: n });
		this.hooks.onTurnStart?.(n, { text, viaInternal: extra !== undefined });

		try {
			if (text.trim()) this.history.push({ role: "user", content: text });
			await this.decide(text, extra);

			// 轮末刷新排队：输出期间到达的输入合并为一条，按序再入一轮
			const queued = this.pending.splice(0);
			const queuedText = queued
				.map((q) => q.text.trim())
				.filter(Boolean)
				.join("\n");
			const queuedExtra = queued.find((q) => q.extra)?.extra;
			if (queuedText) await this.decide(queuedText, queuedExtra);
		} catch (e) {
			this.hooks.onToken(`\n[内部错误] ${(e as Error).message}\n`);
		} finally {
			this.busy = false;
			this.bus.emit({ type: "turn_end", id: n });
			this.hooks.onTurnEnd?.(n);
		}
	}

	/** 决策循环：模型流式产出 → 若要工具则执行并回注 → 继续，直到模型完成。 */
	private async decide(text: string, extra?: string): Promise<void> {
		for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
			const recalled = this.memory
				.recall(`${this.store.name} ${text}`, 5)
				.map((m) => m.text);
			const msgs = buildContext({
				selfName: this.store.name,
				userText: text,
				recalled,
				history: this.history,
				extra,
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
				this.hooks.onToken(`\n  [tool:${tc.name}] `);
				const result = await this.tools.run(
					tc.name,
					(tc.args ?? {}) as Record<string, unknown>,
					{
						onJobDone: (jobId, r) =>
							this.bus.emit({ type: "job_done", jobId, result: r }),
					},
				);
				this.hooks.onToken("\n");
				this.hooks.onTool?.(tc.name, tc.args, result);
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

	/** 自检：当前规模（测试/调试用） */
	stats(): { turns: number; historyLen: number; pending: number } {
		return {
			turns: this.turnSeq,
			historyLen: this.history.length,
			pending: this.pending.length,
		};
	}
}
