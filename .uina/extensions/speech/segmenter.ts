/**
 * Speech 领域分句器（输出表达体系 §5.2/§5.4）：把已剥除表达标签的 Speech 文本
 * 切成可提交的发音片段。终止标点/逗号上限/空白界限/硬切与旧合同一致；连续终止
 * 标点合并为一个切分点。发音文本规范化不吞语义，只去掉不可发音的修饰
 * （Markdown 语法、Emoji、全角旁白括注）。
 */

const TERMINAL_PUNCTUATIONS = new Set(["。", "！", "？", "；", "\n", "!", "?", ";", "…"]);
const COMMA_PUNCTUATIONS = new Set(["，", ","]);
const MAX_SAFE_SENTENCE_CHARS = 1000;

export interface SegmenterOptions {
	readonly maxSentenceChars?: number;
}

/** 检查文本是否含有可发音字符（汉字、拉丁字母、假名、谚文、数字等）。 */
export function hasPronounceableContent(text: string): boolean {
	return /[\p{sc=Han}\p{sc=Latin}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\d]/u.test(text);
}

/**
 * 清理待发音文本中的非发音元素。不吞标签（那是 Output Interpretation 的事）；
 * 全角（…）旁白按既有裁定不朗读，半角 () 只剥括号保留内容。
 */
export function normalizeSpokenText(text: string): string {
	let s = text;
	// Markdown 图片与链接语法：![alt](url) 去图留字；行首标记与行内格式符去修饰。
	s = s.replace(/!\[([^\]]*)\](?:\([^)]+\))?/g, "");
	s = s.replace(/\[([^\]]+)\](?:\([^)]+\))?/g, "$1");
	s = s.replace(/^[#>\s*\-+]+/gm, "");
	s = s.replace(/^\s*\d+\.\s+/gm, "");
	s = s.replace(/[`*_]/g, "");
	// Emoji 与 Pictograph 符号不发音。
	s = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "");
	// 全角旁白括注整体不朗读；未闭合的（按流式语义吞掉尾部（残句不该突然开始念括注）。
	s = s.replace(/（[^（）]*）/g, "").replace(/（[^）]*$/g, "");
	// 全角中文标点前的多余空格与规范化空白。
	s = s.replace(/\s+([，。！？；：])/g, "$1");
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

function graphemeSlice(text: string, count: number): string {
	const parts = Array.from(text);
	return parts.slice(0, count).join("");
}

/**
 * 流式分句状态机：feed 返回已封口的原始片段；forceBoundary 立即封口当前缓冲
 * （Marker 强制分段边界）；flushBoundary 收尾。
 */
export class SpeechSegmenter {
	private readonly maxSentenceChars: number;
	private buffer = "";
	/** 连续终止标点的暂存：流完（下一个非终止字符或 chunk 结束）才切分。 */
	private terminalRun = "";
	/** 全角括注跨 chunk 吞咽状态（旁白是字幕语义不是台词）。 */
	private inParen = false;
	private parenSwallowCount = 0;

	constructor(options: SegmenterOptions = {}) {
		const requested = Number.isFinite(options.maxSentenceChars) ? Math.floor(options.maxSentenceChars as number) : 20;
		this.maxSentenceChars = Math.min(Math.max(requested, 1), MAX_SAFE_SENTENCE_CHARS);
	}

	get pending(): string {
		return this.buffer;
	}

	/** 追加文本并返回本次封口的原始片段。 */
	feed(chunk: string): string[] {
		const emitted: string[] = [];
		let i = 0;
		while (i < chunk.length) {
			const ch = chunk[i]!;
			if (this.inParen) {
				if (ch === "）") {
					this.inParen = false;
					this.parenSwallowCount = 0;
				} else if (++this.parenSwallowCount > 120) {
					// 未闭合容错：超限视为漏配括号，从当前字符恢复朗读
					this.inParen = false;
					this.parenSwallowCount = 0;
					this.buffer += ch;
				}
				i++;
				continue;
			}
			if (ch === "（") {
				this.inParen = true;
				i++;
				continue;
			}
			if (this.terminalRun) {
				if (TERMINAL_PUNCTUATIONS.has(ch)) {
					this.terminalRun += ch;
					i++;
					continue;
				}
				// 标点流结束：并入缓冲并在最后一个终止标点后切分。
				this.buffer += this.terminalRun;
				this.terminalRun = "";
				emitted.push(this.takeBuffer());
				continue; // 当前字符走正常路径（不推进 i）
			}
			if (TERMINAL_PUNCTUATIONS.has(ch)) {
				// 终止标点不进缓冲：等待标点流结束（连续标点合并）后随缓冲一起切分。
				this.terminalRun = ch;
				i++;
				continue;
			}
			this.buffer += ch;
			i++;
			const currentLen = Array.from(this.buffer).length;
			const prevChar = this.buffer.length >= 2 ? this.buffer[this.buffer.length - 2] : "";
			// 数字保护：小数与千分位坚决不切。
			if ((ch === "." || ch === "," || ch === "，") && /\d/.test(prevChar)) continue;
			if (COMMA_PUNCTUATIONS.has(ch) && currentLen >= this.maxSentenceChars) {
				emitted.push(this.takeBuffer());
				continue;
			}
			// 模型可能长期不打标点：空白是安全边界，之后用有界硬切兜底，首段音频不等整轮。
			if (
				this.buffer.length >= this.maxSentenceChars &&
				/\s/.test(ch) &&
				!/[。！？；!?;，,]/.test(this.buffer)
			) {
				emitted.push(this.takeBuffer());
				continue;
			}
			if (currentLen >= Math.max(this.maxSentenceChars * 2, this.maxSentenceChars + 8)) {
				const head = graphemeSlice(this.buffer, this.maxSentenceChars);
				this.buffer = this.buffer.slice(head.length);
				emitted.push(head);
			}
		}
		if (this.terminalRun) {
			// chunk 边界收尾：终止标点随当前缓冲切分（与逐字符合同一致）。
			this.buffer += this.terminalRun;
			this.terminalRun = "";
			emitted.push(this.takeBuffer());
		}
		return emitted;
	}

	/** 强制封口（Marker 到达）：即使普通标点尚未触发也按此规则分段。 */
	forceBoundary(): string | undefined {
		if (!this.buffer.trim()) return undefined;
		return this.takeBuffer();
	}

	/** 收尾：封口残余缓冲。 */
	flushBoundary(): string | undefined {
		return this.forceBoundary();
	}

	reset(): void {
		this.buffer = "";
		this.terminalRun = "";
		this.inParen = false;
		this.parenSwallowCount = 0;
	}

	private takeBuffer(): string {
		const raw = this.buffer;
		this.buffer = "";
		return raw;
	}
}
