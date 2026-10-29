import { ContextCardComponent, type PromptContextCardData } from "../../components/transcript/context-card.js";
import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import { hintsFor, type Keymap, resolve } from "../../keys/keymap.js";
import { panelInnerWidth, renderPanel } from "../../layout/panel.js";

/** /prompt 查询面板：展示最近一次真正用于模型请求的最终 system prompt。 */
export class PromptOverlay implements Component, Focusable {
	focused = true;
	onClose?: () => void;
	private offset = 0;
	private totalLines = 0;

	constructor(private readonly snapshot?: PromptContextCardData) {}

	keymap(): Keymap {
		return {
			capturing: true,
			bindings: [
				{ keys: [Key.up], action: "overlay.lineUp", label: "↑/↓ 1 行" },
				{ keys: [Key.down], action: "overlay.lineDown", label: "↑/↓ 1 行" },
				{ keys: ["k"], action: "overlay.lineUp", label: "↑/↓ 1 行" },
				{ keys: ["j"], action: "overlay.lineDown", label: "↑/↓ 1 行" },
				{ keys: [Key.pageup], action: "overlay.pageUp", label: "PgUp/PgDn 8 行" },
				{ keys: [Key.pagedown], action: "overlay.pageDown", label: "PgUp/PgDn 8 行" },
				{ keys: [Key.escape], action: "overlay.close", label: "Esc 关闭" },
			],
		};
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}
		const action = resolve(this.keymap(), data);
		switch (action) {
			case "overlay.lineUp":
				this.offset = Math.max(0, this.offset - 1);
				this.onRequestRender?.();
				return;
			case "overlay.lineDown":
				this.offset = Math.min(Math.max(0, this.totalLines - 1), this.offset + 1);
				this.onRequestRender?.();
				return;
			case "overlay.pageUp":
				this.offset = Math.max(0, this.offset - 8);
				this.onRequestRender?.();
				return;
			case "overlay.pageDown":
				this.offset += 8;
				this.onRequestRender?.();
				return;
			default:
				return;
		}
	}

	/** 请求浮层重绘的回调（OverlayHandle.requestRender 注入）。 */
	onRequestRender?: () => void;

	render(width = 80, availableHeight = 24): string[] {
		if (width <= 0 || availableHeight <= 0) return [];
		const height = Math.max(1, Math.floor(availableHeight));
		const leftPad = width >= 64 ? 2 : 0;
		const boxWidth = Math.max(1, Math.min(width - leftPad, 112));
		const innerW = Math.max(1, panelInnerWidth(boxWidth));
		const body: string[] = [];
		let footer = `${C.inactive}${"Esc 关闭"}${C.reset}`;
		if (this.snapshot) {
			const card = new ContextCardComponent({ ...this.snapshot, id: this.snapshot.id ?? "prompt-current" });
			card.toggle();
			const lines = card.render(innerW);
			this.totalLines = lines.length;
			// 顶边框 + 底边框 + 页脚行占 3 行，其余给卡片正文
			const bodyHeight = Math.max(1, height - 3);
			const maxOffset = Math.max(0, lines.length - bodyHeight);
			this.offset = Math.min(this.offset, maxOffset);
			body.push(...lines.slice(this.offset, this.offset + bodyHeight));
			// F3：位置指示——页脚声明的能力与真实滚动状态一致
			const first = Math.min(lines.length, this.offset + 1);
			const last = Math.min(lines.length, this.offset + bodyHeight);
			// F3：页脚由键位表生成 + 位置指示，声明与真实滚动状态一致
			footer = `${C.inactive}${hintsFor(this.keymap(), innerW)} · 第 ${first}-${last}/${lines.length} 行${C.reset}`;
		} else {
			body.push(`${C.inactive}当前还没有模型回合，暂无提示词快照${C.reset}`);
		}
		return renderPanel({
			title: "提示词查询 · /prompt",
			body,
			footer,
			boxWidth,
			leftPad,
			titleColor: `${C.bold}${C.suggestion}`,
		}).slice(0, height);
	}

	invalidate(): void {}
}
