/**
 * TUI Surface 键位表：key token → 动作 id 的声明式映射（W5）。
 *
 * Binding 不携带 run() 闭包——执行由浮层把 resolve() 得到的动作 id 分派给自己的
 * 状态机，或由 surface 映射为 PresentationIntent 交给 controller。页脚提示一律由
 * hintsFor 从绑定生成，提示写什么、按键就做什么（审计 F 类的根治手段）。
 * 字节识别复用 core/keys.ts 的 matchesKey，这里不重写按键解析。
 */

import { matchesKey } from "../core/keys.js";
import { fitLine } from "../layout/fit.js";

export type KeyToken = string;

/**
 * Surface 内动作 id（"overlay.close" / "overlay.commit" / "overlay.scrollUp" …）。
 * 与平台中立的 PresentationIntent 命名空间分离：界面内状态（滚动、焦点、预览）
 * 不跨 surface 边界，不属于应用动作词汇。
 */
export type OverlayActionId = `overlay.${string}`;

export interface Binding {
	keys: readonly KeyToken[];
	action: OverlayActionId;
	/** 提示段（含键名与动词），如 "←/→ 预览"。 */
	label: string;
	/** 条件绑定：不满足时不响应也不进提示。 */
	when?: () => boolean;
}

export interface Keymap {
	/** 捕获态：未绑定键不向编辑器透传。每个可交互浮层必须显式声明。 */
	capturing: boolean;
	bindings: readonly Binding[];
}

/** 解析原始键字节 → 动作 id；无匹配返回 undefined（调用方决定是否透传）。 */
export function resolve(map: Keymap, data: string): OverlayActionId | undefined {
	for (const binding of map.bindings) {
		if (binding.when && !binding.when()) continue;
		for (const token of binding.keys) {
			if (matchesKey(data, token) || data === token) return binding.action;
		}
	}
	return undefined;
}

/** 生效绑定的提示文本：标签按声明序以 " · " 连接，超宽时省略。 */
export function hintsFor(map: Keymap, width: number): string {
	// 多键共享同一段提示（↑/↓、←/→）时按声明去重
	const labels = [...new Set(map.bindings.filter((b) => !b.when || b.when()).map((b) => b.label))];
	return fitLine(labels.join(" · "), Math.max(0, width));
}
