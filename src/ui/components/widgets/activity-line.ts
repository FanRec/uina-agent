/**
 * 实时工作状态行组件（复刻 dsh-TUI ActivityLine.tsx 与 shimmer.ts）。
 * 特性：
 * 1. 冰蓝流光扫光（Shimmer Sweep）动态渐变效果；
 * 2. 动态旋转 Spinner 帧（⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏）；
 * 3. 实时耗时统计与 TPS 计算；
 * 4. 支持独立行输出与嵌入圆角盒顶边框（getHeaderString）。
 */

import type { Component } from "../../core/types.js";
import { C, charWidth, truncateToWidth, visibleWidth } from "../../core/utils.js";
import type { QueuedMessage } from "../../../agent/queue.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 流式过程中把字符数折算成 token 的兜底系数。
 *
 * 只在服务端还没报回 output 的那一段生效；真值一到就取代它所在的那段估算。
 *
 * 取值 4 是实测出来的，不是拍的：真机 trace 里 7 个跨结算窗口的 估算/真值 比值为
 * 1.29 / 1.52 / 0.99 / 1.33 / 1.28 / 1.14 / 1.32（中位 1.29），折算回来约 3.86 字符/token。
 * 原先取 3 会让实时读数高三成（实测：显示值比真值高约 29%）。
 *
 * 与 agent/context.ts 的 CHARS_PER_TOKEN (=4) 数值相同，但目的不同：一个管上下文
 * 压缩阈值，一个只补实时显示的空档。它是语料相关的常数 —— 若哪天真在纯中文长文里
 * 生成（1 汉字 ≈ 1 token），这里会偏低，届时按上一批真实值自校准即可。
 */
export const STREAM_CHARS_PER_TOKEN = 4;


interface Rgb {
	r: number;
	g: number;
	b: number;
}

const ICE_RGB: Rgb = { r: 147, g: 190, b: 255 };
const FLASH_RGB: Rgb = { r: 240, g: 246, b: 255 };

function interpolateColor(a: Rgb, b: Rgb, factor: number): Rgb {
	const f = Math.max(0, Math.min(1, factor));
	return {
		r: Math.round(a.r + (b.r - a.r) * f),
		g: Math.round(a.g + (b.g - a.g) * f),
		b: Math.round(a.b + (b.b - a.b) * f),
	};
}

export function sweep(text: string, timeMs: number, base: Rgb = ICE_RGB, highlight: Rgb = FLASH_RGB, stepMs = 60): string {
	const width = visibleWidth(text);
	const cycle = width + 18;
	const glimmerStart = (Math.floor(timeMs / stepMs) % cycle) - 8;

	let out = "";
	let col = 0;
	let lastColor = "";

	for (const char of text) {
		const w = charWidth(char);
		const highlighted = col >= glimmerStart && col + w <= glimmerStart + 8;
		const opacity = highlighted ? (Math.sin(timeMs / (stepMs * 2)) + 1) / 2 : 0;
		const rgb = highlighted ? interpolateColor(base, highlight, opacity) : base;
		const colorKey = `${rgb.r};${rgb.g};${rgb.b}`;

		if (colorKey !== lastColor) {
			out += `\x1b[38;2;${colorKey}m\x1b[1m`;
			lastColor = colorKey;
		}
		out += char;
		col += w;
	}

	if (lastColor) {
		out += "\x1b[0m";
	}
	return out;
}

export type ActivityPhase = "idle" | "thinking" | "streaming" | "tool" | "done";

/** 表盘量程地板：低于它的峰值会被抬到此处，避免小样本把表盘放得过大。 */
const GAUGE_FLOOR = 40;
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const VBLOCKS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const TRACK = "·";

/**
 * 实时 1/8 字符水平仪表盘：`▕██████▋···▏`
 * 依据当前速率 tps 相对于 targetPeak 映射，并按速度区间着色（≥50 绿、≥20 黄、<20 红）。
 */
