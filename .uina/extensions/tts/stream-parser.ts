export interface StreamParserOptions {
  readonly maxSentenceChars?: number;
}

const TERMINAL_PUNCTUATIONS = new Set(["。", "！", "？", "；", "\n", "!", "?", ";", "…"]);
const COMMA_PUNCTUATIONS = new Set(["，", ","]);

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
  private bracketDepth = 0;

  // 待切分文本缓冲
  private sentenceBuffer = "";

  constructor(options: StreamParserOptions = {}) {
    this.maxSentenceChars = options.maxSentenceChars ?? 20;
  }

  feed(chunk: string): string[] {
    const sentences: string[] = [];
    let i = 0;

    while (i < chunk.length) {
      // 1. 处理 <think>...</think> 状态机
      if (this.inThink) {
        const closeIdx = chunk.indexOf("</think>", i);
        if (closeIdx !== -1) {
          this.inThink = false;
          i = closeIdx + 8; // 跳过 </think>
          this.thinkTagBuffer = "";
          continue;
        } else {
          // 检查末尾是否含有半截 "</think"
          this.thinkTagBuffer = chunk.slice(Math.max(i, chunk.length - 8));
          break;
        }
      }

      // 检查进入 <think>
      if (
        chunk.startsWith("<think>", i) ||
        (this.thinkTagBuffer && (this.thinkTagBuffer + chunk.slice(i)).startsWith("<think>"))
      ) {
        this.inThink = true;
        this.thinkTagBuffer = "";
        const tagLen = chunk.startsWith("<think>", i) ? 7 : 7 - this.thinkTagBuffer.length;
        i += tagLen;
        continue;
      }

      // 缓存可能的标签前缀（如 "<th"）
      if (chunk[i] === "<") {
        const remaining = chunk.slice(i);
        if ("<think>".startsWith(remaining)) {
          this.thinkTagBuffer = remaining;
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

      // 3. 处理中英文括号 ( ) 与 （ ）
      if (ch === "(" || ch === "（") {
        this.bracketDepth++;
        i++;
        continue;
      }
      if (ch === ")" || ch === "）") {
        if (this.bracketDepth > 0) {
          this.bracketDepth--;
        }
        i++;
        continue;
      }

      // 括号内部文本完全免播
      if (this.bracketDepth > 0) {
        i++;
        continue;
      }

      this.sentenceBuffer += ch;

      // 4. 检查断句
      const currentLen = this.sentenceBuffer.length;
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
        else if (COMMA_PUNCTUATIONS.has(ch) && this.sentenceBuffer.length >= this.maxSentenceChars) {
          const nextIsComma = i + 1 < chunk.length && COMMA_PUNCTUATIONS.has(chunk[i + 1]);
          if (!nextIsComma) {
            const cleaned = cleanSentence(this.sentenceBuffer);
            if (hasPronounceableContent(cleaned)) {
              sentences.push(cleaned);
            }
            this.sentenceBuffer = "";
          }
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
    this.bracketDepth = 0;
  }
}
