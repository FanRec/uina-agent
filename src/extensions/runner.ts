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
import { createRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeHooks } from "../runtime/hooks.js";

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

export type ExtensionTeardown = () => void | Promise<void>;
export type ExtensionActivation = (pi: ExtensionAPI) => void | ExtensionTeardown | Promise<void | ExtensionTeardown>;
export type ExtensionModule = { default?: ExtensionActivation };

export interface ExtensionRunnerOptions {
	cwd: string;
	tools: ToolBroker;
	onError?: (text: string) => void;
	onProvider?: (name: string, provider: ModelProvider) => ExtensionTeardown | void;
	onCustomMessage?: (message: CustomMessage) => Promise<void>;
	onCustomEntry?: (entry: CustomEntry) => Promise<void>;
}

/** One activation owns every registration it creates. This is the small part
 * of Pi's extension loader/runner lifecycle that Uina needs today. */
class ActivationScope {
	active = true;
	private readonly cleanup: ExtensionTeardown[] = [];
	private dispose?: ExtensionTeardown;

	constructor(readonly id: string, readonly path: string) {}

	own(teardown: ExtensionTeardown): void {
		this.cleanup.push(teardown);
	}

	setDispose(dispose: ExtensionTeardown): void {
		this.dispose = dispose;
	}

	async deactivate(report: (event: string, error: unknown) => void): Promise<void> {
		if (!this.active) return;
		this.active = false;
		if (this.dispose) {
			try { await this.dispose(); } catch (error) { report("dispose", error); }
		}
		for (const cleanup of this.cleanup.splice(0).reverse()) {
			try { await cleanup(); } catch (error) { report("cleanup", error); }
		}
	}
}

export class ExtensionRunner extends ExtensionHost {
	private readonly extensions = new Map<string, ActivationScope>();
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

	/** Core-owned capabilities use the same scope and teardown path as project extensions. */
	async activateBuiltin(id: string, activate: ExtensionActivation): Promise<void> {
		try {
			await this.activateScope(`builtin:${id}`, `builtin:${id}`, activate);
		} catch (error) {
			this.emitOwnedError(`builtin:${id}`, "activate", error);
		}
	}

	async reload(): Promise<void> {
		await this.disposeProjects();
		await this.load();
	}

	async disposeProjects(): Promise<void> {
		for (const extension of [...this.extensions.values()].filter((entry) => entry.id.startsWith("project:")).reverse()) await this.deactivate(extension);
		await this.flush();
	}

	async dispose(): Promise<void> {
		for (const extension of [...this.extensions.values()].reverse()) await this.deactivate(extension);
		await this.flush();
	}

	list(): ReadonlyArray<{ id: string; path: string; active: boolean }> {
		return [...this.extensions.values()].map(({ id, path, active }) => ({ id, path, active }));
	}

	/** Produces a dispatch view over this one Host; it never creates another owner. */
	runtimeHooks(scope?: readonly string[]): RuntimeHooks {
		return createRuntimeHooks(this, scope);
	}

	private async activate(file: string): Promise<void> {
		const id = `project:${file.slice(this.options.cwd.length + 1).replace(/\\/g, "/")}`;
		try {
			const module = await import(`${pathToFileURL(file).href}?uinaReload=${Date.now()}`) as ExtensionModule;
			if (typeof module.default !== "function") throw new Error("扩展必须默认导出 activate(pi)");
			await this.activateScope(id, file, module.default);
		} catch (error) {
			this.emitOwnedError(id, "activate", error);
		}
	}

	private async activateScope(id: string, path: string, activate: ExtensionActivation): Promise<void> {
		if (this.extensions.has(id)) throw new Error(`扩展重复加载: ${id}`);
		const scope = new ActivationScope(id, path);
		this.extensions.set(id, scope);
		try {
			const dispose = await activate(this.apiFor(scope));
			if (typeof dispose === "function") scope.setDispose(dispose);
		} catch (error) {
			await this.deactivate(scope);
			throw error;
		}
	}

	private async deactivate(scope: ActivationScope): Promise<void> {
		await scope.deactivate((event, error) => this.emitOwnedError(scope.id, event, error));
		this.extensions.delete(scope.id);
	}

	private apiFor(scope: ActivationScope): ExtensionAPI {
		const assertActive = () => { if (!scope.active) throw new Error(`扩展上下文已失效: ${scope.id}`); };
		const own = (dispose: ExtensionTeardown): void => { scope.own(dispose); };
		const ui = ownedUI(dynamicUI(() => this.ui), scope.id, assertActive, own);
		return {
			id: scope.id, path: scope.path, ui,
			on: (type, handler) => {
				assertActive();
				const wrapped: ExtensionEventHandler = async (event) => {
					try { return await handler(event as never); }
					catch (error) { this.emitOwnedError(scope.id, type, error); return undefined; }
				};
				const dispose = super.onScoped(scope.id, type, wrapped as never);
				own(dispose);
				return dispose;
			},
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
		this.emitError(event, error, extensionName);
	}
}

function dynamicUI(get: () => ExtensionUIContext): ExtensionUIContext {
	return {
		select: (...args) => get().select(...args), confirm: (...args) => get().confirm(...args), input: (...args) => get().input(...args), notify: (...args) => get().notify(...args),
		setStatus: (...args) => get().setStatus(...args), setWorkingMessage: (...args) => get().setWorkingMessage(...args), setWorkingVisible: (...args) => get().setWorkingVisible(...args), setWidget: (...args) => get().setWidget(...args),
		setHeader: (...args) => get().setHeader(...args), setFooter: (...args) => get().setFooter(...args), showOverlay: (...args) => get().showOverlay(...args), pasteToEditor: (...args) => get().pasteToEditor(...args), setEditorText: (...args) => get().setEditorText(...args), getEditorText: () => get().getEditorText(), onTerminalInput: (...args) => get().onTerminalInput(...args),
	};
}

function ownedUI(base: ExtensionUIContext, id: string, assertActive: () => void, own: (dispose: ExtensionTeardown) => void): ExtensionUIContext {
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