export function formatTpsGauge(tps: number, targetPeak = 60, gaugeWidth = 8): string {
	if (gaugeWidth <= 0) return "";
	const safeTps = Math.max(0, tps);
	// 量程按采样峰值自适应（地板 40）：写死峰值会让"超过峰值"的一切都画成满格，
	// 表盘就失去了区分度。dsh-tui 的 renderTpsGauge 用 max(peak, floor) 同理。
	const ratio = Math.min(1, safeTps / Math.max(GAUGE_FLOOR, targetPeak));
	const eighths = Math.round(ratio * gaugeWidth * 8);
	const full = Math.floor(eighths / 8);
	const rem = eighths % 8;

	let fill = "█".repeat(Math.min(full, gaugeWidth));
	if (full < gaugeWidth && rem > 0) {
		fill += HBLOCKS[rem]!;
	}
	const emptyLen = Math.max(0, gaugeWidth - visibleWidth(fill));
	const track = TRACK.repeat(emptyLen);

	const color = safeTps >= 50 ? C.green : safeTps >= 20 ? C.yellow : C.red;
	return `▕${color}${fill}${C.reset}${C.dim}${track}${C.reset}▏`;
}

/**
 * 垂直火花线趋势图：` ▂▃▅▆▇█`
 * 将历史速率采样数组归一化映射为 Unicode 柱状符号。
 */
export function formatTpsSparkline(samples: readonly number[]): string {
	if (!samples || samples.length === 0) return "";
	const valid = samples.map((s) => Math.max(0, s));
	const min = Math.min(...valid);
	const max = Math.max(...valid);
	const range = max - min;

	return valid
		.map((val) => {
			if (range <= 0) return VBLOCKS[3]!;
			const idx = Math.min(VBLOCKS.length - 1, Math.floor(((val - min) / range) * (VBLOCKS.length - 1)));
			return VBLOCKS[idx]!;
		})
		.join("");
}

export class ActivityLineComponent implements Component {
	private phase: ActivityPhase = "idle";
	private message = "";
	private startTime = 0;
	private elapsedMs = 0;

	/** 上一个真值到达之后新产生的字符折算出的 token 估算数（真值覆盖它时清零）。 */
	private spanEstimateTokens = 0;

	/**
	 * 当前解码跨度的左端（首个 token 到达时刻）；0 表示没有正在进行的解码。
	 *
	 * 一个「step」= 一次模型调用 + 它触发的工具执行。速度的分母只累加每个 step 的
	 * 「首个 token → 末个 token」跨度，工具执行时间不计入：工具跑 8 秒、生成 2 秒，
	 * 若把工具时间算进分母，显示的速度就只有真值的 1/5。
	 *
	 * 左端只取「首个 delta 到达的时刻」，量的是纯解码速度：TTFT（组装上下文 + 网络 +
	 * 服务端预热）与尾部静默都不在分母里。这两段都确实不是模型在吐字的时间，把它们
	 * 算进分母会让短调用被摊薄到几十 tps —— 那回答的是「本轮平均吞吐」，不是解码速度。
	 *
	 * 代价（已知且接受）：服务端报回的 completion_tokens 含不以 text/thinking delta
	 * 到达的内容（首要是工具调用参数），这部分只在分子里、没有对应的生成时间，所以纯
	 * 工具调用轮次的读数会偏高；真机实测不开思考时约 700 tps。要根除它，只能等协议
	 * 给出增量 token 数 —— 当前 API 只在收尾时报一次 usage，流式期间没有任何真值可用。
	 */
	private decodeStartTime = 0;
	/**
	 * 最近一个输出 token 到达的墙钟时刻，也就是当前跨度的右端。
	 *
	 * 不用渲染时刻当右端：两次 token 之间分母会继续涨而分子不动，显示出来的速度就会
	 * 一路往下掉（"一开始很快、越跑越慢"的假象）。dsh-TUI 的实时值同样以 token 事件
	 * 自身的时间戳为右端 —— elapsedMs = event.time - step.firstTokenTime。
	 */
	private lastTokenTime = 0;
	/** 本回合已封存的解码跨度总和（毫秒）。 */
	private decodeMsAccum = 0;
	/**
	 * 本回合**已结算**调用报回的真实输出 token 累计（不含当前正在进行的这次调用）。
	 */
	private realOutputTokens = 0;
	/**
	 * 当前模型调用的标识。服务端会在同一次调用进行中反复推送"累积快照"（同一个
	 * output 值发多次），所以必须按调用记账：同 id 覆盖、换 id 才结算，绝不能每条
	 * usage_update 都累加——那会把一个调用的输出按推送次数重复计。
	 */
	private currentCallId = "";
	/** 当前这次调用最近一次报回的真实输出 token（同一调用的多次推送取最后一次）。 */
	private currentCallTokens = 0;

	/** 每回合一个速度采样，跨回合保留（结束后的火花线取最近若干个回合）。 */
	private tpsSamples: number[] = [];

