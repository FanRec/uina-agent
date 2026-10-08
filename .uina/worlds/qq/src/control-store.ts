import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionMode, AttentionOverride, EffectiveAttention, FollowUpItem, FollowUpState } from "./types.js";

/**
 * QQ 控制状态：attention 覆盖 + follow_up 簿 + 诊断 revision。
 * 单写方；写入直接修改执行时的当前状态，持久确认（tmp+rename）成功后才返回，
 * IO 失败保留旧状态并抛错（调用方报 failed，不宣称保存）。
 * 没有 expectedRevision/条件比较；revision 只是诊断计数，不参与提醒资格。
 */

interface ControlFileShape {
	version: 1;
	revision: number;
	accountOverride: AttentionOverride;
	conversationOverrides: Record<string, AttentionOverride>;
	followUps: Record<string, FollowUpItem>;
}

const EMPTY_OVERRIDE: AttentionOverride = {};

function isIsoTime(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export interface ControlStoreOptions {
	readonly dataDir: string;
	/** 安装初值（部署配置可覆盖；缺省 normal/normal）。 */
	readonly defaultMode?: AttentionMode;
	readonly now?: () => string;
}

export class ControlStore {
	private readonly filePath: string;
	private state: ControlFileShape = {
		version: 1,
		revision: 0,
		accountOverride: EMPTY_OVERRIDE,
		conversationOverrides: {},
		followUps: {},
	};
	private followUpCounter = 0;
	private readonly nowFn: () => string;

	constructor(
		private readonly options: ControlStoreOptions & { readonly selfId: string },
	) {
		this.filePath = join(options.dataDir, "qq-control.json");
		this.nowFn = options.now ?? (() => new Date().toISOString());
	}

	get revision(): number {
		return this.state.revision;
	}

	/** 启动加载；文件损坏明确失败（控制状态不随消息淘汰，损坏不能静默清零）。 */
	load(): { followUps: number } {
		mkdirSync(this.options.dataDir, { recursive: true });
		if (!existsSync(this.filePath)) return { followUps: 0 };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch (error) {
			throw new Error(`QQ 控制状态文件损坏，明确失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		const shape = parsed as Partial<ControlFileShape>;
		if (shape.version !== 1 || typeof shape.revision !== "number" || typeof shape.followUps !== "object" || shape.followUps === null) {
			throw new Error("QQ 控制状态文件形状非法，明确失败");
		}
		this.state = {
			version: 1,
			revision: shape.revision,
			accountOverride: shape.accountOverride ?? EMPTY_OVERRIDE,
			conversationOverrides: shape.conversationOverrides ?? {},
			followUps: shape.followUps,
		};
		for (const ref of Object.keys(this.state.followUps)) {
			const parts = ref.split(":");
			const num = Number.parseInt(parts[parts.length - 1] ?? "", 10);
			if (Number.isInteger(num) && num > this.followUpCounter) this.followUpCounter = num;
		}
		return { followUps: Object.keys(this.state.followUps).length };
	}

	private persist(next: ControlFileShape): void {
		// 先持久化后提交内存：IO 失败时旧状态原样保留（内存与磁盘一致）。
		mkdirSync(this.options.dataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, "\t") + "\n", "utf8");
		renameSync(tmp, this.filePath);
		this.state = next;
	}

	private overrideFor(target: string): AttentionOverride {
		if (target === "account") return { ...this.state.accountOverride };
		return { ...(this.state.conversationOverrides[target] ?? EMPTY_OVERRIDE) };
	}

	/**
	 * attention.set：只修改提供的字段；成功等待持久确认并返回诊断 revision。
	 */
	setAttention(target: string, patch: { mode?: AttentionMode; priority?: import("./types.js").AttentionPriority; pausedUntil?: string | null }): number {
		if (patch.pausedUntil !== undefined && patch.pausedUntil !== null && !isIsoTime(patch.pausedUntil)) {
			throw new Error("pausedUntil 必须是带时区的 ISO 时间或 null");
		}
		const current = this.overrideFor(target);
		const nextOverride: AttentionOverride = {
			...current,
			...(patch.mode !== undefined ? { mode: patch.mode } : {}),
			...(patch.priority !== undefined ? { priority: patch.priority } : {}),
			...(patch.pausedUntil !== undefined ? { pausedUntil: patch.pausedUntil } : {}),
		};
		const next: ControlFileShape =
			target === "account"
				? { ...this.state, accountOverride: nextOverride, revision: this.state.revision + 1 }
				: {
						...this.state,
						conversationOverrides: { ...this.state.conversationOverrides, [target]: nextOverride },
						revision: this.state.revision + 1,
					};
		this.persist(next);
		return this.state.revision;
	}

	/** attention.clear：清除目标覆盖。 */
	clearAttention(target: string): number {
		const next: ControlFileShape =
			target === "account"
				? { ...this.state, accountOverride: EMPTY_OVERRIDE, revision: this.state.revision + 1 }
				: (() => {
						const overrides = { ...this.state.conversationOverrides };
						delete overrides[target];
						return { ...this.state, conversationOverrides: overrides, revision: this.state.revision + 1 };
					})();
		this.persist(next);
		return this.state.revision;
	}

	/**
	 * 生效规则：安装初值 ← 账号覆盖 ← 会话覆盖；账号级 silent/pause 不被局部覆盖。
	 * 已到期的 pause 视为未暂停（到期恢复原规则）。
	 */
	effectiveAttention(target: string): EffectiveAttention {
		const nowMs = Date.parse(this.nowFn());
		const account = this.overrideFor("account");
		const local = target === "account" ? EMPTY_OVERRIDE : this.overrideFor(target);

		const accountPaused =
			account.pausedUntil != null && isIsoTime(account.pausedUntil) && Date.parse(account.pausedUntil) > nowMs;
		const localPaused =
			local.pausedUntil != null && isIsoTime(local.pausedUntil) && Date.parse(local.pausedUntil) > nowMs;

		return {
			mode: accountPaused ? "silent" : (localPaused ? "silent" : (local.mode ?? account.mode ?? this.options.defaultMode ?? "normal")),
			priority: local.priority ?? account.priority ?? "normal",
			pausedUntil: accountPaused ? account.pausedUntil! : localPaused ? local.pausedUntil! : null,
		};
	}

	/** 已到期但尚未恢复处理的暂停目标（到期恢复原规则 + 一次允许的积压摘要；无 backlog 模式参数）。 */
	expiredPauses(): { target: string; pausedUntil: string }[] {
		const nowMs = Date.parse(this.nowFn());
		const out: { target: string; pausedUntil: string }[] = [];
		if (this.state.accountOverride.pausedUntil != null && Date.parse(this.state.accountOverride.pausedUntil) <= nowMs) {
			out.push({ target: "account", pausedUntil: this.state.accountOverride.pausedUntil });
		}
		for (const [target, override] of Object.entries(this.state.conversationOverrides)) {
			if (override.pausedUntil != null && Date.parse(override.pausedUntil) <= nowMs) {
				out.push({ target, pausedUntil: override.pausedUntil });
			}
		}
		return out;
	}

	/* ---------- follow_up ---------- */

	createFollowUp(input: { targetRef: string; note: string; evidenceRefs?: readonly string[]; reviewAt?: string | null }): FollowUpItem {
		if (input.reviewAt != null && !isIsoTime(input.reviewAt)) {
			throw new Error("reviewAt 必须是带时区的 ISO 时间或 null");
		}
		this.followUpCounter++;
		const item: FollowUpItem = {
			ref: `qq-follow-up:${this.options.selfId}:${this.followUpCounter}`,
			targetRef: input.targetRef,
			note: input.note,
			evidenceRefs: input.evidenceRefs ?? [],
			reviewAt: input.reviewAt ?? null,
			reviewNotified: false,
			state: "open",
			formedAt: this.nowFn(),
		};
		this.persist({
			...this.state,
			followUps: { ...this.state.followUps, [item.ref]: item },
			revision: this.state.revision + 1,
		});
		return item;
	}

	private persistFollowUp(item: FollowUpItem): FollowUpItem {
		this.persist({
			...this.state,
			followUps: { ...this.state.followUps, [item.ref]: item },
			revision: this.state.revision + 1,
		});
		return item;
	}

	getFollowUp(ref: string): FollowUpItem | null {
		return this.state.followUps[ref] ?? null;
	}

	listFollowUps(filter: { targetRef?: string; state?: FollowUpState | "all" }): FollowUpItem[] {
		const state = filter.state ?? "open";
		return Object.values(this.state.followUps)
			.filter((item) => (filter.targetRef ? item.targetRef === filter.targetRef : true))
			.filter((item) => (state === "all" ? true : item.state === state))
			.sort((a, b) => a.formedAt.localeCompare(b.formedAt));
	}

	/** update 修改给定字段；reviewAt=null 清除预约。 */
	updateFollowUp(ref: string, patch: { note?: string; evidenceRefs?: readonly string[]; reviewAt?: string | null }): FollowUpItem {
		const item = this.getFollowUp(ref);
		if (!item) throw new Error(`follow_up 不存在: ${ref}`);
		if (item.state !== "open") throw new Error(`follow_up ${ref} 已是 ${item.state}，只能对 open 事项操作`);
		if (patch.reviewAt !== undefined && patch.reviewAt !== null && !isIsoTime(patch.reviewAt)) {
			throw new Error("reviewAt 必须是带时区的 ISO 时间或 null");
		}
		return this.persistFollowUp({
			...item,
			...(patch.note !== undefined ? { note: patch.note } : {}),
			...(patch.evidenceRefs !== undefined ? { evidenceRefs: [...patch.evidenceRefs] } : {}),
			...(patch.reviewAt !== undefined
				? { reviewAt: patch.reviewAt, reviewNotified: patch.reviewAt !== item.reviewAt ? false : item.reviewNotified }
				: {}),
		});
	}

	settleFollowUp(ref: string, resolution: string, state: "closed" | "cancelled"): FollowUpItem {
		const item = this.getFollowUp(ref);
		if (!item) throw new Error(`follow_up 不存在: ${ref}`);
		if (item.state !== "open") throw new Error(`follow_up ${ref} 已是 ${item.state}，只能对 open 事项操作`);
		if (!resolution) throw new Error("close/cancel 需要明确的 resolution");
		return this.persistFollowUp({ ...item, state, resolution, settledAt: this.nowFn() });
	}

	/** 到期提醒计账：通知过就不因只改 note 再提醒；改变 reviewAt 才重建预约（update 已处理）。 */
	markReviewNotified(ref: string): FollowUpItem {
		const item = this.getFollowUp(ref);
		if (!item) throw new Error(`follow_up 不存在: ${ref}`);
		if (item.reviewNotified) return item;
		return this.persistFollowUp({ ...item, reviewNotified: true });
	}

	/** 当前到期且未通知过的 open 事项（调度层消费）。 */
	dueFollowUps(): FollowUpItem[] {
		const nowMs = Date.parse(this.nowFn());
		return Object.values(this.state.followUps).filter(
			(item) => item.state === "open" && !item.reviewNotified && item.reviewAt != null && Date.parse(item.reviewAt) <= nowMs,
		);
	}
}
