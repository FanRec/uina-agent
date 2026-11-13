/**
 * Output Interpretation（通用输出表达机制）：模型 `content` 通道的受限标记协议
 * 唯一解释器。职责边界（docs/refactor/Uina-Expression-Speech-Refactor-Design.md §3/§4）：
 * 只做标签语法、流式解码、表达事件、原文区间与语法注册快照；不做 TTS、动作、
 * 网络请求、工具执行或展示策略。ExpressionEvent 是结构事实，不是行动命令。
 */

import type {
	ExpressionAnnotation,
	ExpressionEvent,
	ExpressionTagAnnotation,
	OutputTagRegistration,
	OutputTagSnapshot,
} from "../core/expression.js";

/** 未决标签前缀的处理上限：超过即按原文字面释放，不截断正常正文。 */
const MAX_TAG_HOLD_CHARS = 512;
/** 未闭合围栏残余行的保留上限：超过按字面文本释放（防无换行洪泛）。 */
const MAX_FENCE_TAIL_CHARS = 4096;

/**
 * 输出标签注册表：注册名在一个 Host 内唯一，重名拒绝并报告所有者；
 * 扩展卸载释放注册；每个 content stream 的 output_start 冻结其语法快照。
 */
export class OutputTagRegistry {
	private readonly entries = new Map<string, { tag: OutputTagRegistration; owner: string; isActive: () => boolean }>();

	register(owner: string, tag: OutputTagRegistration, isActive: () => boolean): () => void {
		const name = tag.name;
		if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
			throw new Error(`输出标签名不合法: "${name}"（扩展 ${owner}）`);
		}
		const existing = this.entries.get(name);
		if (existing && existing.isActive()) {
			throw new Error(`输出标签 "${name}" 已由 ${existing.owner} 注册，扩展 ${owner} 的注册被拒绝`);
		}
		if (tag.kind === "marker") {
			for (const [key, requirement] of Object.entries(tag.attributes ?? {})) {
				if (requirement !== "required-string" && requirement !== "optional-string") {
					throw new Error(`输出标签 "${name}" 的属性合同不合法: ${key}（扩展 ${owner}）`);
				}
			}
		}
		this.entries.set(name, { tag, owner, isActive });
		return () => {
			if (this.entries.get(name)?.owner === owner) this.entries.delete(name);
		};
	}

	/** 冻结当前注册快照：只含仍然活跃的注册；卸载后不延长失效注册的语法。 */
	snapshot(): OutputTagSnapshot {
		const snapshot = new Map<string, OutputTagRegistration>();
		for (const [name, entry] of this.entries) {
			if (!entry.isActive()) continue;
			snapshot.set(
				name,
				entry.tag.kind === "marker" && entry.tag.attributes
					? { name, kind: entry.tag.kind, attributes: { ...entry.tag.attributes } }
					: { name, kind: entry.tag.kind },
			);
		}
		return snapshot;
	}
}

/**
 * 单个 content stream 的流式表达解码器。
 *
 * 解析器可以短暂保留尚不能判定的 `<` 前缀、反引号和代码围栏分隔符；一旦可判定
 * 就及时输出，最终必须释放残余字面文本。标签与待识别前缀超过上限时退化为文本。
 * 规范化合并相邻同 scope 文本事件后，内容、顺序、区间及标签身份与分块方式无关。
 *
 * 实现为缓冲式前沿扫描：不可判定的残余留在 buffer 前端等待后续增量；执行过的
 * 标签不进入文本事件，其余一切（未识别标签、代码内容、围栏本身）按原文保留。
 */
export class ExpressionDecoder {
	private readonly streamId: string;
	private readonly tags: OutputTagSnapshot;
	private buffer = "";
	/** buffer 前端对应的完整原始 content 偏移。 */
	private bufferStart = 0;
	/** 最近一个已消费的原始字符（反斜杠转义判定用）。 */
	private prevRawChar = "";
	/** 当前打开的 Block（不嵌套：Block 内再次出现的同类起始标签是字面文本）。 */
	private block: { id: string; name: string } | null = null;
	private blockSeq = 0;
	/** 代码围栏：行首（至多三个前置空格）长度 ≥3 的连续反引号/波浪线开启。 */
	private fence: { char: string; length: number } | null = null;
	/** 行内代码：相同数量的反引号配对；0 表示不在行内代码中。 */
	private inlineTicks = 0;
	/** 行首状态：自上一个换行以来是否只有 ≤3 个空格。 */
	private lineSol = true;
	private lineIndent = 0;

