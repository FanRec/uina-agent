/**
 * ExtensionUIContext 具体实现。
 * 将扩展的狭窄接口调用映射到底层 UIHost 的 Container、OverlayStack、WidgetSlots 与输入层。
 */

import type { Component, Focusable, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import { CURSOR_MARKER } from "./core/types.js";
import { Key, matchesKey } from "./core/keys.js";
import { C, visibleWidth, truncateToWidth, getPrevGraphemeIndex, getNextGraphemeIndex } from "./core/utils.js";
import type { ExtensionUIContext, UsageSnapshot, ModelPickerGroup } from "../extensions/ui-contract.js";
import type { ThinkingLevel } from "../core/types.js";

export interface UIHostContextPort {
	notify(message: string, type?: "info" | "warning" | "error", timeoutMs?: number): void;
	clearNotification?(): void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWidget(key: string, component: Component | undefined, placement?: WidgetPlacement, priority?: number): void;
	setHeader(component: Component | undefined): void;
	setFooter(component: Component | undefined): void;
	showOverlay(component: Component, options?: OverlayOptions, dispose?: () => void): OverlayHandle;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	onTerminalInput(handler: (data: string) => void): () => void;
	requestRender(): void;
	getGutterMode?(): "scrollbar" | "timeline";
	setGutterMode?(mode: "scrollbar" | "timeline"): void;
	// 消费者富能力（可选；ExtensionUIContext 的可选成员由此转发）
	openHelpMenu?(): void;
	toggleThinking?(): void;
	clearTranscript?(): void;
	openModelPicker?(currentModel: string, groups: ModelPickerGroup[], onPick: (name: string) => Promise<void> | void): void;
	openEffortSlider?(currentLevel: ThinkingLevel | undefined, declaredLevels: ThinkingLevel[], onChange: (level: ThinkingLevel) => void): void;
	openTasks?(): void;
	openSubagents?(): void;
	openTrajectory?(): void;
	openHistory?(): void;
	setModel?(name: string): void;
	setThinkingLevels?(levels?: readonly ThinkingLevel[]): void;
	setReasoningEffort?(level?: ThinkingLevel): void;
	setUsage?(snapshot: UsageSnapshot): void;
	getScrollbarThumbStyle?(): "slim" | "block" | "wide";
	setScrollbarThumbStyle?(style: "slim" | "block" | "wide"): void;
	addCompaction?(record: { summary: string; turnsCount: number; tokensBefore: number; collapsed: boolean }): void;
}

/** 终端鼠标上报前缀（覆盖层统一忽略，避免吞掉后续按键字节）。 */
export function isMouseReport(data: string): boolean {
	return data.startsWith("\x1b[<") || data.startsWith("\x1b[M");
}

/** confirm 对话框的左右切换键（←/→/Tab）。 */
export function isToggleKey(data: string): boolean {
	return matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab);
}

/**
 * confirm 对话框的确认键 → 布尔结果（纯函数）：
 * y/Y 恒真、n/N 恒假、Enter 随当前焦点、Esc 取消为假；其余 undefined = 无动作。
 */
export function confirmChoice(data: string, yesSelected: boolean): boolean | undefined {
	if (data === "y" || data === "Y") return true;
	if (data === "n" || data === "N") return false;
	if (matchesKey(data, Key.enter)) return yesSelected;
	if (matchesKey(data, Key.escape)) return false;
	return undefined;
}

