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
 * 与 `agent/context.ts` 的 `CHARS_PER_TOKEN` (=4, 用于上下文压缩阈值) 刻意分开：
 * 这里只服务于"正在生成时的速度显示"，而速度的分母是实时窗口、且只要服务端报了
 * output 就立刻改用真实值，所以它只需要量级对得上，不需要和压缩口径一致。
 * 中文比英文更"贵"（一个汉字 ≈ 1 token，而非 4 字符），所以这个兜底会偏低——
 * 但只要真实值一到就会被覆盖，不会影响最终读数。
 */
export const STREAM_CHARS_PER_TOKEN = 3;

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

	/** 当前解码跨度内、尚未被真实值取代的字符估算 token 数。 */
	private spanEstimateTokens = 0;

	/**
	 * 当前解码跨度的起点（该跨度首个输出 token 的墙钟时刻）；0 表示没有正在进行的解码。
	 *
	 * 一个「step」= 一次模型调用 + 它触发的工具执行。速度的分母只累加每个 step 的
	 * 「首个 token → 调用结束」跨度，工具执行与每次请求的首 token 等待（TTFT）都不计入：
	 * 工具跑 8 秒、生成 2 秒，若把工具时间算进分母，显示的速度就只有真值的 1/5。
	 * 对齐 dsh-TUI channel.ts 的 tpsTurnDecodeMs —— "summing only first-token → message
	 * spans excludes tool execution and per-request TTFT from generation speed"。
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
		// 跨度内首个 token 到达时才开始计时：此前的等待是 TTFT，不是生成。
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
		// 右端取最近一个 token 的时刻，而非封存时刻：调用收尾到进入工具执行之间的
		// 调度空档不是生成时间。
		this.decodeMsAccum += Math.max(0, this.lastTokenTime - this.decodeStartTime);
		this.decodeStartTime = 0;
	}

	finish(summary = "本轮已完成", elapsedOverride?: number, tokensOverride?: number): void {
		this.sealDecodeSpan();
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
	 * 真实值一到就丢掉当前跨度里那份字符估算——估算（`chars / N`）对中文严重偏低，
	 * 只是真实值到达前的占位，两者绝不能相加。
	 */
	addRealOutputTokens(callId: string, tokens: number): void {
		if (tokens <= 0) return;
		if (callId !== this.currentCallId) {
			// 换调用：把上一个调用的最终值结进累计，再开新账。
			this.realOutputTokens += this.currentCallTokens;
			this.currentCallId = callId;
		}
		this.currentCallTokens = tokens;
		this.spanEstimateTokens = 0;
	}

	/**
	 * 速度分子：已结算调用的真实值 + 当前调用最近一次的真实值；两者都为空时才退回
	 * 字符估算。真实值到达后估算即作废，绝不与真实值相加。
	 */
	private outputTokenCount(): number {
		const real = this.realOutputTokens + this.currentCallTokens;
		return real > 0 ? real : this.spanEstimateTokens;
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

