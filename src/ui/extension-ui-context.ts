/**
 * ExtensionUIContext 具体实现。
 * 将扩展的狭窄接口调用映射到底层 UIHost 的 Container、OverlayStack、WidgetSlots 与输入层。
 */

import type {
	BuiltinUIActionRequest,
	ExtensionUIContext,
	PromptOptions,
	TerminalUIContext,
} from "../extensions/ui-contract.js";
import type { SlotAck } from "../presentation/composition/slots.js";
import { INTERACTIVE_TERMINAL_CAPABILITIES, type SurfaceCapabilities } from "../presentation/surface.js";
import { Key, matchesKey } from "./core/keys.js";
import { TextBuffer } from "./core/text-buffer.js";
import type { Component, Focusable, OverlayHandle, OverlayOptions, WidgetPlacement } from "./core/types.js";
import { CURSOR_MARKER } from "./core/types.js";
import { C, graphemeSegmenter, visibleWidth } from "./core/utils.js";
import { fitLine, wrapLine } from "./layout/fit.js";

export interface UIHostContextPort {
	notify(message: string, type?: "info" | "warning" | "error", timeoutMs?: number): SlotAck;
	clearNotification?(): void;
	setWorking(key: string, message: string | undefined): SlotAck;
	setWidget(key: string, component: Component | undefined, placement?: WidgetPlacement, priority?: number): void;
	setHeader(component: Component | undefined): void;
	setFooter(component: Component | undefined): void;
	showOverlay(component: Component, options?: OverlayOptions, dispose?: () => void): OverlayHandle;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	getEditorText(): string;
	requestRender(): void;
	openGutter?(argument?: string): boolean;
	registerMessageRenderer?: TerminalUIContext["registerMessageRenderer"];
	registerToolRenderer?: TerminalUIContext["registerToolRenderer"];
	registerMarkdownTransformer?: TerminalUIContext["registerMarkdownTransformer"];
	openFeature?(action: BuiltinUIActionRequest): boolean;
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

function renderCursorWindow(before: string, cursor: string, after: string, width: number): string {
	const beforeParts = Array.from(graphemeSegmenter.segment(before), (part) => part.segment);
	const afterParts = Array.from(graphemeSegmenter.segment(after), (part) => part.segment);
	const cursorPart = cursor || " ";
	const cursorWidth = visibleWidth(cursorPart);
	const available = Math.max(0, width - cursorWidth);
	let leftBudget = Math.floor(available / 2);
	let rightBudget = available - leftBudget;
	const beforeWidth = visibleWidth(before);
	const afterWidth = visibleWidth(after);
	if (afterWidth < rightBudget) {
		leftBudget += rightBudget - afterWidth;
		rightBudget = afterWidth;
	}
	if (beforeWidth < leftBudget) {
		rightBudget += leftBudget - beforeWidth;
		leftBudget = beforeWidth;
	}
	const takeSuffix = (parts: string[], maxWidth: number): string => {
		let text = "";
		for (let index = parts.length - 1; index >= 0; index--) {
			const candidate = parts[index]! + text;
			if (visibleWidth(candidate) > maxWidth) break;
			text = candidate;
		}
		return text;
	};
	const takePrefix = (parts: string[], maxWidth: number): string => {
		let text = "";
		for (const part of parts) {
			const candidate = text + part;
			if (visibleWidth(candidate) > maxWidth) break;
			text = candidate;
		}
		return text;
	};
	const leftHidden = beforeParts.length > 0 && beforeWidth > leftBudget;
	const rightHidden = afterParts.length > 0 && afterWidth > rightBudget;
	const left = takeSuffix(beforeParts, Math.max(0, leftBudget - (leftHidden ? 1 : 0)));
	const right = takePrefix(afterParts, Math.max(0, rightBudget - (rightHidden ? 1 : 0)));
	return `${leftHidden ? "…" : ""}${left}${CURSOR_MARKER}\x1b[7m${cursorPart}\x1b[27m${right}${rightHidden ? "…" : ""}`;
}

interface PromptFrame {
	innerWidth: number;
	top: string;
	line(content: string): string;
	bottom(label?: string): string;
}

function createPromptFrame(title: string, width: number): PromptFrame {
	const availableWidth = Math.max(0, Math.floor(width));
	const leftPad = availableWidth >= 64 ? 2 : 0;
	const boxWidth = Math.max(1, Math.min(availableWidth - leftPad, 60));
	const innerWidth = Math.max(1, boxWidth - 4);
	const left = " ".repeat(leftPad);
	const border = C.gray;
	const fit = (line: string): string => fitLine(line, availableWidth, "clip");
	const topTag = `─ ${fitLine(title, Math.max(1, boxWidth - 6))} `;
	const topFill = Math.max(0, boxWidth - 2 - visibleWidth(topTag));

	return {
		innerWidth,
		top: fit(`${left}${border}╭${topTag}${border}${"─".repeat(topFill)}╮${C.reset}`),
		line(content) {
			const safe = fitLine(content, innerWidth);
			return fit(
				`${left}${border}│${C.reset} ${safe}${" ".repeat(Math.max(0, innerWidth - visibleWidth(safe)))} ${border}│${C.reset}`,
			);
		},
		bottom(label) {
			if (label === undefined) return fit(`${left}${border}╰${"─".repeat(Math.max(0, boxWidth - 2))}╯${C.reset}`);
			const tag = `─ ${fitLine(label, Math.max(1, boxWidth - 5))} `;
			const fill = Math.max(0, boxWidth - 2 - visibleWidth(tag));
			return fit(`${left}${border}╰${tag}${"─".repeat(fill)}╯${C.reset}`);
		},
	};
}

function runPrompt<T>(
	host: UIHostContextPort,
	options: PromptOptions | undefined,
	cancelValue: T,
	create: (settle: (value: T) => void) => Component & Focusable,
): Promise<T> {
	return new Promise((resolve) => {
		const signal = options?.signal;
		let handle: OverlayHandle | undefined;
		let settled = false;
		const settle = (value: T): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			handle?.hide();
			resolve(value);
		};
		const onAbort = (): void => settle(cancelValue);
		if (signal?.aborted) {
			settled = true;
			resolve(cancelValue);
			return;
		}
		const component = create(settle);
		signal?.addEventListener("abort", onAbort, { once: true });
		handle = host.showOverlay(component, undefined, onAbort);
	});
}

