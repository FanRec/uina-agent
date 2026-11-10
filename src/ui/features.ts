import type { BuiltinUIActionRequest, BuiltinUIActions } from "../extensions/ui-contract.js";
import { toReadableError } from "../presentation/copy.js";
import type { TrajectoryEventSource } from "../presentation/trajectory.js";
import type { SessionAccess } from "../session/types.js";
import {
	BranchInspectorOverlay,
	EffortSlider,
	HelpMenu,
	ModelPicker,
	PromptOverlay,
	TrajectoryScene,
} from "./features/overlays/index.js";
import type { UIHost } from "./ui-host.js";

export interface UIFeatureOptions {
	sessionPort?: SessionAccess;
}

export function installUIFeatures(
	host: UIHost,
	trajectory: TrajectoryEventSource,
	options: UIFeatureOptions = {},
): { dispose: () => void } {
	const disposers: Array<() => void> = [];
	const register = <Name extends keyof BuiltinUIActions>(
		name: Name,
		handler: (action: Extract<BuiltinUIActionRequest, { name: Name }>) => void,
	): void => {
		disposers.push(host.registerFeature(name, handler));
	};

	register("help", (action) =>
		host.showPanel(
			"help",
			(close) => {
				const menu = new HelpMenu(host.registry.listCommands());
				menu.onClose = close;
				menu.onConvertToInput = (text) => {
					close();
					host.replaceInput(text);
				};
				return menu;
			},
			action.signal,
		),
	);

	register("model-picker", (action) => {
		host.showPanel(
			"model",
			(close) => {
				const picker = new ModelPicker(action.payload.currentModel, action.payload.groups);
				picker.onPick = (name) => {
					const reportFailure = (error: unknown): void => {
						if (!action.signal?.aborted) host.notify(`模型切换失败：${toReadableError(error)}`, "error");
					};
					try {
						void Promise.resolve(action.payload.onPick(name)).catch(reportFailure);
					} catch (error) {
						reportFailure(error);
					}
					close();
				};
				picker.onClose = close;
				return picker;
			},
			action.signal,
		);
	});

	register("effort-slider", (action) => {
		const levels = host.getThinkingLevels();
		// A5/A6：只认声明档位，不回退编造表；过滤后为空与未声明同样处理。
		const tiers = action.payload.tiers.filter((tier) => levels.includes(typeof tier === "string" ? tier : tier.id));
		if (tiers.length === 0) {
			host.notify("当前模型未声明可用的思考档位", "info");
			return;
		}
		host.showPanel(
			"effort",
			(close) => {
				const slider = new EffortSlider(action.payload.currentLevel ?? host.getReasoningEffort(), tiers);
				slider.onChange = (level) => {
					host.setReasoningEffort(level);
					action.payload.onChange(level);
				};
				slider.onClose = close;
				return slider;
			},
			action.signal,
		);
	});

	register("toggle-thinking", () => host.toggleThinking());
	register("clear-transcript", () => host.clearTranscript());
	register("trajectory", (action) =>
		host.showPanel(
			"trajectory",
			(close) => {
				const scene = new TrajectoryScene(trajectory);
				scene.onClose = close;
				return scene;
			},
			action.signal,
		),
	);

	const sessionPort = options.sessionPort;
	if (sessionPort)
		register("history", (action) =>
			host.showPanel(
				"history",
				(close) => {
					const view = new BranchInspectorOverlay(sessionPort);
					view.onClose = close;
					return view;
				},
				action.signal,
			),
		);

	register("prompt", (action) =>
		host.showPanel(
			"prompt",
			(close) => {
				const view = new PromptOverlay(host.getPromptSnapshot(), () => host.getRequestObservations());
				view.onClose = close;
				return view;
			},
			action.signal,
		),
	);

	return {
		dispose: () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
	};
}
