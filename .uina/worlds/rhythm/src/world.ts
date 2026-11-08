import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorldDef, ServiceCompanionContext } from "../../../../src/extensions/world-framework/types.js";
import { writeJsonAtomic } from "../../../../src/extensions/world-framework/json-file.js";
import { worldFailed, worldNotStarted, worldSucceeded } from "../../../../src/extensions/world-framework/result.js";
import { RhythmEngine } from "./engine.js";
import { durationText, recoverPhrase, reminderCountPhrase, reminderLine, rhythmLine, statusBlock } from "./format.js";
import type { RhythmDurableState, RhythmGuardrails, RhythmReminder } from "./types.js";

/**
 * World 输入 ID 会直接进入持久化会话记录，必须跨进程重启与扩展重载保持唯一。
 * 事件 type 串（pacing-opportunity / reminder-due）是历史会话里的既成事实，保持不变。
 */
export function createPacingOpportunityId(): string {
	return `pacing-opportunity:${randomUUID()}`;
}

export function createReminderDueId(): string {
	return `reminder-due:${randomUUID()}`;
}

function reminderSequence(reminderRef: string): number {
	const match = /^r([1-9]\d*)$/.exec(reminderRef);
	const sequence = match ? Number(match[1]) : NaN;
	if (!Number.isSafeInteger(sequence)) throw new Error("Rhythm 提醒引用无效");
	return sequence;
}

function parseReminders(value: unknown): RhythmReminder[] {
	if (!Array.isArray(value)) throw new Error("Rhythm 提醒状态无效");
	const seen = new Set<string>();
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Rhythm 提醒状态无效");
		const reminder = item as Record<string, unknown>;
		if (
			typeof reminder.reminderRef !== "string" ||
			typeof reminder.message !== "string" || reminder.message.trim().length === 0 ||
			!Number.isSafeInteger(reminder.dueAtEpochMs) || new Date(reminder.dueAtEpochMs as number).getTime() !== reminder.dueAtEpochMs
		) throw new Error("Rhythm 提醒状态无效");
		reminderSequence(reminder.reminderRef);
		if (seen.has(reminder.reminderRef)) throw new Error("Rhythm 提醒引用重复");
		seen.add(reminder.reminderRef);
		return {
			reminderRef: reminder.reminderRef,
			message: reminder.message,
			dueAtEpochMs: reminder.dueAtEpochMs as number,
		};
	});
}

async function loadState(filePath: string): Promise<RhythmDurableState | undefined> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const data: unknown = JSON.parse(raw);
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Rhythm 状态格式无效");
	const state = data as Record<string, unknown>;
	const usage = state.dailyAttempts;
	if (!Number.isFinite(state.baseIntervalMs) || (state.baseIntervalMs as number) < 60_000 || (state.baseIntervalMs as number) > 120 * 60_000) throw new Error("Rhythm 周期状态无效");
	if (state.pausedUntilEpochMs !== null && (!Number.isSafeInteger(state.pausedUntilEpochMs) || (state.pausedUntilEpochMs as number) < 0)) throw new Error("Rhythm 静默截止时间无效");
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Rhythm 用量状态无效");
	const attempts = usage as Record<string, unknown>;
	if (typeof attempts.date !== "string" || new Date(attempts.date).toDateString() !== attempts.date || !Number.isSafeInteger(attempts.count) || (attempts.count as number) < 0) throw new Error("Rhythm 用量状态无效");
	const reminders = state.reminders === undefined ? [] : parseReminders(state.reminders);
	const minimumSequence = reminders.reduce((max, reminder) => Math.max(max, reminderSequence(reminder.reminderRef)), 0) + 1;
	const nextReminderSequence = state.nextReminderSequence === undefined ? minimumSequence : state.nextReminderSequence;
	if (!Number.isSafeInteger(nextReminderSequence) || (nextReminderSequence as number) < minimumSequence || (nextReminderSequence as number) < 1) throw new Error("Rhythm 下一个提醒引用序号无效");
	return {
		baseIntervalMs: state.baseIntervalMs as number,
		pausedUntilEpochMs: state.pausedUntilEpochMs as number | null,
		dailyAttempts: { date: attempts.date, count: attempts.count as number },
		reminders,
		nextReminderSequence: nextReminderSequence as number,
	};
}

/** 宿主护栏文件；缺失即无上限，并在状态展示中如实呈现。 */
async function loadGuardrails(filePath: string): Promise<RhythmGuardrails> {
	try {
		const data = JSON.parse(await readFile(filePath, "utf8")) as { maxDailyAttempts?: unknown };
		return { maxDailyAttempts: typeof data.maxDailyAttempts === "number" && Number.isFinite(data.maxDailyAttempts) && data.maxDailyAttempts > 0 ? data.maxDailyAttempts : null };
	} catch (error) {
		if (error instanceof SyntaxError || (error instanceof Error && /ENOENT/.test(error.message))) return { maxDailyAttempts: null };
		throw error;
	}
}

