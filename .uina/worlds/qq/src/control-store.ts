import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../../../../src/extensions/world-framework/json-file.js";
import type { EffectivePush, FollowUpItem, FollowUpState, PushPreference } from "./types.js";

/**
 * QQ 控制状态：静音偏好（v3 哑手机）+ 冷启动基线 + follow_up 簿 + 诊断 revision。
 * 单写方；写入直接修改执行时的当前状态，持久确认（tmp+rename）成功后才返回，
 * IO 失败保留旧状态并抛错（调用方报 failed，不宣称保存）。
 * 没有 expectedRevision/条件比较；revision 只是诊断计数，不参与提醒资格。
 */

interface ControlFileShape {
	version: 2;
	selfId: string;
	revision: number;
	accountPush: PushPreference;
	conversationPush: Record<string, PushPreference>;
	/** 冷启动基线（R4③）：首见会话时写入当前 latestSequence，绝不覆盖。 */
	initializationBaseline: Record<string, number>;
	readerInitialized?: boolean;
	followUps: Record<string, FollowUpItem>;
}

function isIsoTime(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** v3 一次性迁移：任意历史偏好形状（AttentionOverride / v2 mode+filter）归并为 {off, pausedUntil}。 */
function normalizePush(raw: unknown): PushPreference {
	const value = (raw ?? {}) as {
		off?: unknown;
		mode?: unknown;
		pausedUntil?: unknown;
	};
	const off = value.off === true || value.mode === "off" || value.mode === "silent";
	return {
		...(off ? { off: true } : {}),
		...(value.pausedUntil !== undefined ? { pausedUntil: value.pausedUntil as string | null } : {}),
	};
}

export interface ControlStoreOptions {
	readonly dataDir: string;
	readonly now?: () => string;
}

export class ControlStore {
	private readonly filePath: string;
	private state: ControlFileShape = {
		version: 2,
		selfId: "",
		revision: 0,
		accountPush: {},
		conversationPush: {},
		initializationBaseline: {},
		followUps: {},
	};
	private followUpCounter = 0;
	private readonly nowFn: () => string;

	constructor(private readonly options: ControlStoreOptions & { readonly selfId: string }) {
		this.filePath = join(options.dataDir, "qq-control.json");
		this.state.selfId = options.selfId;
		this.nowFn = options.now ?? (() => new Date().toISOString());
	}

	get revision(): number {
		return this.state.revision;
	}

	/** 启动加载；文件损坏明确失败（控制状态不随消息淘汰，损坏不能静默清零）。 */
	load(readOnly = false): { followUps: number } {
		if (!readOnly) mkdirSync(this.options.dataDir, { recursive: true });
		if (!existsSync(this.filePath)) return { followUps: 0 };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch (error) {
			throw new Error(`QQ 控制状态文件损坏，明确失败: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
		const shape = parsed as Partial<ControlFileShape>;
		if (
			shape.version !== 2 ||
			shape.selfId !== this.options.selfId ||
			typeof shape.revision !== "number" ||
			typeof shape.followUps !== "object" ||
			shape.followUps === null
		) {
			throw new Error("QQ 控制状态 v2 账号元信息不匹配或形状非法，明确失败");
		}
		// v3 一次性迁移：任意历史偏好形状归并为 {off, pausedUntil}；迁移后持久化文件不再携带旧字段。
		let accountPush = shape.accountPush;
		let conversationPush = shape.conversationPush;
		const legacy = (parsed as { accountOverride?: unknown }).accountOverride !== undefined;
		if (legacy) {
			const legacyAccount = (parsed as { accountOverride?: unknown }).accountOverride;
			const legacyConversations =
				(parsed as { conversationOverrides?: Record<string, unknown> }).conversationOverrides ?? {};
			accountPush = normalizePush(legacyAccount);
			conversationPush = Object.fromEntries(Object.entries(legacyConversations).map(([k, v]) => [k, normalizePush(v)]));
		} else if (accountPush !== undefined) {
			accountPush = normalizePush(accountPush);
			conversationPush = Object.fromEntries(
				Object.entries(conversationPush ?? {}).map(([k, v]) => [k, normalizePush(v)]),
			);
		}
		this.state = {
			version: 2,
			selfId: this.options.selfId,
			revision: shape.revision,
			accountPush: accountPush ?? {},
			conversationPush: conversationPush ?? {},
			initializationBaseline: shape.initializationBaseline ?? {},
			readerInitialized: shape.readerInitialized === true,
			followUps: shape.followUps,
		};
		if (legacy && !readOnly) this.persist(this.state);
		for (const ref of Object.keys(this.state.followUps)) {
			if (!/^f[1-9]\d*$/.test(ref)) throw new Error("QQ 事项引用非法");
			const num = Number(ref.slice(1));
			if (Number.isInteger(num) && num > this.followUpCounter) this.followUpCounter = num;
		}
		return { followUps: Object.keys(this.state.followUps).length };
	}

	private persist(next: ControlFileShape): void {
		// 先持久化后提交内存：IO 失败时旧状态原样保留（内存与磁盘一致）。
		writeJsonAtomicSync(this.filePath, next);
		this.state = next;
	}

	/* ---------- 静音偏好（v3 哑手机；off 是唯一持久配置） ---------- */

	private pushFor(target: string): PushPreference {
		if (target === "account") return { ...this.state.accountPush };
		return { ...(this.state.conversationPush[target] ?? {}) };
	}

	/** setPush：只修改提供的字段；省略 = 不修改；pausedUntil null = 解除暂停。 */
	setPush(target: string, patch: PushPreference): number {
		if (patch.off !== undefined && typeof patch.off !== "boolean") {
			throw new Error("off 必须是布尔值");
		}
		if (patch.pausedUntil !== undefined && patch.pausedUntil !== null && !isIsoTime(patch.pausedUntil)) {
			throw new Error("pausedUntil 必须是带时区的 ISO 时间或 null");
		}
		const current = this.pushFor(target);
		const nextPref: PushPreference = {
			...current,
			...(patch.off !== undefined ? { off: patch.off } : {}),
			...(patch.pausedUntil !== undefined ? { pausedUntil: patch.pausedUntil } : {}),
		};
		const next: ControlFileShape =
			target === "account"
				? { ...this.state, accountPush: nextPref, revision: this.state.revision + 1 }
				: {
						...this.state,
						conversationPush: { ...this.state.conversationPush, [target]: nextPref },
						revision: this.state.revision + 1,
					};
		this.persist(next);
		return this.state.revision;
	}

	/** 清除目标静音偏好（回落账号继承/默认响铃）。 */
	clearPush(target: string): number {
		const next: ControlFileShape =
			target === "account"
				? { ...this.state, accountPush: {}, revision: this.state.revision + 1 }
				: (() => {
						const push = { ...this.state.conversationPush };
						delete push[target];
						return { ...this.state, conversationPush: push, revision: this.state.revision + 1 };
					})();
		this.persist(next);
		return this.state.revision;
	}

	/**
	 * 生效静音状态：本地显式值或账号值任一 off 即静音；暂停（账号或局部）折算为 off。
	 * focus（在场）不经过此处——开着窗口无视门铃，由调度层直接判定。
	 */
	effectivePush(target: string): EffectivePush {
		const nowMs = Date.parse(this.nowFn());
		const account = this.pushFor("account");
		const local = target === "account" ? {} : this.pushFor(target);
		const accountPaused = account.pausedUntil != null && isIsoTime(account.pausedUntil) && Date.parse(account.pausedUntil) > nowMs;
		const localPaused = local.pausedUntil != null && isIsoTime(local.pausedUntil) && Date.parse(local.pausedUntil) > nowMs;
		const pausedUntil = accountPaused ? account.pausedUntil! : localPaused ? local.pausedUntil! : null;
		return {
			off: local.off === true || account.off === true || accountPaused || localPaused,
			pausedUntil,
		};
	}

	/* ---------- 冷启动基线（R4③，按会话） ---------- */

	/** 首见会话封存基线；已存在绝不覆盖（诚实冷启动只发生一次）。 */
	ensureBaseline(conversationRef: string, latestSequence: number): number {
		const existing = this.state.initializationBaseline[conversationRef];
		if (existing !== undefined) return existing;
		const baseline = this.state.readerInitialized ? 0 : Math.max(0, Math.floor(latestSequence));
		this.persist({
			...this.state,
			initializationBaseline: { ...this.state.initializationBaseline, [conversationRef]: baseline },
			revision: this.state.revision + 1,
		});
		return baseline;
	}

	initializeReader(journal: import("./facts-journal.js").FactsJournal): void {
		if (this.state.readerInitialized) return;
		const baseline = { ...this.state.initializationBaseline };
		for (const ref of journal.listConversationRefs()) baseline[ref] ??= journal.latestSequence(ref);
		this.persist({
			...this.state,
			initializationBaseline: baseline,
			readerInitialized: true,
			revision: this.state.revision + 1,
		});
	}

	pushTargets(): string[] {
		return Object.keys(this.state.conversationPush);
	}

	baselineOf(conversationRef: string): number | undefined {
		return this.state.initializationBaseline[conversationRef] ?? (this.state.readerInitialized ? 0 : undefined);
	}

	/* ---------- follow_up ---------- */

	createFollowUp(input: {
		targetRef: string;
		note: string;
		evidenceRefs?: readonly string[];
		reviewAt?: string | null;
	}): FollowUpItem {
		if (input.reviewAt != null && !isIsoTime(input.reviewAt)) {
			throw new Error("reviewAt 必须是带时区的 ISO 时间或 null");
		}
		this.followUpCounter++;
		const item: FollowUpItem = {
			ref: `f${this.followUpCounter}`,
			targetRef: input.targetRef,
			note: input.note,
			evidenceRefs: input.evidenceRefs ?? [],
			reviewAt: input.reviewAt ?? null,
			reviewNotified: false,
			state: "open",
			formedAt: this.nowFn(),
		};
		return this.persistFollowUp(item);
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

	settleFollowUp(ref: string, resolution: string, state: "closed" | "cancelled"): FollowUpItem {
		const item = this.getFollowUp(ref);
		if (!item) throw new Error(`follow_up 不存在: ${ref}`);
		if (item.state !== "open") throw new Error(`follow_up ${ref} 已是 ${item.state}，只能对 open 事项操作`);
		if (!resolution) throw new Error("close/cancel 需要明确的 resolution");
		return this.persistFollowUp({ ...item, state, resolution, settledAt: this.nowFn() });
	}

	/** 到期提醒计账：通知过就不重复提醒。 */
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
			(item) =>
				item.state === "open" && !item.reviewNotified && item.reviewAt != null && Date.parse(item.reviewAt) <= nowMs,
		);
	}
}
