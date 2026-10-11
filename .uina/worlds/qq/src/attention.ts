import { REF_PATTERNS } from "./types.js";
import type { ControlStore } from "./control-store.js";

/**
 * 注意力模型（设计 §1.2 双态在场）：
 * - focus 是会话期内存注意力状态：进程重启后重置为空（T14 冷启动无焦点），
 *   绝不持久化、绝不隐式修改 push.mode。
 * - effectiveFollow = isFocused(target) && resolvedPushMode(target) === "follow"。
 * - setFocus 原子替换；传空数组即放下所有关注；会话引用非法显式失败。
 */
export class AttentionModel {
	private readonly focus = new Set<string>();

	constructor(private readonly deps: { readonly control: ControlStore }) {}

	/** 原子替换当前置顶关注会话列表；传空数组 = 放下所有关注。 */
	setFocus(conversationRefs: readonly string[]): void {
		const next = new Set<string>();
		for (const ref of conversationRefs) {
			if (!REF_PATTERNS.conversation.test(ref)) throw new Error(`非法会话引用: ${ref}`);
			next.add(ref);
		}
		this.focus.clear();
		for (const ref of next) this.focus.add(ref);
	}

	focusList(): string[] {
		return [...this.focus];
	}

	isFocused(conversationRef: string): boolean {
		return this.focus.has(conversationRef);
	}

	/** 有效跟读派生公式（§1.2）：视线在该会话 且 解析后 push.mode === "follow"。 */
	effectiveFollow(conversationRef: string): boolean {
		return this.focus.has(conversationRef) && this.deps.control.effectivePush(conversationRef).mode === "follow";
	}
}
