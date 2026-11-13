/**
 * 操作者调用展开（/skill name args → 真实模型输入）。
 *
 * 占位符：$ARGUMENTS（未改动的原始参数串）、$ARGUMENTS[n] 与 $n（0 起）、
 * arguments 声明的 $name。引号包裹的参数按一个位置参数处理；引号不平衡明确报错。
 * 未提供的索引占位符保留原文；仅当正文没有有效参数占位符时，才把非空原始参数串
 * 附在末尾作为任务要求。单次替换、支持 \$ 字面转义；不做 Shell 展开、递归模板
 * 或表达式求值。
 */

import { listResources, resolveSkill } from "./read.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

export class SkillInvocationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillInvocationError";
	}
}

interface ParsedArgs {
	positional: string[];
	raw: string;
}

/** 解析操作者参数：空白分隔；'…' 与 "…" 包裹算一个；引号不平衡明确报错。 */
export function parseInvocationArguments(raw: string): ParsedArgs {
	const positional: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started || current) {
				positional.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (quote) throw new SkillInvocationError(`参数引号不平衡：${quote} 未闭合`);
	if (started || current) positional.push(current);
	return { positional, raw };
}

/** 展开期间遇到的占位符种类；用于判断"正文有没有有效参数占位符"。 */
interface PlaceholderScan {
	hasArguments: boolean;
	hasIndexed: boolean;
	hasNamed: boolean;
}

function scanPlaceholders(body: string, declaredNames: readonly string[]): PlaceholderScan {
	const scan: PlaceholderScan = { hasArguments: false, hasIndexed: false, hasNamed: false };
	let index = 0;
	while (index < body.length) {
		if (body[index] === "\\") {
			index += 2;
			continue;
		}
		if (body[index] === "$") {
			const rest = body.slice(index + 1);
			if (rest.startsWith("ARGUMENTS")) {
				const bracket = /^\[(\d+)\]/.exec(rest.slice("ARGUMENTS".length));
				if (bracket) scan.hasIndexed = true;
				else scan.hasArguments = true;
			} else if (/^\d/.test(rest)) {
				scan.hasIndexed = true;
			} else {
				const name = /^[A-Za-z][A-Za-z0-9_-]*/.exec(rest);
				if (name && declaredNames.includes(name[0])) scan.hasNamed = true;
			}
		}
		index += 1;
	}
	return scan;
}

/** 单遍替换：\$ → $ 字面；$ARGUMENTS / $ARGUMENTS[n] / $n / $declared。 */
function substitute(
	body: string,
	args: ParsedArgs,
	declaredNames: readonly string[],
): { text: string; placeholders: PlaceholderScan } {
	const scan = scanPlaceholders(body, declaredNames);
	let output = "";
	let index = 0;
	while (index < body.length) {
		const char = body[index]!;
		if (char === "\\" && body[index + 1] === "$") {
			output += "$";
			index += 2;
			continue;
		}
		if (char === "$") {
			const rest = body.slice(index + 1);
			if (rest.startsWith("ARGUMENTS")) {
				const bracket = /^\[(\d+)\]/.exec(rest.slice("ARGUMENTS".length));
				if (bracket) {
					const value = args.positional[Number(bracket[1])];
					// 未提供的索引占位符保留原文，不吞占位符。
					output += value !== undefined ? value : `$ARGUMENTS[${bracket[1]}]`;
					index += 1 + "ARGUMENTS".length + bracket[0].length;
					continue;
				}
				output += args.raw;
				index += 1 + "ARGUMENTS".length;
				continue;
			}
			const digits = /^\d+/.exec(rest);
			if (digits) {
				const value = args.positional[Number(digits[0])];
				output += value !== undefined ? value : `$${digits[0]}`;
				index += 1 + digits[0].length;
				continue;
			}
			const name = /^[A-Za-z][A-Za-z0-9_-]*/.exec(rest);
			if (name && declaredNames.includes(name[0])) {
				const declaredIndex = declaredNames.indexOf(name[0]);
				output += args.positional[declaredIndex] ?? `$${name[0]}`;
				index += 1 + name[0].length;
				continue;
			}
		}
		output += char;
		index += 1;
	}
	return { text: output, placeholders: scan };
}

export interface SkillInvocation {
	text: string;
	displayText: string;
	data: Record<string, unknown>;
}

/** 资源提示段：调用展开必须自带 read_skill 的用法，手动专用 Skill 尤其依赖它。 */
function resourceGuidance(entry: SkillEntry, listing: readonly string[]): string {
	if (listing.length === 0) return "";
	return [
		"附属资源（需要时用 read_skill({name, resource}) 读取，例如 read_skill({name: " +
			JSON.stringify(entry.name) +
			", resource: " +
			JSON.stringify(listing[0] ?? "") +
			"})）:",
		...listing.map((item) => `- ${item}`),
	].join("\n");
}

/**
 * 用提交时的 Snapshot 展开一次显式调用。仅 userInvocable 的条目允许；
 * 返回的 text 是模型真正接收的正文（含名称/revision/资源目录与资源清单）。
 */
export async function expandInvocation(
	snapshot: SkillSnapshot,
	name: string,
	rawArgs: string,
): Promise<SkillInvocation> {
	const entry = resolveSkill(snapshot, name);
	if (!entry) {
		throw new SkillInvocationError(`未知 Skill: ${name}。用 /skills 查看当前可用列表。`);
	}
	if (!entry.userInvocable) {
		throw new SkillInvocationError(`Skill "${name}" 不允许用户显式调用（user-invocable: false）。`);
	}
	const args = parseInvocationArguments(rawArgs);
	const declaredNames = entry.argumentNames ?? [];
	const substituted = substitute(entry.body, args, declaredNames);
	let text = substituted.text.trimEnd();
	if (
		!substituted.placeholders.hasArguments &&
		!substituted.placeholders.hasIndexed &&
		!substituted.placeholders.hasNamed &&
		args.raw.trim()
	) {
		// 正文没有有效参数占位符：把非空原始参数串附在末尾作为任务要求，避免重复输入。
		text += `\n\n[操作者参数] ${args.raw}`;
	}
	let listing: string[] = [];
	try {
		listing = [...(await listResources(entry)).entries].filter((item) => !item.endsWith("/"));
	} catch {
		listing = [];
	}
	const guidance = resourceGuidance(entry, listing);
	const expanded = [
		`[Skill 调用: ${entry.name}（revision ${entry.revision.slice(0, 12)}，来源 ${entry.sourceId}）]`,
		`Skill 目录: ${entry.root}（相对引用与 read_skill 的 resource 参数基于此目录）`,
		"",
		"以下正文来自操作者显式调用的 Skill，是可复用的程序性知识；按其中的指引完成任务，原始请求由会话提供。",
		"",
		text,
		...(guidance ? ["", guidance] : []),
	].join("\n");
	return {
		text: expanded,
		displayText: rawArgs.trim() ? `/skill ${name} ${rawArgs}` : `/skill ${name}`,
		data: {
			skill: entry.name,
			revision: entry.revision,
			source: entry.sourceId,
			root: entry.root,
			arguments: args.raw,
		},
	};
}
