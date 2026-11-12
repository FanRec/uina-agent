/**
 * Prompt File Compiler（扩展 Prompt 文件机制）：把扩展资源根内的 Markdown 入口
 * 编译为一份稳定文本，供 Runner 注册为普通静态 guidance。
 *
 * 职责边界：只做本地文件读取、独立行 `{{include:...}}` 展开、路径与内容校验和
 * 来源元数据；不注入消息、不判断扩展在线状态、不管理 Prompt 预算（Request 的
 * Token 预算仍由既有机制处理）。
 *
 * 合同（docs/refactor/Uina-Extension-Prompt-Files-Design.md §6）：
 * - 引用只能落在拥有该 Source 的扩展资源根内；根内合法符号链接可用，指向根外的
 *   符号链接拒绝；只支持 .md 普通 UTF-8 文本文件。
 * - 引用是独立成行的 `{{include:relative/path.md}}`（允许行首行尾空白和 `include:`
 *   后的空格），相对发起引用的文件目录解析，原地展开，子文件可再引用。
 * - 围栏代码块（三个及以上反引号或波浪线）内的同形文本为字面量；独立行的
 *   `\{{include:...}}` 是转义：去掉反斜杠而不展开；非 include 的 `{{...}}` 原样保留。
 * - 循环检测基于当前递归栈，不是全局 visited：同一文件被多处包含按位置重复展开。
 * - 展开累计超过 64 KiB UTF-8 立即拒绝；检测到循环、缺失、非法路径或过大时不产出
 *   半成品，错误报告触发文件、行号与引用链。
 * - CRLF/LF 输入统一为 LF，去除 UTF-8 BOM；正文内部空行与缩进保留，结果首尾 trim。
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface CompiledPrompt {
	/** 展开后稳定的 Markdown（LF、无 BOM、首尾 trim）。 */
	readonly text: string;
	/** SHA-256(text)。 */
	readonly hash: string;
	/** 相对扩展资源根的入口路径。 */
	readonly entry: string;
	/** 实际读取的文件，按首次访问顺序去重（相对资源根，posix 分隔符）。 */
	readonly sources: readonly string[];
}

