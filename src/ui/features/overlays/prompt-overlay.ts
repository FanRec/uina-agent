import type { Component, Focusable } from "../../core/types.js";
import { Key, matchesKey } from "../../core/keys.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";
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
		const boxWidth = Math.max(42, Math.min(width - 4, 110));
		const innerWidth = Math.max(1, boxWidth - 4);
		const title = " 提示词查询 · /prompt ";
		const top = `${C.suggestion}╭─${C.bold}${title}${C.reset}${C.suggestion}${"─".repeat(Math.max(2, boxWidth - visibleWidth(title) - 3))}╮${C.reset}`;
		if (!this.snapshot)
			return [
				top,
				`${C.suggestion}│${C.reset} ${C.inactive}当前还没有模型回合，暂无提示词快照${C.suggestion} │${C.reset}`,
				`${C.suggestion}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`,
			];
		const card = new ContextCardComponent({ ...this.snapshot, id: this.snapshot.id ?? "prompt-current" });
		card.toggle();
		const lines = card.render(innerWidth);
		const body = lines
			.slice(1, -1)
			.map(
				(line) =>
					`${C.suggestion}│${C.reset} ${truncateToWidth(line.replace(/^  /, ""), innerWidth, "…")} ${C.suggestion}│${C.reset}`,
			);
		const visible = body.slice(this.offset, this.offset + 24);
		return [
			top,
			...visible,
			`${C.suggestion}╰${"─".repeat(boxWidth - 2)}╯${C.reset}`,
			`${C.dim}↑/↓ 或 j/k 滚动 · Esc 关闭${C.reset}`,
		];
	}

	invalidate(): void {}
}
