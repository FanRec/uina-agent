/**
 * CRAP 存量债务 C2：projectWaveBand 波形投影的覆盖补齐（此前 comp≥8 且 0% 覆盖）。
 */
import { describe, expect, it } from "vitest";
import type { TrajectoryNode } from "../src/presentation/trajectory.js";
import { projectWaveBand } from "../src/ui/features/overlays/trajectory-scene.js";

function node(overrides: Partial<TrajectoryNode> = {}): TrajectoryNode {
	return {
		id: "n1",
		kind: "model_stream",
		name: "stream",
		label: "stream",
		status: "completed",
		startedAt: 1_000,
		endedAt: 2_000,
		...overrides,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

describe("projectWaveBand 波形投影", () => {
	it("width<=0 返回空对；无事件返回两行等宽空白", () => {
		expect(projectWaveBand([], 0, 0)).toEqual(["", ""]);
		const empty = projectWaveBand([], 10, 0);
		expect(empty).toEqual([" ".repeat(10), " ".repeat(10)]);
	});

	it("单事件：所在列出现实心柱，其余列为占位点；光标列第二行标 ▲", () => {
		const band = projectWaveBand([node()], 8, 0);
		expect(band).toHaveLength(2);
		const [line1, line2] = band.map(stripAnsi);
		expect(line1).toHaveLength(8);
		expect(line2).toHaveLength(8);
		// midTime=1500 落在 span [1000,2000] 的中点 → col 4 有柱
		expect(line1![4]).toMatch(/[▂▃▄▅▆▇█]/);
		expect(line2![4]).toBe("▲");
		expect(line1!.replace(/[▂▃▄▅▆▇█·]/g, "")).toBe("");
		expect(line2!.replace(/▲/g, "")).toMatch(/^ *$/);
	});

	it("错误事件列染红、工具事件列染黄、普通列青色", () => {
		const failed = projectWaveBand([node({ status: "failed" })], 4, -1);
		expect(failed[0]).toContain("\x1b[31m");
		const tool = projectWaveBand([node({ kind: "tool_call" })], 4, -1);
		expect(tool[0]).toContain("\x1b[33m");
		const plain = projectWaveBand([node()], 4, -1);
		expect(plain[0]).toContain("\x1b[36m");
	});

	it("列密度决定柱高：count=1 取 ▂，高密度取 █", () => {
		// 4 个事件落在同一列 → heightVal=min(8,8)=8 → █
		const dense = projectWaveBand([node(), node(), node(), node()], 2, -1);
		expect(stripAnsi(dense[0]!)).toContain("█");
		// 单事件 → ▂
		const sparse = projectWaveBand([node()], 2, -1);
		expect(stripAnsi(sparse[0]!)).toContain("▂");
	});

	it("cursorIndex 指向的事件列获得反显高亮与 ▲ 指示", () => {
		const nodes = [
			node({ id: "a", startedAt: 1_000, endedAt: 1_500 }),
			node({ id: "b", startedAt: 5_000, endedAt: 6_000 }),
		];
		const band = projectWaveBand(nodes, 10, 1);
		// 反显标记在原始行上（剥 ANSI 后消失）
		expect(band[0]).toContain("\x1b[7m");
		const [line1, line2] = band.map(stripAnsi);
		expect(line2).toContain("▲");
		// col a=0、col b=9（midTime 5500/5000*10），光标在事件 b 所在列
		expect(line1!.lastIndexOf("▂")).toBe(9);
		expect(line2!.indexOf("▲")).toBe(9);
	});
});
