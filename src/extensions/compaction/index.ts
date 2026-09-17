/**
 * 官方压缩 capability（P6a：manual 算法槽；P6b：自动压缩语义切换）。
 *
 * P6b 起自动压缩完全由本 capability 拥有，实现路径 = 执行稿 P6 行：
 *   transformContext 按 summary 裁剪当前请求上下文，阈值体检按裁剪后
 *   上下文估算。journal 不再被自动压缩截断——全量历史始终持久化，
 *   每个请求的 ChatMsg 流由无状态裁剪器收敛进窗口。
 *
 * 摘要对齐与 rewind-proof 的构造性保证：
 * - 滚动摘要覆盖生成时刻的 ChatMsg 流前缀 [0..coveredUpTo)；流坐标对
 *   前缀稳定（追加只发生在尾部），跨请求/跨回合可比较。
 * - 摘要锚定生成时的主线头 entry id：锚仍在主线（pi.history 的 id 集）
 *   = 前缀未被回溯切断 = 摘要仍有效；锚被放弃则结构性失效、重新生成。
 * - 裁剪边界与摘要覆盖在同一处理点用同一预算函数计算——覆盖不足时
 *   当场补生成（罕见路径，等价旧"回合内暴涨"压缩），构造上无未摘要间隙。
 * - 摘要持久化为 uina.compaction.summary custom entry（Auxiliary 数据，
 *   私有持久态），重启后从 pi.history() 重载。
 */
import { CHARS_PER_TOKEN } from "../../agent/context.js";
import { streamCompactor } from "../../agent/compaction.js";
import type { HydratedSessionEntry } from "../../session/types.js";
import type { RuntimeEvent } from "../../runtime/events.js";
import type { ExtensionAPI } from "../runner.js";

/** 摘要持久化的命名空间（数据模型原则：私有持久态走 custom entry）。 */
export const SUMMARY_ENTRY_TYPE = "uina.compaction.summary";

/** 触发阈值与目标窗口的保留量（对齐 DEFAULT_COMPACTION_SETTINGS.reserveTokens；
 * 同时吸收摘要消息本身的开销）。 */
const RESERVE_TOKENS = 16_384;

/** 滚动摘要的内存态（重启后由 journal 重载）。 */
interface RollingSummary {
	readonly summary: string;
	/** 生成时刻 ChatMsg 流中被摘要覆盖的前缀长度（流坐标，前缀稳定）。 */
	readonly coveredUpTo: number;
	/** 生成时的主线头 entry id；仍在主线 = 前缀未被回溯切断。 */
	readonly anchorId: string;
}

/** 裁剪器操作的最小消息视图：ChatMsg 与其 DeepReadonly 形态均可赋值。 */
interface StreamMessageView {
	readonly role: string;
	readonly content: string;
	readonly tool_call_id?: string;
	readonly tool_calls?: readonly { readonly name: string; readonly args?: unknown }[];
}

