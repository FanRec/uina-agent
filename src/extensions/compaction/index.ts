/**
 * 官方压缩 capability（P6a 算法下沉；P6b 自动压缩语义切换；P6c 端到端收口）。
 *
 * 本 capability 是上下文窗口管理的唯一入口（L1 一语义一入口）：自动压缩与
 * 手动 /compact 都收敛到同一个 transformContext 裁剪点——按 summary 裁剪
 * 当前请求上下文，journal 不再被任何压缩路径截断，全量历史始终持久化，
 * 每个请求的 ChatMsg 流由无状态裁剪器收敛进窗口。
 *
 * 手动 /compact = force 标志：跳过预算早退，按下一次请求的 transformContext
 * 强制裁剪（保留 keepRecent 尾部）。没有下一个请求就没有压缩对象——压缩
 * 本就是请求上下文的操作，语义自洽。
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
import type { HydratedSessionEntry } from "../../session/types.js";
import type { RuntimeEvent } from "../../runtime/events.js";
import type { ExtensionAPI } from "../runner.js";

/** 摘要持久化的命名空间（数据模型原则：私有持久态走 custom entry）。 */
const SUMMARY_ENTRY_TYPE = "uina.compaction.summary";

/** 触发阈值与目标窗口的保留量（对齐旧 DEFAULT_COMPACTION_SETTINGS.reserveTokens；
 * 同时吸收摘要消息本身的开销）。 */
const RESERVE_TOKENS = 16_384;

/** 手动 /compact 的尾部保留量（对齐旧 DEFAULT_COMPACTION_SETTINGS.keepRecentTokens）。 */
const MANUAL_KEEP_TOKENS = 20_000;

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
function findTrimBoundary(messages: readonly StreamMessageView[], budgetTokens: number): number | null {
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
function renderTrimmed<T extends StreamMessageView>(
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

/** 从 auxiliary timeline 的私有 custom entry 重载滚动摘要（取 seq 最新的一条）。 */
function loadSummary(auxiliary: readonly { kind: string; customType?: string; data?: unknown; seq?: number }[]): RollingSummary | undefined {
	let latest: RollingSummary | undefined;
	for (const record of auxiliary) {
		if (record.kind !== "custom_entry" || record.customType !== SUMMARY_ENTRY_TYPE) continue;
		const data = record.data as RollingSummary | undefined;
		if (data && typeof data.summary === "string" && typeof data.coveredUpTo === "number" && typeof data.anchorId === "string") {
			latest = { summary: data.summary, coveredUpTo: data.coveredUpTo, anchorId: data.anchorId };
		}
	}
	return latest;
}

export default function activateCompaction(pi: ExtensionAPI): void {
	let cached: RollingSummary | undefined;
	let reloaded = false;
	/** /compact 的待生效请求：下一个 transformContext 强制裁剪。 */
	let force: { instruction?: string } | undefined;

	// P6c：手动压缩命令化——/compact 归 capability 端到端拥有（旧 pi.compact →
	// Subject.compact → canonical 截断链路整体退役）。只设标志不直接执行：
	// 压缩对象是"下一次请求的上下文"，没有下一个请求就没有压缩对象。
	pi.registerCommand({
		name: "compact",
		description: "压缩会话历史释放上下文空间",
		hasArgs: true,
		argumentHint: "[instruction]",
		handler: (arg) => {
			force = { instruction: arg || undefined };
			pi.ui.notify("已安排压缩：下一次请求时生效", "info", 2500);
		},
	});

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
		// 手动压缩优先受理：无论预算状态都强制走裁剪路径（跳过预算早退）。
		const forced = force;
		force = undefined;
		const window = pi.models.current().contextWindow;
		// 未知窗口即未知，不伪造保护；force 无从确定边界，一并透传。
		if (window === undefined) return undefined;
		// reserve 随窗口缩放（永不超窗口一半）：小窗口模型下 16k 保留量会吃掉全部预算。
		const budget = window - Math.min(RESERVE_TOKENS, Math.floor(window / 2));
		const tokensBefore = estimateStreamTokens(messages);
		const boundary = forced
			? findTrimBoundary(messages, MANUAL_KEEP_TOKENS)
			: tokensBefore <= budget
				? null
				: findTrimBoundary(messages, budget);
		if (boundary === null) {
			// 自动路径：整流在预算内，无事可做。强制路径：保留预算内整流放得下，
			// 没有可压缩的前缀——失败可见，与旧 manual "无需压缩" 提示同语义。
			if (forced) {
				await pi.emitEvent({ type: "session_compact_failed", error: "当前会话上下文无需压缩" });
			}
			return undefined;
		}

		const entries = pi.history();
		// 重启恢复：journal 里的滚动摘要只在本次激活内加载一次（私有状态走 auxiliary，
		// 与 canonical 主线分离——锚语义要求主线头 id 来自 history() 而非私有记录）。
		if (!reloaded) {
			cached = loadSummary(pi.auxiliary());
			reloaded = true;
		}
		if (!cached || !summaryValid(cached, entries, boundary, messages.length)) {
			// 补生成：覆盖 [0..coverTarget) ⊇ [0..boundary)——裁剪与摘要在同一处理点
			// 对齐，无未摘要间隙；余量吸收回合内增长（阈值体检按裁剪后上下文估算）。
			const anchorId = entries.at(-1)?.id;
			if (!anchorId) return undefined;
			const coverTarget = coverTargetFor(messages, boundary, budget);
			try {
				const summary = await requestSummary(pi, messages.slice(0, coverTarget), forced?.instruction);
				if (!summary) throw new Error("摘要生成返回空结果");
				cached = { summary, coveredUpTo: coverTarget, anchorId };
				await pi.appendEntry({ customType: SUMMARY_ENTRY_TYPE, data: { summary, coveredUpTo: coverTarget, anchorId } });
				const event: RuntimeEvent = {
					type: "session_compact",
					summary,
					tokensBefore,
					retainedTailCount: messages.length - boundary,
				};
				await pi.emitEvent(event);
			} catch (err) {
				// 强制路径失败必须可见（用户显式要求过）；自动路径静默——
				// 下一个请求自然重试，provider 层错误另有出口。
				if (forced) {
					await pi.emitEvent({ type: "session_compact_failed", error: String((err as Error).message ?? err) });
				}
				return undefined;
			}
		}
		return { messages: renderTrimmed(messages, boundary, [cached.summary]) };
	});
}

/** 请求级摘要生成：摘要"模型实际看到的内容"（请求消息流），经 pi.models.stream。 */
async function requestSummary(
	pi: ExtensionAPI,
	dropped: readonly StreamMessageView[],
	instruction?: string,
): Promise<string | undefined> {
	const model = pi.models.current();
	let summary = "";
	const signal = pi.signal;
	const focus = instruction?.trim() ? `\n\n额外关注：${instruction.trim()}` : "";
	await pi.models.stream(
		model,
		{
			messages: [
				{ role: "system", content: "你是上下文摘要助手。把对话历史压缩成一份保留关键事实、决定与未竟事项的摘要，供后续对话作为唯一前情参考。直接输出摘要正文。" },
				{ role: "user", content: transcript(dropped) + focus },
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
