import { describe, expect, it, vi } from "vitest";
import { routePresentationIntent } from "../src/cli/presentation-intents.js";
import type { HostSnapshot } from "../src/host/events.js";
import { createInteractiveUI } from "../src/ui/tui.js";
import { createSilentTerminal, getTestUIHost } from "./harness/index.js";

describe("PresentationIntent application routing", () => {
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

		expect(intents).toContainEqual({ type: "input.submit", text: "hello", mode: "direct" });
		expect(intents).toContainEqual({ type: "turn.cancel", source: "ctrl+c" });
		tui.close();
	});

	it("routes each presentation action to its matching application operation", () => {
		const actions = {
			submit: vi.fn(),
			interaction: vi.fn(),
			cancel: vi.fn(),
			interruptAndDeliver: vi.fn(),
			pullBackQueue: vi.fn(),
			cycleThinkingLevel: vi.fn(),
		};

		routePresentationIntent({ type: "input.submit", text: "hello", mode: "steer" }, actions);
		routePresentationIntent({ type: "ui.interaction" }, actions);
		routePresentationIntent({ type: "turn.cancel", source: "escape" }, actions);
		routePresentationIntent({ type: "turn.interruptAndDeliver", text: "urgent" }, actions);
		routePresentationIntent({ type: "queue.pullBack" }, actions);
		routePresentationIntent({ type: "thinking.cycle" }, actions);

		expect(actions.submit).toHaveBeenCalledWith("hello", "steer");
		expect(actions.interaction).toHaveBeenCalledOnce();
		expect(actions.cancel).toHaveBeenCalledWith("escape");
		expect(actions.interruptAndDeliver).toHaveBeenCalledWith("urgent");
		expect(actions.pullBackQueue).toHaveBeenCalledOnce();
		expect(actions.cycleThinkingLevel).toHaveBeenCalledOnce();
	});
});
