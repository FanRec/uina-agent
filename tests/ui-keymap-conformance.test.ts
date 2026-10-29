/**
 * W5 键位一致性：页脚提示由 keymap 生成，提示写什么、按键就做什么。
 *
 * - 每个可交互浮层都有显式 capturing keymap；
 * - 提示文本中的每个键段都能 resolve 到动作（生成即一致）；
 * - F1/F3/F5/F7 的具体行为断言。
 */

import { describe, expect, it } from "vitest";
import type { ModelPickerGroup } from "../src/extensions/ui-contract.js";
import type { TrajectoryEventSource, TrajectoryNode } from "../src/presentation/trajectory.js";
import { MemorySessionStore } from "../src/session/jsonl-store.js";
import {
	listSessionBranches,
	listSessionNodes,
	readSessionBranch,
	readSessionNode,
} from "../src/session/navigation.js";
import { stripAnsi } from "../src/ui/core/utils.js";
import { BranchInspectorOverlay } from "../src/ui/features/overlays/branch-inspector.js";
import { EffortSlider } from "../src/ui/features/overlays/effort-slider.js";
import { HelpMenu } from "../src/ui/features/overlays/help-menu.js";
import { ModelPicker } from "../src/ui/features/overlays/model-picker.js";
import { PromptOverlay } from "../src/ui/features/overlays/prompt-overlay.js";
import { TrajectoryScene } from "../src/ui/features/overlays/trajectory-scene.js";
import { hintsFor, resolve } from "../src/ui/keys/keymap.js";

/** 常见 KeyToken 的真实字节序列：round-trip 用；字节用字符码构造，避免源码里出现裸控制字符。 */
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const KEY_BYTES: Record<string, string> = {
	up: `${CSI}A`,
	down: `${CSI}B`,
	right: `${CSI}C`,
	left: `${CSI}D`,
	enter: String.fromCharCode(13),
	escape: ESC,
	tab: String.fromCharCode(9),
	pageup: `${CSI}5~`,
	pagedown: `${CSI}6~`,
};
const GROUPS: ModelPickerGroup[] = [
	{
		id: "g1",
		name: "分组一",
		description: "描述",
		models: [
			{ id: "p/m1", name: "模型一", description: "一", provider: "p" },
			{ id: "p/m2", name: "模型二", description: "二", provider: "p" },
		],
	},
];

function trajectorySource(nodes: TrajectoryNode[]): TrajectoryEventSource {
	return { list: () => nodes, aggregate: () => [] };
}

describe("键位一致性：结构", () => {
	const overlays: readonly [string, { keymap(): unknown }][] = [
		["help", new HelpMenu([])],
		["effort", new EffortSlider("high", ["off", "high", "max"])],
		["prompt", new PromptOverlay(undefined)],
		["picker", new ModelPicker("p/m1", GROUPS)],
		["trajectory", new TrajectoryScene(trajectorySource([]))],
		["branch", new BranchInspectorOverlay({} as never)],
	];

	it("每个可交互浮层都有 capturing keymap，且每条绑定可 resolve", () => {
		for (const [name, overlay] of overlays) {
			const map = (overlay as { keymap(): import("../src/ui/keys/keymap.js").Keymap }).keymap();
			expect(map.capturing, `${name} 必须显式声明 capturing`).toBe(true);
			expect(map.bindings.length, `${name} 至少有一条关闭/导航绑定`).toBeGreaterThan(0);
			for (const binding of map.bindings) {
				expect(binding.action.startsWith("overlay."), `${name} 动作 id 命名空间`).toBe(true);
				expect(binding.keys.length, `${name} ${binding.action} 必须声明键`).toBeGreaterThan(0);
				// round-trip：绑定声明的主键必须能解析回该动作
				const primary = binding.keys[0]!;
				const data = KEY_BYTES[primary] ?? primary;
				expect(resolve(map, data), `${name} ${primary}`).toBe(binding.action);
			}
		}
	});

	it("页脚提示 = hintsFor 输出（提示与绑定同源）", () => {
		const help = new HelpMenu([]);
		const rendered = stripAnsi(help.formatLines(80, 100).join("\n"));
		const hint = hintsFor(help.keymap(), 200);
		expect(rendered).toContain(hint);

		const picker = new ModelPicker("p/m1", GROUPS);
		const pickerText = stripAnsi(picker.formatLines(80, 100).join("\n"));
		expect(pickerText).toContain(hintsFor(picker.keymap(), 200));
	});
});

