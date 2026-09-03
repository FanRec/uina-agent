/** Project-local, trusted extension runtime.  It deliberately mirrors Pi's
 * lifecycle model: registrations are owned by an activation and become stale
 * on reload/dispose instead of leaking into the next runtime. */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelProvider } from "../core/types.js";
import type { Tool, ToolBroker } from "../tools/broker.js";
import type { ExtensionUIContext, CustomEntry, CustomMessage, EntryRenderer, LocalCommand, MessageRenderer } from "../ui/extensions/types.js";
import { ExtensionRegistry } from "../ui/extensions/registry.js";
import { ExtensionHost, type ExtensionEvent, type ExtensionEventHandler } from "./host.js";

export interface ExtensionAPI {
	readonly id: string;
	readonly path: string;
	readonly ui: ExtensionUIContext;
	on<T extends ExtensionEvent["type"]>(type: T, handler: ExtensionEventHandler<Extract<ExtensionEvent, { type: T }>>): () => void;
	registerTool(tool: Tool): void;
	registerCommand(command: LocalCommand): void;
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
	registerProvider(name: string, provider: ModelProvider): void;
	sendMessage(message: CustomMessage): Promise<void>;
	appendEntry(entry: CustomEntry): Promise<void>;
}

export type ExtensionModule = { default?: (pi: ExtensionAPI) => void | (() => void) | Promise<void | (() => void)> };

export interface ExtensionRunnerOptions {
	cwd: string;
	tools: ToolBroker;
	onError?: (text: string) => void;
	onProvider?: (name: string, provider: ModelProvider) => (() => void) | void;
	onCustomMessage?: (message: CustomMessage) => Promise<void>;
	onCustomEntry?: (entry: CustomEntry) => Promise<void>;
}

interface ActiveExtension { id: string; path: string; active: boolean; cleanup: Array<() => void>; dispose?: () => void; }

export class ExtensionRunner extends ExtensionHost {
	private readonly extensions = new Map<string, ActiveExtension>();
	private ui: ExtensionUIContext;
	readonly registry = new ExtensionRegistry();

	constructor(private readonly options: ExtensionRunnerOptions) {
		super();
		this.ui = createPrintUI((message, type) => options.onError?.(`[${type ?? "info"}] ${message}`));
		this.onError((error) => options.onError?.(`[extension_error:${error.extensionName ?? "unknown"}:${error.event}] ${error.error}`));
	}

	attachUI(ui: ExtensionUIContext): void {
		this.ui = ui;
	}

	async load(): Promise<void> {
		const directory = join(this.options.cwd, ".uina", "extensions");
		let files: string[];
		try { files = await readdir(directory); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const file of files.filter((name) => /\.(?:[cm]?js|ts)$/.test(name)).sort()) {
			await this.activate(resolve(directory, file));
		}
	}

	/** Core-owned extensions are activated once and are intentionally excluded from project reload. */
	async activateBuiltin(id: string, activate: (pi: ExtensionAPI) => void | (() => void) | Promise<void | (() => void)>): Promise<void> {
		const extension: ActiveExtension = { id: `builtin:${id}`, path: `builtin:${id}`, active: true, cleanup: [] };
		if (this.extensions.has(extension.id)) throw new Error(`内置扩展重复加载: ${id}`);
		this.extensions.set(extension.id, extension);
		try { const dispose = await activate(this.apiFor(extension)); if (typeof dispose === "function") extension.dispose = dispose; }
		catch (error) { this.deactivate(extension); this.emitOwnedError(extension.id, "activate", error); }
	}

	async reload(): Promise<void> {
		await this.disposeProjects();
		await this.load();
	}

	async disposeProjects(): Promise<void> {
		for (const extension of [...this.extensions.values()].filter((entry) => entry.id.startsWith("project:")).reverse()) this.deactivate(extension);
		await this.flush();
	}

	async dispose(): Promise<void> {
		for (const extension of [...this.extensions.values()].reverse()) this.deactivate(extension);
		await this.flush();
	}

	list(): ReadonlyArray<{ id: string; path: string; active: boolean }> {
		return [...this.extensions.values()].map(({ id, path, active }) => ({ id, path, active }));
	}

	private async activate(file: string): Promise<void> {
		const id = `project:${file.slice(this.options.cwd.length + 1).replace(/\\/g, "/")}`;
		if (this.extensions.has(id)) throw new Error(`扩展重复加载: ${id}`);
		const extension: ActiveExtension = { id, path: file, active: true, cleanup: [] };
		this.extensions.set(id, extension);
		try {
			const module = await import(`${pathToFileURL(file).href}?uinaReload=${Date.now()}`) as ExtensionModule;
			if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
			const dispose = await module.default(this.apiFor(extension));
			if (typeof dispose === "function") extension.dispose = dispose;
		} catch (error) {
			this.deactivate(extension);
			this.emitOwnedError(extension.id, "activate", error);
		}
	}

