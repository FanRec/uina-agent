/**
 * ExtensionUIContext 具体实现。
 * 将扩展的狭窄接口调用映射到底层 UIHost 的 Container、OverlayStack、WidgetSlots 与输入层。
 */

import type { Component, Focusable, OverlayHandle, OverlayOptions, WidgetPlacement } from "../core/types.js";
import { Key, matchesKey } from "../core/keys.js";
import { C, visibleWidth, truncateToWidth } from "../core/utils.js";
import type { ExtensionUIContext } from "./types.js";

export interface UIHostContextPort {
	notify(message: string, type?: "info" | "warning" | "error"): void;
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
}

export function createExtensionUIContext(host: UIHostContextPort): ExtensionUIContext {
	return {
		select(title: string, options: string[]): Promise<string | undefined> {
			return new Promise((resolve) => {
				let selected = 0;
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

						for (let i = 0; i < options.length; i++) {
							const opt = options[i]!;
							const isSel = i === selected;
							const pointer = isSel ? `${C.cyan}❯${C.reset}` : " ";
							const text = isSel ? `${C.bold}${C.white}${opt}${C.reset}` : `${C.dim}${opt}${C.reset}`;
							const line = `${pointer} ${text}`;
							out.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);
						}

						const hint = `↑↓ 导航 · Enter 确认 · Esc 取消`;
						const botFill = Math.max(1, boxW - 2 - visibleWidth(hint) - 2);
						out.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);
						return out;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.up)) {
							selected = Math.max(0, selected - 1);
							host.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selected = Math.min(options.length - 1, selected + 1);
							host.requestRender();
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
						if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
							yesSelected = !yesSelected;
							host.requestRender();
						} else if (data === "y" || data === "Y") {
							handle?.hide();
							resolve(true);
						} else if (data === "n" || data === "N") {
							handle?.hide();
							resolve(false);
						} else if (matchesKey(data, Key.enter)) {
							handle?.hide();
							resolve(yesSelected);
						} else if (matchesKey(data, Key.escape)) {
							handle?.hide();
							resolve(false);
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

						const display = text ? text : `${C.dim}${placeholder}${C.reset}`;
						const line = `${C.cyan}❯${C.reset} ${display}`;
						out.push(`  ${borderCol}│${C.reset} ${line}${" ".repeat(Math.max(0, innerW - visibleWidth(line)))} ${borderCol}│${C.reset}`);

						const hint = `Enter 确认 · Esc 取消`;
						const botFill = Math.max(1, boxW - 2 - visibleWidth(hint) - 2);
						out.push(`  ${borderCol}╰─ ${C.dim}${hint}${C.reset} ${borderCol}${"─".repeat(botFill)}╯${C.reset}`);
						return out;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.enter)) {
							handle?.hide();
							resolve(text);
						} else if (matchesKey(data, Key.escape)) {
							handle?.hide();
							resolve(undefined);
						} else if (matchesKey(data, Key.backspace)) {
							text = text.slice(0, -1);
							host.requestRender();
						} else if (data && !data.startsWith("\x1b")) {
							text += data;
							host.requestRender();
						}
					},
					invalidate(): void {},
				};

				handle = host.showOverlay(comp);
			});
		},

		notify(message: string, type: "info" | "warning" | "error" = "info"): void {
			host.notify(message, type);
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

		setWidget(key: string, component: Component | undefined, options): void {
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
	};
}