	constructor(streamId: string, tags: OutputTagSnapshot) {
		this.streamId = streamId;
		this.tags = tags;
	}

	feed(chunk: string): readonly ExpressionEvent[] {
		this.buffer += chunk;
		const events: ExpressionEvent[] = [];
		/** 当前连续字面文本（自 runStart 起，尚未作为事件发出）。 */
		let run = "";
		let runStart = this.bufferStart;
		const flushRun = (): void => {
			if (run) {
				events.push(this.textEvent(run, runStart));
				run = "";
			}
		};
		for (;;) {
			const buffer = this.buffer;
			if (buffer.length === 0) break;
			// 1. 标签候选：仅在代码区域外。
			if (this.inlineTicks === 0 && !this.fence && buffer.startsWith("<")) {
				const end = findTagEnd(buffer);
				if (end === -1) {
					if (this.holdViable(buffer) && buffer.length <= MAX_TAG_HOLD_CHARS) break; // 等待更多增量
					// 不可行或超限：释放到下一个可能开启新候选的 `<`（或整段）。
					const later = buffer.indexOf("<", 1);
					const cut = later === -1 ? buffer.length : later;
					run += buffer.slice(0, cut);
					this.noteText(buffer.slice(0, cut));
					this.advance(cut);
					continue;
				}
				const candidate = buffer.slice(0, end + 1);
				if (candidate.length > MAX_TAG_HOLD_CHARS || !this.holdViable(candidate)) {
					// 完整形状但超限或不可行：整段按原文释放。
					run += candidate;
					this.noteText(candidate);
					this.advance(candidate.length);
					continue;
				}
				if (this.resolveCandidate(events, candidate, run, runStart)) {
					run = "";
					runStart = this.bufferStart;
				} else {
					// 完整形状但未通过合同：整段按原文释放为字面文本。
					run += candidate;
					this.noteText(candidate);
					this.advance(candidate.length);
				}
				continue;
			}
			// 2. 行内代码：等待恰好 N 个反引号的闭合 run；正文与闭合 run 都是字面文本。
			if (this.inlineTicks > 0) {
				const scan = scanInlineClose(buffer, this.inlineTicks);
				if (scan.kind === "wait") break;
				run += scan.text;
				this.noteText(scan.text);
				this.advance(scan.text.length);
				if (scan.kind === "closed") this.inlineTicks = 0;
				continue;
			}
			// 3. 代码围栏：按完整行推进，仅由同字符且长度不短于开头的行首围栏结束。
			if (this.fence) {
				const scan = scanFenceBody(buffer, this.fence);
				if (scan.kind === "wait") break;
				run += scan.text;
				this.noteText(scan.text);
				this.advance(scan.text.length);
				if (scan.closed) this.fence = null;
				continue;
			}
			// 4. 结构起点：反引号 run / 行首波浪线 run。
			const ch = buffer[0]!;
			if (ch === "`" || (ch === "~" && this.lineSol && this.lineIndent <= 3)) {
				const runLength = leadingRunLength(buffer, ch);
				if (runLength === buffer.length) break; // run 可能跨增量，等待补齐
				const atLineStart = this.lineSol && this.lineIndent <= 3;
				const text = buffer.slice(0, runLength);
				run += text;
				this.noteText(text);
				this.advance(runLength);
				if (runLength >= 3 && atLineStart) {
					// 行首围栏开启（fence 为 null 时才会走到这里；闭合在正文扫描中判定）。
					this.fence = { char: ch, length: runLength };
					continue;
				}
				if (ch === "`") {
					this.inlineTicks = runLength; // 行内代码：相同数量反引号配对
				}
				continue;
			}
			// 5. 普通字符：立即推进。
			run += ch;
			this.noteChar(ch);
			this.advance(1);
		}
		flushRun();
		return events;
	}

