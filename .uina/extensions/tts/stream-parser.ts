export interface StreamParserOptions {
  readonly maxSentenceChars?: number;
}

const TERMINAL_PUNCTUATIONS = new Set(["。", "！", "？", "；", "\n", "!", "?", ";", "…"]);
const COMMA_PUNCTUATIONS = new Set(["，", ","]);
const MAX_SAFE_SENTENCE_CHARS = 1000;

function graphemeCount(text: string): number {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => { segment(input: string): Iterable<unknown> } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  return Array.from(text).length;
}

function graphemeSlice(text: string, count: number): string {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => { segment(input: string): Iterable<unknown> } }).Segmenter;
  if (Segmenter) {
    let end = 0;
    let seen = 0;
    for (const part of new Segmenter(undefined, { granularity: "grapheme" }).segment(text) as Iterable<{ segment: string; index: number }>) {
      if (seen++ >= count) break;
      end = part.index + part.segment.length;
    }
    return text.slice(0, end);
  }
  return Array.from(text).slice(0, count).join("");
}

function longestTagPrefixSuffix(text: string, tag: string): string {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return text.slice(-length);
  }
  return "";
}

/**
 * 清理待发声文本中的非发音元素（Markdown 语法、Emoji、多余空白等）。
 */
export function cleanSentence(text: string): string {
	let s = text;
	// 0. 剥离具身动作线索 <cue id="..."/>，以及跨分块被截断的残缺 cue 前缀。
	//    它们是大模型给具身系统的旁路信号，不是台词，绝不能送进合成器念出来。
	//    这里独立清洗而不复用 embodiment 的 StreamingTagStripper.cleanText：voice/tts
	//    在架构上与具身系统对等（无代理原则），不通过它二手转交正文。
	//    注意顺序：必须在下方 Markdown 规则之前，否则下划线规则会先把 id 里的 `_` 吃掉。
	s = s.replace(/<\s*cue\b[^>]*?\/?>/gi, "");
	s = s.replace(/<\s*(?:cue\b[^>]*|c(?:u(?:e)?)?)?$/i, "");
	// 1. 移除 Markdown 图片语法 ![alt](url) -> "" 与独立图片标记 ![alt] -> ""
	s = s.replace(/!\[([^\]]*)\](?:\([^)]+\))?/g, "");
  // 2. 移除 Markdown 链接语法 [text](url) -> text 与独立链接括号 [text] -> text
  s = s.replace(/\[([^\]]+)\](?:\([^)]+\))?/g, "$1");
  // 3. 移除行首 Markdown 标记 (#, >, -, *, + 等)
  s = s.replace(/^[#>\s*\-+]+/gm, "");
  // 3.5 括号标点本身不发音，但括号内容保留（§4.4"不能一律吞掉"）
  s = s.replace(/[()（）]/g, "");
  // 4. 移除行首数字列表标记 (1. , 2. 等)
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  // 5. 移除行内 Markdown 格式符 (**, *, __, _, `)
  s = s.replace(/[`*_]/g, "");
  // 6. 移除 Emoji 与 Pictograph 符号（Unicode 扩展象形文字与展示用 Emoji）
  s = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "");
  // 7. 移除全角中文标点前的多余空格（如 "Uina ！" -> "Uina！"）
  s = s.replace(/\s+([，。！？；：])/g, "$1");
  // 8. 规范化空白字符
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * 检查文本是否含有可发音字符（汉字、拉丁字母、假名、谚文、数字等），避免空发声或纯标点报错。
 */
export function hasPronounceableContent(text: string): boolean {
  return /[\p{sc=Han}\p{sc=Latin}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\d]/u.test(text);
}

export class StreamParser {
  private readonly maxSentenceChars: number;

  // 跨 chunk 状态
  private inThink = false;
  private thinkTagBuffer = "";
  private inCode = false;
  private codeBacktickCount = 0;

  // 待切分文本缓冲
  private sentenceBuffer = "";

  constructor(options: StreamParserOptions = {}) {
    const requested = Number.isFinite(options.maxSentenceChars) ? Math.floor(options.maxSentenceChars as number) : 20;
    this.maxSentenceChars = Math.min(Math.max(requested, 1), MAX_SAFE_SENTENCE_CHARS);
  }

  feed(chunk: string): string[] {
    const sentences: string[] = [];
    let i = 0;

    while (i < chunk.length) {
      // 1. 处理 <think>...</think> 状态机
      if (this.inThink) {
        const combined = this.thinkTagBuffer + chunk.slice(i);
        const closeIdx = combined.indexOf("</think>");
        if (closeIdx !== -1) {
          const prefixLength = this.thinkTagBuffer.length;
          this.inThink = false;
          this.thinkTagBuffer = "";
          // The prefix may have arrived in the previous chunk. Only advance
          // over the part of the close tag present in this chunk.
          i += Math.max(0, closeIdx + 8 - prefixLength);
          continue;
        } else {
          this.thinkTagBuffer = longestTagPrefixSuffix(combined, "</think>");
          break;
        }
      }

      // 检查进入 <think>
      if (this.thinkTagBuffer) {
        const combined = this.thinkTagBuffer + chunk.slice(i);
        if (combined.startsWith("<think>")) {
          const prefixLength = this.thinkTagBuffer.length;
          this.inThink = true;
          this.thinkTagBuffer = "";
          i += 7 - prefixLength;
          continue;
        }
        const prefix = longestTagPrefixSuffix(combined, "<think>");
        if (prefix) {
          this.thinkTagBuffer = prefix;
          break;
        }
        this.sentenceBuffer += this.thinkTagBuffer;
        this.thinkTagBuffer = "";
      }

      if (chunk.startsWith("<think>", i)) {
        this.inThink = true;
        this.thinkTagBuffer = "";
        i += 7;
        continue;
      }

      // 缓存可能的标签前缀（如 "<th"）
      if (chunk[i] === "<") {
        const remaining = chunk.slice(i);
        const prefix = longestTagPrefixSuffix(remaining, "<think>");
        if (prefix) {
          this.thinkTagBuffer = prefix;
          break;
        }
      }

      const ch = chunk[i];

      // 2. 处理代码块 ```` ``` ````
      if (ch === "`") {
        this.codeBacktickCount++;
        if (this.codeBacktickCount === 3) {
          this.inCode = !this.inCode;
          this.codeBacktickCount = 0;
        }
        i++;
        continue;
      } else {
        this.codeBacktickCount = 0;
      }

      if (this.inCode) {
        i++;
        continue;
      }

      // 括号标点不发音，但内容照常朗读（§4.4"不能一律吞掉"）。
      // 标点剥离放在 cleanSentence 的 Markdown 链接规则之后，避免破坏 [text](url) 的模式匹配。
      this.sentenceBuffer += ch;

      // 3. 检查断句
      const currentLen = graphemeCount(this.sentenceBuffer);
      const prevChar = currentLen >= 2 ? this.sentenceBuffer[currentLen - 2] : "";
      const nextChar = i + 1 < chunk.length ? chunk[i + 1] : "";

      // 数字保护：小数 (3.14) 与千分位 (100,000) 坚决不切
      const isNumberDot = ch === "." && /\d/.test(prevChar) && /\d/.test(nextChar);
      const isNumberComma = (ch === "," || ch === "，") && /\d/.test(prevChar) && /\d/.test(nextChar);

      if (!isNumberDot && !isNumberComma) {
        // 终止标点：遇到即切
        if (TERMINAL_PUNCTUATIONS.has(ch)) {
          // 连续标点合并：如果下一个字符也是终止标点，先不切，等标点流完再切
          const nextIsTerminal = i + 1 < chunk.length && TERMINAL_PUNCTUATIONS.has(chunk[i + 1]);
          if (!nextIsTerminal) {
            const cleaned = cleanSentence(this.sentenceBuffer);
            if (hasPronounceableContent(cleaned)) {
              sentences.push(cleaned);
            }
            this.sentenceBuffer = "";
          }
        }
        // 逗号长句防断流：超过 maxSentenceChars 且遇逗号
        else if (COMMA_PUNCTUATIONS.has(ch) && currentLen >= this.maxSentenceChars) {
          const nextIsComma = i + 1 < chunk.length && COMMA_PUNCTUATIONS.has(chunk[i + 1]);
          if (!nextIsComma) {
            const cleaned = cleanSentence(this.sentenceBuffer);
            if (hasPronounceableContent(cleaned)) {
              sentences.push(cleaned);
            }
            this.sentenceBuffer = "";
          }
        }

        // A model can omit punctuation for a long time. Keep normal
        // whitespace as a safe boundary, then use a bounded code-point split
        // as the last resort so first audio is not delayed for the whole turn.
        if (this.sentenceBuffer.length >= this.maxSentenceChars &&
            /\s/.test(ch) &&
            !/[。！？；!?;，,]/.test(this.sentenceBuffer)) {
          const cleaned = cleanSentence(this.sentenceBuffer);
          if (hasPronounceableContent(cleaned)) sentences.push(cleaned);
          this.sentenceBuffer = "";
        } else if (this.sentenceBuffer.length >= Math.max(this.maxSentenceChars * 2, this.maxSentenceChars + 8)) {
          const head = cleanSentence(graphemeSlice(this.sentenceBuffer, this.maxSentenceChars));
          if (hasPronounceableContent(head)) sentences.push(head);
          this.sentenceBuffer = this.sentenceBuffer.slice(graphemeSlice(this.sentenceBuffer, this.maxSentenceChars).length);
        }
      }

      i++;
    }

    return sentences;
  }

  flush(): string[] {
    const sentences: string[] = [];
    const cleaned = cleanSentence(this.sentenceBuffer);
    if (hasPronounceableContent(cleaned)) {
      sentences.push(cleaned);
    }
    this.reset();
    return sentences;
  }

  reset(): void {
    this.sentenceBuffer = "";
    this.inThink = false;
    this.thinkTagBuffer = "";
    this.inCode = false;
    this.codeBacktickCount = 0;
  }
}
