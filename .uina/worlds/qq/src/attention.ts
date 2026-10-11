import { REF_PATTERNS } from "./types.js";

/**
 * 注意力模型（v3 哑手机）：focus = 打开的聊天窗口。
 * - focus 是会话期内存状态：进程重启后重置为空（在场是行为状态，重启重新声明），
 *   绝不持久化、绝不隐式修改静音偏好。
 * - focus 流式无视静音：开着窗口 = 看得到，门铃（off/pausedUntil）只管不在场时。
 * - setFocus 原子替换；传空数组即放下所有关注；会话引用非法显式失败。
 */
export class AttentionModel {
	private readonly focus = new Set<string>();

	/** 原子替换当前打开窗口的会话列表；传空数组 = 放下所有关注。 */
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
}
