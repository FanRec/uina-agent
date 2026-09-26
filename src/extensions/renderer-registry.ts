import { Registrations } from "../core/registrations.js";
import type { LocalCommand, MessageRenderer, ToolRenderer, MarkdownTransformer } from "./ui-contract.js";
/** Shared presentation registry. Changes invalidate cached transcript projections. */
export class ExtensionRegistry {
	private readonly messageRenderers = new Registrations<MessageRenderer>();
	private readonly toolRenderers = new Registrations<ToolRenderer>();
	private readonly markdown = new Registrations<MarkdownTransformer>();
	private readonly commands = new Registrations<LocalCommand>();
	private readonly listeners = new Set<() => void>();
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private register<T>(registry: Registrations<T>, name: string, value: T, options?: { replace?: boolean }): () => void {
		const dispose = registry.register(name, value, options);
		this.changed();
		return () => {
			dispose();
			this.changed();
		};
	}
	private changed(): void {
		for (const listener of this.listeners) listener();
	}
	registerMessageRenderer<T = unknown>(
		type: string,
		renderer: MessageRenderer<T>,
		options?: { replace?: boolean },
	): () => void {
		return this.register(this.messageRenderers, type, renderer as MessageRenderer, options);
	}
	getMessageRenderer(type: string): MessageRenderer | undefined {
		return this.messageRenderers.get(type);
	}
	registerToolRenderer(name: string, renderer: ToolRenderer, options?: { replace?: boolean }): () => void {
		return this.register(this.toolRenderers, name, renderer, options);
	}
	getToolRenderer(name: string): ToolRenderer | undefined {
		return this.toolRenderers.get(name);
	}
	registerMarkdownTransformer(
		name: string,
		transformer: MarkdownTransformer,
		options?: { replace?: boolean },
	): () => void {
		return this.register(this.markdown, name, transformer, options);
	}
	transformMarkdown(text: string, context: Parameters<MarkdownTransformer>[1]): string {
		for (const transformer of this.markdown.values()) text = transformer(text, context);
		return text;
	}
	registerCommand(command: LocalCommand, options?: { replace?: boolean }): () => void {
		return this.register(this.commands, command.name, command, options);
	}
	getCommand(name: string): LocalCommand | undefined {
		return this.commands.get(name);
	}
	listCommands(): readonly LocalCommand[] {
		return [...this.commands.values()];
	}
}
