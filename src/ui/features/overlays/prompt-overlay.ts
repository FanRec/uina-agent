import type { RequestObservation } from "../../../core/types.js";
import { ContextCardComponent, type PromptContextCardData } from "../../components/transcript/context-card.js";
import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { hintsFor, type Keymap, resolve } from "../../keys/keymap.js";
import { wrapLine } from "../../layout/fit.js";
import { panelInnerWidth, renderPanel } from "../../layout/panel.js";

/** /prompt 查询面板：回合提示词与最近一次请求附带的世界观察。 */
export class PromptOverlay implements Component, Focusable {
	focused = true;
	onClose?: () => void;
	private offset = 0;
	private totalLines = 0;

	constructor(
		private readonly snapshot?: PromptContextCardData,
		private readonly getObservations?: () => readonly RequestObservation[] | undefined,
	) {}

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
		const lines: string[] = [];
		const observations = this.getObservations?.();
		if (observations !== undefined) {
			lines.push(...wrapLine(`${C.bold}最近一次模型请求 · 世界观察${C.reset}`, innerW));
			if (observations.length === 0) lines.push(...wrapLine("未附加世界观察", innerW));
			for (const { source, text } of observations) {
				lines.push(...wrapLine(`${C.cyan}${sanitizeRenderText(source)}${C.reset}`, innerW));
				lines.push(...wrapLine(sanitizeRenderText(text), innerW));
			}
			lines.push("");
		}
		if (this.snapshot) {
			const card = new ContextCardComponent({ ...this.snapshot, id: this.snapshot.id ?? "prompt-current" });
			card.toggle();
			lines.push(...card.render(innerW));
		} else {
			lines.push(`${C.inactive}暂无系统提示词快照${C.reset}`);
		}
		this.totalLines = lines.length;
		const bodyHeight = Math.max(1, height - 3);
		this.offset = Math.min(this.offset, Math.max(0, lines.length - bodyHeight));
		const last = Math.min(lines.length, this.offset + bodyHeight);
		const footer =
			lines.length > bodyHeight
				? `${hintsFor(this.keymap(), innerW)} · 第 ${this.offset + 1}-${last}/${lines.length} 行`
				: "Esc 关闭";
		return renderPanel({
			title: "提示词查询 · /prompt",
			body: lines.slice(this.offset, this.offset + bodyHeight),
			footer: `${C.inactive}${footer}${C.reset}`,
			boxWidth,
			leftPad,
			titleColor: `${C.bold}${C.suggestion}`,
		}).slice(0, height);
	}

	invalidate(): void {}
}
