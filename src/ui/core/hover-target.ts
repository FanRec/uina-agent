/**
 * 鼠标热区标识的编码与解码。
 *
 * 此前生产端（`ui-host.ts` 注册 interactive targets）与消费端（hover 分派）相隔 150 行，
 * 各自拿字面星串拼/拆 `thinking:...`、`tool:...`、`rail-tick-...`，格式靠人脑同步：
 * 改一处忘一处，编译器不会说话。把协议收成一个判别联合后，新增热区只需改这里，
 * 且 `switch` + `never` 会强制所有分支穷尽。
 *
 * 纯字符串逻辑、不依赖时间与终端 —— 因此可以真单测（不像滚动/鼠标时序）。
 *
 * 格式刻意与既有字节串保持一致（冒号用于携带多个字段的三类，连字符用于单字段的行类），
 * 以免改动协议本身。
 */

/** 一条热区标识所表达的全部事实。 */
export type HoverTarget =
	| { kind: "thinking"; uid: number }
	| { kind: "tool"; callId: string; line: number }
	| { kind: "compaction"; index: number; line: number }
	| { kind: "rail-tick"; turnUid: number }
	| { kind: "rail-up" }
	| { kind: "rail-down" }
	| { kind: "scrollbar-row"; row: number }
	| { kind: "help-overlay-row"; row: number }
	| { kind: "context-progress" };

export function encodeHoverTarget(target: HoverTarget): string {
	switch (target.kind) {
		case "thinking":
			return `thinking:${target.uid}`;
		case "tool":
			return `tool:${target.callId}:${target.line}`;
		case "compaction":
			return `compaction:${target.index}:${target.line}`;
		case "rail-tick":
			return `rail-tick-${target.turnUid}`;
		case "scrollbar-row":
			return `scrollbar-row-${target.row}`;
		case "help-overlay-row":
			return `help-overlay-row-${target.row}`;
		case "rail-up":
			return "rail-up";
		case "rail-down":
			return "rail-down";
		case "context-progress":
			return "context-progress";
		default: {
			// 穷尽性检查：新增 kind 却忘了在这里编码，会在此编译失败。
			const _exhaustive: never = target;
			return _exhaustive;
		}
	}
}

/** 解析一整数字段；非合法整数返回 null（调用方据此放弃该热区，而不是拿去用）。 */
function intOrNull(text: string | undefined): number | null {
	if (text === undefined) return null;
	const n = parseInt(text, 10);
	return Number.isInteger(n) ? n : null;
}

/**
 * 解出热区标识。无法识别时返回 null —— 这里的 null 是"没有热区"这一**正常结果**，
 * 不是错误，因此不抛异常。
 */
export function decodeHoverTarget(id: string): HoverTarget | null {
	if (id === "rail-up") return { kind: "rail-up" };
	if (id === "rail-down") return { kind: "rail-down" };
	if (id === "context-progress") return { kind: "context-progress" };

	if (id.startsWith("thinking:")) {
		const uid = intOrNull(id.slice("thinking:".length));
		return uid === null ? null : { kind: "thinking", uid };
	}
	if (id.startsWith("tool:")) {
		const parts = id.split(":");
		const line = intOrNull(parts[2]);
		const callId = parts[1];
		return callId === undefined || callId === "" || line === null
			? null
			: { kind: "tool", callId, line };
	}
	if (id.startsWith("compaction:")) {
		const parts = id.split(":");
		const index = intOrNull(parts[1]);
		const line = intOrNull(parts[2]);
		return index === null || line === null ? null : { kind: "compaction", index, line };
	}
	if (id.startsWith("rail-tick-")) {
		const turnUid = intOrNull(id.slice("rail-tick-".length));
		return turnUid === null ? null : { kind: "rail-tick", turnUid };
	}
	if (id.startsWith("scrollbar-row-")) {
		const row = intOrNull(id.slice("scrollbar-row-".length));
		return row === null ? null : { kind: "scrollbar-row", row };
	}
	if (id.startsWith("help-overlay-row-")) {
		const row = intOrNull(id.slice("help-overlay-row-".length));
		return row === null ? null : { kind: "help-overlay-row", row };
	}
	return null;
}
