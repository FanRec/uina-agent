import type { ThinkingLevel } from "../core/types.js";
import type { SessionAccess } from "../session/types.js";
import type { UIHost } from "./ui-host.js";
import type { JobPort } from "./adapters/jobs.js";
import type { SubagentPort } from "./adapters/subagents.js";
import { TrajectoryProjection } from "./adapters/agent-events.js";
import {
	BranchInspectorOverlay, DEFAULT_EFFORT_TIERS, EffortSlider, HelpMenu,
	ModelPicker, SubagentDashboard, SubagentDetailScene, TaskDashboard,
	TrajectoryScene, type EffortTier, type ModelGroup,
} from "./features/overlays/index.js";

export interface UIFeatureOptions {
	jobPort?: JobPort;
	subagentPort?: SubagentPort;
	sessionPort?: SessionAccess;
}

export interface ModelPickerRequest {
	currentModel: string;
	groups: ModelGroup[];
	onPick: (name: string) => Promise<void> | void;
}

export interface EffortSliderRequest {
	currentLevel?: ThinkingLevel;
	tiers: readonly (EffortTier | ThinkingLevel)[];
	onChange: (level: ThinkingLevel) => void;
}

export function installUIFeatures(host: UIHost, options: UIFeatureOptions = {}): { trajectory: TrajectoryProjection; dispose: () => void } {
	const trajectory = new TrajectoryProjection();
	const disposers: Array<() => void> = [];
	const register = (name: string, handler: (payload?: unknown) => void): void => {
		disposers.push(host.registerFeature(name, handler));
	};

	register("help", () => host.showPanel("help", (close) => {
		const menu = new HelpMenu(host.registry.listCommands());
		menu.onClose = close;
		menu.onConvertToInput = (text) => { close(); host.inputLine.setText(text); host.requestRender(); };
		return menu;
	}));

	register("model-picker", (payload) => {
		const request = payload as ModelPickerRequest | undefined;
		if (!request) return;
		host.showPanel("model", (close) => {
			const picker = new ModelPicker(request.currentModel, request.groups);
			picker.onPick = (name) => { void request.onPick(name); close(); };
			picker.onClose = close;
			return picker;
		});
	});

	register("effort-slider", (payload) => {
		const request = payload as EffortSliderRequest | undefined;
		if (!request) return;
		const levels = host.getThinkingLevels();
		if (!levels.length) { host.notify("当前模型未声明思考档位", "info"); return; }
		host.showPanel("effort", (close) => {
			const tiers = request.tiers.length > 0
				? request.tiers.filter((tier) => levels.includes(typeof tier === "string" ? tier : tier.id))
				: DEFAULT_EFFORT_TIERS.filter((tier) => levels.includes(tier.id));
			const slider = new EffortSlider(request.currentLevel ?? host.getReasoningEffort() ?? "off", tiers);
			slider.onChange = (level) => { host.setReasoningEffort(level); request.onChange(level); };
			slider.onClose = close;
			return slider;
		});
	});

	const jobPort = options.jobPort;
	if (jobPort) register("tasks", () => host.showPanel("tasks", (close) => {
		const view = new TaskDashboard(jobPort);
		view.onClose = close;
		return view;
	}));

	const subagentPort = options.subagentPort;
	if (subagentPort) register("subagents", () => host.showPanel("subagents", (close, { hide }) => {
		const view = new SubagentDashboard(subagentPort);
		view.onClose = close;
		view.onDrilldown = (agent) => {
			hide();
			const detail = new SubagentDetailScene(agent, subagentPort);
			let detailHandle: ReturnType<typeof host.overlayStack.showOverlay> | null = null;
			detail.onClose = () => { detailHandle?.hide(); detailHandle = null; close(); };
			detail.onRequestRender = () => host.requestRender();
			detailHandle = host.overlayStack.showOverlay(detail, { anchor: "center" }, close);
		};
		return view;
	}));

	register("trajectory", () => host.showPanel("trajectory", (close) => {
		const scene = new TrajectoryScene(trajectory);
		scene.onClose = close;
		return scene;
	}));

	const sessionPort = options.sessionPort;
	if (sessionPort) register("history", () => host.showPanel("history", (close) => {
		const view = new BranchInspectorOverlay(sessionPort);
		view.onClose = close;
		return view;
	}));

	return { trajectory, dispose: () => { for (const dispose of disposers.splice(0)) dispose(); } };
}
