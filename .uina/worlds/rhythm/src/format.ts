import type { RhythmReminder, RhythmStatusSnapshot } from "./types.js";

/**
 * 节奏文案的唯一事实源：status 块、写动作回显、自主节拍推送全部出自这里，禁止在别处复制措辞。
 * 措辞纪律：白话；只陈述快照里真实存在的事实；概念层以主体自身为参照（"安静""醒来"）。
 */

const SHANGHAI = "Asia/Shanghai";

/** 剩余时长 → "即将到来 / 约 N 秒/分钟/小时后"。 */
export function durationText(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s === 0) return "即将到来";
	if (s < 60) return `约 ${s} 秒后`;
	const minutes = Math.round(s / 60);
	if (minutes < 60) return `约 ${minutes} 分钟后`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `约 ${hours} 小时 ${rest} 分钟后` : `约 ${hours} 小时后`;
}

/** "…自动恢复"拼接专用：避开"即将到来自动恢复"病句。 */
export function recoverPhrase(seconds: number): string {
	const d = durationText(seconds);
	return d === "即将到来" ? "即将自动恢复" : `${d}自动恢复`;
}

/** 已经过的时长 → "不足 1 分钟 / 约 47 分钟 / 约 3 小时 5 分钟"。 */
function sinceText(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return "不足 1 分钟";
	const minutes = Math.round(s / 60);
	if (minutes < 60) return `约 ${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

function dateTimeText(epochMs: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: SHANGHAI,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(epochMs));
}

/** 触发时刻的钟点（HH:MM，北京时间）。 */
export function clockLabel(epochMs: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: SHANGHAI,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(epochMs));
}

/** 单条提醒行："r1 · 内容 · 2026-10-28 01:28（北京时间），约 40 分钟后"。 */
export function reminderLine(reminder: RhythmReminder, nowEpochMs: number): string {
	const remaining = Math.round((reminder.dueAtEpochMs - nowEpochMs) / 1000);
	const when = remaining > 0 ? durationText(remaining) : "已到期";
	return `${reminder.reminderRef} · ${reminder.message} · ${dateTimeText(reminder.dueAtEpochMs)}（北京时间），${when}`;
}

/** 实际节拍短语；退避生效时说明原因，相等时不啰嗦。 */
function pacePhrase(s: RhythmStatusSnapshot): string {
	if (s.effectiveIntervalMinutes === s.baseIntervalMinutes) {
		return `实际 ${s.baseIntervalMinutes} 分钟一次`;
	}
	return `实际 ${s.effectiveIntervalMinutes} 分钟一次（基准 ${s.baseIntervalMinutes} 分钟，安静自动放慢）`;
}

/** 一行"当前节奏"：写动作回显与自主节拍推送共用。 */
export function rhythmLine(s: RhythmStatusSnapshot): string {
	return `当前节奏：${pacePhrase(s)} · 下次自主节拍${durationText(s.nextPacingWakeInSeconds)}`;
}

/** 下次自主唤醒为何排在此刻的白话归因；正常时返回 null。status 与推送用。 */
export function describeNextWake(s: RhythmStatusSnapshot): string | null {
	switch (s.nextWakeReason) {
		case "paused":
			return `静默中，${recoverPhrase(s.pausedRemainingSeconds)}；期间提醒照常到期`;
		case "daily_limit":
			return `今日自主唤醒已达上限（${s.dailyAttemptsUsed}/${s.dailyAttemptsLimit}），1 小时后再试`;
		case "avoiding_busy":
			return "你正在处理事情，节拍避让中，稍后即到";
		case "avoiding_recent_input":
			return "刚有人说过话，30 秒避让期内，稍后即到";
		case "backoff":
			return `已安静 ${s.quietMinutes} 分钟，自动放慢到至少 ${s.effectiveIntervalMinutes} 分钟一次；外界有动静后会回落到基准`;
		case "normal":
			return null;
	}
}

/**
 * 自主节拍推送正文。首行自带头 [ ]，投影层据此免除机器前缀（event-frame 规则）。
 * 推送时点引擎已排好下一次唤醒，节奏行里的"下次"是从这次醒来算起的真实未来。
 */
export function opportunityText(s: RhythmStatusSnapshot, timeLabel: string): string {
	return [
		"[自主节拍]",
		`现在是 ${timeLabel}。距上次节拍到来${sinceText(s.secondsSinceLastWake)}。`,
		rhythmLine(s),
		"你可以留意世界、思考、行动，也可以只是待着。",
	].join("\n");
}

/** status 动作的完整多行块。提醒清单由调用方传入（快照不携带提醒）。 */
export function statusBlock(
	s: RhythmStatusSnapshot,
	reminders: readonly RhythmReminder[],
	nowEpochMs: number,
): string {
	const lines = [
		"你的节拍",
		`· ${s.isPaused ? "静默中" : "运行中"} · ${pacePhrase(s)}`,
	];
	const reason = describeNextWake(s);
	if (reason) lines.push(`· ${reason}`);
	if (s.nextWakeReason !== "paused") lines.push(`· 下次自主节拍${durationText(s.nextPacingWakeInSeconds)}`);
	lines.push(`· 今日已自主醒来 ${s.dailyAttemptsUsed} 次（上限：${s.dailyAttemptsLimit ?? "未设"}）`);
	if (reminders.length === 0) lines.push("· 没有待触发的提醒");
	else {
		lines.push(`· 待触发提醒 ${reminders.length} 件：`);
		for (const reminder of reminders) lines.push(`    ${reminderLine(reminder, nowEpochMs)}`);
	}
	return lines.join("\n");
}

/** 写动作回显里的提醒现状短句。 */
export function reminderCountPhrase(reminders: readonly RhythmReminder[]): string {
	if (reminders.length === 0) return "当前没有待触发的提醒";
	return `当前待触发提醒 ${reminders.length} 件：${reminders.map((reminder) => reminder.reminderRef).join("、")}`;
}
