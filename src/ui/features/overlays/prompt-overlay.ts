import {
	ContextCardComponent,
	type PromptPort,
	type PromptRequestCardData,
} from "../../components/transcript/context-card.js";
import { Key, matchesKey } from "../../core/keys.js";
import type { Component, Focusable } from "../../core/types.js";
import { C } from "../../core/utils.js";
import { toReadableError } from "../../../presentation/copy.js";
import { hintsFor, type Keymap, resolve } from "../../keys/keymap.js";
import { panelInnerWidth, renderPanel } from "../../layout/panel.js";

/**
 * /prompt 检查面（信息注入体系）：经 Host 只读端口显示最近准备交给 Provider 的
 * 语义请求；无请求记录时显示明确标注的"当前预览"。预览为纯读操作，可手动刷新。
 */
export class PromptOverlay implements Component, Focusable {
	focused = true;
	onClose?: () => void;
	private offset = 0;
	private totalLines = 0;
	private view?: PromptRequestCardData;
	private status: string | undefined;
	/** 首次装载完成的信号（测试与延迟渲染消费）。 */
	readonly ready: Promise<void>;

	constructor(private readonly port: PromptPort) {
		this.ready = this.refresh();
	}

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
				{ keys: ["r"], action: "overlay.refresh", label: "R 刷新" },
				{ keys: [Key.escape], action: "overlay.close", label: "Esc 关闭" },
			],
		};
	}

	async refresh(): Promise<void> {
		try {
			const prepared = await this.port.requestObservation();
			this.view = prepared ?? (await this.port.inspectRequest());
			this.status = undefined;
		} catch (error) {
			this.status = `查询失败：${toReadableError(error)}`;
		}
		this.offset = 0;
		this.onRequestRender?.();
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
			case "overlay.refresh":
				void this.refresh();
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
		if (this.view) {
			const card = new ContextCardComponent({
				...this.view,
				id: this.view.id ?? (this.view.basis === "prepared" ? "prompt-prepared" : "prompt-preview"),
			});
			card.toggle();
			lines.push(...card.render(innerW));
		} else if (this.status) {
			lines.push(`${C.inactive}${this.status}${C.reset}`);
		} else {
			lines.push(`${C.inactive}正在读取请求检查…${C.reset}`);
		}
		this.totalLines = lines.length;
		const bodyHeight = Math.max(1, height - 3);
		this.offset = Math.min(this.offset, Math.max(0, lines.length - bodyHeight));
		const last = Math.min(lines.length, this.offset + bodyHeight);
		const footer =
			lines.length > bodyHeight
				? `${hintsFor(this.keymap(), innerW)} · 第 ${this.offset + 1}-${last}/${lines.length} 行`
				: hintsFor(this.keymap(), innerW);
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