/** 展开文本的硬上界：防止无环重复包含导致意外爆炸，不是建议常驻体积。 */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** 独立成行的 include 指令：行首行尾允许空白，`include:` 后允许空格。 */
const INCLUDE_LINE = /^[ \t]*\{\{include:[ \t]*([^{}]+?)[ \t]*\}\}[ \t]*$/;
/** 转义形式：独立行的 `\{{include:...}}`，输出时去掉反斜杠而不展开。 */
const ESCAPED_INCLUDE_LINE = /^[ \t]*\\\{\{include:[ \t]*[^{}]+?[ \t]*\}\}[ \t]*$/;
/** Markdown 围栏（CommonMark：至多 3 个空格缩进的三个及以上反引号/波浪线）。 */
const FENCE_LINE = /^[ ]{0,3}(`{3,}|~{3,})/;
/** 闭合围栏（CommonMark）：与开围栏同字符且更长，其后只允许空白——"```text" 不是闭合。 */
const FENCE_CLOSE_LINE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;

interface CompileContext {
	readonly rootReal: string;
	/** 当前递归栈（真实路径）：循环检测只对当前栈进行。 */
	readonly stack: string[];
	/** 首次访问顺序的来源文件（相对资源根，posix）。 */
	readonly sources: string[];
	readonly seenSources: Set<string>;
	/** 展开输出的累计字节数（UTF-8）。 */
	bytes: number;
}

/** 编译一个扩展 Prompt 入口。任何失败都会抛出带定位的完整错误，绝不返回半成品。 */
export async function compilePromptFile(entry: string, root: string): Promise<CompiledPrompt> {
	if (typeof entry !== "string" || !entry.trim()) throw new Error("Prompt 入口路径不能为空");
	const rootReal = await realpath(root).catch(() => {
		throw new Error(`扩展资源根不存在: ${root}`);
	});
	const ctx: CompileContext = { rootReal, stack: [], sources: [], seenSources: new Set(), bytes: 0 };
	const entryReal = await locate(entry, rootReal, ctx);
	// expand 自己管理递归栈的压入与弹出（循环检测对"经由引用到达"的文件进行）。
	const lines = await expand(entryReal, ctx);
	const text = lines.join("\n").trim();
	return {
		text,
		hash: createHash("sha256").update(text, "utf8").digest("hex"),
		entry: displayPath(entryReal, ctx.rootReal),
		sources: [...ctx.sources],
	};
}

/** 解析并校验一个引用目标：根内、.md、普通文件；返回真实路径。 */
async function locate(target: string, baseDir: string, ctx: CompileContext): Promise<string> {
	if (isAbsolute(target)) throw new Error(`不支持绝对路径引用: ${target}`);
	const candidate = resolve(baseDir, target);
	const real = await realpath(candidate).catch(() => {
		throw new Error(`引用的文件不存在: ${target}`);
	});
	if (!inRoot(real, ctx.rootReal)) throw new Error(`引用越出扩展资源根: ${target}`);
	const info = await stat(real).catch(() => {
		throw new Error(`无法读取引用目标: ${target}`);
	});
	if (!info.isFile()) throw new Error(`引用目标不是普通文件: ${target}`);
	if (extname(real).toLowerCase() !== ".md") throw new Error(`只支持 .md 文件: ${target}`);
	return real;
}

/** 逐行扫描一个文件：围栏跟踪、include 展开、转义还原；返回展开后的行序列。 */
async function expand(fileReal: string, ctx: CompileContext): Promise<string[]> {
	if (ctx.stack.includes(fileReal)) {
		const cycle = [...ctx.stack.slice(ctx.stack.indexOf(fileReal)), fileReal].map((p) => displayPath(p, ctx.rootReal));
		throw new Error(`检测到循环引用: ${cycle.join(" -> ")}`);
	}
	const display = displayPath(fileReal, ctx.rootReal);
	if (!ctx.seenSources.has(display)) {
		ctx.seenSources.add(display);
		ctx.sources.push(display);
	}
	const source = await readMarkdown(fileReal, display);
	if (source === "") return [];
	ctx.stack.push(fileReal);
	try {
		const out: string[] = [];
		let fence: { char: string; length: number } | undefined;
		// 末尾换行是文件终止符，不是内容：去掉这一个空行残留，正文内部空行仍保留。
		const lines = (source.endsWith("\n") ? source.slice(0, -1) : source).split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			const fenceInfo = FENCE_LINE.exec(line);
			if (fence) {
				const closes =
					fenceInfo !== null &&
					fenceInfo[1]![0] === fence.char &&
					fenceInfo[1]!.length >= fence.length &&
					FENCE_CLOSE_LINE.test(line);
				if (closes) fence = undefined;
				push(out, line, ctx);
				continue;
			}
			if (fenceInfo) {
				fence = { char: fenceInfo[1]![0]!, length: fenceInfo[1]!.length };
				push(out, line, ctx);
				continue;
			}
			if (ESCAPED_INCLUDE_LINE.test(line)) {
				push(out, line.replace("\\{{", "{{"), ctx);
				continue;
			}
			const include = INCLUDE_LINE.exec(line);
			if (include) {
				// 路径相对发起引用的文件目录；指令行的前后空白不传递给被包含内容。
				const target = include[1]!.trim();
				try {
					const targetReal = await locate(target, dirname(fileReal), ctx);
					out.push(...(await expand(targetReal, ctx)));
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new Error(`${display}:${index + 1}: ${reason}`);
				}
				continue;
			}
			// 非 include 形式的 {{...}} 原样保留，不视为变量引用。
			push(out, line, ctx);
		}
		return out;
	} finally {
		ctx.stack.pop();
	}
}

/** 记账式输出：累计 UTF-8 字节超上界立即拒绝（含每行换行符）。 */
function push(out: string[], line: string, ctx: CompileContext): void {
	ctx.bytes += Buffer.byteLength(line, "utf8") + 1;
	if (ctx.bytes > MAX_OUTPUT_BYTES) {
		throw new Error(`展开文本超过 ${MAX_OUTPUT_BYTES} 字节上界（防无环重复包含爆炸；非建议常驻体积）`);
	}
	out.push(line);
}

async function readMarkdown(fileReal: string, display: string): Promise<string> {
	const bytes = await readFile(fileReal);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		throw new Error(`文件不是有效的 UTF-8 编码: ${display}`);
	}
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function inRoot(real: string, rootReal: string): boolean {
	return real === rootReal || real.startsWith(rootReal + sep);
}

function displayPath(fileReal: string, rootReal: string): string {
	return relative(rootReal, fileReal).split(sep).join("/");
}
