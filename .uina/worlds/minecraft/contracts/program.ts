/**
 * Program 与 Library 公共类型（I1 阶段仅落目录/发现所需形状）。
 *
 * 唯一定义来源：docs/proposals/mc/modules/program.md §7 与 library.md §5。
 * 完整 ProgramPort/ProgramCapacity/LibraryPort 端口随 P 工作包引入；
 * 本文件先给 DiscoveryEntry 引用的 ProgramDescription 与 SourceRequest。
 */

import type { ExactRef, JsonValue } from "./values.js";

/** 程序以 {name} 或 {code} 提交；Runtime 受理时解析成确切字节。 */
export type SourceRequest = { name: string } | { code: string };

/** Library 程序文件头解析出的可选契约与描述。 */
export interface ProgramDescription {
	name: string;
	summary: string | null;
	tags: string[];
	path: string;
	/** 头声明的输入/输出契约；不声明则运行时按需校验。 */
	input?: JsonValue;
	output?: ExactRef;
	/** 头契约有明确错误码时列出；坏头保留原文诊断。 */
	errors?: { code: string; meaning: string }[];
}
