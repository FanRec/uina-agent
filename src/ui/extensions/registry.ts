/**
 * 扩展渲染器与命令注册中心（ExtensionRegistry）。
 */

import type { EntryRenderer, LocalCommand, MessageRenderer } from "./types.js";

export class ExtensionRegistry {
	private readonly messageRenderers = new Map<string, MessageRenderer>();
	private readonly entryRenderers = new Map<string, EntryRenderer>();
	private readonly commands = new Map<string, LocalCommand>();

	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void {
		this.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		return this.messageRenderers.get(customType);
	}

	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void {
		this.entryRenderers.set(customType, renderer as EntryRenderer);
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		return this.entryRenderers.get(customType);
	}

	registerCommand(command: LocalCommand): void {
		this.commands.set(command.name, command);
	}

	getCommand(name: string): LocalCommand | undefined {
		return this.commands.get(name);
	}

	listCommands(): LocalCommand[] {
		return Array.from(this.commands.values());
	}
}
