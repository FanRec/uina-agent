import type { SessionAccess } from "../session/types.js";
import type { UIHost } from "./ui-host.js";
import type { BuiltinUIActions } from "../extensions/ui-contract.js";
import { TrajectoryProjection } from "./adapters/agent-events.js";
import {
	BranchInspectorOverlay,
	PromptOverlay,
	DEFAULT_EFFORT_TIERS,
	EffortSlider,
	HelpMenu,
	ModelPicker,
	TrajectoryScene,
} from "./features/overlays/index.js";

export interface UIFeatureOptions {
	sessionPort?: SessionAccess;
}

export function installUIFeatures(
	host: UIHost,
	options: UIFeatureOptions = {},
): { trajectory: TrajectoryProjection; dispose: () => void } {
	const trajectory = new TrajectoryProjection();
	const disposers: Array<() => void> = [];
	const register = <Name extends keyof BuiltinUIActions>(
		name: Name,
		handler: (payload: BuiltinUIActions[Name]) => void,
	): void => {
		disposers.push(host.registerFeature(name, handler));
	};

	register("help", () =>
		host.showPanel("help", (close) => {
			const menu = new HelpMenu(host.registry.listCommands());
			menu.onClose = close;
			menu.onConvertToInput = (text) => {
				close();
				host.inputLine.setText(text);
				host.requestRender();
			};
			return menu;
		}),
	);

	register("model-picker", (request) => {
		host.showPanel("model", (close) => {
			const picker = new ModelPicker(request.currentModel, request.groups);
			picker.onPick = (name) => {
				void request.onPick(name);
				close();
			};
			picker.onClose = close;
			return picker;
		});
	});

	register("effort-slider", (request) => {
		const levels = host.getThinkingLevels();
		if (!levels.length) {
			host.notify("当前模型未声明思考档位", "info");
			return;
		}
		host.showPanel("effort", (close) => {
			const tiers =
				request.tiers.length > 0
					? request.tiers.filter((tier) => levels.includes(typeof tier === "string" ? tier : tier.id))
					: DEFAULT_EFFORT_TIERS.filter((tier) => levels.includes(tier.id));
			const slider = new EffortSlider(request.currentLevel ?? host.getReasoningEffort() ?? "off", tiers);
			slider.onChange = (level) => {
				host.setReasoningEffort(level);
				request.onChange(level);
			};
			slider.onClose = close;
			return slider;
		});
	});

	register("toggle-thinking", () => host.toggleThinking());
	register("clear-transcript", () => host.clearTranscript());
	register("trajectory", () =>
		host.showPanel("trajectory", (close) => {
			const scene = new TrajectoryScene(trajectory);
			scene.onClose = close;
			return scene;
		}),
	);

	const sessionPort = options.sessionPort;
	if (sessionPort)
		register("history", () =>
			host.showPanel("history", (close) => {
				const view = new BranchInspectorOverlay(sessionPort);
				view.onClose = close;
				return view;
			}),
		);

	register("prompt", () =>
		host.showPanel("prompt", (close) => {
			const view = new PromptOverlay(host.getPromptSnapshot());
			view.onClose = close;
			return view;
		}),
	);

	return {
		trajectory,
		dispose: () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
	};
}