export function createExtensionUIContext(host: UIHostContextPort): ExtensionUIContext {
	return {
		select(title: string, options: string[]): Promise<string | undefined> {
			return new Promise((resolve) => {
				let selected = 0;
				let scrollOffset = 0;
				const maxVisible = 8;
				let handle: OverlayHandle | null = null;

				const comp: Component & Focusable = {
					focused: true,
					render(w: number): string[] {
						const boxW = Math.max(36, Math.min(w - 6, 60));
						const innerW = boxW - 4;
						const borderCol = C.gray;
						let topTag = `─ ${title} `;
						if (scrollOffset > 0) {
							topTag = `─ ${title} (↑+${scrollOffset}) `;
						}
						const fillTop = Math.max(1, boxW - 2 - visibleWidth(topTag));
						const top = `  ${borderCol}╭${topTag}${"─".repeat(fillTop)}╮${C.reset}`;
						const out = [top];

						if (options.length === 0) {
							const emptyMsg = `${C.dim}（暂无可用选项）${C.reset}`;
							out.push(`  ${borderCol}│${C.reset} ${emptyMsg}${" ".repeat(Math.max(0, innerW - visibleWidth(emptyMsg)))} ${borderCol}│${C.reset}`);
						} else {
							const visibleOptions = options.slice(scrollOffset, scrollOffset + maxVisible);
							for (let idx = 0; idx < visibleOptions.length; idx++) {
								const i = scrollOffset + idx;
								const opt = visibleOptions[idx]!;
								const isSel = i === selected;
								const pointer = isSel ? `${C.cyan}❯${C.reset}` : " ";
								const maxTextW = Math.max(1, innerW - 3);
								const safeOpt = truncateToWidth(opt, maxTextW, "…");
								const text = isSel ? `${C.bold}${C.white}${safeOpt}${C.reset}` : `${C.dim}${safeOpt}${C.reset}`;
								const line = `${pointer} ${text}`;
								out.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);
							}
						}

						const remainingDown = Math.max(0, options.length - (scrollOffset + maxVisible));
						let hint = `↑↓ 导航 · Enter 确认 · Esc 取消`;
						if (remainingDown > 0) {
							hint = `↓+${remainingDown} · ${hint}`;
						}
						const botFill = Math.max(1, boxW - 2 - visibleWidth(hint) - 2);
						out.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);
						return out;
					},
					handleInput(data: string): void {
						if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return;
						if (matchesKey(data, Key.up)) {
							if (options.length > 0) {
								selected = Math.max(0, selected - 1);
								if (selected < scrollOffset) {
									scrollOffset = selected;
								}
								host.requestRender();
							}
						} else if (matchesKey(data, Key.down)) {
							if (options.length > 0) {
								selected = Math.min(options.length - 1, selected + 1);
								if (selected >= scrollOffset + maxVisible) {
									scrollOffset = selected - maxVisible + 1;
								}
								host.requestRender();
							}
						} else if (matchesKey(data, Key.enter)) {
							handle?.hide();
							resolve(options[selected]);
						} else if (matchesKey(data, Key.escape)) {
							handle?.hide();
							resolve(undefined);
						}
					},
					invalidate(): void {},
				};

				handle = host.showOverlay(comp);
			});
		},

		confirm(title: string, message: string): Promise<boolean> {
			return new Promise((resolve) => {
				let handle: OverlayHandle | null = null;
				let yesSelected = true;

				const comp: Component & Focusable = {
					focused: true,
					render(w: number): string[] {
						const boxW = Math.max(36, Math.min(w - 6, 60));
						const innerW = boxW - 4;
						const borderCol = C.gray;
						const topTag = `─ ${title} `;
						const fillTop = Math.max(1, boxW - 2 - visibleWidth(topTag));
						const top = `  ${borderCol}╭${topTag}${"─".repeat(fillTop)}╮${C.reset}`;
						const out = [top];

						const msgLine = truncateToWidth(message, innerW);
						out.push(`  ${borderCol}│${C.reset} ${msgLine}${" ".repeat(Math.max(0, innerW - visibleWidth(msgLine)))} ${borderCol}│${C.reset}`);

						const btnYes = yesSelected ? `\x1b[7m [ 是 (Y) ] \x1b[0m` : ` [ 是 (Y) ] `;
						const btnNo = !yesSelected ? `\x1b[7m [ 否 (N) ] \x1b[0m` : ` [ 否 (N) ] `;
						const btnRow = `  ${btnYes}   ${btnNo}`;
						out.push(`  ${borderCol}│${C.reset} ${btnRow}${" ".repeat(Math.max(0, innerW - visibleWidth(btnRow)))} ${borderCol}│${C.reset}`);

						const bot = `  ${borderCol}╰${"─".repeat(boxW - 2)}╯${C.reset}`;
						out.push(bot);
						return out;
					},
					handleInput(data: string): void {
						if (isMouseReport(data)) return;
						if (isToggleKey(data)) {
							yesSelected = !yesSelected;
							host.requestRender();
							return;
						}
						const choice = confirmChoice(data, yesSelected);
						if (choice !== undefined) {
							handle?.hide();
							resolve(choice);
						}
					},
					invalidate(): void {},
				};

				handle = host.showOverlay(comp);
			});
		},

		input(title: string, placeholder = ""): Promise<string | undefined> {
			return new Promise((resolve) => {
				let text = "";
				let cursorIndex = 0;
				let inPaste = false;
				let pasteBuf = "";
				let handle: OverlayHandle | null = null;

				const comp: Component & Focusable = {
					focused: true,
					render(w: number): string[] {
						const boxW = Math.max(36, Math.min(w - 6, 60));
						const innerW = boxW - 4;
						const borderCol = C.gray;
						const topTag = `─ ${title} `;
						const fillTop = Math.max(1, boxW - 2 - visibleWidth(topTag));
						const top = `  ${borderCol}╭${topTag}${"─".repeat(fillTop)}╮${C.reset}`;
						const out = [top];

						let content = "";
						if (text.length === 0) {
							content = `${CURSOR_MARKER}\x1b[7m \x1b[27m${C.dim}${placeholder}${C.reset}`;
						} else {
							const before = text.slice(0, cursorIndex);
							const atCursor = text.slice(cursorIndex, cursorIndex + 1);
							const after = text.slice(cursorIndex + 1);
							const cursorChar = atCursor || " ";
							content = `${before}${CURSOR_MARKER}\x1b[7m${cursorChar}\x1b[27m${after}`;
						}

						const maxContentW = Math.max(1, innerW - 3);
						const safeContent = truncateToWidth(content, maxContentW, "");
						const line = `${C.cyan}❯${C.reset} ${safeContent}`;
						out.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);

						const hint = `Enter 确认 · Esc 取消`;
						const botFill = Math.max(1, boxW - 2 - visibleWidth(hint) - 2);
						out.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);
						return out;
					},
					handleInput(data: string): void {
						if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return;

						if (data.includes("\x1b[200~")) {
							inPaste = true;
							pasteBuf = "";
							const idx = data.indexOf("\x1b[200~") + 6;
							const remaining = data.slice(idx);
							if (remaining.includes("\x1b[201~")) {
								const endIdx = remaining.indexOf("\x1b[201~");
								const pasted = remaining.slice(0, endIdx).replace(/[\r\n]/g, " ");
								text = text.slice(0, cursorIndex) + pasted + text.slice(cursorIndex);
								cursorIndex += pasted.length;
								inPaste = false;
								host.requestRender();
								return;
							}
							pasteBuf += remaining;
							return;
						}
						if (inPaste) {
							if (data.includes("\x1b[201~")) {
								const endIdx = data.indexOf("\x1b[201~");
								pasteBuf += data.slice(0, endIdx);
								const pasted = pasteBuf.replace(/[\r\n]/g, " ");
								text = text.slice(0, cursorIndex) + pasted + text.slice(cursorIndex);
								cursorIndex += pasted.length;
								inPaste = false;
								host.requestRender();
								return;
							}
							pasteBuf += data;
							return;
						}

						if (matchesKey(data, Key.enter)) {
							handle?.hide();
							resolve(text);
						} else if (matchesKey(data, Key.escape)) {
							handle?.hide();
							resolve(undefined);
						} else if (matchesKey(data, Key.left)) {
							if (cursorIndex > 0) {
								cursorIndex = getPrevGraphemeIndex(text, cursorIndex);
								host.requestRender();
							}
						} else if (matchesKey(data, Key.right)) {
							if (cursorIndex < text.length) {
								cursorIndex = getNextGraphemeIndex(text, cursorIndex);
								host.requestRender();
							}
						} else if (matchesKey(data, Key.home)) {
							cursorIndex = 0;
							host.requestRender();
						} else if (matchesKey(data, Key.end)) {
							cursorIndex = text.length;
							host.requestRender();
						} else if (matchesKey(data, Key.backspace)) {
							if (cursorIndex > 0) {
								const prev = getPrevGraphemeIndex(text, cursorIndex);
								text = text.slice(0, prev) + text.slice(cursorIndex);
								cursorIndex = prev;
								host.requestRender();
							}
						} else if (matchesKey(data, Key.delete)) {
							if (cursorIndex < text.length) {
								const next = getNextGraphemeIndex(text, cursorIndex);
								text = text.slice(0, cursorIndex) + text.slice(next);
								host.requestRender();
							}
						} else if (matchesKey(data, Key.ctrl("u"))) {
							text = "";
							cursorIndex = 0;
							host.requestRender();
						} else if (data && !data.startsWith("\x1b")) {
							const clean = data.replace(/[\r\n]/g, "");
							text = text.slice(0, cursorIndex) + clean + text.slice(cursorIndex);
							cursorIndex += clean.length;
							host.requestRender();
						}
					},
					invalidate(): void {},
				};

				handle = host.showOverlay(comp);
			});
		},

		notify(message: string, type: "info" | "warning" | "error" = "info", timeoutMs?: number): void {
			if (timeoutMs !== undefined) {
				host.notify(message, type, timeoutMs);
			} else {
				host.notify(message, type);
			}
		},

		clearNotification(): void {
			host.clearNotification?.();
		},

		setStatus(key: string, text: string | undefined): void {
			host.setStatus(key, text);
		},

		setWorkingMessage(message?: string): void {
			host.setWorkingMessage(message);
		},

		setWorkingVisible(visible: boolean): void {
			host.setWorkingVisible(visible);
		},

		setWidget(
			key: string,
			component: Component | undefined,
			options?: { placement?: WidgetPlacement; priority?: number },
		): void {
			host.setWidget(key, component, options?.placement, options?.priority);
		},

		setHeader(component: Component | undefined): void {
			host.setHeader(component);
		},

		setFooter(component: Component | undefined): void {
			host.setFooter(component);
		},

		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
			return host.showOverlay(component, options);
		},

		pasteToEditor(text: string): void {
			host.pasteToEditor(text);
		},

		setEditorText(text: string): void {
			host.setEditorText(text);
		},

		getEditorText(): string {
			return host.getEditorText();
		},

		onTerminalInput(handler: (data: string) => void): () => void {
			return host.onTerminalInput(handler);
		},

		getGutterMode(): "scrollbar" | "timeline" {
			return host.getGutterMode?.() ?? "scrollbar";
		},

		setGutterMode(mode: "scrollbar" | "timeline"): void {
			host.setGutterMode?.(mode);
		},

		hasUI(): boolean {
			return true;
		},

		// 消费者富能力转发：端口不提供即留 undefined，扩展侧 ?.() 自然降级为无操作。
		openHelpMenu: () => host.openHelpMenu?.(),
		toggleThinking: () => host.toggleThinking?.(),
		clearTranscript: () => host.clearTranscript?.(),
		openModelPicker: (currentModel, groups, onPick) => host.openModelPicker?.(currentModel, groups, onPick),
		openEffortSlider: (currentLevel, declaredLevels, onChange) => host.openEffortSlider?.(currentLevel, declaredLevels, onChange),
		openTasks: () => host.openTasks?.(),
		openSubagents: () => host.openSubagents?.(),
		openTrajectory: () => host.openTrajectory?.(),
		openHistory: () => host.openHistory?.(),
		setModel: (name) => host.setModel?.(name),
		setThinkingLevels: (levels) => host.setThinkingLevels?.(levels),
		setReasoningEffort: (level) => host.setReasoningEffort?.(level),
		setUsage: (snapshot) => host.setUsage?.(snapshot),
		getScrollbarThumbStyle: (): "slim" | "block" | "wide" => host.getScrollbarThumbStyle?.() ?? "slim",
		setScrollbarThumbStyle: (style) => host.setScrollbarThumbStyle?.(style),
		addCompaction: (record) => host.addCompaction?.(record),
	};
}
