import type { Subject } from "../agent/loop.js";
import type { ModelRegistry } from "../ai/providers.js";
import type { JobRegistry } from "./jobs/registry.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { ExtensionAPI } from "./runner.js";
import type { UIHost } from "../ui/ui-host.js";
import { ModelPicker, type ModelGroup } from "../ui/components/overlays/model-picker.js";
import { EffortSlider, DEFAULT_EFFORT_TIERS } from "../ui/components/overlays/effort-slider.js";
import { TaskDashboard } from "../ui/components/overlays/task-dashboard.js";
import { SubagentDashboard } from "../ui/components/overlays/subagent-dashboard.js";
import { SubagentDetailScene } from "../ui/components/overlays/subagent-detail-scene.js";
import { TrajectoryScene } from "../ui/components/overlays/trajectory-scene.js";
import { createJobAdapter } from "../ui/adapters/jobs.js";
import { createSubagentAdapter } from "../ui/adapters/subagents.js";

export interface BuiltinServices { subject: Subject; models: ModelRegistry; jobs: JobRegistry; subagents: SubagentRegistry; host?: UIHost; reload(): Promise<void>; shutdown(): Promise<void>; }

export function activateBuiltinCommands(services: BuiltinServices): (pi: ExtensionAPI) => void {
	return (pi) => {
		const host = () => services.host;
		pi.registerCommand({ name: "help", description: "查看所有可用命令与快捷键", handler: () => host()?.openHelpMenu() });
		pi.registerCommand({ name: "commands", description: "查看所有可用斜杠命令", handler: () => host()?.openHelpMenu() });
		pi.registerCommand({ name: "hotkeys", description: "查看快捷键", handler: () => host()?.openHelpMenu() });
		pi.registerCommand({ name: "think", description: "展开或折叠思考", handler: () => { host()?.transcript.toggleThinking(); host()?.requestRender(); } });
		pi.registerCommand({ name: "clear", description: "清空当前屏幕转录", handler: () => { host()?.transcript.clear(); host()?.requestRender(); } });
		pi.registerCommand({ name: "session", description: "查看当前会话信息", handler: () => { const model = services.subject.getModel(); pi.ui.notify(`会话信息: 模型=${model.name} · 思考=${services.subject.getThinkingLevel()}`); } });
		pi.registerCommand({ name: "model", description: "切换模型", hasArgs: true, argumentHint: "<provider>", handler: async (arg) => {
			if (!arg) { const picker = new ModelPicker(services.subject.getModel().name, modelGroups(services.models)); const handle = pi.ui.showOverlay(picker); picker.onPick = (name) => { void selectModel(name); handle.hide(); }; picker.onClose = () => handle.hide(); picker.onRequestRender = () => host()?.requestRender(); return; }
			await selectModel(arg);
		} });
		const selectModel = async (arg: string): Promise<void> => {
			const provider = services.models.resolve(arg); await services.subject.setModel(provider); host()?.setModel(provider.name); host()?.setThinkingLevels(provider.thinkingLevels ?? ["off"]); pi.ui.notify(`已切换至模型: ${provider.name}`);
		};
		pi.registerCommand({ name: "effort", description: "设置思考等级", hasArgs: true, argumentHint: "<level>", handler: (arg) => { if (!arg) { const levels = services.subject.getModel().thinkingLevels ?? ["off"]; const slider = new EffortSlider(services.subject.getThinkingLevel(), DEFAULT_EFFORT_TIERS.filter((tier) => levels.includes(tier.id))); const handle = pi.ui.showOverlay(slider); slider.onChange = (level) => { services.subject.setThinkingLevel(level); host()?.setReasoningEffort(level); }; slider.onClose = () => handle.hide(); slider.onRequestRender = () => host()?.requestRender(); return; } const level = arg as import("../core/types.js").ThinkingLevel; if (!services.subject.getModel().thinkingLevels?.includes(level)) throw new Error(`当前 Provider 不支持: ${arg}`); services.subject.setThinkingLevel(level); host()?.setReasoningEffort(level); } });
		pi.registerCommand({ name: "thinking", description: "设置思考等级", hasArgs: true, argumentHint: "<level>", handler: (arg) => { const level = arg as import("../core/types.js").ThinkingLevel; if (!services.subject.getModel().thinkingLevels?.includes(level)) throw new Error(`当前 Provider 不支持: ${arg}`); services.subject.setThinkingLevel(level); host()?.setReasoningEffort(level); } });
		pi.registerCommand({ name: "compact", description: "压缩会话", hasArgs: true, argumentHint: "[instruction]", handler: (arg) => services.subject.compact(arg || undefined) });
		pi.registerCommand({ name: "tasks", description: "后台任务看板", handler: () => showTasks(pi, services.jobs) });
		pi.registerCommand({ name: "jobs", description: "后台任务看板", handler: () => showTasks(pi, services.jobs) });
		pi.registerCommand({ name: "subagents", description: "子代理看板", handler: () => showSubagents(pi, services.subagents) });
		pi.registerCommand({ name: "agents", description: "子代理看板", handler: () => showSubagents(pi, services.subagents) });
		pi.registerCommand({ name: "trajectory", description: "轨迹看板", handler: () => { const h = host(); if (h) { const scene = new TrajectoryScene(h.trajectoryProjection); let handle = pi.ui.showOverlay(scene); scene.onClose = () => handle.hide(); } } });
		pi.registerCommand({ name: "reload", description: "重载项目扩展", handler: () => services.reload() });
		pi.registerCommand({ name: "quit", description: "退出 Uina", handler: () => services.shutdown() });
		pi.registerCommand({ name: "exit", description: "退出 Uina", handler: () => services.shutdown() });
	};
}

function showTasks(pi: ExtensionAPI, jobs: JobRegistry): void { const view = new TaskDashboard(createJobAdapter(jobs)); const handle = pi.ui.showOverlay(view); view.onClose = () => handle.hide(); view.onRequestRender = () => {}; }
function showSubagents(pi: ExtensionAPI, subagents: SubagentRegistry): void { const view = new SubagentDashboard(createSubagentAdapter(subagents)); const handle = pi.ui.showOverlay(view); view.onClose = () => handle.hide(); view.onDrilldown = (agent) => { handle.hide(); const detail = new SubagentDetailScene(agent, createSubagentAdapter(subagents)); const next = pi.ui.showOverlay(detail); detail.onClose = () => next.hide(); }; view.onRequestRender = () => {}; }

function modelGroups(models: ModelRegistry): ModelGroup[] {
	return models.choices().map((choice) => ({ id: choice.id, name: choice.id, description: "已配置或已注册 Provider", models: [{ id: choice.id, name: choice.name, description: choice.id, provider: choice.id }] }));
}
