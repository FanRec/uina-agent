/**
 * CRAP 存量债务 C2：SubagentDashboard/SubagentDetailScene 的 handleInput 与
 * projectWaveBand 波形投影的覆盖补齐（三者此前 comp≥8 且 0% 覆盖）。
 */
import { describe, expect, it, vi } from "vitest";
import type { SubagentPort } from "../src/ui/features/overlays/subagent-dashboard.js";
import type { SubagentSnapshot } from "../src/extensions/subagents/types.js";
import { SubagentDashboard, SubagentDetailScene } from "../src/ui/features/overlays/subagent-dashboard.js";
import { projectWaveBand, type TrajectoryNode } from "../src/ui/features/overlays/trajectory-scene.js";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "agent-1",
		ownerId: "root",
		label: "worker",
		status: "running",
		createdAt: 1_000,
		outputCursor: 0,
		busy: false,
		...overrides,
	};
}

function port(agents: SubagentSnapshot[]) {
	return {
		list: () => agents,
		read: vi.fn(),
		transcript: vi.fn(),
		send: vi.fn(),
		interrupt: vi.fn().mockResolvedValue("interruption-requested"),
	} as unknown as SubagentPort & { interrupt: ReturnType<typeof vi.fn> };
}

describe("SubagentDashboard.handleInput（列表视图）", () => {
	it("Esc 关闭且不触发渲染回调", () => {
		const p = port([snapshot()]);
		const onClose = vi.fn();
		const onRequestRender = vi.fn();
		const dash = new SubagentDashboard(p);
		dash.onClose = onClose;
		dash.onRequestRender = onRequestRender;
		dash.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onRequestRender).not.toHaveBeenCalled();
	});

	it("↑/↓ 移动选中并双向夹取边界", () => {
		const p = port([snapshot({ id: "a" }), snapshot({ id: "b" }), snapshot({ id: "c" })]);
		const dash = new SubagentDashboard(p);
		dash.handleInput("\x1b[A"); // up 在 0 处：夹取仍为 0
		dash.handleInput("\x1b[B"); // down → 1
		dash.handleInput("\x1b[B"); // down → 2
		dash.handleInput("\x1b[B"); // down → 夹取在 2
		dash.handleInput("\r");
		expect(p.interrupt).not.toHaveBeenCalled();
		// onDrilldown 收到最后一个 agent
		const onDrilldown = vi.fn();
		dash.onDrilldown = onDrilldown;
		dash.handleInput("\r");
		expect(onDrilldown).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
	});

	it("i 中断只对 running/accepted 生效，settled 忽略", () => {
		const running = port([snapshot({ id: "run", status: "running" })]);
		const runningDash = new SubagentDashboard(running);
		runningDash.handleInput("i");
		expect(running.interrupt).toHaveBeenCalledWith("run", "root");

		const settled = port([snapshot({ id: "done", status: "settled" })]);
		const settledDash = new SubagentDashboard(settled);
		settledDash.handleInput("i");
		expect(settled.interrupt).not.toHaveBeenCalled();
	});
});

describe("SubagentDetailScene.handleInput（详情视图）", () => {
	function detail(status: SubagentSnapshot["status"]) {
		const p = port([snapshot({ id: "agent-1", status })]);
		const scene = new SubagentDetailScene("agent-1", p);
		return { p, scene };
	}

	it("Esc 关闭；Tab 切换标签页并复位滚动", () => {
		const { scene } = detail("running");
		const onClose = vi.fn();
		scene.onClose = onClose;
		scene.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
		const onRequestRender = vi.fn();
		scene.onRequestRender = onRequestRender;
		scene.handleInput("\x1b[A"); // scrollUp: 0→1
		scene.handleInput("\t"); // toggleTab + 复位
		// 复位后 scrollUp 又从 0→1；两次 Tab 往返 tabs
		scene.handleInput("\t");
		expect(onRequestRender).toHaveBeenCalled();
	});

	it("↑ 累加滚动、↓ 递减且不越 0", () => {
		const { scene } = detail("settled");
		const onRequestRender = vi.fn();
		scene.onRequestRender = onRequestRender;
		const scrollOf = () => (scene as unknown as { scrollOffset: number }).scrollOffset;
		scene.handleInput("\x1b[A");
		scene.handleInput("\x1b[A");
		expect(scrollOf()).toBe(2);
		scene.handleInput("\x1b[B");
		expect(scrollOf()).toBe(1);
		scene.handleInput("\x1b[B");
		scene.handleInput("\x1b[B");
		expect(scrollOf()).toBe(0);
	});

	it("i 中断仅对可中断状态生效", () => {
		const running = detail("running");
		running.scene.handleInput("i");
		expect(running.p.interrupt).toHaveBeenCalledWith("agent-1", "root");

		const settled = detail("settled");
		settled.scene.handleInput("i");
		expect(settled.p.interrupt).not.toHaveBeenCalled();
	});
});

function node(overrides: Partial<TrajectoryNode> = {}): TrajectoryNode {
	return {
		id: "n1",
		kind: "model_stream",
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
