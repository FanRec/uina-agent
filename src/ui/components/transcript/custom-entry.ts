/**
 * 自定义会话条目组件（CustomEntryComponent）。
 * 渲染扩展持久化的 CustomEntry（不进入模型上下文），
 * 优先调用注册的 EntryRenderer，若无则优雅兜底显示标签与 JSON 预览。
 */

import { Container } from "../../core/container.js";
import { C, truncateToWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import type { CustomEntry, EntryRenderer } from "../../../extensions/ui-contract.js";

export class CustomEntryComponent extends Container {
	private expanded = false;

	constructor(
		private readonly entry: CustomEntry,
		private readonly renderer?: EntryRenderer,
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
				const c = this.renderer(this.entry, { expanded: this.expanded });
				if (c) {
					this.addChild(c);
					return;
				}
			} catch (err) {
				this.addChild({
					render: () => [`${C.red}✗ [${this.entry.customType}] Entry 渲染失败: ${String(err)}${C.reset}`],
					invalidate: () => {},
				});
				return;
			}
		}

		// 默认呈现
		const self = this;
		this.addChild({
			render(w: number): string[] {
				const tag = `[条目: ${self.entry.customType}]`;
				// Extension data may be cyclic or contain bigints; a renderer throw
				// would abort the whole frame, so degrade to a readable placeholder.
				let preview = "(无附带数据)";
				if (self.entry.data !== undefined) {
					try {
						preview = sanitizeRenderText(JSON.stringify(self.entry.data) ?? "null");
					} catch {
						preview = "[无法序列化的数据]";
					}
				}
				return [
					`  ${C.gray}◈ ${C.cyan}${tag}${C.reset} ${truncateToWidth(preview, Math.max(10, w - 20))}`,
				];
			},
			invalidate: () => {},
		});
	}
}