	private deactivate(extension: ActiveExtension): void {
		if (!extension.active) return;
		extension.active = false;
		try { extension.dispose?.(); } catch (error) { this.emitOwnedError(extension.id, "dispose", error); }
		for (const cleanup of extension.cleanup.splice(0).reverse()) {
			try { cleanup(); } catch (error) { this.emitOwnedError(extension.id, "cleanup", error); }
		}
		this.extensions.delete(extension.id);
	}

	private apiFor(extension: ActiveExtension): ExtensionAPI {
		const assertActive = () => { if (!extension.active) throw new Error(`扩展上下文已失效: ${extension.id}`); };
		const own = (dispose: () => void): void => { extension.cleanup.push(dispose); };
		const ui = ownedUI(dynamicUI(() => this.ui), extension.id, assertActive, own);
		return {
			id: extension.id, path: extension.path, ui,
			on: (type, handler) => { assertActive(); const wrapped: ExtensionEventHandler = (event) => handler(event as never); const dispose = super.on(type, wrapped as never); own(dispose); return dispose; },
			registerTool: (tool) => { assertActive(); this.options.tools.register(tool); own(() => this.options.tools.remove(tool.def.function.name)); },
			registerCommand: (command) => { assertActive(); own(this.registry.registerCommand(command)); },
			registerMessageRenderer: (type, renderer) => { assertActive(); own(this.registry.registerMessageRenderer(type, renderer)); },
			registerEntryRenderer: (type, renderer) => { assertActive(); own(this.registry.registerEntryRenderer(type, renderer)); },
			registerProvider: (name, provider) => { assertActive(); const dispose = this.options.onProvider?.(name, provider); if (dispose) own(dispose); },
			sendMessage: async (message) => { assertActive(); await this.options.onCustomMessage?.(structuredClone(message)); },
			appendEntry: async (entry) => { assertActive(); await this.options.onCustomEntry?.(structuredClone(entry)); },
		};
	}

	private emitOwnedError(extensionName: string, event: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.options.onError?.(`[extension_error:${extensionName}:${event}] ${message}`);
	}
}

function dynamicUI(get: () => ExtensionUIContext): ExtensionUIContext {
	return {
		select: (...args) => get().select(...args), confirm: (...args) => get().confirm(...args), input: (...args) => get().input(...args), notify: (...args) => get().notify(...args),
		setStatus: (...args) => get().setStatus(...args), setWorkingMessage: (...args) => get().setWorkingMessage(...args), setWorkingVisible: (...args) => get().setWorkingVisible(...args), setWidget: (...args) => get().setWidget(...args),
		setHeader: (...args) => get().setHeader(...args), setFooter: (...args) => get().setFooter(...args), showOverlay: (...args) => get().showOverlay(...args), pasteToEditor: (...args) => get().pasteToEditor(...args), setEditorText: (...args) => get().setEditorText(...args), getEditorText: () => get().getEditorText(), onTerminalInput: (...args) => get().onTerminalInput(...args),
	};
}

function ownedUI(base: ExtensionUIContext, id: string, assertActive: () => void, own: (dispose: () => void) => void): ExtensionUIContext {
	const key = (value: string) => `${id}:${value}`;
	return {
		select: (...args) => { assertActive(); return base.select(...args); }, confirm: (...args) => { assertActive(); return base.confirm(...args); }, input: (...args) => { assertActive(); return base.input(...args); }, notify: (...args) => { assertActive(); base.notify(...args); },
		setStatus: (name, text) => { assertActive(); base.setStatus(key(name), text); own(() => base.setStatus(key(name), undefined)); },
		setWorkingMessage: (message) => { assertActive(); base.setWorkingMessage(message); }, setWorkingVisible: (visible) => { assertActive(); base.setWorkingVisible(visible); },
		setWidget: (name, component, options) => { assertActive(); base.setWidget(key(name), component, options); own(() => base.setWidget(key(name), undefined)); },
		setHeader: (component) => { assertActive(); base.setHeader(component); own(() => base.setHeader(undefined)); }, setFooter: (component) => { assertActive(); base.setFooter(component); own(() => base.setFooter(undefined)); },
		showOverlay: (component, options) => { assertActive(); const handle = base.showOverlay(component, options); own(() => handle.hide()); return handle; },
		pasteToEditor: (text) => { assertActive(); base.pasteToEditor(text); }, setEditorText: (text) => { assertActive(); base.setEditorText(text); }, getEditorText: () => { assertActive(); return base.getEditorText(); },
		onTerminalInput: (handler) => { assertActive(); const dispose = base.onTerminalInput(handler); own(dispose); return dispose; },
	};
}

export function createPrintUI(write: (message: string, type?: "info" | "warning" | "error") => void): ExtensionUIContext {
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined,
		notify: write, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWidget: () => {}, setHeader: () => {}, setFooter: () => {},
		showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => true, focus() {}, unfocus() {}, isFocused: () => false }),
		pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", onTerminalInput: () => () => {},
	};
}
