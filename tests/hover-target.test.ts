/**
 * 鼠标热区协议：编码与解码互为逆运算，且对垃圾输入返回 null（而非抛错或半解析）。
 *
 * 这是 P1.1 能真单测的原因 —— 它是纯字符串逻辑，不依赖终端时序。
 */
import { describe, expect, it } from "vitest";
import { decodeHoverTarget, encodeHoverTarget, type HoverTarget } from "../src/ui/core/hover-target.js";

const ALL: HoverTarget[] = [
	{ kind: "thinking", uid: 42 },
	{ kind: "tool", callId: "call_abc", line: 7 },
	{ kind: "compaction", index: 3, line: 11 },
	{ kind: "rail-tick", turnUid: 5 },
	{ kind: "rail-up" },
	{ kind: "rail-down" },
	{ kind: "scrollbar-row", row: 9 },
	{ kind: "help-overlay-row", row: 2 },
	{ kind: "context-progress" },
];

describe("hover-target：编解码往返", () => {
	it("每个 kind 都能编码后原样解回", () => {
		for (const target of ALL) {
			const id = encodeHoverTarget(target);
			expect(decodeHoverTarget(id), `id=${id}`).toEqual(target);
		}
	});

	it("编码结果与既有协议字节一致（不改变线上格式）", () => {
		expect(encodeHoverTarget({ kind: "thinking", uid: 42 })).toBe("thinking:42");
		expect(encodeHoverTarget({ kind: "tool", callId: "call_abc", line: 7 })).toBe("tool:call_abc:7");
		expect(encodeHoverTarget({ kind: "compaction", index: 3, line: 11 })).toBe("compaction:3:11");
		expect(encodeHoverTarget({ kind: "rail-tick", turnUid: 5 })).toBe("rail-tick-5");
		expect(encodeHoverTarget({ kind: "scrollbar-row", row: 9 })).toBe("scrollbar-row-9");
		expect(encodeHoverTarget({ kind: "help-overlay-row", row: 2 })).toBe("help-overlay-row-2");
		expect(encodeHoverTarget({ kind: "rail-up" })).toBe("rail-up");
		expect(encodeHoverTarget({ kind: "rail-down" })).toBe("rail-down");
		expect(encodeHoverTarget({ kind: "context-progress" })).toBe("context-progress");
	});
});

describe("hover-target：无法识别与畸形输入", () => {
	it("未知前缀返回 null（没有热区是正常结果，不是错误）", () => {
		expect(decodeHoverTarget("nope:1")).toBeNull();
		expect(decodeHoverTarget("")).toBeNull();
		expect(decodeHoverTarget("thinking-42")).toBeNull(); // 连字符不是 thinking 的分隔符
		expect(decodeHoverTarget("rail-up-extra")).toBeNull();
	});

	it("字段缺失或非整数一律返回 null，不做半解析", () => {
		expect(decodeHoverTarget("thinking:")).toBeNull();
		expect(decodeHoverTarget("thinking:abc")).toBeNull();
		expect(decodeHoverTarget("tool:call_abc")).toBeNull(); // 缺 line
		expect(decodeHoverTarget("tool::7")).toBeNull(); // 缺 callId
		expect(decodeHoverTarget("tool:call_abc:xx")).toBeNull();
		expect(decodeHoverTarget("compaction:3")).toBeNull(); // 缺 line
		expect(decodeHoverTarget("compaction::11")).toBeNull(); // 缺 index
		expect(decodeHoverTarget("rail-tick-")).toBeNull();
		expect(decodeHoverTarget("scrollbar-row-x")).toBeNull();
		expect(decodeHoverTarget("help-overlay-row-")).toBeNull();
	});

	it("callId 自身含冒号属于无法解析（字段顺序会错位，宁可放弃也不要半解析）", () => {
		// 生产端 callId 里若混进冒号，第 3 段就不是行号了；此时解出来的 line 会错，
		// 因此必须返回 null，让消费端当作"没有热区"，而不是拿一个错位的坐标去高亮。
		expect(decodeHoverTarget("tool:weird:id:12")).toBeNull();
	});
});