describe("F1：轨迹页脚不再承诺不存在的 Enter 展开", () => {
	it("hint 无 Enter；e 下一错误生效", () => {
		const now = 1_700_000_000_000;
		const nodes: TrajectoryNode[] = [
			{ id: "n1", kind: "model_stream", name: "a", label: "a", status: "completed", startedAt: now, endedAt: now + 10 },
			{ id: "n2", kind: "tool_call", name: "x", label: "b", status: "failed", startedAt: now + 20, endedAt: now + 30 },
			{
				id: "n3",
				kind: "model_stream",
				name: "c",
				label: "c",
				status: "completed",
				startedAt: now + 40,
				endedAt: now + 50,
			},
		];
		const scene = new TrajectoryScene(trajectorySource(nodes));
		const text = stripAnsi(scene.formatLines(80, 30).join("\n"));
		expect(text).not.toContain("Enter");
		expect(text).toContain("e 下一错误");

		// e 跳到下一个失败节点
		scene.handleInput("e");
		expect(scene["cursorIndex"]).toBe(1);
	});
});

describe("F3：提示词浮层方向键与位置指示", () => {
	it("页脚声明 ↑/↓ 且滚动生效；Esc 关闭", () => {
		const prompt = new PromptOverlay({
			kind: "prompt",
			id: "p1",
			turnNumber: 1,
			systemPrompt: Array.from({ length: 40 }, (_, i) => `第 ${i} 行系统提示`).join("\n"),
			injections: [],
		});
		const text = stripAnsi(prompt.render(80, 24).join("\n"));
		expect(text).toContain("↑/↓ 1 行");
		expect(text).toContain("第 1-");
		expect(text).toContain("Esc 关闭");
	});
});

describe("F5：帮助菜单关闭键限定", () => {
	it("普通可打印字符不再关闭；? 转输入；Esc 关闭", () => {
		const menu = new HelpMenu([]);
		let closed = 0;
		let converted: string | undefined;
		menu.onClose = () => closed++;
		menu.onConvertToInput = (text) => {
			converted = text;
			closed++;
		};

		menu.handleInput("x");
		menu.handleInput("q");
		menu.handleInput(" ");
		expect(closed).toBe(0);

		menu.handleInput("?");
		expect(converted).toBe("?");
		menu.handleInput(KEY_BYTES.escape!);
		expect(closed).toBe(2);
	});
});

describe("F7：分支检视提示按焦点与视图生成", () => {
	async function seed(): Promise<BranchInspectorOverlay> {
		const store = new MemorySessionStore();
		await store.appendMessage({ role: "user", content: "一" });
		const targetId = store.readRecords()[0]!.id;
		await store.appendMessage({ role: "assistant", content: "分支内容" });
		await store.appendRewind({
			id: "rw",
			requestId: "q",
			targetId,
			fromId: store.readRecords().at(-1)!.id,
			source: "model",
			reason: "键位测试",
		});
		return new BranchInspectorOverlay({
			list: (options?: Parameters<typeof listSessionNodes>[1]) => listSessionNodes(store.state, options),
			listBranches: () => listSessionBranches(store.state),
			readBranch: (id: string) => readSessionBranch(store.state, id),
			read: (id: string) => readSessionNode(store.state, id),
		} as never);
	}

	it("主线列表：无 Enter 选择提示；Esc 写关闭", async () => {
		const view = await seed();
		const text = stripAnsi(view.render(80, 24).join("\n"));
		expect(text).toContain("Esc 关闭");
		expect(text).toContain("Tab 焦点");
		expect(text).not.toContain("选择分支");
	});

	it("分支选择视图：Enter 选择分支可见", async () => {
		const view = await seed();
		view.handleInput(KEY_BYTES.right!); // ←/→ 切到分支列表
		const text = stripAnsi(view.render(80, 24).join("\n"));
		expect(text).toContain("Enter 选择分支");
	});

	it("详情焦点：提示按详情实际能力生成", async () => {
		const view = await seed();
		view.handleInput(KEY_BYTES.tab!); // Tab → detail 焦点
		const text = stripAnsi(view.render(80, 24).join("\n"));
		// 详情可翻页时显示 X/Y；内容不足一页时显式说“已到边界”，不再写静态承诺
		expect(text).toContain("←/→ 详情");
	});
});

describe("F4：effort 预览/提交/回滚", () => {
	it("←/→ 只预览；Enter 提交一次；Esc 回滚不写回", () => {
		const changed: string[] = [];
		const slider = new EffortSlider("low", ["off", "low", "high"]);
		slider.onChange = (level) => changed.push(level);
		slider.handleInput(KEY_BYTES.right!);
		expect(slider.getActiveTierId()).toBe("low");
		slider.handleInput(KEY_BYTES.enter!);
		expect(changed).toEqual(["high"]);
		slider.handleInput(KEY_BYTES.left!);
		slider.handleInput(KEY_BYTES.escape!);
		expect(changed).toEqual(["high"]);
	});

	it("A6：不存在编造的默认档位表", async () => {
		const module = await import("../src/ui/features/overlays/effort-slider.js");
		expect("DEFAULT_EFFORT_TIERS" in module).toBe(false);
	});
});
