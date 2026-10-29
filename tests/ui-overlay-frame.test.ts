/**
 * W3 浮层边框不变量：所有居中面板与看板的每一行都必须精确等于其框宽。
 *
 * - 布局原语（renderPanel / panelRow / panelDivider）在任何宽度下行宽精确；
 * - 六个浮层（help/effort/picker/prompt/trajectory/branch）整框行宽一致，
 *   `╯` 不再被 `…` 吃掉，内容行不再比边框宽 2 列；
 * - 每行可视宽度 <= 终端宽度。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import {
	listSessionBranches,
	listSessionNodes,
	readSessionBranch,
	readSessionNode,
} from "../src/session/navigation.js";
import { visibleWidth } from "../src/ui/core/utils.js";
import { BranchInspectorOverlay } from "../src/ui/features/overlays/branch-inspector.js";
import { EffortSlider } from "../src/ui/features/overlays/effort-slider.js";
import { HelpMenu } from "../src/ui/features/overlays/help-menu.js";
import { ModelPicker } from "../src/ui/features/overlays/model-picker.js";
import { PromptOverlay } from "../src/ui/features/overlays/prompt-overlay.js";
import { TrajectoryScene } from "../src/ui/features/overlays/trajectory-scene.js";
import {
	panelBottomBorder,
	panelCrossDivider,
	panelDivider,
	panelInnerWidth,
	panelRow,
	panelSplitRow,
	panelTopBorder,
	renderPanel,
} from "../src/ui/layout/panel.js";

const WIDTHS = [40, 56, 64, 80, 120, 160, 200];

describe("布局原语：宽度守卫", () => {
	it("renderPanel 每行精确 boxWidth", () => {
		for (const boxWidth of [20, 40, 54, 78, 92, 120, 200]) {
			const rows = renderPanel({
				title: "标题会很长很长很长很长很长很长很长很长很长很长",
				body: ["短行", "一行很长的内容".repeat(6), ""],
				footer: "页脚提示",
				bottomTag: "底部提示",
				boxWidth,
				leftPad: 2,
			});
			for (const row of rows) {
				expect(visibleWidth(row)).toBe(boxWidth + 2);
			}
		}
	});

	it("panelRow / panelDivider / 顶底边框 / 双栏行各自精确", () => {
		for (const boxWidth of WIDTHS) {
			expect(visibleWidth(panelTopBorder(boxWidth, { title: "标题" }))).toBe(boxWidth);
			expect(visibleWidth(panelRow("内容", boxWidth))).toBe(boxWidth);
			expect(visibleWidth(panelDivider(boxWidth))).toBe(boxWidth);
			expect(visibleWidth(panelBottomBorder(boxWidth, { tag: "提示" }))).toBe(boxWidth);
			const midCol = Math.floor(boxWidth / 2);
			expect(visibleWidth(panelSplitRow(boxWidth, "左栏", "右栏", midCol))).toBe(boxWidth);
			expect(visibleWidth(panelCrossDivider(boxWidth, [midCol]))).toBe(boxWidth);
			expect(panelInnerWidth(boxWidth)).toBe(boxWidth - 4);
		}
	});

	it("内容行不会因宽 SGR 截断破坏行宽", () => {
		const styled = `\x1b[38;2;125;161;222m中文内容与 ANSI 混排的很长一行\x1b[0m`;
		for (const boxWidth of [30, 44, 60]) {
			const row = panelRow(styled, boxWidth);
			expect(visibleWidth(row)).toBe(boxWidth);
		}
	});
});

describe("浮层整框宽度一致", () => {
	function assertUniform(name: string, lines: readonly string[], maxWidth: number): void {
		expect(lines.length, name).toBeGreaterThan(0);
		const widths = new Set(lines.map((l) => visibleWidth(l)));
		expect(widths.size, `${name} 行宽不齐`).toBe(1);
		for (const line of lines) {
			expect(visibleWidth(line), name).toBeLessThanOrEqual(maxWidth);
		}
	}

	it("help 宽屏双栏与紧凑单栏", () => {
		const help = new HelpMenu([]);
		for (const width of [64, 80, 120]) {
			assertUniform(`help(${width})`, help.formatLines(width, 100), width);
		}
		for (const width of [40, 50, 63]) {
			assertUniform(`help compact(${width})`, help.formatLines(width, 100), width);
		}
	});

	it("effort 滑块", () => {
		const slider = new EffortSlider("high", ["off", "low", "high", "max"]);
		for (const width of [40, 64, 80, 120]) {
			assertUniform(`effort(${width})`, slider.formatLines(width, 100), width);
		}
	});

	it("model-picker：分组/模型/空列表", () => {
		const groups = [
			{
				id: "g1",
				name: "分组一",
				description: "描述文本",
				provider: "p",
				models: [
					{ id: "p/m1", name: "模型一", description: "很长的模型描述".repeat(4), provider: "p" },
					{ id: "p/m2", name: "模型二", description: "另一个", provider: "p" },
				],
			},
		];
		const picker = new ModelPicker("p/m1", groups);
		for (const width of [40, 64, 80, 120]) {
			assertUniform(`picker groups(${width})`, picker.formatLines(width, 100), width);
			picker.confirm();
			assertUniform(`picker models(${width})`, picker.formatLines(width, 100), width);
			picker.back();
		}
		assertUniform("picker empty", new ModelPicker(undefined, []).formatLines(80, 100), 80);
	});

	it("prompt 查询面板", () => {
		const prompt = new PromptOverlay(undefined);
		for (const width of [40, 64, 80, 120]) {
			assertUniform(`prompt(${width})`, prompt.render(width, 24), width);
		}
	});

	it("trajectory 看板：空态宽屏与紧凑", () => {
		const emptySource = { list: () => [], aggregate: () => [] };
		const scene = new TrajectoryScene(emptySource);
		for (const width of [64, 80, 120]) {
			assertUniform(`trajectory(${width})`, scene.formatLines(width, 30), width);
		}
		for (const width of [40, 50, 63]) {
			assertUniform(`trajectory compact(${width})`, scene.formatLines(width, 20), width);
		}
	});

	it("branch 检视器：主线/分支选择/分支历史", async () => {
		const store = new MemorySessionStore();
		for (let i = 0; i < 24; i++) {
			await store.appendMessage({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `第 ${i} 条会话消息 ${"中文内容".repeat((i % 3) + 1)}`,
			});
		}
		const targetId = store.readRecords()[8]!.id;
		await store.appendMessage({ role: "assistant", content: "分支回复内容\n第二行也很长很长的中文描述文本" });
		await store.appendRewind({
			id: "rewind-frame-test",
			requestId: "q1",
			targetId,
			fromId: store.readRecords().at(-1)!.id,
			source: "model",
			reason: "边框不变量验证回溯",
		});
		const view = new BranchInspectorOverlay({
			list: (options?: Parameters<typeof listSessionNodes>[1]) => listSessionNodes(store.state, options),
			listBranches: () => listSessionBranches(store.state),
			readBranch: (id: string) => readSessionBranch(store.state, id),
			read: (id: string) => readSessionNode(store.state, id),
		} as never);
		for (const width of [64, 80, 120]) {
			assertUniform(`branch main(${width})`, view.render(width, 24), width);
		}
	});
});

describe("布局原语 allowlist", () => {
	it("src/ui 内截断/折行只允许出现在 layout/fit.ts", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts")) {
					if (full.replace(/\\/g, "/").endsWith("src/ui/layout/fit.ts")) continue;
					const text = readFileSync(full, "utf8");
					if (text.includes("truncateToWidth") || text.includes("wrapTextWithAnsi")) {
						offenders.push(full);
					}
				}
			}
		};
		walk(join(import.meta.dirname, "../src/ui"));
		expect(offenders, "组件必须经 layout/fit.ts 截断").toEqual([]);
	});
});
