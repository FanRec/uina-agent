import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../src/ui/core/utils.js";
import { BranchInspectorOverlay } from "../src/ui/features/overlays/branch-inspector.js";
import { EffortSlider } from "../src/ui/features/overlays/effort-slider.js";
import { HelpMenu } from "../src/ui/features/overlays/help-menu.js";
import { ModelPicker } from "../src/ui/features/overlays/model-picker.js";
import { PromptOverlay } from "../src/ui/features/overlays/prompt-overlay.js";
import { TrajectoryScene } from "../src/ui/features/overlays/trajectory-scene.js";
import { ContextBarComponent } from "../src/ui/components/widgets/context-bar.js";

const emptySession = {
	list: () => ({ nodes: [] }),
	listBranches: () => ({ branches: [] }),
	readBranch: () => ({ nodes: [] }),
	read: () => undefined,
	requestRewind: async () => ({ requestId: "test", status: "committed" }),
} as any;

const overlays = () => [
	new EffortSlider("unknown", ["off", "medium", "high"]),
	new ModelPicker("model-a", [
		{
			id: "provider",
			name: "provider",
			description: "provider",
			models: [{ id: "model-a", name: "model-a", description: "model", provider: "provider" }],
		},
	]),
	new HelpMenu(),
	new TrajectoryScene({ list: () => [], aggregate: () => [] }),
	new BranchInspectorOverlay(emptySession),
	new PromptOverlay(),
	new PromptOverlay({
		kind: "prompt",
		id: "prompt-test",
		turnNumber: 1,
		systemPrompt: "system prompt line\n".repeat(30),
		injections: [],
	}),
];

describe("responsive TUI overlays", () => {
	it("keeps every built-in panel within narrow and short terminal viewports", () => {
		for (const width of [40, 50, 80, 120]) {
			for (const height of [8, 12, 24]) {
				for (const overlay of overlays()) {
					const lines = overlay.render(width, height);
					expect(lines.length, `${overlay.constructor.name} ${width}x${height}`).toBeLessThanOrEqual(height);
					for (const [index, line] of lines.entries()) {
						expect(
							visibleWidth(line),
							`${overlay.constructor.name} ${width}x${height} row ${index}`,
						).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	it("keeps the model picker component itself within one- and two-row heights", () => {
		const picker = overlays().find((overlay) => overlay instanceof ModelPicker)!;
		for (const height of [1, 2]) {
			const rows = picker.render(40, height);
			expect(rows).toHaveLength(height);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
		}
	});

	it("does not claim a current reasoning tier when the host value is unknown", () => {
		const slider = new EffortSlider("unknown", ["off", "medium", "high"]);
		expect(stripAnsi(slider.render(80).join("\n"))).not.toContain("✓");
	});

	it("keeps the focused reasoning tier visible and counts hidden tiers on narrow panels", () => {
		const slider = new EffortSlider("off");
		const initial = stripAnsi(slider.render(40).join("\n"));
		expect(initial).toContain("→");
		for (let index = 0; index < 4; index++) slider.navigateRight();
		const focused = stripAnsi(slider.render(40).join("\n"));
		expect(focused).toContain("High");
		expect(focused).toContain("←4");
	});

	it("redraws the compact help panel after a scroll key", () => {
		const menu = new HelpMenu(
			Array.from({ length: 20 }, (_, index) => ({ name: `command-${index}`, description: `command ${index}` })),
		);
		let redraws = 0;
		menu.onRequestRender = () => redraws++;
		const before = stripAnsi(menu.render(40, 8).join("\n"));

		menu.handleInput("\x1b[B");

		expect(redraws).toBe(1);
		expect(stripAnsi(menu.render(40, 8).join("\n"))).not.toBe(before);
	});

	it("uses a scrollable help layout when commands exceed available height", () => {
		const menu = new HelpMenu(
			Array.from({ length: 32 }, (_, index) => ({ name: `command-${index}`, description: `command ${index}` })),
		);
		const rows = menu.render(80, 20);

		expect(rows.length).toBeLessThanOrEqual(20);
		expect(stripAnsi(rows.join("\n"))).toContain("滚动");
	});

	it("keeps compact help entries aligned with the wide help menu", () => {
		const menu = new HelpMenu([{ name: "only", description: "Only registered command" }]);
		const compact = stripAnsi(menu.render(40, 14).join("\n"));
		const wide = stripAnsi(menu.render(80, 24).join("\n"));

		expect(compact).toContain("Alt+O");
		expect(compact).toContain("/only");
		expect(compact).not.toContain("/help");
		expect(wide).toContain("Alt+O");
		expect(wide).toContain("/only");
		expect(wide).not.toContain("/help");
	});

	it("does not reserve a blank ContextBar row and shows a keyboard details affordance when data exists", () => {
		const bar = new ContextBarComponent();
		expect(bar.render(80)).toEqual([]);
		bar.update({ usedTokens: 100, contextWindow: 1000 });
		expect(stripAnsi(bar.render(80)[0]!)).toContain("Ctrl+L");
		bar.setExpanded(true);
		expect(stripAnsi(bar.render(80)[0]!)).toContain("剩余");
	});
});
