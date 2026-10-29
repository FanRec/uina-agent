import type { PresentationIntent } from "../presentation/actions.js";

export interface PresentationIntentActions {
	submit(text: string, mode: "direct" | "steer" | "followUp"): void;
	interaction(): void;
	cancel(source?: "escape" | "ctrl+c"): void;
	interruptAndDeliver(text: string): void;
	pullBackQueue(): void;
	cycleThinkingLevel(): void;
}

/** Application-owned handling of actions emitted by any presentation surface. */
export function routePresentationIntent(intent: PresentationIntent, actions: PresentationIntentActions): void {
	switch (intent.type) {
		case "input.submit":
			actions.submit(intent.text, intent.mode);
			return;
		case "ui.interaction":
			actions.interaction();
			return;
		case "turn.cancel":
			actions.cancel(intent.source);
			return;
		case "turn.interruptAndDeliver":
			actions.interruptAndDeliver(intent.text);
			return;
		case "queue.pullBack":
			actions.pullBackQueue();
			return;
		case "thinking.cycle":
			actions.cycleThinkingLevel();
			return;
		default: {
			const exhaustive: never = intent;
			return exhaustive;
		}
	}
}
