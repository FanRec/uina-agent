import type { ExtractedCue } from "./types.js";

/**
 * 深度流式文本过滤器与标签剥离器 (StreamingTagStripper)
 *
 * 采用滑动窗口与状态机，从大模型流式输出中：
 * 1. 精准提取 `<cue id="..." (target="...")/>` 并派发给具身系统；
 * 2. 跨 Chunk 识别并静默过滤 ```代码块``` 与 `<think>` 深度思考块；
 * 3. 杜绝退化正则误伤：普通 `<`（如 `x < 3`）立即放行，不阻碍首字发音延迟；
 * 4. 彻底杜绝未闭合标签或代码被流式送给 TTS 读出声。
 */
export class StreamingTagStripper {
	private buffer = "";
	private inCodeBlock = false;
	private inThinkBlock = false;

	// 精准前缀正则：仅当 < 紧跟 c/cu/cue 或 t/th/thi/thin/think 时才可能是未决标签
	private static readonly PENDING_TAG_PREFIX =
		/^<\/?(?:c(?:u(?:e(?:\s.*)?)?)?|t(?:h(?:i(?:n(?:k(?:\s.*)?)?)?)?)?)?$/i;

	// 缓冲区最大容量保护，防止异常流导致内存无界累积
	private static readonly MAX_BUFFER_LENGTH = 4096;

	reset(): void {
		this.buffer = "";
		this.inCodeBlock = false;
		this.inThinkBlock = false;
	}

	/**
	 * 处理一个流式文本分块
	 */
	processChunk(chunk: string): { cleanText: string; cues: ExtractedCue[] } {
		this.buffer += chunk;
		const cues: ExtractedCue[] = [];
		let cleanText = "";

		this.protectBufferOverflow((discarded) => {
			cleanText += discarded;
		});

		while (this.buffer.length > 0) {
			if (this.inCodeBlock) {
				if (!this.consumeCodeBlock()) break;
				continue;
			}

			if (this.inThinkBlock) {
				if (!this.consumeThinkBlock()) break;
				continue;
			}

			const hit = this.findEarliestSpecial();
			if (hit.type === "none") {
				cleanText += this.consumeSafeNormalTail();
				break;
			}

			// 先把特殊结构之前的正文输出
			cleanText += this.buffer.slice(0, hit.index);
			this.buffer = this.buffer.slice(hit.index);

			if (hit.type === "code") {
				this.inCodeBlock = true;
				this.buffer = this.buffer.slice(3);
			} else if (hit.type === "think") {
				this.inThinkBlock = true;
				this.buffer = this.buffer.slice(hit.matchLength);
			} else if (hit.type === "cue") {
				const cue = this.parseCueTag(hit.match!);
				if (cue) cues.push(cue);
				this.buffer = this.buffer.slice(hit.matchLength);
			}
		}

		return { cleanText, cues };
	}

	private protectBufferOverflow(onDiscard: (text: string) => void): void {
		if (
			this.buffer.length > StreamingTagStripper.MAX_BUFFER_LENGTH &&
			!this.inCodeBlock &&
			!this.inThinkBlock
		) {
			const safeCut = this.buffer.length - 256;
			onDiscard(this.buffer.slice(0, safeCut));
			this.buffer = this.buffer.slice(safeCut);
		}
	}

	private consumeCodeBlock(): boolean {
		const closeIdx = this.buffer.indexOf("```");
		if (closeIdx !== -1) {
			this.inCodeBlock = false;
			this.buffer = this.buffer.slice(closeIdx + 3);
			return true;
		}
		if (this.buffer.endsWith("``") || this.buffer.endsWith("`")) {
			const keep = this.buffer.endsWith("``") ? 2 : 1;
			this.buffer = this.buffer.slice(-keep);
		} else {
			this.buffer = "";
		}
		return false;
	}

