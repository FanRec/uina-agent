import { randomUUID } from "node:crypto";
import type { AgentFactory } from "../../agent/runtime.js";
import type { ToolBroker } from "../../tools/broker.js";
import type { SubagentRead, SubagentRecord, SubagentSnapshot, SubagentStartOptions, SubagentTranscript } from "./types.js";

export interface SubagentRegistryOptions {
	factory: AgentFactory;
	provider: Parameters<AgentFactory["create"]>[0]["provider"];
	createTools: () => ToolBroker;
	thinkingLevel?: Parameters<AgentFactory["create"]>[0]["thinkingLevel"];
	notify?: (text: string, data: Record<string, unknown>) => Promise<void>;
}

export class SubagentRegistry {
	private readonly records = new Map<string, SubagentRecord>();
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

	list(ownerId: string): SubagentSnapshot[] {
		return [...this.records.values()].filter((record) => record.ownerId === ownerId).map((record) => this.snapshot(record));
	}

	get(id: string, ownerId: string): SubagentSnapshot {
		return this.snapshot(this.expect(id, ownerId));
	}

	read(id: string, ownerId: string, cursor = 0): SubagentRead {
		const record = this.expect(id, ownerId);
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor 无效");
		const first = record.outputs[0]?.cursor ?? record.outputs.length + 1;
		return {
			cursor: record.outputs.at(-1)?.cursor ?? 0,
			output: record.outputs.filter((item) => item.cursor > cursor).map((item) => ({ ...item })),
			outputLost: cursor > 0 && cursor < first - 1,
			subagent: this.snapshot(record),
		};
	}

	transcript(id: string, ownerId: string): SubagentTranscript {
		const record = this.expect(id, ownerId);
		return { subagent: this.snapshot(record), messages: record.handle.history() };
	}

	async send(id: string, ownerId: string, text: string): Promise<void> {
		const record = this.expect(id, ownerId);
		if (record.status !== "waiting" && record.status !== "running") throw new Error(`子代理 ${id} 已结算`);
		if (!text.trim()) throw new Error("子代理消息不能为空");
		await this.run(record, text, "subagent-input", true);
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
		await Promise.all([...this.records.values()].filter((record) => record.status !== "settled").map((record) => this.interrupt(record.id, record.ownerId)));
	}

	private makeRecord(id: string, request: SubagentStartOptions): SubagentRecord {
		const outputs: SubagentRecord["outputs"] = [];
		let record!: SubagentRecord;
		const add = (kind: SubagentRecord["outputs"][number]["kind"], text: string): void => {
			if (text) outputs.push({ cursor: outputs.length + 1, kind, text });
		};
		const hooks = {
			onToken: (text: string) => add("text", text),
			onThinking: (text: string) => add("thinking", text),
			onToolStart: (name: string, args: unknown) => add("tool_start", `${name} ${JSON.stringify(args)}`),
			onToolDone: (name: string, result: string) => add("tool_done", `${name}: ${result}`),
			onError: (error: string) => { record.error = error; record.detail = error; },
			onTurnStart: () => { if (record.status !== "interrupted") record.status = "running"; },
			onTurnEnd: () => { if (record.status === "running") record.status = "waiting"; },
		};
		const handle = this.options.factory.create({ provider: this.options.provider, tools: this.options.createTools(), hooks, thinkingLevel: this.options.thinkingLevel });
		record = { id, ownerId: request.ownerId, parentId: request.parentId, label: request.label, status: "accepted", createdAt: Date.now(), outputCursor: 0, busy: false, handle, outputs };
		return record;
	}

	private async begin(record: SubagentRecord, prompt: string): Promise<void> {
		await this.run(record, prompt, "subagent-start", false);
	}

	private async run(record: SubagentRecord, text: string, inputType: "subagent-start" | "subagent-input", propagateFailure: boolean): Promise<void> {
		try {
			record.status = "running";
			record.busy = true;
			await record.handle.send({ id: `${inputType}-${record.id}-${randomUUID()}`, mode: record.handle.subject.isBusy() ? "steer" : "followUp", source: { kind: "agent", type: inputType, ref: record.id }, text });
			record.busy = false;
			if (record.error) await this.release(record, "failed");
			else if (record.status === "running") record.status = "waiting";
		} catch (error) {
			record.busy = false;
			record.error ??= errorMessage(error);
			record.detail ??= record.error;
			await this.release(record, "failed");
			if (propagateFailure) throw error;
		}
	}

	private async release(record: SubagentRecord, terminalStatus: "interrupted" | "failed"): Promise<void> {
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
			record.outputCursor = record.outputs.at(-1)?.cursor ?? 0;
			try {
				await this.options.notify?.(`子代理 ${record.id} 已${record.terminalStatus === "failed" ? "失败" : "中断"}。任务：${record.label}。请使用 subagent_status 或 subagent_output 读取详情。`, { id: record.id, status: record.terminalStatus, label: record.label });
			} catch (error) {
				const noticeError = `通知投递失败：${errorMessage(error)}`;
				record.detail = record.detail ? `${record.detail}；${noticeError}` : noticeError;
			}
		})();
		return record.settling;
	}

	private expect(id: string, ownerId: string): SubagentRecord {
		const record = this.records.get(id);
		if (!record || record.ownerId !== ownerId) throw new Error(`无权访问子代理 ${id}`);
		return record;
	}

	private snapshot(record: SubagentRecord): SubagentSnapshot {
		return { id: record.id, ownerId: record.ownerId, ...(record.parentId ? { parentId: record.parentId } : {}), label: record.label, status: record.status, ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}), detail: record.detail, createdAt: record.createdAt, finishedAt: record.finishedAt, outputCursor: record.outputs.at(-1)?.cursor ?? 0, busy: record.handle.subject.isBusy() };
	}
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
