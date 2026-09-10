/**
 * 自定义消息组件（CustomMessageComponent）。
 * 针对扩展投递的 CustomMessage 进行渲染，优先调用已注册的渲染器，
 * 未注册时提供标准的深色背景边框卡片兜底呈现。
 */

import { Container } from "../../core/container.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import type { CustomMessage, MessageRenderer } from "../../extensions/types.js";

export class CustomMessageComponent extends Container {
	private expanded = false;

	constructor(
		private readonly message: CustomMessage,
		private readonly renderer?: MessageRenderer,
	) {
		super();
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();

		if (this.renderer) {
			try {
				const c = this.renderer(this.message, { expanded: this.expanded });
				if (c) {
					this.addChild(c);
					return;
				}
			} catch (err) {
				// 渲染器报错显示明确错误行
				this.addChild({
					render: (_w: number) => [
						`${C.red}✗ [${this.message.customType}] 渲染失败: ${String(err)}${C.reset}`,
					],
					invalidate: () => {},
				});
				return;
			}
		}

		// 默认呈现卡片
		const self = this;
		this.addChild({
			render(w: number): string[] {
				const boxW = Math.max(24, Math.min(w, 80));
				const innerW = boxW - 6;
				const tag = `[${self.message.customType}]`;
				const borderCol = C.blue;
				const topFill = Math.max(2, boxW - visibleWidth(tag) - 8);
				const header = `  ${borderCol}╭─ ${C.bold}${tag}${C.reset}${borderCol} ${"─".repeat(topFill)}╮${C.reset}`;
				// Untrusted extension content: strip control sequences and split
				// real rows (one array entry must map to one terminal row).
				const rawLines = sanitizeRenderText(self.message.content).replace(/\r\n/g, "\n").split("\n");
				const bodyLines = rawLines.map((line) => {
					const text = truncateToWidth(line, innerW);
					const pad = Math.max(0, innerW - visibleWidth(text));
					return `  ${borderCol}│${C.reset}  ${text}${" ".repeat(pad)}  ${borderCol}│${C.reset}`;
				});
				const footer = `  ${borderCol}╰${"─".repeat(Math.max(4, boxW - 4))}╯${C.reset}`;
				return [header, ...bodyLines, footer];
			},
			invalidate: () => {},
		});
	}
}
