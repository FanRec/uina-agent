/**
 * 表达输出协议词汇（跨层共享：agent 解释、session 校验、presentation 回放）。
 *
 * 模型 `content` 通道中的受限标记协议（Block 与 Marker 两类）由 Output
 * Interpretation 唯一解释；这里只放合同类型与确定规则，不承载执行语义。
 * ExpressionEvent 是结构事实，不是行动命令。
 */

/** 扩展注册的输出标签合同（注册名在一个 Host 内唯一，重名拒绝并报告所有者）。 */
export interface OutputTagRegistration {
	readonly name: string;
	readonly kind: "block" | "marker";
	/** marker 属性合同：值为 "required-string" 或 "optional-string"。block 无属性。 */
	readonly attributes?: Readonly<Record<string, "required-string" | "optional-string">>;
}

/** 每个 content stream 的 output_start 冻结的语法快照；中途卸载不改变该流文本如何解释。 */
export type OutputTagSnapshot = ReadonlyMap<string, OutputTagRegistration>;

export interface ExpressionScope {
	readonly blockId: string;
	readonly name: string;
}

/** 增量语义事件。rawRange 是完整原始 content 中的 UTF-16 半开区间 [start, end)。 */
export type ExpressionEvent =
	| {
			kind: "text";
			streamId: string;
			text: string;
			/** Block 外的 text 没有 scope；Block 内指向当前 blockId/name。 */
			scope?: ExpressionScope;
			rawRange: readonly [number, number];
	  }
	| { kind: "block_start"; streamId: string; blockId: string; name: string; rawRange: readonly [number, number] }
	| {
			kind: "block_end";
			streamId: string;
			blockId: string;
			name: string;
			reason: "closed" | "ended" | "interrupted";
			/** 显式关闭标签有区间；ended/interrupted 隐式收尾没有关闭标签区间。 */
			rawRange?: readonly [number, number];
	  }
	| {
			kind: "marker";
			streamId: string;
			name: string;
			attributes: Readonly<Record<string, string>>;
			/** 位于 Block 内时携带所属 blockId。 */
			blockId?: string;
			rawRange: readonly [number, number];
	  };

/** 随 Assistant canonical 持久化的最小注解：只记录已识别标签，不保存清洗过的全文。 */
export type ExpressionTagAnnotation =
	| { kind: "block_start"; name: string; blockId: string; rawRange: readonly [number, number] }
	| { kind: "block_end"; name: string; blockId: string; reason: "closed"; rawRange: readonly [number, number] }
	// 隐式结束不占原文
	| { kind: "block_end"; name: string; blockId: string; reason: "ended" | "interrupted" }
	| {
			kind: "marker";
			name: string;
			blockId?: string;
			attributes: Readonly<Record<string, string>>;
			rawRange: readonly [number, number];
	  };

export interface ExpressionAnnotation {
	readonly version: 1;
	readonly streamId: string;
	readonly tags: readonly ExpressionTagAnnotation[];
}

/**
 * 从原文剔除已识别表达标签的语法字节，保留其余原文（含 Block 内文本）。
 * 展示回放与模型历史视图共用这一条确定规则；没有注解的历史原样返回。
 */
export function stripExpressionTags(content: string, annotation?: ExpressionAnnotation): string {
	if (!annotation || annotation.tags.length === 0) return content;
	const ranges = annotation.tags
		.map((tag) => ("rawRange" in tag ? tag.rawRange : undefined))
		.filter((range): range is readonly [number, number] => range !== undefined)
		.sort((a, b) => a[0] - b[0]);
	if (ranges.length === 0) return content;
	let result = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start < cursor) continue;
		result += content.slice(cursor, start);
		cursor = Math.min(end, content.length);
	}
	result += content.slice(cursor);
	return result;
}