	/** finish 时释放残余字面文本并按 reason 隐式封口未闭合 Block。 */
	finish(reason: "completed" | "interrupted"): readonly ExpressionEvent[] {
		const events: ExpressionEvent[] = [];
		if (this.buffer) {
			events.push(this.textEvent(this.buffer, this.bufferStart));
			this.noteText(this.buffer);
			this.buffer = "";
		}
		if (this.block) {
			events.push({
				kind: "block_end",
				streamId: this.streamId,
				blockId: this.block.id,
				name: this.block.name,
				reason: reason === "completed" ? "ended" : "interrupted",
			});
			this.block = null;
		}
		this.inlineTicks = 0;
		this.fence = null;
		this.lineSol = true;
		this.lineIndent = 0;
		return events;
	}

	/** hold 是否仍可能成为某个注册标签的前缀（含等待 `>` 的完整名称状态）。 */
	private holdViable(text: string): boolean {
		if (text === "<") return true;
		if (!text.startsWith("<")) return false;
		const body = text.slice(1);
		const closing = body.startsWith("/");
		const namePart = closing ? body.slice(1) : body;
		for (const name of this.tags.keys()) {
			if (name.startsWith(namePart) || namePart.startsWith(name)) return true;
		}
		return false;
	}

	/** 候选按注册合同解析；成功时先冲刷前置字面文本再发出标签事件并消费候选。 */
	private resolveCandidate(events: ExpressionEvent[], candidate: string, run: string, runStart: number): boolean {
		const gt = candidate.length - 1;
		const body = candidate.slice(1, gt);
		const closing = body.startsWith("/");
		const inner = closing ? body.slice(1) : body;
		const charBefore = run ? run[run.length - 1]! : this.prevRawChar;
		const tagStart = this.bufferStart;
		for (const [name, tag] of this.tags) {
			if (closing) {
				if (tag.kind !== "block") continue;
				if (!new RegExp(`^${escapeRegExp(name)}\\s*$`).test(inner)) continue;
				if (this.block?.name !== name) continue; // 未配对/错位闭合是字面文本
				if (charBefore === "\\") continue; // 被反斜杠转义的标签按字面文本处理
				const blockId = this.block.id;
				const range = freezeRange(tagStart, tagStart + candidate.length);
				if (run) events.push(this.textEvent(run, runStart));
				this.consume(candidate);
				this.block = null;
				events.push({ kind: "block_end", streamId: this.streamId, blockId, name, reason: "closed", rawRange: range });
				return true;
			}
			if (!inner.startsWith(name)) continue;
			const rest = inner.slice(name.length);
			if (tag.kind === "block") {
				if (!/^\s*$/.test(rest)) continue;
				if (this.block) continue; // Block 内再次出现的起始标签是字面文本
				if (charBefore === "\\") continue;
				const blockId = `${name}-${++this.blockSeq}`;
				const range = freezeRange(tagStart, tagStart + candidate.length);
				if (run) events.push(this.textEvent(run, runStart));
				this.consume(candidate);
				this.block = { id: blockId, name };
				events.push({ kind: "block_start", streamId: this.streamId, blockId, name, rawRange: range });
				return true;
			}
			// marker：必须是自闭合形状，属性满足注册合同。
			if (!rest.endsWith("/")) continue;
			const attributes = this.parseMarkerAttributes(name, rest.slice(0, -1));
			if (!attributes) continue;
			if (charBefore === "\\") continue;
			const range = freezeRange(tagStart, tagStart + candidate.length);
			if (run) events.push(this.textEvent(run, runStart));
			this.consume(candidate);
			events.push({
				kind: "marker",
				streamId: this.streamId,
				name,
				attributes,
				...(this.block ? { blockId: this.block.id } : {}),
				rawRange: range,
			});
			return true;
		}
		return false;
	}

