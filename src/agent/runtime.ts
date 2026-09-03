import { randomUUID } from "node:crypto";
import type { ChatMsg, ThinkingLevel } from "../core/types.js";
import { MemorySessionStore } from "../session/jsonl-store.js";
import type { SessionStore } from "../session/types.js";
import { Subject, type AgentInput, type LoopHooks } from "./loop.js";
import type { ToolBroker } from "../tools/broker.js";
import type { ModelProvider } from "../core/types.js";

export type AgentStatus = "running" | "idle" | "disposed";

export interface AgentSnapshot {
	readonly id: string;
	readonly status: AgentStatus;
	readonly busy: boolean;
	readonly turn: number;
}

export interface AgentCreateOptions {
	id?: string;
	provider: ModelProvider;
	tools: ToolBroker;
	hooks?: LoopHooks;
	store?: SessionStore;
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentHandle {
	readonly id: string;
	readonly subject: Subject;
	send(input: AgentInput): Promise<void>;
	interrupt(reason?: string): Promise<void>;
	waitForIdle(): Promise<void>;
	snapshot(): AgentSnapshot;
	history(): ChatMsg[];
	dispose(): Promise<void>;
}

export interface AgentFactory {
	create(options: AgentCreateOptions): AgentHandle;
}

class RuntimeAgent implements AgentHandle {
	private status: AgentStatus = "idle";
	private disposed = false;
	private turn = 0;
	private readonly store: SessionStore;
	private disposePromise?: Promise<void>;
	readonly subject: Subject;

	constructor(readonly id: string, options: AgentCreateOptions) {
		this.store = options.store ?? new MemorySessionStore();
		this.subject = new Subject(options.provider, options.tools, {
			...options.hooks,
			onToken: options.hooks?.onToken ?? (() => {}),
			onTurnStart: (turn, text) => {
				this.status = "running";
				this.turn = turn;
				options.hooks?.onTurnStart?.(turn, text);
			},
			onTurnEnd: (turn) => {
				this.status = this.disposed ? "disposed" : "idle";
				options.hooks?.onTurnEnd?.(turn);
			},
		}, {
			store: this.store,
			systemPrompt: options.systemPrompt,
			thinkingLevel: options.thinkingLevel,
		});
	}

	send(input: AgentInput): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Agent 已释放"));
		this.status = "running";
		return this.subject.accept(input);
	}

	interrupt(_reason?: string): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.subject.interrupt();
		return this.subject.waitForIdle().then(() => {
			if (!this.disposed) this.status = "idle";
		});
	}

	waitForIdle(): Promise<void> {
		return this.subject.waitForIdle().then(() => {
			if (!this.disposed) this.status = "idle";
		});
	}

	snapshot(): AgentSnapshot {
		return { id: this.id, status: this.disposed ? "disposed" : this.status, busy: this.subject.isBusy(), turn: this.turn };
	}

	history(): ChatMsg[] {
		return this.subject.historySnapshot();
	}

	async dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = (async () => {
			this.subject.interrupt();
			await this.subject.waitForIdle();
			await this.store.close();
			this.status = "disposed";
		})();
		return this.disposePromise;
	}
}

export class DefaultAgentFactory implements AgentFactory {
	create(options: AgentCreateOptions): AgentHandle {
		return new RuntimeAgent(options.id ?? `agent-${randomUUID()}`, options);
	}
}
