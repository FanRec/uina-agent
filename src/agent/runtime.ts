import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "../core/types.js";
import { MemorySessionStore } from "../session/jsonl-store.js";
import type { SessionStore } from "../session/types.js";
import { Subject, type AgentInput } from "./loop.js";
import type { ToolView } from "../tools/broker.js";
import type { Model, ModelStreamFn } from "../core/types.js";
import type { RuntimeHooks } from "../runtime/hooks.js";

export type AgentStatus = "running" | "idle" | "disposed";

export interface AgentSnapshot {
	readonly id: string;
	readonly status: AgentStatus;
	readonly busy: boolean;
	readonly turn: number;
}

export interface AgentCreateOptions {
	id?: string;
	model: Model;
	stream: ModelStreamFn;
	tools: ToolView;
	store?: SessionStore;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
	runtimeHooks?: RuntimeHooks;
}

export interface AgentHandle {
	readonly id: string;
	readonly subject: Subject;
	send(input: AgentInput): Promise<void>;
	interrupt(reason?: string): Promise<void>;
	waitForIdle(): Promise<void>;
	snapshot(): AgentSnapshot;
	history(): AgentMessage[];
	dispose(): Promise<void>;
}

export interface AgentFactory {
	create(options: AgentCreateOptions): AgentHandle;
}

class RuntimeAgent implements AgentHandle {
	private disposed = false;
	private turn = 0;
	private readonly store: SessionStore;
	private disposePromise?: Promise<void>;
	readonly subject: Subject;

	constructor(readonly id: string, options: AgentCreateOptions) {
		this.store = options.store ?? new MemorySessionStore();
		this.subject = new Subject(options.model, options.stream, options.tools, {
			store: this.store,
			systemPrompt: options.systemPrompt,
			thinkingLevel: options.thinkingLevel,
			runtimeHooks: options.runtimeHooks,
		});
		this.subject.subscribe((event) => {
			if (event.type === "turn_start") {
				this.turn = event.turnNumber;
			}
		});
	}

	send(input: AgentInput): Promise<void> {
		if (this.disposed || this.disposePromise) return Promise.reject(new Error("Agent 已释放"));
		return this.subject.accept(input);
	}

	interrupt(_reason?: string): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.subject.interrupt();
		return this.subject.waitForIdle();
	}

	waitForIdle(): Promise<void> {
		return this.subject.waitForIdle().then(() => {
		});
	}

	snapshot(): AgentSnapshot {
		return { id: this.id, status: this.disposed ? "disposed" : this.subject.isBusy() ? "running" : "idle", busy: this.subject.isBusy(), turn: this.turn };
	}

	history(): AgentMessage[] {
		return this.subject.historySnapshot();
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = (async () => {
			this.subject.interrupt();
			await this.subject.waitForIdle();
			await this.store.close();
			this.disposed = true;
		})();
		return this.disposePromise;
	}
}

export class DefaultAgentFactory implements AgentFactory {
	create(options: AgentCreateOptions): AgentHandle {
		return new RuntimeAgent(options.id ?? `agent-${randomUUID()}`, options);
	}
}
