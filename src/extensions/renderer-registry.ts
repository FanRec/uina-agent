/**
 * 扩展渲染器与命令注册中心（ExtensionRegistry）。
 */

import type { EntryRenderer, LocalCommand, MessageRenderer } from "./ui-contract.js";

export class ExtensionRegistry {
	private readonly messageRenderers = new Map<string, MessageRenderer>();
	private readonly entryRenderers = new Map<string, EntryRenderer>();
	private readonly commands = new Map<string, LocalCommand>();

	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): () => void {
		if (this.messageRenderers.has(customType)) throw new Error(`custom message renderer 已注册: ${customType}`);
		this.messageRenderers.set(customType, renderer as MessageRenderer);
		return () => { if (this.messageRenderers.get(customType) === renderer) this.messageRenderers.delete(customType); };
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		return this.messageRenderers.get(customType);
	}

	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): () => void {
		if (this.entryRenderers.has(customType)) throw new Error(`custom entry renderer 已注册: ${customType}`);
		this.entryRenderers.set(customType, renderer as EntryRenderer);
		return () => { if (this.entryRenderers.get(customType) === renderer) this.entryRenderers.delete(customType); };
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		return this.entryRenderers.get(customType);
	}

	registerCommand(command: LocalCommand): () => void {
		if (this.commands.has(command.name)) throw new Error(`命令已注册: /${command.name}`);
		this.commands.set(command.name, command);
		return () => { if (this.commands.get(command.name) === command) this.commands.delete(command.name); };
	}

	getCommand(name: string): LocalCommand | undefined {
		return this.commands.get(name);
	}

	listCommands(): LocalCommand[] {
		return Array.from(this.commands.values());
	}
}