	private consumeThinkBlock(): boolean {
		const closeIdx = this.buffer.indexOf("</think>");
		if (closeIdx !== -1) {
			this.inThinkBlock = false;
			this.buffer = this.buffer.slice(closeIdx + 8);
			return true;
		}
		const lastLt = this.buffer.lastIndexOf("<");
		if (lastLt !== -1 && this.buffer.length - lastLt < 8) {
			this.buffer = this.buffer.slice(lastLt);
		} else {
			this.buffer = "";
		}
		return false;
	}

	private findEarliestSpecial(): {
		type: "code" | "think" | "cue" | "none";
		index: number;
		matchLength: number;
		match?: RegExpExecArray;
	} {
		const codeIdx = this.buffer.indexOf("```");
		const thinkMatch = /<\s*think\b[^>]*>/i.exec(this.buffer);
		const cueMatch = /<\s*cue\b([^>]*?)\/?>/i.exec(this.buffer);

		let type: "code" | "think" | "cue" | "none" = "none";
		let index = Number.MAX_SAFE_INTEGER;
		let matchLength = 0;
		let match: RegExpExecArray | undefined;

		if (codeIdx !== -1 && codeIdx < index) {
			type = "code";
			index = codeIdx;
			matchLength = 3;
		}
		if (thinkMatch && thinkMatch.index < index) {
			type = "think";
			index = thinkMatch.index;
			matchLength = thinkMatch[0].length;
			match = thinkMatch;
		}
		if (cueMatch && cueMatch.index < index) {
			type = "cue";
			index = cueMatch.index;
			matchLength = cueMatch[0].length;
			match = cueMatch;
		}

		return { type, index, matchLength, match };
	}

	private consumeSafeNormalTail(): string {
		let safeLen = this.buffer.length;

		// 检查末尾反引号 (可能构成 ```)
		if (this.buffer.endsWith("``")) {
			safeLen = Math.min(safeLen, this.buffer.length - 2);
		} else if (this.buffer.endsWith("`")) {
			safeLen = Math.min(safeLen, this.buffer.length - 1);
		}

		// 检查末尾是否可能是未闭合的 <cue 或 <think 标签
		const lastLt = this.buffer.lastIndexOf("<");
		if (lastLt !== -1) {
			const tail = this.buffer.slice(lastLt);
			if (!tail.includes(">") && StreamingTagStripper.PENDING_TAG_PREFIX.test(tail)) {
				safeLen = Math.min(safeLen, lastLt);
			}
		}

		const output = this.buffer.slice(0, safeLen);
		this.buffer = this.buffer.slice(safeLen);
		return output;
	}

	private parseCueTag(match: RegExpExecArray): ExtractedCue | undefined {
		const attrs = match[1];
		if (!attrs) return undefined;
		const idMatch = /\bid=(["'])(.*?)\1/i.exec(attrs);
		const targetMatch = /\btarget=(["'])(.*?)\1/i.exec(attrs);

		if (idMatch && idMatch[2]) {
			return {
				id: idMatch[2].trim(),
				target: targetMatch ? targetMatch[2].trim() : undefined,
				rawTag: match[0],
			};
		}
		return undefined;
	}

	/**
	 * 流结束时冲刷剩余缓冲区
	 */
	flush(): { cleanText: string; cues: ExtractedCue[] } {
		// 如果在代码块或思考块内部结束，残余内容直接丢弃并重置状态
		if (this.inCodeBlock || this.inThinkBlock) {
			this.reset();
			return { cleanText: "", cues: [] };
		}

		if (!this.buffer) {
			return { cleanText: "", cues: [] };
		}

		// 冲刷时最后处理一次
		const res = this.processChunk("");
		// 剩余未能作为标签解析的内容（如数学符号 < 3）作为纯文本全部吐出
		const flushed = res.cleanText + this.buffer;
		this.buffer = "";
		return { cleanText: flushed, cues: res.cues };
	}
}