function hasRepresentableDeadline(afterSeconds: number): boolean {
	const dueAtEpochMs = Date.now() + afterSeconds * 1000;
	return Number.isSafeInteger(dueAtEpochMs) && new Date(dueAtEpochMs).getTime() === dueAtEpochMs;
}

export function createRhythmWorld(): WorldDef {
	let engine: RhythmEngine | null = null;
	let unbind: (() => void) | null = null;

	const teardown = async () => {
		unbind?.();
		unbind = null;
		const previousEngine = engine;
		engine = null;
		await previousEngine?.stop();
	};
	const world: WorldDef = {
		name: "rhythm",
		description:
			"你的节拍与提醒。节拍是你周期到来的自主时刻——那时你会收到一条“自主节拍”，用它决定留意什么、做什么，或只是继续待着；安静得越久，节拍自动越慢，你在忙时它会避让。提醒是你给自己记的一次性念想，到点原文送回给你。当前节奏如何、下次何时醒来，看 status。",
		// 写路径全部是持久状态变更，显式串行避免并发调用在持久化完成顺序上互踩。
		executionMode: "sequential",
		defaultState: { enabled: false },
		async onStart(ctx: ServiceCompanionContext) {
			await teardown();
			// 状态是持久数据，必须落在宿主数据目录；缺失时明确失败而不是写进源码安装目录。
			if (!ctx.worldDataDir) throw new Error("[rhythm] 缺少 worldDataDir，无法持久化节拍状态");
			const stateFile = join(ctx.worldDataDir, "state.json");
			const [initial, guardrails] = await Promise.all([
				loadState(stateFile),
				loadGuardrails(join(ctx.worldDataDir, "config.json")),
			]);
			const host = {
				isBusy: () => ctx.isBusy?.() ?? false,
				submitOpportunity: async (text: string) => {
					if (!ctx.emitEvent) throw new Error("宿主未提供 emitEvent");
					const result = await ctx.emitEvent({
						id: createPacingOpportunityId(),
						type: "pacing-opportunity",
						channel: "world",
						delivery: "queued",
						origin: "internal",
						text,
					});
					if (!result.accepted) throw new Error(result.reason);
				},
				submitReminder: async (reminder: RhythmReminder) => {
					if (ctx.signal.aborted) throw new Error("Rhythm 世界已停用，提醒仍待投递");
					if (!ctx.emitEvent) throw new Error("宿主未提供 emitEvent");
					const result = await ctx.emitEvent({
						id: createReminderDueId(),
						type: "reminder-due",
						channel: "world",
						delivery: "queued",
						origin: "internal",
						text: `[提醒到期 ${reminder.reminderRef}]\n${reminder.message}`,
						data: { reminderRef: reminder.reminderRef, dueAtEpochMs: reminder.dueAtEpochMs },
					});
					if (!result.accepted) throw new Error(result.reason);
				},
				saveDurableState: (next: RhythmDurableState) => writeJsonAtomic(stateFile, next),
			};
			engine = new RhythmEngine(host, initial, guardrails);
			engine.start();
			unbind = ctx.onActivity?.((event) => engine?.notifyActivity(event)) ?? null;
		},
		async onStop() {
			await teardown();
		},
		actions: {
			status: {
				description: "查看你的现状：实际节拍多长、为什么是这个长度、下次醒来还有多久、有哪些提醒待触发。只读。",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				run() {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					const snapshot = engine.getStatus();
					const reminders = engine.listReminders();
					return worldSucceeded(statusBlock(snapshot, reminders, Date.now()), {
						...snapshot,
						reminders: reminders.map((reminder) => ({ ...reminder })),
					});
				},
			},
			set_interval: {
				description:
					"设定节拍的基准长度（分钟）。想多想事就调短，想安宁就调长。安静超过一定时长会自动比基准更慢，返回会告诉你实际生效的长度。",
				parameters: {
					type: "object",
					properties: { minutes: { type: "integer", minimum: 1, maximum: 120 } },
					required: ["minutes"],
					additionalProperties: false,
				},
				async run(args: Record<string, unknown>) {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					const minutes = args.minutes as number;
					try {
						await engine.setInterval(minutes);
					} catch (error) {
						return worldFailed("调整失败，基准周期未改变。", { reason: "interval_save_failed", error: error instanceof Error ? error.message : String(error) });
					}
					const snapshot = engine.getStatus();
					return worldSucceeded(
						`基准已设为 ${snapshot.baseIntervalMinutes} 分钟。\n${rhythmLine(snapshot)}`,
						{ ...snapshot },
						"applied",
					);
				},
			},
			pause: {
				description:
					"让节拍静默一段时间，到点自己恢复。期间不再推送自主节拍，但提醒照常到达。适合你连续做事、不想被节拍打断的时候。",
				parameters: {
					type: "object",
					properties: { minutes: { type: "number", minimum: 1 } },
					required: ["minutes"],
					additionalProperties: false,
				},
				async run(args: Record<string, unknown>) {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					const minutes = args.minutes as number;
					try {
						await engine.pause(minutes);
					} catch (error) {
						return worldFailed("静默失败，节拍仍在运行。", { reason: "pause_save_failed", error: error instanceof Error ? error.message : String(error) });
					}
					const snapshot = engine.getStatus();
					const reminders = engine.listReminders();
					const reminderNote = reminders.length
						? `期间提醒照常：${reminders.map((reminder) => `${reminder.reminderRef} ${durationText((reminder.dueAtEpochMs - Date.now()) / 1000)}`).join("、")}。`
						: "期间没有待触发的提醒。";
					return worldSucceeded(
						`节拍静默 ${minutes} 分钟，${recoverPhrase(snapshot.pausedRemainingSeconds)}。${reminderNote}`,
						{ ...snapshot, reminders: reminders.map((reminder) => ({ ...reminder })) },
						"applied",
					);
				},
			},
			resume: {
				description: "提前结束静默。恢复后很快会有一次节拍到达（补上静默欠你的那次），之后回到正常。",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				async run(_args: Record<string, unknown>) {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					if (!engine.getStatus().isPaused) {
						return worldSucceeded("你的节拍没有在静默中，无需恢复。");
					}
					try {
						await engine.resume();
					} catch (error) {
						return worldFailed("恢复失败，节拍仍在静默中。", { reason: "resume_save_failed", error: error instanceof Error ? error.message : String(error) });
					}
					const snapshot = engine.getStatus();
					return worldSucceeded(`静默已结束，一次节拍马上到达。\n${rhythmLine(snapshot)}`, { ...snapshot }, "applied");
				},
			},
			remind: {
				description:
					"记一件一次性的事，afterSeconds 秒后原文推送给你。不会自动执行它，只是送到你面前。也可以趁现在给之后的自己留一件事。",
				parameters: {
					type: "object",
					properties: {
						afterSeconds: { type: "integer", minimum: 1 },
						message: { type: "string", minLength: 1 },
					},
					required: ["afterSeconds", "message"],
					additionalProperties: false,
				},
				async run(args: Record<string, unknown>) {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					if (
						!Number.isSafeInteger(args.afterSeconds) || (args.afterSeconds as number) < 1 ||
						!hasRepresentableDeadline(args.afterSeconds as number) ||
						typeof args.message !== "string" || args.message.trim().length === 0
					) {
						return worldFailed("参数错误：afterSeconds 必须是至少 1 秒的正整数，message 不能为空。", { reason: "invalid_reminder" });
					}
					const afterSeconds = args.afterSeconds as number;
					let reminder: RhythmReminder;
					try {
						reminder = await engine.setReminder(afterSeconds, args.message as string);
					} catch (error) {
						return worldFailed("保存提醒失败，未记录。", { reason: "reminder_save_failed", error: error instanceof Error ? error.message : String(error) });
					}
					const reminders = engine.listReminders();
					return worldSucceeded(
						`已记下 ${reminder.reminderRef}：${durationText(afterSeconds)}原文送到你面前。${reminderCountPhrase(reminders)}。`,
						{
							reminderRef: reminder.reminderRef,
							afterSeconds,
							dueAt: new Date(reminder.dueAtEpochMs).toISOString(),
							dueAtEpochMs: reminder.dueAtEpochMs,
						},
						"applied",
					);
				},
			},
			cancel_reminder: {
				description: "按编号收回还没到达的提醒。已经到达或已排队的收不回，会如实告诉你。",
				parameters: {
					type: "object",
					properties: { reminderRef: { type: "string", pattern: "^r[1-9]\\d*$" } },
					required: ["reminderRef"],
					additionalProperties: false,
				},
				async run(args: Record<string, unknown>) {
					if (!engine) return worldNotStarted("你的节拍世界未启动。", { reason: "rhythm_not_started" });
					const reminderRef = args.reminderRef as string;
					if (typeof reminderRef !== "string" || !/^r[1-9]\d*$/.test(reminderRef)) {
						return worldFailed("参数错误：reminderRef 必须是形如 r1、r12 的提醒编号。", { reason: "invalid_reminder_ref" });
					}
					// 取消前先取内容，成功文案能复述收回的是什么。
					const known = engine.listReminders().find((reminder) => reminder.reminderRef === reminderRef);
					let status: "cancelled" | "not_found" | "already_due";
					try {
						status = await engine.cancelReminder(reminderRef);
					} catch (error) {
						return worldFailed("取消失败，提醒仍保留。", { reason: "reminder_save_failed", reminderRef, error: error instanceof Error ? error.message : String(error) });
					}
					if (status === "cancelled") {
						const reminders = engine.listReminders();
						const detail = known ? `（${reminderLine(known, Date.now())}）` : "";
						return worldSucceeded(`已收回提醒 ${reminderRef}${detail}。${reminderCountPhrase(reminders)}。`, { reminderRef }, "applied");
					}
					if (status === "already_due") {
						return worldFailed(`${reminderRef} 已到期排队，收不回——它会照常到达。`, { reason: "reminder_already_due", reminderRef });
					}
					return worldFailed(`没有待触发的提醒 ${reminderRef}。用 status 看看现在有哪些。`, { reason: "reminder_not_found", reminderRef });
				},
			},
		},
	};
	return world;
}

export const rhythmWorld = createRhythmWorld();
export default rhythmWorld;