export function createExtensionUIContext(host: UIHostContextPort): ExtensionUIContext {
	const terminal: TerminalUIContext = {
		setWidget(key, component, options) {
			host.setWidget(key, component, options?.placement, options?.priority);
		},
		setHeader(component) {
			host.setHeader(component);
		},
		setFooter(component) {
			host.setFooter(component);
		},
		showOverlay(component, options) {
			return host.showOverlay(component, options);
		},
		openGutter(argument) {
			return host.openGutter?.(argument) ?? false;
		},
		pasteToEditor(text) {
			host.pasteToEditor(text);
		},
		setEditorText(text) {
			host.setEditorText(text);
		},
		getEditorText() {
			return host.getEditorText();
		},
		registerMessageRenderer: (customType, renderer, options) =>
			host.registerMessageRenderer?.(customType, renderer, options) ?? (() => {}),
		registerToolRenderer: (name, renderer, options) =>
			host.registerToolRenderer?.(name, renderer, options) ?? (() => {}),
		registerMarkdownTransformer: (name, transformer, options) =>
			host.registerMarkdownTransformer?.(name, transformer, options) ?? (() => {}),
	};
	return {
		select(title: string, options: string[], promptOptions?: PromptOptions): Promise<string | undefined> {
			return runPrompt<string | undefined>(host, promptOptions, undefined, (settle) => {
				let selected = 0;
				let scrollOffset = 0;
				const maxVisible = 8;
				const comp: Component & Focusable = {
					focused: true,
					render(w: number, height = 24): string[] {
						if (w <= 0 || height <= 0) return [];
						if (w < 5) return [fitLine(title, w, "clip")];
						const frame = createPromptFrame(title, w);
						const { innerWidth } = frame;
						const out = [frame.top];
						const rowBudget = Math.max(0, Math.min(maxVisible, Math.floor(height) - 2));
						const visibleCount = Math.min(options.length, rowBudget);
						const maxOffset = Math.max(0, options.length - visibleCount);
						scrollOffset = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), maxOffset));
						if (options.length === 0) {
							out.push(frame.line("（暂无可用选项）"));
						} else {
							const visibleOptions = options.slice(scrollOffset, scrollOffset + visibleCount);
							for (let idx = 0; idx < visibleOptions.length; idx++) {
								const i = scrollOffset + idx;
								const opt = visibleOptions[idx]!;
								const isSel = i === selected;
								const pointer = isSel ? `${C.cyan}❯${C.reset}` : " ";
								const maxTextW = Math.max(1, innerWidth - 3);
								const safeOpt = fitLine(opt, maxTextW);
								const text = isSel ? `${C.bold}${C.white}${safeOpt}${C.reset}` : `${C.dim}${safeOpt}${C.reset}`;
								const line = `${pointer} ${text}`;
								out.push(frame.line(line));
							}
						}

						const remainingDown = Math.max(0, options.length - (scrollOffset + visibleCount));
						const hint = `↑${scrollOffset} ↓${remainingDown} · ↑↓ 导航 · Enter 确认 · Esc 取消`;
						out.push(frame.bottom(hint));
						return out.slice(0, Math.max(1, Math.floor(height)));
					},
					handleInput(data: string): void {
						if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) return;
						if (matchesKey(data, Key.up)) {
							if (options.length > 0) {
								selected = Math.max(0, selected - 1);
								host.requestRender();
							}
						} else if (matchesKey(data, Key.down)) {
							if (options.length > 0) {
								selected = Math.min(options.length - 1, selected + 1);
								host.requestRender();
							}
						} else if (matchesKey(data, Key.enter)) {
							settle(options[selected]);
						} else if (matchesKey(data, Key.escape)) {
							settle(undefined);
						}
					},
					invalidate(): void {},
				};
				return comp;
			});
		},

		confirm(title: string, message: string, promptOptions?: PromptOptions): Promise<boolean> {
			return runPrompt<boolean>(host, promptOptions, false, (settle) => {
				let yesSelected = false;
				let messageScroll = 0;

				const comp: Component & Focusable = {
					focused: true,
					render(w: number, height = Number.MAX_SAFE_INTEGER): string[] {
						const frame = createPromptFrame(title, w);
						const { innerWidth } = frame;

						const bodyLines = message
							.replace(/\r\n/g, "\n")
							.replace(/\r/g, "\n")
							.split("\n")
							.flatMap((line) => (line.length === 0 ? [""] : wrapLine(line, innerWidth)));
						const safeBody = bodyLines.length > 0 ? bodyLines : [""];
						const horizontalButtonsFit = visibleWidth("[ 是 (Y) ]   [ 否 (N) ]") <= innerWidth;
						const buttonLines = horizontalButtonsFit ? 1 : 2;
						const fixedRows = 2 + buttonLines; // top, button rows, bottom
						const reserveScrollRow = height >= fixedRows + 3 && safeBody.length > height - fixedRows;
						const bodyHeight = Math.max(0, Math.min(safeBody.length, height - fixedRows - (reserveScrollRow ? 1 : 0)));
						const maxScroll = Math.max(0, safeBody.length - bodyHeight);
						messageScroll = Math.max(0, Math.min(messageScroll, maxScroll));
						const visibleBody = safeBody.slice(messageScroll, messageScroll + bodyHeight);
						const out = [frame.top, ...visibleBody.map(frame.line)];

						if (horizontalButtonsFit) {
							const btnYes = yesSelected ? `\x1b[7m[ 是 (Y) ]\x1b[0m` : "[ 是 (Y) ]";
							const btnNo = !yesSelected ? `\x1b[7m[ 否 (N) ]\x1b[0m` : "[ 否 (N) ]";
							out.push(frame.line(`${btnYes}   ${btnNo}`));
						} else {
							out.push(frame.line(yesSelected ? `› [ 是 (Y) ]` : "  [ 是 (Y) ]"));
							out.push(frame.line(!yesSelected ? `› [ 否 (N) ]` : "  [ 否 (N) ]"));
						}

						if (reserveScrollRow && maxScroll > 0) {
							const first = messageScroll + 1;
							const last = Math.min(safeBody.length, messageScroll + bodyHeight);
							const hint = `说明 ${first}-${last}/${safeBody.length} · PgUp/PgDn 翻阅`;
							out.splice(out.length - 1, 0, frame.line(`${C.inactive}${hint}${C.reset}`));
						}
						out.push(frame.bottom());
						return out.slice(0, Math.max(1, Math.floor(height)));
					},
					handleInput(data: string): void {
						if (isMouseReport(data)) return;
						if (matchesKey(data, Key.pageup)) {
							messageScroll = Math.max(0, messageScroll - 3);
							host.requestRender();
							return;
						}
						if (matchesKey(data, Key.pagedown)) {
							messageScroll += 3;
							host.requestRender();
							return;
						}
						if (isToggleKey(data)) {
							yesSelected = !yesSelected;
							host.requestRender();
							return;
						}
						const choice = confirmChoice(data, yesSelected);
						if (choice !== undefined) {
							settle(choice);
						}
					},
					invalidate(): void {},
				};
				return comp;
			});
		},

		input(title: string, placeholder = "", promptOptions?: PromptOptions): Promise<string | undefined> {
			return runPrompt<string | undefined>(host, promptOptions, undefined, (settle) => {
				const buffer = new TextBuffer();
				let inPaste = false;
				let pasteBuf = "";

				const comp: Component & Focusable = {
					focused: true,
					render(w: number, height = 24): string[] {
						if (w <= 0 || height <= 0) return [];
						if (w < 5) return [fitLine(title, w, "clip")];
						const frame = createPromptFrame(title, w);
						const { innerWidth } = frame;
						const out = [frame.top];

						const maxContentW = Math.max(1, innerWidth - 3);
						let content = "";
						if (buffer.text.length === 0) {
							content = `${CURSOR_MARKER}\x1b[7m \x1b[27m${C.dim}${placeholder}${C.reset}`;
						} else {
							const before = buffer.text.slice(0, buffer.cursor);
							const atCursor = buffer.cursorGrapheme;
							const after = buffer.text.slice(buffer.cursor + atCursor.length);
							content = renderCursorWindow(before, atCursor, after, maxContentW);
						}

						const safeContent = buffer.text.length === 0 ? fitLine(content, maxContentW, "clip") : content;
						const line = `${C.cyan}❯${C.reset} ${safeContent}`;
						out.push(frame.line(line));

						const hint = `Enter 确认 · Esc 取消`;
						out.push(frame.bottom(hint));
						return out.slice(0, Math.max(1, Math.floor(height)));
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
								buffer.insert(pasted);
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
								buffer.insert(pasted);
								inPaste = false;
								host.requestRender();
								return;
							}
							pasteBuf += data;
							return;
						}

						if (matchesKey(data, Key.enter)) {
							settle(buffer.text);
						} else if (matchesKey(data, Key.escape)) {
							settle(undefined);
						} else if (matchesKey(data, Key.left)) {
							if (buffer.cursor > 0) {
								buffer.moveLeft();
								host.requestRender();
							}
						} else if (matchesKey(data, Key.right)) {
							if (buffer.cursor < buffer.text.length) {
								buffer.moveRight();
								host.requestRender();
							}
						} else if (matchesKey(data, Key.home)) {
							buffer.moveHome();
							host.requestRender();
						} else if (matchesKey(data, Key.end)) {
							buffer.moveEnd();
							host.requestRender();
						} else if (matchesKey(data, Key.backspace)) {
							if (buffer.cursor > 0) {
								buffer.deleteBackward();
								host.requestRender();
							}
						} else if (matchesKey(data, Key.delete)) {
							if (buffer.cursor < buffer.text.length) {
								buffer.deleteForward();
								host.requestRender();
							}
						} else if (matchesKey(data, Key.ctrl("u"))) {
							buffer.setText("");
							host.requestRender();
						} else if (data && !data.startsWith("\x1b")) {
							const clean = data.replace(/[\r\n]/g, "");
							buffer.insert(clean);
							host.requestRender();
						}
					},
					invalidate(): void {},
				};
				return comp;
			});
		},

		notify(message: string, type: "info" | "warning" | "error" = "info", timeoutMs?: number): SlotAck {
			if (timeoutMs !== undefined) {
				return host.notify(message, type, timeoutMs);
			}
			return host.notify(message, type);
		},

		clearNotification(): void {
			host.clearNotification?.();
		},

		setWorking(key: string, message: string | undefined): SlotAck {
			return host.setWorking(key, message);
		},

		openFeature(action: BuiltinUIActionRequest): boolean {
			return host.openFeature?.(action) ?? false;
		},

		capabilities(): SurfaceCapabilities {
			return INTERACTIVE_TERMINAL_CAPABILITIES;
		},

		hasUI(): boolean {
			return this.capabilities().interactive;
		},

		terminal,
	};
}
