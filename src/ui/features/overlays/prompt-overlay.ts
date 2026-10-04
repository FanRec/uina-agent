import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C } from "../../core/utils.js";
import { ContextCardComponent, type PromptContextCardData } from "../../components/transcript/context-card.js";

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

	render(width = 80): string[] {
		const contentWidth = Math.max(20, Math.min(width, 110));
		const header = `  ${C.bold}${C.suggestion}提示词查询 · /prompt${C.reset}`;
		if (!this.snapshot) {
			return [header, `  ${C.inactive}当前还没有模型回合，暂无提示词快照${C.reset}`];
		}
		const card = new ContextCardComponent({ ...this.snapshot, id: this.snapshot.id ?? "prompt-current" });
		card.toggle();
		const lines = card.render(contentWidth);
		const maxOffset = Math.max(0, lines.length - 24);
		this.offset = Math.min(this.offset, maxOffset);
		return [header, ...lines.slice(this.offset, this.offset + 24), `${C.dim}↑/↓ 或 j/k 滚动 · Esc 关闭${C.reset}`];
	}

	invalidate(): void {}
}
