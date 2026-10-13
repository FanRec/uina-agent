import type { TuiIntent } from "../ui/intents.js";

export interface TuiIntentActions {
	submit(text: string, mode: "direct" | "steer" | "followUp"): void;
	interaction(): void;
	cancel(source?: "escape" | "ctrl+c"): void;
	interruptAndDeliver(text: string): void;
	pullBackQueue(): void;
	cycleThinkingLevel(): void;
}

/** Application-owned handling of user actions emitted by the terminal surface. */
export function routeTuiIntent(intent: TuiIntent, actions: TuiIntentActions): void {
	switch (intent.type) {
		case "submit":
			actions.submit(intent.text, intent.mode);
			return;
		case "interaction":
			actions.interaction();
			return;
		case "cancel":
			actions.cancel(intent.source);
			return;
		case "interrupt-and-deliver":
			actions.interruptAndDeliver(intent.text);
			return;
		case "pull-back-queue":
			actions.pullBackQueue();
			return;
		case "cycle-thinking-level":
			actions.cycleThinkingLevel();
			return;
		default: {
			const exhaustive: never = intent;
			return exhaustive;
		}
	}
}