	/** 解析 marker 属性；未知、重复、缺失必需或值非法都返回 undefined（整标签退化为文本）。 */
	private parseMarkerAttributes(name: string, source: string): Record<string, string> | undefined {
		const contract = this.tags.get(name)?.attributes ?? {};
		const attributes: Record<string, string> = {};
		let rest = source;
		for (;;) {
			rest = rest.replace(/^\s+/, "");
			if (!rest) break;
			const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
			if (!match) return undefined;
			const key = match[1]!;
			if (key in attributes) return undefined; // 重复属性
			const requirement = contract[key];
			if (requirement === undefined) return undefined; // 未知属性
			const value = match[2] ?? match[3] ?? "";
			if (requirement === "required-string" && !value) return undefined;
			attributes[key] = value;
			rest = rest.slice(match[0].length);
		}
		for (const [key, requirement] of Object.entries(contract)) {
			if (requirement === "required-string" && !(key in attributes)) return undefined;
		}
		return attributes;
	}

	private textEvent(text: string, start: number): ExpressionEvent {
		return {
			kind: "text",
			streamId: this.streamId,
			text,
			...(this.block ? { scope: { blockId: this.block.id, name: this.block.name } } : {}),
			rawRange: freezeRange(start, start + text.length),
		};
	}

	private advance(chars: number): void {
		this.buffer = chars >= this.buffer.length ? "" : this.buffer.slice(chars);
		this.bufferStart += chars;
	}

	private consume(candidate: string): void {
		// 执行过的标签同样推进行首状态（属性值里可能含字面换行），不私改原文字节。
		this.noteText(candidate);
		this.advance(candidate.length);
	}

	private noteText(text: string): void {
		for (const ch of text) this.noteChar(ch);
	}

	private noteChar(ch: string): void {
		if (ch === "\n") {
			this.lineSol = true;
			this.lineIndent = 0;
			return;
		}
		if (this.lineSol) {
			if (ch === " " && this.lineIndent <= 3) this.lineIndent++;
			else this.lineSol = false;
		}
		this.prevRawChar = ch;
	}
}

/**
 * 单次模型调用的 Output Interpreter：每个 streamId 一份 Decoder，语法快照在
 * output_start 冻结；注解由语义事件同步累积，随 StreamCollectorResult 进入
 * Assistant canonical 提交。无已识别标签的流不产生注解。
 */
export class OutputInterpreter {
	private readonly streams = new Map<string, { decoder: ExpressionDecoder; annotations: ExpressionTagAnnotation[] }>();

	/** output_start(content)：冻结当前标签注册快照并建立 Decoder。 */
	startStream(streamId: string, snapshot: OutputTagSnapshot): void {
		if (this.streams.has(streamId)) return;
		this.streams.set(streamId, { decoder: new ExpressionDecoder(streamId, snapshot), annotations: [] });
	}

	/** output_update(content)：同步生成语义事件。 */
	feed(streamId: string, text: string): readonly ExpressionEvent[] {
		const stream = this.streams.get(streamId);
		if (!stream) return [];
		return this.collect(stream, stream.decoder.feed(text));
	}

	/** output_end / output_interrupted：收尾语义事件（隐式封口、残余释放）。 */
	finish(streamId: string, reason: "completed" | "interrupted"): readonly ExpressionEvent[] {
		const stream = this.streams.get(streamId);
		if (!stream) return [];
		return this.collect(stream, stream.decoder.finish(reason));
	}

	/** 取走该流的持久化注解（随 Assistant 消息一次性提交；无已识别标签返回 undefined）。 */
	takeAnnotation(streamId: string): ExpressionAnnotation | undefined {
		const stream = this.streams.get(streamId);
		if (!stream) return undefined;
		this.streams.delete(streamId);
		if (stream.annotations.length === 0) return undefined;
		return { version: 1, streamId, tags: stream.annotations };
	}

	private collect(
		stream: { decoder: ExpressionDecoder; annotations: ExpressionTagAnnotation[] },
		events: readonly ExpressionEvent[],
	): readonly ExpressionEvent[] {
		for (const event of events) this.annotate(stream.annotations, event);
		return events;
	}

