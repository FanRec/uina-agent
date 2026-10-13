/** User actions that cross from the terminal surface into the application. */
export type TuiIntent =
	| { type: "submit"; text: string; mode: "direct" | "steer" | "followUp" }
	| { type: "interaction" }
	| { type: "cancel"; source?: "escape" | "ctrl+c" }
	| { type: "interrupt-and-deliver"; text: string }
	| { type: "pull-back-queue" }
	| { type: "cycle-thinking-level" };
