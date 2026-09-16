import { randomUUID } from "node:crypto";
import { errorMessage } from "../../core/errors.js";
import type { AgentFactory, AgentHandle } from "../../agent/runtime.js";
import type { AgentInput } from "../../agent/loop.js";
import type { ToolView } from "../../tools/broker.js";
import { TaskOutputBuffer } from "../../runtime/task-handle.js";
import type {
	SubagentChunk,
	SubagentRead,
	SubagentSnapshot,
	SubagentStartOptions,
	SubagentTranscript,
} from "./types.js";

export interface SubagentRegistryOptions {
	factory: AgentFactory;
	/** Resolved per child creation so a model switch affects new subagents. */
	model: () => Parameters<AgentFactory["create"]>[0]["model"];
	stream: Parameters<AgentFactory["create"]>[0]["stream"];
	createTools: (ownerId: string) => ToolView;
	thinkingLevel?: Parameters<AgentFactory["create"]>[0]["thinkingLevel"];
	notify?: (text: string, data: Record<string, unknown>, ownerId: string) => Promise<void>;
}

/** Per-child output budget; the oldest chunks are released once exceeded. */
const OUTPUT_BUDGET_BYTES = 256 * 1024;

interface TrackedSubagent {
	readonly id: string;
	readonly ownerId: string;
	readonly parentId?: string;
	readonly label: string;
	readonly createdAt: number;
	finishedAt?: number;
	detail?: string;
	status?: "interrupted" | "failed" | "settled";
	terminalStatus?: "failed" | "interrupted";
	handle: AgentHandle;
	readonly buffer: TaskOutputBuffer<SubagentChunk>;
	error?: string;
	settling?: Promise<void>;
}

export class SubagentRegistry {
	private readonly records = new Map<string, TrackedSubagent>();
	private accepting = true;

	constructor(private readonly options: SubagentRegistryOptions) {}

	start(request: SubagentStartOptions): SubagentSnapshot {
		if (!this.accepting) throw new Error("子代理服务已关闭");
		if (!request.ownerId || !request.label.trim() || !request.prompt.trim()) throw new Error("子代理需要 ownerId、label 和 prompt");
		const id = `subagent-${randomUUID()}`;
		const record = this.makeRecord(id, request);
		this.records.set(id, record);
		void this.begin(record, request.prompt);
		return this.snapshot(record);
	}

	session(id: string): import("../../session/types.js").SessionAccess {
		const record = this.records.get(id);
		if (!record || record.status) throw new Error(`子代理会话不可用: ${id}`);
		return record.handle.subject.session;
	}

	list(ownerId: string): SubagentSnapshot[] {
		return [...this.records.values()]
			.filter((record) => record.ownerId === ownerId)
			.map((record) => this.snapshot(record));
	}

	get(id: string, ownerId: string): SubagentSnapshot {
		return this.snapshot(this.expect(id, ownerId));
	}

	read(id: string, ownerId: string, cursor = 0): SubagentRead {
		const record = this.expect(id, ownerId);
		const readResult = record.buffer.read(cursor);
		return {
			cursor: readResult.cursor,
			output: readResult.chunks.map((item) => ({ ...item })),
			outputLost: readResult.outputLost,
			subagent: this.snapshot(record),
		};
	}

	transcript(id: string, ownerId: string): SubagentTranscript {
		const record = this.expect(id, ownerId);
		return { subagent: this.snapshot(record), messages: record.handle.history() };
	}

	async send(id: string, ownerId: string, text: string): Promise<void> {
		const record = this.expect(id, ownerId);
		if (record.status) throw new Error(`子代理 ${id} 已结算`);
		if (!text.trim()) throw new Error("子代理消息不能为空");
		await this.run(record, text, "subagent-input", true);
	}

	/** Host delivery to the actual initiating agent, preserving runtime input facts. */
	async acceptInput(id: string, input: AgentInput): Promise<void> {
		const record = this.records.get(id);
		if (!record) throw new Error(`未知子代理 ${id}`);
		if (record.status) throw new Error(`子代理 ${id} 已结算`);
		try {
			await record.handle.send(input);
			if (record.error) await this.release(record, "failed");
		} catch (error) {
			record.error ??= errorMessage(error);
			record.detail ??= record.error;
			await this.release(record, "failed");
			throw error;
		}
	}

	async interrupt(id: string, ownerId: string): Promise<"interruption-requested" | "already-finished"> {
		const record = this.expect(id, ownerId);
		if (record.settling) {
			await record.settling;
			return "already-finished";
		}
		if (record.status === "settled") return "already-finished";
		record.status = "interrupted";
		await record.handle.interrupt("子代理被请求中断");
		await this.release(record, "interrupted");
		return "interruption-requested";
	}

