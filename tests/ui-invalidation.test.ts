/**
 * 失效粒度对拍：增量容器 vs 每步全量重建的容器。
 *
 * 失效分级后，轮内变更/timeline 追加不再发全量失效信号，正确性完全依赖
 * 「buildSettledBlocks 的 builtItems 差额物化 + 定点失效」。这里用两条等价
 * 路径对拍：B 在每一步后强制 invalidate()（全量重建），A 走生产路径；
 * 两者逐行、逐索引必须一致。任何漏发失效都会在这里现形。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TranscriptContainer } from "../src/ui/components/transcript/transcript.js";
import { toolDoneNode, toolStartNode } from "./harness/index.js";

const W = 117;

type Step = (container: TranscriptContainer) => void;

const STEPS: Step[] = [
	(t) => t.startTurn(1, "第一轮：帮我看看这个函数为什么慢"),
	(t) => t.appendToken("我先读一下文件，然后给你结论。\n\n"),
	(t) => t.startTool(toolStartNode("read_file", { path: "src/a.ts" }, "call-1")),
	(t) => t.addToolDone(toolDoneNode("read_file", "文件内容\n".repeat(6), 12, "succeeded", "call-1")),
	(t) => t.startTool(toolStartNode("exec_command", { command: "pnpm test" }, "call-2")),
	(t) => t.addToolDone(toolDoneNode("exec_command", "exit 1\nat least one failure", 300, "failed", "call-2")),
	(t) => t.appendToken("结论如下：\n\n第二段结论。"),
	(t) => t.finishTurn(),
	(t) => t.addNotice("会话已压缩"),
	(t) => t.startTurn(2, "第二轮：继续"),
	(t) => t.appendToken("继续分析。"),
	// history 分支：结果落在已结算轮的旧工具上
	(t) => t.addToolDone(toolDoneNode("read_file", "补充内容", 20, "succeeded", "call-1")),
	(t) => t.addToolDone(toolDoneNode("exec_command", "重试成功", 120, "succeeded", "call-2")),
	(t) => t.addPromptSnapshot({ kind: "prompt", id: "p1", turnNumber: 2, systemPrompt: "sys", injections: [] }),
	(t) => t.addCustomMessage({ customType: "demo", content: "hello" }),
	(t) =>
		t.addCompaction({
			status: "completed",
			summary: "摘要",
			retainedTailEntries: 2,
			tokensBefore: 1000,
			collapsed: true,
		}),
	(t) => t.appendThinking("推理中……"),
	(t) => t.finishTurn(),
	// 交互类：展开/收起落在已结算块上
	(t) => t.toggleTool("call-2", W),
	(t) => t.toggleAllTools(false),
	(t) => t.toggleAllThinking(false),
	(t) => t.addError("boom"),
];

function applyAll(steps: readonly Step[], forceInvalidate: boolean): TranscriptContainer {
	const container = new TranscriptContainer();
	container.setRendererResolver({ message: () => undefined, tool: () => undefined, markdown: (text) => text });
	for (const step of steps) {
		step(container);
		if (forceInvalidate) container.invalidate();
	}
	return container;
}

describe("失效粒度对拍（增量 vs 每步全量重建）", () => {
	const realNow = Date.now;
	let clock = 1_700_000_000_000;

	beforeAll(() => {
		Date.now = () => clock;
	});
	afterAll(() => {
		Date.now = realNow;
	});

	for (let prefix = 1; prefix <= STEPS.length; prefix++) {
		it(`前 ${prefix} 步后逐行/逐索引一致`, () => {
			// 冻结时钟：运行中工具卡的秒表按真实时间走，两个容器的构建时刻差会让行不可比
			const incremental = applyAll(STEPS.slice(0, prefix), false);
			const rebuilt = applyAll(STEPS.slice(0, prefix), true);
			expect(incremental.getFrameModel(W).lines).toEqual(rebuilt.getFrameModel(W).lines);
			expect(incremental.getTurnStartLinesByUid(W)).toEqual(rebuilt.getTurnStartLinesByUid(W));
			expect(incremental.getToolLineIndices(W).map((l) => [l.callId, l.lineIndex, l.lineCount])).toEqual(
				rebuilt.getToolLineIndices(W).map((l) => [l.callId, l.lineIndex, l.lineCount]),
			);
			expect(incremental.getThinkingLineIndices(W).map((l) => [l.lineIndex, l.lineCount])).toEqual(
				rebuilt.getThinkingLineIndices(W).map((l) => [l.lineIndex, l.lineCount]),
			);
			expect(incremental.getCompactionLineIndices(W).map((l) => [l.index, l.lineIndex])).toEqual(
				rebuilt.getCompactionLineIndices(W).map((l) => [l.index, l.lineIndex]),
			);
		});
	}

	it("宽度切换后回到原宽度内容一致（LRU 双槽语义）", () => {
		const container = applyAll(STEPS, false);
		const at117 = container.getFrameModel(W).lines;
		const at80 = container.getFrameModel(80).lines;
		// 回到原宽度：LRU 未淘汰（2 槽），内容必须与首次一致
		expect(container.getFrameModel(W).lines).toEqual(at117);
		expect(at80.length).toBeGreaterThan(0);
	});
});