	/** 自上次结算以来是否封存过跨度：只有占过跨度的真值才进分子。 */
	private pendingSpanSinceSettle = false;

	start(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
		this.startTime = Date.now();
		this.spanEstimateTokens = 0;
		this.elapsedMs = 0;
		this.decodeStartTime = 0;
		this.lastTokenTime = 0;
		this.decodeMsAccum = 0;
		this.realOutputTokens = 0;
		this.currentCallId = "";
		this.currentCallTokens = 0;
		this.pendingSpanSinceSettle = false;
		// tpsSamples 不在这里清空：只留一个回合的历史，量程峰值就等于当前值，
		// 表盘每个回合都会从满格重新开始缩；跨回合保留才有参照物。
	}

	update(phase: ActivityPhase, message: string): void {
		this.phase = phase;
		this.message = message;
	}

	addTokens(count: number): void {
		this.spanEstimateTokens += count;
		const now = Date.now();
		this.lastTokenTime = now;
		if (this.decodeStartTime === 0) this.decodeStartTime = now;
	}

	/**
	 * 封存当前解码跨度。模型调用结束（进入工具执行）或回合结束时调用。
	 *
	 * 工具执行期间不会再封存，于是工具耗时落不进分母；下一个 token 到达时会开启
	 * 一个新跨度。dsh-TUI 对应 tpsTurnDecodeMs += 首token→message 的跨度。
	 */
	sealDecodeSpan(): void {
		if (this.decodeStartTime <= 0) return;
		this.decodeMsAccum += Math.max(0, this.lastTokenTime - this.decodeStartTime);
		this.decodeStartTime = 0;
		this.pendingSpanSinceSettle = true;
	}

	finish(summary = "本轮已完成", elapsedOverride?: number, tokensOverride?: number): void {
		this.sealDecodeSpan();
		// 最后一个调用没有下一个 callId 来触发换账，在这里补结算，判据与中途一致。
		this.settleCurrentCall();
		this.phase = "done";
		// 字符估算只在没有任何真实值时兜底，避免真实值与估算被计两次。
		if (tokensOverride !== undefined && tokensOverride > 0 && this.realOutputTokens + this.currentCallTokens === 0) {
			this.spanEstimateTokens = tokensOverride;
		}
		if (elapsedOverride !== undefined && elapsedOverride > 0) {
			this.elapsedMs = elapsedOverride;
		} else if (this.startTime > 0) {
			this.elapsedMs = Math.max(0, Date.now() - this.startTime);
		} else {
			this.elapsedMs = 0;
		}
		this.message = summary;
		// 回合级采样：结束后火花线用最近若干个回合的速度。
		const decodeMs = this.settledDecodeMs();
		const tokens = this.outputTokenCount();
		if (tokens > 0 && decodeMs > 0) {
			this.tpsSamples.push(Math.round(tokens / (decodeMs / 1000)));
			if (this.tpsSamples.length > 500) this.tpsSamples.shift();
		}
	}

	reset(): void {
		this.phase = "idle";
		this.message = "";
		this.startTime = 0;
		this.spanEstimateTokens = 0;
		this.elapsedMs = 0;
		this.decodeStartTime = 0;
		this.lastTokenTime = 0;
		this.decodeMsAccum = 0;
		this.realOutputTokens = 0;
		this.currentCallId = "";
		this.currentCallTokens = 0;
		this.pendingSpanSinceSettle = false;
	}

	getPhase(): ActivityPhase {
		return this.phase;
	}

	/**
	 * 记录一次模型调用报回的真实输出 token 数，按调用标识去重。
	 *
	 * 服务端的 output 是"本次调用"的 completion_tokens，但同一次调用会收到多条
	 * usage_update（累积快照，值可能一路增长），因此：同一个 callId 只取最后一次
	 * （覆盖），换 callId 时才把上一个调用的结果结算进 realOutputTokens。一个回合可以
	 * 有多轮调用（stream → tool → stream），各轮结算后才累加，计入这一轮的总速度。
	 * 真值到达时清空字符估算：它覆盖的正是这次调用已经吐出的那段字符，真值权威更高，
	 * 两者不能并存。清空同时也是边界标记 —— 此后新到达的字符重新从零累计。
	 */
	addRealOutputTokens(callId: string, tokens: number): void {
		if (tokens <= 0) return;
		if (callId !== this.currentCallId) {
			// 换调用：把上一个调用的最终值结进累计，再开新账。
			this.settleCurrentCall();
			this.currentCallId = callId;
		}
		this.currentCallTokens = tokens;
		this.spanEstimateTokens = 0;
	}

