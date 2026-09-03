/**
 * 自定义消息组件（CustomMessageComponent）。
 * 针对扩展投递的 CustomMessage 进行渲染，优先调用已注册的渲染器，
 * 未注册时提供标准的深色背景边框卡片兜底呈现。
 */

import { Container } from "../../core/container.js";
import { C, truncateToWidth, visibleWidth } from "../../core/utils.js";
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
				const tag = `[${self.message.customType}]`;
				const borderCol = C.blue;
				const header = `  ${borderCol}╭─ ${C.bold}${tag}${C.reset}${borderCol} ${"─".repeat(Math.max(2, w - visibleWidth(tag) - 8))}╮${C.reset}`;
				const text = truncateToWidth(self.message.content, Math.max(10, w - 8));
				const body = `  ${borderCol}│${C.reset}  ${text}`;
				const footer = `  ${borderCol}╰${"─".repeat(Math.max(4, w - 6))}╯${C.reset}`;
				return [header, body, footer];
			},
			invalidate: () => {},
		});
	}
}
