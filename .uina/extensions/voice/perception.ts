import type { ContextValue } from "../../../src/core/types.js";

export type VoiceFact =
	| { readonly kind: "delivery_failed"; readonly summary: string }
	| { readonly kind: "delivery_unknown"; readonly summary: string };

/**
 * Voice 持有的未解决事实（信息注入体系）：只维护**当前未解决且影响后续判断**的声音
 * 事实，经 observation Source 只读暴露；不改变候选集合、不标记已读、不触发模型。
 *
 * 生命周期按真实声音状态定（§4.3）：
 * - 有真实 causeRef（声音源身份）的事实按源键控：同源更新替换（不累积重复通知），
 *   resolve(causeRef) 撤销；
 * - 没有真实身份的临时事实（如无源停止未知）进单一"最近临时事实"槽位：新事实替换
 *   旧事实；不以 fact.kind 充当伪 ID 把多次独立故障错误合并；
 * - 任何 resolve（某声音源全部确认完成 = 声音链路正常交付的真实证据）同时清除临时
 *   槽位与先于它记录的旧事实——"新一轮恢复事实"让已终结的故障退出，不永久滞留；
 * - 一次性的"已被主动打断"不代表持续待处理问题，不进入长驻观察（调用方不记录）。
 *
 * record/resolve 通过服务链串行化后按实际发生顺序生效，避免异步乱序让已恢复的
 * 故障再次出现。
 */
export class VoicePerception {
	private readonly facts = new Map<string, { fact: VoiceFact; seq: number }>();
	private transient: { fact: VoiceFact; seq: number } | null = null;
	private seq = 0;

	/** 记录一条未解决事实。causeRef 缺省时只进临时槽位（单槽替换）。 */
	record(fact: VoiceFact, causeRef?: string): VoiceFact {
		const entry = { fact, seq: ++this.seq };
		if (causeRef !== undefined) this.facts.set(causeRef, entry);
		else this.transient = entry;
		return fact;
	}

	/** 撤销一个声音源的事实；同时视为"链路正常交付"的恢复证据，清理此前记录的全部
	 * 已终结故障与临时事实——否则没有 resolve 回调的故障会永久滞留。串行化合同保证
	 * resolve 执行时没有并发 record；其后再记录的新事实（seq 更大）不受影响。 */
	resolve(causeRef: string): void {
		void causeRef;
		this.facts.clear();
		this.transient = null;
	}

	/** 最新一条未解决事实（诊断用）；没有返回 null。 */
	peek(): VoiceFact | null {
		return this.transient?.fact ?? [...this.facts.values()].at(-1)?.fact ?? null;
	}

	/** 全部清空（扩展卸载等业务终止）。 */
	clear(): void {
		this.facts.clear();
		this.transient = null;
	}

	/** observation Source 的只读快照：没有未解决事实时返回 null，不改变状态。 */
	observationValue(): ContextValue | null {
		const lines: string[] = [];
		for (const entry of this.facts.values()) lines.push(entry.fact.summary);
		if (this.transient) lines.push(this.transient.fact.summary);
		if (lines.length === 0) return null;
		return {
			text: `[声音] 未解决的声音事实：${lines.join("；")}`,
			source: { type: "voice.perception", origin: "internal" },
		};
	}
}