	async close(): Promise<void> {
		this.accepting = false;
		await Promise.all(
			[...this.records.values()]
				.filter((record) => record.status !== "settled")
				.map((record) => this.interrupt(record.id, record.ownerId)),
		);
	}

	private makeRecord(id: string, request: SubagentStartOptions): TrackedSubagent {
		const buffer = new TaskOutputBuffer<SubagentChunk>({ maxBytes: OUTPUT_BUDGET_BYTES });
		const handle = this.options.factory.create({
			id,
			model: this.options.model(),
			stream: this.options.stream,
			tools: this.options.createTools(id),
			thinkingLevel: this.options.thinkingLevel,
		});
		// record 先于 subscribe 完整构造：回调里引用的对象必须在任何事件可能到达前就绪，
		// 不依赖"subscribe 与赋值之间没有 await"这类隐式时序。
		const record: TrackedSubagent = {
			id,
			ownerId: request.ownerId,
			parentId: request.parentId,
			label: request.label,
			createdAt: Date.now(),
			handle,
			buffer,
		};
		handle.subject.subscribe((event) => {
			if (event.type === "output_update") {
				if (event.channel === "content" && event.text) buffer.append({ kind: "text", text: event.text });
				else if (event.channel === "thinking" && event.text) buffer.append({ kind: "thinking", text: event.text });
			} else if (event.type === "tool_call") {
				buffer.append({ kind: "tool_start", text: `${event.toolName} ${JSON.stringify(event.args)}` });
			} else if (event.type === "tool_result") {
				buffer.append({ kind: "tool_done", text: `${event.toolName}: ${event.result}` });
			} else if (event.type === "error") {
				record.error = event.text;
				record.detail = event.text;
			}
		});
		return record;
	}

	private async begin(record: TrackedSubagent, prompt: string): Promise<void> {
		await this.run(record, prompt, "subagent-start", false);
	}

	private async run(record: TrackedSubagent, text: string, inputType: "subagent-start" | "subagent-input", propagateFailure: boolean): Promise<void> {
		try {
			await record.handle.send({
				id: `${inputType}-${record.id}-${randomUUID()}`,
				mode: record.handle.subject.isBusy() ? "steer" : "followUp",
				source: { kind: "agent", type: inputType, ref: record.id },
				text,
			});
			if (record.error) await this.release(record, "failed");
		} catch (error) {
			record.error ??= errorMessage(error);
			record.detail ??= record.error;
			await this.release(record, "failed");
			if (propagateFailure) throw error;
		}
	}

	private async release(record: TrackedSubagent, terminalStatus: "interrupted" | "failed"): Promise<void> {
		if (record.settling) return record.settling;
		record.settling = (async () => {
			record.status = terminalStatus;
			record.terminalStatus = terminalStatus;
			try {
				await record.handle.dispose();
			} catch (error) {
				record.terminalStatus = "failed";
				record.error = `释放失败：${errorMessage(error)}`;
				record.detail = record.error;
			}
			record.status = "settled";
			record.finishedAt = Date.now();
			try {
				await this.options.notify?.(
					`子代理 ${record.id} 已${record.terminalStatus === "failed" ? "失败" : "中断"}。任务：${record.label}。请使用 subagent_status 或 subagent_output 读取详情。`,
					{ id: record.id, status: record.terminalStatus, label: record.label },
					record.ownerId,
				);
			} catch (error) {
				const noticeError = `通知投递失败：${errorMessage(error)}`;
				record.detail = record.detail ? `${record.detail}；${noticeError}` : noticeError;
			}
		})();
		return record.settling;
	}

	private expect(id: string, ownerId: string): TrackedSubagent {
		const record = this.records.get(id);
		if (!record || record.ownerId !== ownerId) throw new Error(`无权访问子代理 ${id}`);
		return record;
	}

	private snapshot(record: TrackedSubagent): SubagentSnapshot {
		return {
			id: record.id,
			ownerId: record.ownerId,
			...(record.parentId ? { parentId: record.parentId } : {}),
			label: record.label,
			status: record.status ?? (record.handle.snapshot().busy ? "running" : "waiting"),
			...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
			detail: record.detail,
			createdAt: record.createdAt,
			finishedAt: record.finishedAt,
			outputCursor: record.buffer.currentCursor,
			busy: record.handle.subject.isBusy(),
		};
	}
}

