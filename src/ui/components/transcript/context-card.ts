import type { ImageContent } from "../../../core/content.js";
import { imageNotice } from "../../../core/content.js";
import type { InputSource } from "../../../core/types.js";
import { C, stripAnsi, visibleWidth } from "../../core/utils.js";
import { sanitizeRenderText } from "../../format.js";
import { fitLine, wrapLine } from "../../layout/fit.js";

/**
 * /prompt 检查卡数据（信息注入体系）：只描述两类事实——
 * - basis="prepared"：最近准备交给 Provider 的活动语义请求（可能尚无 Wire 摘要，
 *   不虚称"已发送成功"）；
 * - basis="preview"：按当前状态预测的预览（独立身份，纯读装配）。
 */
export interface PromptRequestCardData {
	kind: "prompt";
	id?: string;
	basis: "prepared" | "preview";
	/** prepared 时是活动请求的 requestId；preview 时是独立预览 id。 */
	requestId?: string;
	modelKey: string;
	systemPrompt: string;
	messageCount: number;
	toolCount: number;
	/** 预览请求携带测量；活动请求观察只携带装配事实，测量可能未获知。 */
	measurement?: { inputTokens: number; kind: "exact" | "approximate" };
	sources: readonly { owner: string; id: string; kind: string; status: string; reason?: string }[];
	/** Provider Wire 摘要（实际准备发送载荷）；Provider 未接入观察时缺省，不得伪造。 */
	wire?: { hash: string; bytes: number; messageCount?: number; toolCount?: number };
}

/** /prompt 的 Host 只读查询端口（UI 不直接 import Subject 或访问扩展 Registry）。 */
export interface PromptPort {
	/** 最近准备交给 Provider 的活动语义请求；无记录返回 undefined。 */
	requestObservation(): Promise<PromptRequestCardData | undefined>;
	/** 当前预览（纯读装配，未发送）。 */
	inspectRequest(): Promise<PromptRequestCardData>;
}

export interface ExternalContextCardData {
	kind: "external";
	inputId: string;
	source: InputSource;
	receivedAt: string;
	text: string;
	images?: readonly ImageContent[];
}

export type ContextCardData = PromptRequestCardData | ExternalContextCardData;

export class ContextCardComponent {
	private expanded = false;

	constructor(private readonly data: ContextCardData) {}

	toggle(): void {
		this.expanded = !this.expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	render(width: number): string[] {
		const boxWidth = Math.max(32, Math.min(width, 100));
		const innerWidth = Math.max(1, boxWidth - 6);
		const border = this.data.kind === "external" ? C.cyan : C.suggestion;
		const title =
			this.data.kind === "external" ? "◇ 外部注入" : this.data.basis === "prepared" ? "◆ 最近请求准备" : "◆ 当前预览";
		const state = this.data.kind === "external" ? this.externalTitle() : (this.data.requestId ?? "");
		const tag = ` ${title}${state ? ` · ${state}` : ""} `;
		const top = `  ${border}╭─${C.bold}${tag}${C.reset}${border}${"─".repeat(Math.max(2, boxWidth - visibleWidth(tag) - 5))}╮${C.reset}`;
		const rows = this.data.kind === "external" ? this.externalRows(innerWidth) : this.promptRows(innerWidth);
		const body = rows.map((row) => {
			const clipped = fitLine(stripAnsi(row), innerWidth);
			return `  ${border}│${C.reset} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${border}│${C.reset}`;
		});
		const bottom = `  ${border}╰${"─".repeat(Math.max(2, boxWidth - 4))}╯${C.reset}`;
		return [top, ...body, bottom];
	}

	private externalTitle(): string {
		const data = this.data as ExternalContextCardData;
		return `${data.source.type}${data.source.ref ? ` · ${data.source.ref}` : ""}`;
	}

	private promptRows(width: number): string[] {
		const data = this.data as PromptRequestCardData;
		const rows: string[] = [];
		rows.push(
			`${C.text}model ${C.reset}${data.modelKey} · ${C.text}${data.messageCount}${C.reset} 条语义消息 · ` +
				`${C.text}${data.toolCount}${C.reset} 个工具 · ` +
				(data.measurement
					? `估算 ${data.measurement.inputTokens} tokens（${data.measurement.kind === "exact" ? "精确" : "近似"}）`
					: "token 测量未获知"),
		);
		if (data.basis === "prepared") {
			rows.push(
				`  ${C.dim}这是最近准备交给 Provider 的语义请求；不证明已成功发送。可能早于扩展重载、回溯或模型切换。${C.reset}`,
			);
		} else {
			rows.push(`  ${C.dim}这是按当前状态预测的预览（未发送）。${C.reset}`);
		}
		const included = data.sources.filter((s) => s.status === "included");
		const others = data.sources.filter((s) => s.status !== "included");
		if (included.length === 0 && others.length === 0) rows.push(`  ${C.inactive}└─ 无 Context Source 贡献${C.reset}`);
		else {
			included.forEach((s, index) => {
				const branch = index === included.length - 1 && others.length === 0 ? "└─" : "├─";
				rows.push(`  ${C.suggestion}${branch}${C.reset} ${s.owner}/${s.id} · ${s.kind}`);
			});
			others.forEach((s, index) => {
				const branch = index === others.length - 1 ? "└─" : "├─";
				rows.push(
					`  ${C.inactive}${branch}${C.reset} ${s.owner}/${s.id} · ${s.status}${s.reason ? ` · ${s.reason}` : ""}`,
				);
			});
		}
		rows.push(
			data.wire
				? `  ${C.dim}Wire 摘要：${data.wire.hash.slice(0, 12)}… · ${data.wire.bytes} bytes${data.wire.messageCount !== undefined ? ` · ${data.wire.messageCount} msgs` : ""}${data.wire.toolCount !== undefined ? ` · ${data.wire.toolCount} tools` : ""}${C.reset}`
				: `  ${C.inactive}Wire 摘要：未提供${C.reset}`,
		);
		if (this.expanded) {
			rows.push(`${C.dim}系统提示词（System 段）${C.reset}`);
			for (const line of wrapLine(sanitizeRenderText(data.systemPrompt), Math.max(1, width - 2)))
				rows.push(`  ${C.dim}${line}${C.reset}`);
		}
		return rows;
	}

	private externalRows(width: number): string[] {
		const data = this.data as ExternalContextCardData;
		const rows = [
			`${C.text}来源${C.reset} ${data.source.kind}/${data.source.type}${data.source.ref ? ` · ${data.source.ref}` : ""}`,
			`${C.dim}${data.receivedAt}${C.reset}${this.expanded ? ` · ${C.dim}收起${C.reset}` : ""}`,
		];
		const text = sanitizeRenderText(data.text + imageNotice(data.images));
		const lines = wrapLine(text, Math.max(1, width - 2));
		if (this.expanded || lines.length <= 3) rows.push(...lines.map((line) => `  ${C.text}${line}${C.reset}`));
		else rows.push(`  ${C.text}${lines.slice(0, 3).join(" ")}…${C.reset}`);
		return rows;
	}
}
