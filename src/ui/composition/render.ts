/**
 * TUI Surface 的槽位行渲染：SlotContribution → 终端行。
 *
 * 中立层（presentation/composition/slots.ts）只产出贡献与回执；
 * 把贡献画成多少行、用什么颜色、如何截断，全部是本 Surface 的职责。
 */

import type { SlotContribution, SlotLevel } from "../../presentation/composition/slots.js";
import { C } from "../core/utils.js";
import { fitLine } from "../layout/fit.js";

/** toast 展示上限与队列容量一致；activity 并列上限 + “+N”。 */
export const TOAST_VISIBLE = 3;
export const ACTIVITY_VISIBLE = 3;

function toastColor(level: SlotLevel): string {
	return level === "error" ? C.error : level === "warning" ? C.warning : C.inactive;
}

/**
 * toast 队列 → 行（最多 TOAST_VISIBLE 条，最新的在最下）。
 * 复制回执（tone "copy"）保留品牌冰蓝；其余按级别上色。
 */
export function renderToastLines(toasts: readonly SlotContribution[], width: number): string[] {
	const visible = toasts.slice(0, TOAST_VISIBLE);
	const lines: string[] = [];
	for (const toast of visible) {
		const { payload } = toast;
		if (payload.kind === "notice" || payload.kind === "text") {
			const color =
				payload.kind === "text" && payload.tone === "copy" ? C.suggestion : toastColor(payload.level ?? "info");
			const fitted = fitLine(`${color}${payload.text}${C.reset}`, Math.max(0, width - 1));
			lines.push(fitted);
		}
	}
	return lines;
}

/** working 并列行（C6）：最多 ACTIVITY_VISIBLE 条，超出合并为“+N 项工作”。 */
export function renderActivityLines(activities: readonly SlotContribution[], width: number, now: number): string[] {
	const visible = activities.slice(0, ACTIVITY_VISIBLE);
	const hidden = activities.length - visible.length;
	const lines: string[] = [];
	for (const item of visible) {
		const { payload } = item;
		if (payload.kind !== "activity") continue;
		const elapsed =
			payload.startedAt === undefined ? undefined : Math.max(0, (now - payload.startedAt) / 1000).toFixed(1);
		const label = `${payload.label}${payload.detail ? `：${payload.detail}` : ""}`;
		const suffix = payload.startedAt === undefined ? "" : ` · ${elapsed}s`;
		const fitted = fitLine(`${C.inactive}⟳ ${label}${suffix}${C.reset}`, Math.max(0, width - 1));
		lines.push(fitted);
	}
	if (hidden > 0) {
		lines.push(fitLine(`${C.inactive}⟳ … 还有 ${hidden} 项工作${C.reset}`, Math.max(0, width - 1)));
	}
	return lines;
}