	private annotate(annotations: ExpressionTagAnnotation[], event: ExpressionEvent): void {
		switch (event.kind) {
			case "block_start":
				annotations.push({
					kind: "block_start",
					name: event.name,
					blockId: event.blockId,
					rawRange: event.rawRange,
				});
				break;
			case "block_end":
				if (event.reason === "closed" && event.rawRange) {
					annotations.push({
						kind: "block_end",
						name: event.name,
						blockId: event.blockId,
						reason: "closed",
						rawRange: event.rawRange,
					});
				} else if (event.reason !== "closed") {
					annotations.push({ kind: "block_end", name: event.name, blockId: event.blockId, reason: event.reason });
				}
				break;
			case "marker":
				annotations.push({
					kind: "marker",
					name: event.name,
					...(event.blockId !== undefined ? { blockId: event.blockId } : {}),
					attributes: event.attributes,
					rawRange: event.rawRange,
				});
				break;
			default:
				break;
		}
	}
}

function escapeRegExp(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function freezeRange(start: number, end: number): readonly [number, number] {
	return Object.freeze([start, end]) as readonly [number, number];
}

function leadingRunLength(buffer: string, char: string): number {
	let n = 0;
	while (n < buffer.length && buffer[n] === char) n++;
	return n;
}

/** 标签候选的结束 `>`：引号包裹的属性值中的 `>` 不结束候选。 */
function findTagEnd(buffer: string): number {
	let quote: string | null = null;
	for (let i = 1; i < buffer.length; i++) {
		const ch = buffer[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ">") return i;
	}
	return -1;
}

type InlineScan = { kind: "text"; text: string } | { kind: "closed"; text: string } | { kind: "wait" };

/** 行内代码正文扫描：找到恰好 N 个反引号即闭合；闭合 run 本身也是字面文本。 */
function scanInlineClose(buffer: string, ticks: number): InlineScan {
	let i = 0;
	for (;;) {
		if (i >= buffer.length) return { kind: "wait" };
		if (buffer[i] !== "`") {
			let j = i;
			while (j < buffer.length && buffer[j] !== "`") j++;
			if (j === buffer.length) {
				let tail = 0;
				while (tail < j && buffer[j - 1 - tail] === "`") tail++;
				return { kind: tail > 0 ? "wait" : "text", text: buffer.slice(0, j - tail) };
			}
			i = j;
			continue;
		}
		let end = i;
		while (end < buffer.length && buffer[end] === "`") end++;
		const length = end - i;
		if (length === ticks) return { kind: "closed", text: buffer.slice(0, end) };
		if (end === buffer.length) return { kind: "wait" }; // 未决 run 可能补齐
		return { kind: "text", text: buffer.slice(0, end) }; // 更长的 run 不是闭合，整体字面
	}
}

type FenceScan = { kind: "text"; text: string; closed: boolean } | { kind: "wait" };

/** 围栏正文扫描：按完整行推进；闭合行首围栏（同字符、长度不短于开头）时结束。 */
function scanFenceBody(buffer: string, fence: { char: string; length: number }): FenceScan {
	let consumed = 0;
	for (;;) {
		const newline = buffer.indexOf("\n", consumed);
		if (newline === -1) {
			const partial = buffer.slice(consumed);
			// 该行已不可能成为闭合行（缩进超限或围栏字符断开）或超长时按字面释放。
			if (partial.length > MAX_FENCE_TAIL_CHARS || !canStillCloseFence(partial, fence)) {
				return { kind: "text", text: buffer.slice(0, consumed) + partial, closed: false };
			}
			return { kind: "wait" };
		}
		const lineEnd = newline + 1;
		const line = buffer.slice(consumed, lineEnd);
		let indent = 0;
		while (indent < line.length && line[indent] === " ") indent++;
		if (indent <= 3 && line[indent] === fence.char) {
			let length = 0;
			while (line[indent + length] === fence.char) length++;
			if (length >= fence.length) {
				return { kind: "text", text: buffer.slice(0, lineEnd), closed: true };
			}
		}
		consumed = lineEnd;
	}
}

/** 未完整的行是否仍可能成为闭合围栏的行首（≤3 空格 + ≥3 个围栏字符的前缀）。 */
function canStillCloseFence(partial: string, fence: { char: string; length: number }): boolean {
	let indent = 0;
	while (indent < partial.length && partial[indent] === " ") indent++;
	if (indent > 3) return false;
	let length = 0;
	while (indent + length < partial.length && partial[indent + length] === fence.char) length++;
	if (length >= fence.length) return true;
	return indent + length >= partial.length; // 仍是围栏字符前缀，等待补齐
}