	/**
	 * 结算当前调用：只有自上次结算以来封存过跨度（这次调用确实产生过 token 增量）时，
	 * 它的真值才进分子。
	 *
	 * 分子按调用累计、分母按跨度累计，两者触发点不同步：真值无条件进分子就会出现
	 * "有输出量、没有对应生成时间"的白送。真机实测：某次调用报回 175 / 820 个
	 * output，期间一个 token 增量都没有（整轮输出都是工具调用参数），跨度为 0，
	 * 于是一路读到 2092 tokens / 2.32s = 902 tps 的虚高读数。
	 * 口径 A：无跨度的真值不进分子、也不进分母 —— 代价是纯工具调用轮次的输出量
	 * 不出现在读数里。
	 */
	private settleCurrentCall(): void {
		if (this.pendingSpanSinceSettle) this.realOutputTokens += this.currentCallTokens;
		this.currentCallTokens = 0;
		this.pendingSpanSinceSettle = false;
	}

	/**
	 * 速度分子：已结算调用的真实值 + 当前调用最近一次的真实值 + 当前跨度内还没被真值
	 * 覆盖的字符估算。
	 *
	 * 三项相加不会重复计数：服务端每次调用只在收尾时报一次 output（实测每个 callId 只
	 * 报一个恒定值，并不存在想像中的同一调用内多值递增快照），所以 spanEstimateTokens
	 * 攒下的总是上一个真值之后新产生的字符，与任何已计入的真值都不重叠。
	 *
	 * 此前写成 real > 0 ? real : spanEstimateTokens —— 只要有过一次真值就永久丢弃估算，
	 * 于是当前这次调用吐出的 token 全都不进分子、而分母照涨，读数一路往下掉
	 * （真机实测：模型正以约 350 tps 输出，显示值却从 297 单调跌到 75）。
	 */
	private outputTokenCount(): number {
		// 当前调用的真值同样只在它占着跨度时才算：没有跨度的输出量没有分母可除。
		const current = this.pendingSpanSinceSettle || this.decodeStartTime > 0 ? this.currentCallTokens : 0;
		return this.realOutputTokens + current + this.spanEstimateTokens;
	}

	/**
	 * 解码耗时（毫秒）：已封存跨度 + 当前正在进行的跨度。
	 *
	 * 当前跨度以「最近一个 token 的时刻」为右端，所以没有新 token 时这个值不变，
	 * 显示的速度也就不会自己往下掉。
	 */
	private decodeMs(): number {
		if (this.decodeStartTime > 0) {
			const end = Math.max(this.lastTokenTime, this.decodeStartTime);
			return this.decodeMsAccum + Math.max(0, end - this.decodeStartTime);
		}
		return this.decodeMsAccum;
	}

	/** 结束态的解码耗时：实测跨度优先，一次都没测到才退回墙钟。 */
	private settledDecodeMs(): number {
		return this.decodeMsAccum > 0 ? this.decodeMsAccum : this.elapsedMs;
	}

	/** 提取适用于圆角盒顶边框嵌入的状态文本 */
	getHeaderString(maxWidth = 60): string {
		if (this.phase === "idle") return "";
		const now = Date.now();
		// "耗时"展示整个回合的墙钟时间（含工具执行），这是用户感知的总时长。
		const currentElapsed = this.phase === "done" ? this.elapsedMs : (this.startTime > 0 ? now - this.startTime : 0);
		const seconds = (Math.max(0, currentElapsed) / 1000).toFixed(1);
		const tokens = this.outputTokenCount();

		if (this.phase === "done") {
			const prefix = `${C.green}✓${C.reset}`;
			let sparkStr = "";
			// tps 的分母是解码耗时而非墙钟耗时：工具执行不该稀释生成速度。
			const decodeMs = this.settledDecodeMs();
			if (tokens > 0 && decodeMs > 0) {
				const avgTps = Math.round(tokens / (decodeMs / 1000));
				// 火花线取最近 12 个回合（dsh-TUI 同为 slice(-12)）。
				const spark = formatTpsSparkline(this.tpsSamples.slice(-12));
				const sparkColor = avgTps >= 50 ? C.green : avgTps >= 20 ? C.yellow : C.red;
				sparkStr = spark ? ` · ${sparkColor}${spark}${C.reset} ~${avgTps} tps` : ` · ~${avgTps} tps`;
			}
			const text = `${C.gray}${this.message} · 耗时 ${seconds}s${tokens > 0 ? ` · ~${tokens} tokens` : ""}${sparkStr}${C.reset}`;
			return truncateToWidth(`${prefix} ${text}`, maxWidth);
		}

		const frameIdx = Math.floor(now / 80) % SPINNER_FRAMES.length;
		const spinner = `${C.iceBlue}${SPINNER_FRAMES[frameIdx]}${C.reset}`;
		let tpsStr = "";
		// 分母由 token 到达时刻推算：没有新 token 时分子分母一起停住，不会因为
		// 分母空转而显示成"越来越慢"。dsh-TUI 的门控同为 elapsed > 500ms。
		const decodeMs = this.decodeMs();
		if (tokens > 0 && decodeMs > 500) {
			const tps = Math.round(tokens / (decodeMs / 1000));
			// 量程随采样峰值缩放（地板 40），柱状图才不会长期满格。
			const peak = Math.max(tps, ...this.tpsSamples, 0);
			const gauge = formatTpsGauge(tps, peak, 8);
			tpsStr = ` · ${gauge} ~${tps} tps`;
		}

		const shimmerText = sweep(this.message || "正在处理...", now, ICE_RGB, FLASH_RGB, 60);
		const suffix = `${C.gray} · ${seconds}s${tpsStr}${C.reset}`;

		return truncateToWidth(`${spinner} ${shimmerText}${suffix}`, maxWidth);
	}