/** 请求级 token 估算（对齐 CHARS_PER_TOKEN 哲学：宁低勿高）。 */
export function estimateStreamTokens(messages: readonly StreamMessageView[]): number {
	let chars = 0;
	for (const msg of messages) {
		chars += msg.content.length;
		if (msg.tool_calls) {
			for (const call of msg.tool_calls) chars += call.name.length + JSON.stringify(call.args ?? {}).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 无状态裁剪边界：从尾部按预算保留，返回首个保留下标（= 被摘要前缀长度）。
 * 整流放得下返回 null。保护 leading system 消息；不把工具结果与其调用拆开
 * （边界落在 tool 结果或带调用的 assistant 上时向前越过硬边界）。
 */
export function findTrimBoundary(messages: readonly StreamMessageView[], budgetTokens: number): number | null {
	if (estimateStreamTokens(messages) <= budgetTokens) return null;
	let acc = 0;
	let keepFrom = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		const cost = estimateStreamTokens([messages[index] as StreamMessageView]);
		if (acc + cost > budgetTokens) {
			keepFrom = index + 1;
			break;
		}
		acc += cost;
		keepFrom = index;
	}
	// 硬边界推进：被保留的尾部不得以孤儿工具结果或"调用在界外"的消息开头。
	while (keepFrom < messages.length) {
		const msg = messages[keepFrom] as StreamMessageView;
		const hasCalls = msg.role === "assistant" && Boolean(msg.tool_calls?.length);
		if (msg.role !== "tool" && !hasCalls) break;
		keepFrom++;
	}
	// leading system 永不裁剪：边界最多退到第一条非 system 消息。
	while (keepFrom < messages.length && messages[keepFrom]?.role === "system") keepFrom++;
	if (keepFrom <= 0) return null;
	return keepFrom;
}

/** 裁剪后的请求流：leading system 原位保留，摘要紧随其后（与 convertToLlm 对
 * compactionSummary 的渲染同构），再接预算内尾部。 */
export function renderTrimmed<T extends StreamMessageView>(
	messages: readonly T[],
	boundary: number,
	summaries: readonly string[],
): (T | { role: "user"; content: string })[] {
	let systemEnd = 0;
	while (systemEnd < messages.length && messages[systemEnd]?.role === "system") systemEnd++;
	const summaryMessages = summaries.map((summary) => ({ role: "user" as const, content: `[历史摘要] ${summary}` }));
	return [...messages.slice(0, systemEnd), ...summaryMessages, ...messages.slice(boundary)];
}

function transcript(messages: readonly StreamMessageView[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "tool") {
			lines.push(`[工具结果 ${msg.tool_call_id}] ${msg.content}`);
			continue;
		}
		const calls = msg.tool_calls?.map((call) => `调用工具 ${call.name}(${JSON.stringify(call.args ?? {})})`).join("；");
		lines.push(calls ? `[${msg.role}] ${msg.content}${msg.content ? "\n" : ""}${calls}` : `[${msg.role}] ${msg.content}`);
	}
	return lines.join("\n");
}

/** 从 journal 的 custom entry 重载滚动摘要（取 seq 最新的一条）。 */
export function loadSummary(entries: readonly HydratedSessionEntry[]): RollingSummary | undefined {
	let latest: RollingSummary | undefined;
	for (const entry of entries) {
		if (entry.kind !== "custom_entry" || entry.customType !== SUMMARY_ENTRY_TYPE) continue;
		const data = entry.data as RollingSummary | undefined;
		if (data && typeof data.summary === "string" && typeof data.coveredUpTo === "number" && typeof data.anchorId === "string") {
			latest = { summary: data.summary, coveredUpTo: data.coveredUpTo, anchorId: data.anchorId };
		}
	}
	return latest;
}

export default function activateCompaction(pi: ExtensionAPI): void {
	// P6a：manual 压缩算法槽（Subject.compact 的算法来源；P6c manual 命令化时收口）。
	// pi.models.stream 会以 runtime provider hooks 覆盖 request.providerHooks：
	// streamCompactor 内部的占位 hooks 永远不会真正生效。
	pi.registerCompactor(streamCompactor((model, request, onDelta, signal) =>
		pi.models.stream(model, request, onDelta, signal),
	));

	let cached: RollingSummary | undefined;
	let reloaded = false;

	/** 覆盖目标 = 裁剪边界 + 余量（半个预算）：吸收回合内增长，避免逐请求重生成螺旋。 */
	const coverTargetFor = (messages: readonly StreamMessageView[], boundary: number, budgetTokens: number): number => {
		const margin = Math.floor(budgetTokens / 2);
		let acc = 0;
		let target = boundary;
		while (target < messages.length) {
			acc += estimateStreamTokens([messages[target] as StreamMessageView]);
			if (acc > margin) break;
			target++;
		}
		return target;
	};

	/** 摘要有效 = 锚仍在主线（前缀未被回溯切断）且覆盖 ⊇ 被裁剪前缀且未因回溯失配。 */
	const summaryValid = (summary: RollingSummary, entries: readonly HydratedSessionEntry[], boundary: number, streamLength: number): boolean =>
		entries.some((entry) => entry.id === summary.anchorId) && boundary <= summary.coveredUpTo && summary.coveredUpTo <= streamLength;

	pi.onHook("turn.transformContext", async (messages) => {
		const window = pi.models.current().contextWindow;
		// 未知窗口即未知，不伪造保护（对齐 shouldCompact 的哲学）。
		if (window === undefined) return undefined;
		// reserve 随窗口缩放（永不超窗口一半）：小窗口模型下 16k 保留量会吃掉全部预算。
		const budget = window - Math.min(RESERVE_TOKENS, Math.floor(window / 2));
		const tokensBefore = estimateStreamTokens(messages);
		if (tokensBefore <= budget) return undefined;
		const boundary = findTrimBoundary(messages, budget);
		// 单条超窗且无法安全切分：透传（与旧"切点落空即跳过"语义一致）。
		if (boundary === null) return undefined;

		const entries = pi.history();
		// 重启恢复：journal 里的滚动摘要只在本次激活内加载一次。
		if (!reloaded) {
			cached = loadSummary(entries);
			reloaded = true;
		}
		if (!cached || !summaryValid(cached, entries, boundary, messages.length)) {
			// 补生成：覆盖 [0..coverTarget) ⊇ [0..boundary)——裁剪与摘要在同一处理点
			// 对齐，无未摘要间隙；余量吸收回合内增长（阈值体检按裁剪后上下文估算）。
			const anchorId = entries.at(-1)?.id;
			if (!anchorId) return undefined;
			const coverTarget = coverTargetFor(messages, boundary, budget);
			const summary = await requestSummary(pi, messages.slice(0, coverTarget));
			if (!summary) return undefined;
			cached = { summary, coveredUpTo: coverTarget, anchorId };
			await pi.appendEntry({ customType: SUMMARY_ENTRY_TYPE, data: { summary, coveredUpTo: coverTarget, anchorId } });
			const event: RuntimeEvent = {
				type: "session_compact",
				summary,
				tokensBefore,
				retainedTailCount: messages.length - boundary,
			};
			await pi.emitEvent(event);
		}
		return { messages: renderTrimmed(messages, boundary, [cached.summary]) };
	});
}

/** 请求级摘要生成：摘要"模型实际看到的内容"（请求消息流），经 pi.models.stream。 */
async function requestSummary(pi: ExtensionAPI, dropped: readonly StreamMessageView[]): Promise<string | undefined> {
	const model = pi.models.current();
	let summary = "";
	const signal = pi.signal;
	await pi.models.stream(
		model,
		{
			messages: [
				{ role: "system", content: "你是上下文摘要助手。把对话历史压缩成一份保留关键事实、决定与未竟事项的摘要，供后续对话作为唯一前情参考。直接输出摘要正文。" },
				{ role: "user", content: transcript(dropped) },
			],
			tools: [],
		},
		(delta) => {
			if (delta.kind === "text") summary += delta.text;
		},
		signal,
	);
	const trimmed = summary.trim();
	return trimmed || undefined;
}
