import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionOverride, EffectivePush, FollowUpItem, FollowUpState, PushPreference } from "./types.js";

/**
 * QQ 控制状态：push 偏好（v2）+ 冷启动基线 + follow_up 簿 + 诊断 revision。
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

/** R5 迁移映射：silent→off、direct_only→digest+direct、normal→digest+all；priority 丢弃。 */
function migrateOverride(override: AttentionOverride): PushPreference {
	return {
		...(override.mode === "silent"
			? { mode: "off" as const }
			: override.mode === "direct_only"
				? { mode: "digest" as const, filter: "direct" as const }
				: override.mode === "normal"
					? { mode: "digest" as const, filter: "all" as const }
					: {}),
		...(override.pausedUntil !== undefined ? { pausedUntil: override.pausedUntil } : {}),
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
		// R5 一次性迁移：旧 v2 文件中的 AttentionOverride → push 偏好（priority 丢弃）。
		// 迁移后持久化文件不再携带旧字段；新写路径只有 push 偏好。
		let accountPush = shape.accountPush;
		let conversationPush = shape.conversationPush;
		const legacy = shape.accountPush === undefined;
		if (legacy) {
			const legacyAccount = (parsed as { accountOverride?: AttentionOverride }).accountOverride ?? {};
			const legacyConversations =
				(parsed as { conversationOverrides?: Record<string, AttentionOverride> }).conversationOverrides ?? {};
			accountPush = migrateOverride(legacyAccount);
			conversationPush = Object.fromEntries(
				Object.entries(legacyConversations).map(([k, v]) => [k, migrateOverride(v)]),
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
		mkdirSync(this.options.dataDir, { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, "\t") + "\n", "utf8");
		renameSync(tmp, this.filePath);
		this.state = next;
	}

	/** 已到期但尚未恢复处理的暂停目标（push 偏好口径；到期恢复原规则 + 一次允许的积压摘要）。 */
	expiredPauses(): { target: string; pausedUntil: string }[] {
		const nowMs = Date.parse(this.nowFn());
		const out: { target: string; pausedUntil: string }[] = [];
		const account = this.state.accountPush;
		if (account.pausedUntil != null && Date.parse(account.pausedUntil) <= nowMs) {
			out.push({ target: "account", pausedUntil: account.pausedUntil });
		}
		for (const [target, pref] of Object.entries(this.state.conversationPush)) {
			if (pref.pausedUntil != null && Date.parse(pref.pausedUntil) <= nowMs) {
				out.push({ target, pausedUntil: pref.pausedUntil });
			}
		}
		return out;
	}

	/* ---------- push 偏好（v2 阅读重构；语义见设计文档 §1.2/§3/§9） ---------- */

	private pushFor(target: string): PushPreference {
		if (target === "account") return { ...this.state.accountPush };
		return { ...(this.state.conversationPush[target] ?? {}) };
	}

	/** setPush：只修改提供的字段；省略 = 不修改；pausedUntil null = 解除暂停。 */
	setPush(target: string, patch: PushPreference): number {
		if (patch.pausedUntil !== undefined && patch.pausedUntil !== null && !isIsoTime(patch.pausedUntil)) {
			throw new Error("pausedUntil 必须是带时区的 ISO 时间或 null");
		}
		const current = this.pushFor(target);
		const nextPref: PushPreference = {
			...current,
			...(patch.mode !== undefined ? { mode: patch.mode } : {}),
			...(patch.filter !== undefined ? { filter: patch.filter } : {}),
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

	/** 清除目标推送偏好（回落账号继承/默认）。 */
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
	 * 继承解析（设计文档 §1.2 公式）：resolved = 会话显式值优先，inherit/缺省回落账号；
	 * 账号回落默认 digest/all。账号级 off 只是账号默认值，不压制会话显式选择（§1.1 选择权）。
	 * 暂停（账号或局部）视作临时 off，到期自动恢复。
	 */
	effectivePush(target: string): EffectivePush {
		const nowMs = Date.parse(this.nowFn());
		const account = this.pushFor("account");
		const local = target === "account" ? {} : this.pushFor(target);
		const accountPaused =
			account.pausedUntil != null && isIsoTime(account.pausedUntil) && Date.parse(account.pausedUntil) > nowMs;
		const localPaused =
			local.pausedUntil != null && isIsoTime(local.pausedUntil) && Date.parse(local.pausedUntil) > nowMs;
		let pausedUntil: string | null = null;
		if (accountPaused) pausedUntil = account.pausedUntil!;
		else if (localPaused) pausedUntil = local.pausedUntil!;
		const resolveMode = (): Exclude<import("./types.js").PushMode, "inherit"> => {
			const m = local.mode !== "inherit" && local.mode !== undefined ? local.mode : (account.mode ?? "digest");
			return m === "inherit" ? "digest" : m;
		};
		const resolveFilter = (): Exclude<import("./types.js").PushFilter, "inherit"> => {
			const f = local.filter !== "inherit" && local.filter !== undefined ? local.filter : (account.filter ?? "all");
			return f === "inherit" ? "all" : f;
		};
		return {
			mode: accountPaused || localPaused ? "off" : resolveMode(),
			filter: resolveFilter(),
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