	render(width: number): string[] {
		const str = this.getHeaderString(width);
		if (!str) return [];
		return [truncateToWidth(`  ${str}`, width)];
	}

	invalidate(): void {}
}

/* ------------------------------------------------------------------ */
/* 待办队列悬浮视窗组件                                                */
/* ------------------------------------------------------------------ */

export interface PendingQueueOptions {
	maxVisible?: number;
}

export class PendingQueueComponent {
	private items: readonly QueuedMessage[] = [];
	private readonly maxVisible: number;

	constructor(options: PendingQueueOptions = {}) {
		this.maxVisible = options.maxVisible ?? 3;
	}

	setItems(items: readonly QueuedMessage[]): void {
		this.items = items;
	}

	getItems(): readonly QueuedMessage[] {
		return this.items;
	}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const steerItems = this.items.filter((i) => i.mode === "steer");
		const followUpItems = this.items.filter((i) => i.mode === "followUp");
		const lines: string[] = [];

		const maxContentW = Math.max(4, width - 8);
		let renderedCount = 0;

		// 1. 渲染 Steer (插话)
		if (steerItems.length > 0) {
			const steerSuffix = steerItems.length > 1 ? ` (${steerItems.length} 条待办)` : "";
			lines.push(`  ${C.suggestion}◆ (Steer)${C.reset} ${C.inactive}· 下一步送达${steerSuffix}${C.reset}`);
			for (const item of steerItems) {
				if (renderedCount >= this.maxVisible) break;
				const cleanText = item.text.replace(/[\r\n]+/g, " ").trim();
				const truncated = truncateToWidth(cleanText, maxContentW);
				lines.push(`    ${C.subtle}↳${C.reset} ${C.text}${truncated}${C.reset}`);
				renderedCount++;
			}
		}

		// 2. 渲染 Follow-up (排队)
		if (followUpItems.length > 0) {
			const countSuffix = followUpItems.length > 1 ? ` (${followUpItems.length} 条待办)` : "";
			lines.push(`  ${C.inactive}◇ (Follow-up)${C.reset} ${C.inactive}· 本轮结束后送达${countSuffix}${C.reset}`);
			for (const item of followUpItems) {
				if (renderedCount >= this.maxVisible) break;
				const cleanText = item.text.replace(/[\r\n]+/g, " ").trim();
				const truncated = truncateToWidth(cleanText, maxContentW);
				lines.push(`    ${C.subtle}↳${C.reset} ${C.text}${truncated}${C.reset}`);
				renderedCount++;
			}
		}

		// 3. 超出最大显示预算折叠
		const remaining = this.items.length - renderedCount;
		if (remaining > 0) {
			lines.push(`    ${C.subtle}↳${C.reset} ${C.inactive}...另有 ${remaining} 条待办已排队${C.reset}`);
		}

		// 4. 操作指引行
		lines.push(`  ${C.subtle}↳ Alt+↑ 撤回 · Esc 打断并发送 · Ctrl+Enter 插队${C.reset}`);

		return lines.map((l) => truncateToWidth(l, width));
	}
}

