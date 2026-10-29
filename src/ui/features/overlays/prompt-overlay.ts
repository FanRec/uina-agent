import { ContextCardComponent, type PromptContextCardData } from "../../components/transcript/context-card.js";
import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import { panelInnerWidth, renderPanel } from "../../layout/panel.js";

/** /prompt 查询面板：展示最近一次真正用于模型请求的最终 system prompt。 */
export class PromptOverlay implements Component, Focusable {
	focused = true;
	onClose?: () => void;
	private offset = 0;

	constructor(private readonly snapshot?: PromptContextCardData) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, Key.pageup) || data === "k" || data === "K") this.offset = Math.max(0, this.offset - 8);
		else if (matchesKey(data, Key.pagedown) || data === "j" || data === "J") this.offset += 8;
	}

	render(width = 80, availableHeight = 24): string[] {
		if (width <= 0 || availableHeight <= 0) return [];
		const height = Math.max(1, Math.floor(availableHeight));
		const leftPad = width >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(width - leftPad, 112));
		const innerW = Math.max(1, panelInnerWidth(boxWidth));
		const body: string[] = [];
		if (this.snapshot) {
			const card = new ContextCardComponent({ ...this.snapshot, id: this.snapshot.id ?? "prompt-current" });
			card.toggle();
			const lines = card.render(innerW);
			// 顶边框 + 底边框 + 页脚行占 3 行，其余给卡片正文
			const bodyHeight = Math.max(1, height - 3);
			const maxOffset = Math.max(0, lines.length - bodyHeight);
			this.offset = Math.min(this.offset, maxOffset);
			body.push(...lines.slice(this.offset, this.offset + bodyHeight));
		} else {
			body.push(`${C.inactive}当前还没有模型回合，暂无提示词快照${C.reset}`);
		}
		return renderPanel({
			title: "提示词查询 · /prompt",
			body,
			footer: `${C.dim}↑/↓ 或 j/k 滚动 · Esc 关闭${C.reset}`,
			boxWidth,
			leftPad,
			titleColor: `${C.bold}${C.suggestion}`,
		}).slice(0, height);
	}

	invalidate(): void {}
}
