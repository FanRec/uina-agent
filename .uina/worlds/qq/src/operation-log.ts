import { closeSync, fsyncSync, mkdirSync, openSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationRecord, OperationOutcome } from "./types.js";
import { classifyPlatformReceipt, refBelongsToAccount } from "./types.js";
import { recoverJsonlLines } from "./jsonl-log.js";

/**
 * QQ 操作日志：外部动作的意图、结论与迟到回执。
 * 派发前的 durable 屏障用 fsync（will_dispatch commit）；普通回执追加按常规写。
 * unknown 不自动重发：查询不重执行；迟到回执归并到同一 operationRef。
 */

type LogRecord =
	| { kind: "operation"; record: OperationRecord }
	| { kind: "receipt"; ref: string; outcome: OperationOutcome; messageRef?: string; reason?: string; at: string; receipt?: unknown };

export interface OperationLogOptions {
	readonly dataDir: string;
	readonly selfId: string;
}

export class OperationLog {
	private readonly filePath: string;
	private readonly records = new Map<string, OperationRecord>();
	/** echo → operationRef 索引：迟到回执凭 echo 归并（SDK 回执只带 echo 不带 ref）。 */
	private readonly byEcho = new Map<string, string>();
	/** 已把 unknown 结论交付给工具结果的 ref：只有这些操作的迟到回执升级才需要通知主体。 */
	private readonly deliveredUnknown = new Set<string>();

	constructor(private readonly options: OperationLogOptions) {
		this.filePath = join(options.dataDir, "qq-operations.jsonl");
	}

	/** 启动恢复；尾部 partial 截断语义与 facts journal 一致。 */
	recover(): { truncatedTailLines: number; count: number } {
		mkdirSync(this.options.dataDir, { recursive: true });
		const { records, truncatedTailLines } = recoverJsonlLines<LogRecord>(this.filePath, "QQ 操作日志 ");
		for (const record of records) this.apply(record);
		return { truncatedTailLines, count: this.records.size };
	}

	private apply(record: LogRecord): void {
		if (record.kind === "operation") {
			if (!refBelongsToAccount(record.record.ref, this.options.selfId)) return;
			this.records.set(record.record.ref, record.record);
			if (record.record.echo) this.byEcho.set(record.record.echo, record.record.ref);
			return;
		}
		const existing = this.records.get(record.ref);
		if (!existing) return;
		this.records.set(record.ref, {
			...existing,
			outcome: record.outcome,
			messageRef: record.messageRef ?? existing.messageRef,
			reason: record.reason ?? existing.reason,
			settledAt: record.at,
			receipt: record.receipt ?? existing.receipt,
		});
	}

	private append(record: LogRecord): void {
		appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
	}

	/**
	 * 派发屏障：动作意图在发出平台调用前必须真实 durable commit。
	 * fsync 保证崩溃后意图仍在，unknown 结算有据可查。
	 */
	commitIntent(record: OperationRecord): void {
		mkdirSync(this.options.dataDir, { recursive: true });
		const line = JSON.stringify({ kind: "operation", record } satisfies LogRecord) + "\n";
		const fd = openSync(this.filePath, "a");
		try {
			writeFileSync(fd, line, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.apply({ kind: "operation", record });
	}

	/** 平台回执结算/升级（含迟到回执）；同 echo 迟到回执归并到同一 operationRef。 */
	settle(ref: string, outcome: OperationOutcome, at: string, extra?: { messageRef?: string; reason?: string; receipt?: unknown }): void {
		this.append({ kind: "receipt", ref, outcome, ...extra, at });
		this.apply({ kind: "receipt", ref, outcome, ...extra, at });
	}

	get(ref: string): OperationRecord | null {
		return this.records.get(ref) ?? null;
	}

	/** 凭 echo 反查操作记录（index 装配层判断迟到回执是否需要通知主体）。 */
	getByEcho(echo: string): OperationRecord | null {
		const ref = this.byEcho.get(echo);
		return ref ? (this.records.get(ref) ?? null) : null;
	}

	/** unknown 工具结果已返回给主体；此后该操作的迟到回执升级应通知。 */
	markDeliveredUnknown(ref: string): void {
		this.deliveredUnknown.add(ref);
	}

	wasDeliveredUnknown(ref: string): boolean {
		return this.deliveredUnknown.has(ref);
	}

	/**
	 * 迟到回执归并：凭 echo 找到操作，仅当它仍是 unknown 时用回执升级结论。
	 * 已有确定结论（succeeded/failed）不被迟到副本降级/覆盖。
	 */
	settleFromEchoReceipt(echo: string, response: { status?: unknown; retcode?: unknown; data?: unknown }, at: string): OperationRecord | null {
		const ref = this.byEcho.get(echo);
		if (!ref) return null;
		const record = this.records.get(ref);
		if (!record || record.outcome !== "unknown") return record ?? null;
		const outcome = classifyPlatformReceipt(response);
		const ok = outcome === "succeeded";
		const messageRef = ok ? (response.data as { message_id?: unknown } | null | undefined)?.message_id : undefined;
		this.settle(ref, outcome, at, {
			...(typeof messageRef === "number" ? { messageRef: `qq-message:${this.options.selfId}:${messageRef}` } : {}),
			reason: ok ? undefined : `late_receipt: retcode=${String(response.retcode)}${outcome === "unknown" ? " (effect unconfirmed)" : ""}`,
			receipt: response,
		});
		return this.records.get(ref) ?? null;
	}

	/** 结果仍为 unknown 的操作（observe scope=operations state=unknown）。 */
	listUnknown(): OperationRecord[] {
		return [...this.records.values()].filter((record) => record.outcome === "unknown").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	recent(limit: number): OperationRecord[] {
		return [...this.records.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, limit);
	}

	private nextCounter = 0;

	/** 操作 ref 铸造（进程内单调；重启后以既有 ref 计数续起，避免撞号）。 */
	seedCounterFromExisting(): void {
		for (const ref of this.records.keys()) {
			const num = Number.parseInt(ref.split(":").pop() ?? "", 10);
			if (Number.isInteger(num) && num > this.nextCounter) this.nextCounter = num;
		}
	}

	newOperationRef(): string {
		this.nextCounter++;
		return `qq-operation:${this.options.selfId}:${this.nextCounter}`;
	}
}
