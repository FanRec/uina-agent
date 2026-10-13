import { describe, expect, it, vi } from "vitest";
import { routeTuiIntent } from "../src/cli/tui-intents.js";
import { createInteractiveUI } from "../src/ui/tui.js";
import type { HostSnapshot } from "../src/host/events.js";
import { createSilentTerminal, getTestUIHost } from "./harness/index.js";

describe("TuiIntent application routing", () => {
	it("initializes the terminal view from HostSnapshot facts before start", () => {
		const tui = createInteractiveUI();
		const snapshot: HostSnapshot = {
			modelName: "provider:model",
			thinkingLevels: ["off", "low"],
			thinkingLevel: "low",
			busy: true,
			queue: [{ id: "queued-1", order: 1, mode: "steer", text: "pending" }],
			queueDepth: 1,
		};

		tui.initialize(snapshot);

		const host = getTestUIHost(tui);
		expect(host.modelName).toBe("provider:model");
		expect(host.getReasoningEffort()).toBe("low");
		expect(host.isBusy()).toBe(true);
		tui.close();
	});

	it("emits submit and cancel intents from real terminal input", () => {
		const terminal = createSilentTerminal(80, 24);
		const tui = createInteractiveUI({ terminal: terminal.terminal });
		const intents: unknown[] = [];
		tui.onIntent((intent) => intents.push(intent));
		tui.start();

		terminal.feedInput("hello");
		terminal.feedInput("\r");
		terminal.feedInput("\x03");

		expect(intents).toContainEqual({ type: "submit", text: "hello", mode: "direct" });
		expect(intents).toContainEqual({ type: "cancel", source: "ctrl+c" });
		tui.close();
	});

	it("routes each UI action to its matching application operation", () => {
		const actions = {
			submit: vi.fn(),
			interaction: vi.fn(),
			cancel: vi.fn(),
			interruptAndDeliver: vi.fn(),
			pullBackQueue: vi.fn(),
			cycleThinkingLevel: vi.fn(),
		};

		routeTuiIntent({ type: "submit", text: "hello", mode: "steer" }, actions);
		routeTuiIntent({ type: "interaction" }, actions);
		routeTuiIntent({ type: "cancel", source: "escape" }, actions);
		routeTuiIntent({ type: "interrupt-and-deliver", text: "urgent" }, actions);
		routeTuiIntent({ type: "pull-back-queue" }, actions);
		routeTuiIntent({ type: "cycle-thinking-level" }, actions);

		expect(actions.submit).toHaveBeenCalledWith("hello", "steer");
		expect(actions.interaction).toHaveBeenCalledOnce();
		expect(actions.cancel).toHaveBeenCalledWith("escape");
		expect(actions.interruptAndDeliver).toHaveBeenCalledWith("urgent");
		expect(actions.pullBackQueue).toHaveBeenCalledOnce();
		expect(actions.cycleThinkingLevel).toHaveBeenCalledOnce();
	});
});
